/**
 * Send-path chaining pipeline (issue #47 send-path slice).
 *
 * Two pure functions adapters (VS Code extension, future CLI) call around a
 * single HTTP exchange:
 *
 *   1. `prepareChainSend`  — before sending, resolve `{{name.response…}}`,
 *      `{{name.request.body…}}`, and capture-name references against the
 *      run store. Runs BEFORE environment substitution; unresolved chain
 *      references stay literal with diagnostics so the adapter can refuse
 *      to send a raw placeholder.
 *   2. `recordChainExchange` — after a response is received, evaluate the
 *      request's `# @capture` directives against that response and record
 *      the named request/response into the store for later references.
 *
 * A `received: false` exchange (transport failure / cancellation) performs
 * NO store mutation: downstream references keep failing loudly against the
 * last genuinely-received state instead of a synthesized error.
 *
 * Secret policy: values of `secret`-flagged captures ARE substituted into
 * the request being sent (that is the point of chaining) and are returned
 * as `resolvedSecrets` / `resolvedCaptures` provenance so adapters can keep
 * them out of derived surfaces (previews, logs, exports). Nothing here
 * persists anything to disk.
 */
import { MAX_CAPTURES_PER_REQUEST } from '../parser.js';
import {
  applyCapture,
  isValidChainName,
  MAX_SECRET_PROVENANCE,
  parseCaptureDirective,
  resolveChainRequest,
  serializeValue,
  validateRequestNames,
  type AppliedCapture,
  type ChainDiagnostic,
  type ChainRequestInput,
  type ChainStore,
  type ResolvedCapture,
} from './resolver.js';

/** Outcome of receiving an exchange, as seen by the recording stage. */
export interface SendExchange {
  /** False for transport failure / user cancellation: nothing is recorded. */
  received: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ChainSendResult {
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: string;
  diagnostics: ChainDiagnostic[];
  /** Every capture substitution made, with secret flags. */
  resolvedCaptures: ResolvedCapture[];
  /** Values substituted from `secret` captures (for redaction lists). */
  resolvedSecrets: string[];
  /** Names of `secret` captures substituted (for diagnostics/UI labels). */
  resolvedSecretNames: string[];
}

/**
 * Resolve all chain references in a request against the run store. See the
 * module docs for ordering and failure semantics.
 */
export function prepareChainSend(
  req: ChainRequestInput,
  store: ChainStore,
): ChainSendResult {
  const resolved = resolveChainRequest(req, store);
  const secrets = new Set<string>();
  const secretNames: string[] = [];
  const addSecret = (name: string, value: string): void => {
    if (value === '') return;
    if (!secretNames.includes(name)) secretNames.push(name);
    secrets.add(value);
  };
  for (const cap of resolved.resolvedCaptures) {
    if (!cap.secret) continue;
    addSecret(cap.name, cap.value);
  }
  // Value-equality sweep (issue #47 review blocker B3): a DIRECT response
  // reference (`{{login.response.body.$.token}}`) substitutes the same
  // secret text without capture-name provenance. Sweep every substituted
  // surface against the store's secret captures so the adapter's redaction
  // boundary cannot be bypassed by ref style. Substring equality is exactly
  // the matching the adapter's `redactSecretText` performs downstream, so a
  // value listed here is a value that WILL be redacted there.
  // The sweep also covers REJECTED-but-evaluated secret captures (issue #47
  // review S4/L1): their exchange's response IS recorded, so a direct
  // reference into it can carry the rejected secret onto the wire.
  const secretCaptures: Array<{ name: string; value: string }> = store
    .captureNames()
    .map((name) => ({ name, record: store.getCapture(name) }))
    .filter((entry): entry is { name: string; record: { value: unknown; secret: true } } =>
      entry.record !== undefined && entry.record.secret === true,
    )
    .map((entry) => ({ name: entry.name, value: serializeValue(entry.record.value) }));
  for (const hint of store.secretProvenance()) {
    if (!secretCaptures.some((c) => c.value === hint.value)) {
      secretCaptures.push(hint);
    }
  }
  if (secretCaptures.length > 0) {
    const surfaces = [
      resolved.url,
      resolved.body,
      ...resolved.headers.map((h) => h.value),
    ];
    for (const entry of secretCaptures) {
      const value = entry.value;
      if (value === '' || secrets.has(value)) continue;
      if (surfaces.some((text) => text.includes(value))) addSecret(entry.name, value);
    }
  }
  return {
    url: resolved.url,
    headers: resolved.headers,
    body: resolved.body,
    diagnostics: resolved.diagnostics,
    resolvedCaptures: resolved.resolvedCaptures,
    resolvedSecrets: [...secrets],
    resolvedSecretNames: secretNames,
  };
}

export interface ChainRecordResult {
  /**
   * Captures this exchange evaluated and STORED (a re-run of the same
   * named exchange refreshes the captures it owns). Entries rejected by
   * the store as duplicates of ANOTHER exchange's captures are excluded
   * and reported via `diagnostics`.
   */
  applied: AppliedCapture[];
  /** Human-readable diagnostics (invalid directives, duplicates, name errors). */
  diagnostics: string[];
}

/**
 * Record one completed exchange into the run store.
 *
 * - `name` is the `# @name` identifier (or `undefined` for an unnamed
 *   request — the exchange still applies its captures, it just cannot be
 *   referenced by name later).
 * - `captures` are raw `# @capture` directive sources (from the parser).
 * - `sentBody` is the body recorded for `{{name.request.body.$.path}}`
 *   references. The core stores it verbatim; the VS Code adapter passes the
 *   secret-scrubbed copy of the wire body (issue #47 review F1-R3/r6). When
 *   the scrubber refuses (no candidate is both valid JSON and secret-free,
 *   review r11), the adapter records the empty string — the truthful
 *   "no recordable body" state, which makes later body references fail
 *   closed with the not-valid-JSON diagnostic.
 * - A `received: false` exchange mutates nothing.
 */
export function recordChainExchange(
  store: ChainStore,
  name: string | undefined,
  captures: readonly string[],
  sentBody: string,
  exchange: SendExchange,
): ChainRecordResult {
  if (!exchange.received) return { applied: [], diagnostics: [] };

  const diagnostics: string[] = [];
  if (name !== undefined && !isValidChainName(name)) {
    // The whole named recording is ambiguous — skip it (and its captures)
    // with one clear diagnostic instead of half-applied state.
    return { applied: [], diagnostics: validateRequestNames([name]) };
  }

  // Defensive bound (issue #47 review F4): the parser caps capture
  // directives per request, but this is PUBLIC API for CLI/runner adapters
  // too — evaluating an unbounded directive list would let any caller
  // reintroduce the hostile-work problem the parser cap solved. Keep the
  // first MAX_CAPTURES_PER_REQUEST and say so.
  let captureSources = captures;
  if (captureSources.length > MAX_CAPTURES_PER_REQUEST) {
    diagnostics.push(
      `request supplied more than ${MAX_CAPTURES_PER_REQUEST} capture directives: ` +
        `kept the first ${MAX_CAPTURES_PER_REQUEST}, ignored ` +
        `${captureSources.length - MAX_CAPTURES_PER_REQUEST} (capture limit)`,
    );
    captureSources = captureSources.slice(0, MAX_CAPTURES_PER_REQUEST);
  }

  // Fail-closed secret-provenance quota (issue #47 review r7 SEC2): the
  // value-equality sweep can only redact secrets whose REJECTED capture
  // values the store still remembers (bounded, in memory). Once the quota
  // is exhausted, recording a NAMED exchange that carries a `secret`
  // capture directive would store a response whose potential secret can no
  // longer be guaranteed swept — so refuse the whole recording (the value
  // is then not referenceable at all) instead of silently dropping the
  // hint. Unnamed exchanges record no response, so they cannot leak this
  // way and are unaffected, as are exchanges without secret directives.
  const secretDirectiveCount = captureSources.filter((src) => {
    const parsed = parseCaptureDirective(src);
    return !('error' in parsed) && parsed.secret === true;
  }).length;
  // Conservative headroom check (issue #47 review r9 SEC2): every secret
  // directive MIGHT be rejected and need a hint, so the exchange is refused
  // unless the quota has room for ALL of them. Dedup inside the store may
  // have used less than the full reserve — refusing anyway is the
  // fail-closed direction and keeps a recorded named exchange's provenance
  // promise whole.
  if (
    name !== undefined &&
    secretDirectiveCount > 0 &&
    store.secretProvenance().length + secretDirectiveCount > MAX_SECRET_PROVENANCE
  ) {
    diagnostics.push(
      `request not recorded: secret-capture provenance quota (${MAX_SECRET_PROVENANCE}) exhausted for this run — the response would not be safely redactable (secret-provenance limit)`,
    );
    return { applied: [], diagnostics };
  }

  const responseRecord = {
    status: exchange.status,
    headers: exchange.headers,
    body: exchange.body,
  };

  const applied: AppliedCapture[] = [];
  for (const directive of captureSources) {
    const result = applyCapture(directive, responseRecord);
    if ('error' in result) diagnostics.push(result.error);
    else applied.push(result);
  }

  // Exchange + capture recording happen in ONE step per name (issue #47
  // review B4/F2): for a named exchange the store first REMOVES every
  // capture this owner previously held, then records the fresh response
  // and this run's successful captures. A capture whose directive failed
  // (or was removed) this run therefore disappears instead of serving a
  // stale value that disagrees with the new response. Unnamed recordings
  // replace nothing.
  if (name !== undefined) {
    store.recordRequest(name, { body: sentBody });
    store.recordResponse(name, responseRecord);
    // Called even with zero successful captures: `replaceOwner` clears the
    // owner's stale captures so a failed/removed directive cannot leave a
    // value disagreeing with the fresh response (F2).
    const results = store.recordCaptures(applied, { owner: name, replaceOwner: true });
    diagnostics.push(...results.filter((r) => !r.stored).map((r) => r.diagnostic!));
    // `applied` reports exactly the captures this exchange STORED (S1):
    // first-wins within one call, so only rejected entries drop out.
    const storedIndexes = new Set(results.filter((r) => r.stored).map((r) => r.index));
    const stored = applied.filter((_, i) => storedIndexes.has(i));
    return { applied: stored, diagnostics };
  }
  if (applied.length > 0) {
    const results = store.recordCaptures(applied);
    diagnostics.push(...results.filter((r) => !r.stored).map((r) => r.diagnostic!));
    const storedIndexes = new Set(results.filter((r) => r.stored).map((r) => r.index));
    return { applied: applied.filter((_, i) => storedIndexes.has(i)), diagnostics };
  }
  return { applied: [], diagnostics };
}
