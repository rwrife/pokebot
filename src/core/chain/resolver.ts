/**
 * Pure request-chaining resolver for `# @name` + `{{ref}}` captures (issue #47).
 *
 * A "chain store" is a per-run, in-memory record of requests that were sent
 * and responses that came back, keyed by the `# @name <ident>` directive of
 * each request. The resolver substitutes chain references into text:
 *
 *   {{name.response.status}}                  — numeric status as text
 *   {{name.response.headers.<Header-Name>}}   — case-insensitive header lookup
 *   {{name.response.body.$.path.to.value}}    — JSONPath subset into the JSON body
 *   {{name.request.body.$.path.to.value}}     — JSONPath into the sent request body
 *
 * Everything here is payload-pure: no VS Code, no network, no persistence.
 * Captures are per-run in memory only (issue #47 — nothing is written to
 * disk). Non-chain references (`{{envVar}}`, `{{$guid}}`, …) pass through
 * untouched so the ordinary environment substitution pass can handle them.
 */

import { z } from 'zod';

import { parseJsonPath, queryJsonPath } from './jsonpath.js';

/** Identifier grammar for `# @name` and capture names (issue #47). */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Hard length cap on identifiers (issue #47 review S6): valid identifiers
 * beyond this are REJECTED, because diagnostics echo the offending name and
 * an unbounded name is an unbounded toast/echo vector.
 */
export const MAX_CHAIN_NAME_LENGTH = 128;

/** Per-item bound on every diagnostic message this module emits (review S6). */
const DIAGNOSTIC_MAX = 300;

/** Clip hostile-length text for safe embedding in a diagnostic. */
function bounded(text: string, max = DIAGNOSTIC_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Clip a name for diagnostic echo (review S6). */
function clipName(name: string): string {
  return bounded(name, 140);
}

/** True when `value` is a valid `# @name` / capture identifier. */
export function isValidChainName(value: string): boolean {
  return value.length <= MAX_CHAIN_NAME_LENGTH && NAME_RE.test(value);
}

/** A recorded chain reference parsed out of `{{ ... }}` text. */
export type ChainReference =
  | { kind: 'response'; part: 'status'; requestName: string }
  | { kind: 'response'; part: 'headers'; requestName: string; headerName: string }
  | { kind: 'response'; part: 'body'; requestName: string; path: string }
  | { kind: 'request'; part: 'body'; requestName: string; path: string };

const CHAIN_REF_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)\.(response|request)\.(status|headers|body)(?:\.(.+))?$/;

/** Recorded namespaces that mark a reference as chain-intent. */
const CHAIN_NAMESPACES: readonly ('response' | 'request')[] = ['response', 'request'];

/**
 * Parse one `{{...}}` inner reference into a chain reference, or return
 * `null` when the reference is not a chain ref (env var, built-in `$...`,
 * or a malformed combination such as `name.request.status`).
 */
export function parseChainReference(ref: string): ChainReference | null {
  const m = CHAIN_REF_RE.exec(ref);
  if (!m) return null;
  const [, requestName, kindRaw, partRaw, restRaw] = m;
  // Length bound (issue #47 review r7 S6): an over-long valid-shaped name
  // can never be a recorded chain name; reject it as a chain ref here so
  // classifyChainReference can never echo it inside a malformed diagnostic.
  if (requestName.length > MAX_CHAIN_NAME_LENGTH) return null;
  const kind = kindRaw as 'response' | 'request';
  const part = partRaw as 'status' | 'headers' | 'body';
  const rest = restRaw === undefined ? undefined : restRaw.trim();

  if (kind === 'request') {
    // Only `name.request.body.$.path` is defined.
    if (part !== 'body' || rest === undefined || !rest.startsWith('$')) return null;
    if ('error' in parseJsonPath(rest)) return null;
    return { kind, part, requestName, path: rest };
  }

  if (part === 'status') {
    if (rest !== undefined && rest.length > 0) return null;
    return { kind, part: 'status', requestName };
  }
  if (part === 'headers') {
    if (rest === undefined || rest.length === 0) return null;
    return { kind, part: 'headers', requestName, headerName: rest };
  }
  // response body: requires a JSONPath starting at `$`.
  if (rest === undefined || !rest.startsWith('$')) return null;
  if ('error' in parseJsonPath(rest)) return null;
  return { kind, part: 'body', requestName, path: rest };
}

// ---------------------------------------------------------------------------
// Capture directives (`# @capture name[: type [secret]] = $.path`)
// ---------------------------------------------------------------------------

export type CaptureType = 'string' | 'number' | 'boolean';

export interface ParsedCapture {
  name: string;
  /** Declared type from `name: type`, or `null` when untyped. */
  declaredType: CaptureType | null;
  secret: boolean;
  path: string;
}

export interface CaptureParseError {
  error: string;
}

const CAPTURE_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z]+)(\s+secret)?)?\s*=\s*(\S.*)$/;

const CAPTURE_TYPES: readonly CaptureType[] = ['string', 'number', 'boolean'];

/** Parse the value after `# @capture` (already de-commented). */
export function parseCaptureDirective(
  source: string,
): ParsedCapture | CaptureParseError {
  const m = CAPTURE_RE.exec(source.trim());
  if (!m) {
    return {
      error: bounded(
        `Invalid capture directive: "${source}" (expected name[: type [secret]] = $.path)`,
      ),
    };
  }
  const [, name, typeRaw, secretRaw, pathRaw] = m;
  // Identifier length bound (issue #47 review S6): an over-long valid-shaped
  // name is rejected here so no downstream diagnostic ever echoes it whole.
  if (name.length > MAX_CHAIN_NAME_LENGTH) {
    return {
      error: `Capture name too long (${name.length} chars; max ${MAX_CHAIN_NAME_LENGTH}): "${clipName(name)}"`,
    };
  }
  let declaredType: CaptureType | null = null;
  if (typeRaw !== undefined) {
    if (!CAPTURE_TYPES.includes(typeRaw as CaptureType)) {
      return { error: bounded(`Unknown capture type "${typeRaw}" (expected string | number | boolean)`) };
    }
    declaredType = typeRaw as CaptureType;
  }
  const secret = secretRaw !== undefined;
  if (secret && declaredType === null) {
    return { error: '`secret` requires a declared type, e.g. `tok: string secret`' };
  }
  const path = pathRaw.trim();
  if (!path.startsWith('$')) {
    return { error: bounded(`Capture path must be a JSONPath starting with '$': "${pathRaw}"`) };
  }
  if ('error' in parseJsonPath(path)) {
    return { error: bounded(`Unsupported capture path "${path}" (subset: $, .key, ['key'], [n])`) };
  }
  return { name, declaredType, secret, path };
}

const TYPE_SCHEMAS: Record<CaptureType, z.ZodTypeAny> = {
  string: z.string(),
  number: z.number().finite(),
  boolean: z.boolean(),
};

export interface AppliedCapture {
  name: string;
  value: unknown;
  secret: boolean;
}

export interface CaptureApplyError {
  error: string;
}

/**
 * Single-parse cache for capture evaluation (issue #47 review B5): a
 * request may declare many `# @capture` directives against the SAME
 * response record; parsing a (potentially large, hostile) body once per
 * directive would multiply work per send. The WeakMap is keyed by the
 * response-record object identity, so it caches per exchange without ever
 * outliving it — and never parses the same `body` string twice.
 */
const captureBodyDocs = new WeakMap<
  ChainResponseRecord,
  { ok: true; doc: unknown } | { ok: false }
>();

function parseCaptureBody(response: ChainResponseRecord): { ok: true; doc: unknown } | { ok: false } {
  const cached = captureBodyDocs.get(response);
  if (cached) return cached;
  let result: { ok: true; doc: unknown } | { ok: false };
  try {
    result = { ok: true, doc: JSON.parse(response.body) };
  } catch {
    result = { ok: false };
  }
  captureBodyDocs.set(response, result);
  return result;
}

/**
 * Evaluate a capture directive against a recorded response, validating the
 * declared type when one was given.
 */
export function applyCapture(
  directiveSource: string,
  response: ChainResponseRecord,
): AppliedCapture | CaptureApplyError {
  const parsed = parseCaptureDirective(directiveSource);
  if ('error' in parsed) return parsed;

  const doc = parseCaptureBody(response);
  if (!doc.ok) {
    return { error: `Response body is not valid JSON; cannot capture ${parsed.path}` };
  }
  const q = queryJsonPath(doc.doc, parsed.path);
  if (!q.found) return { error: `Capture ${parsed.name}: ${q.error}` };

  if (parsed.declaredType !== null) {
    const schema = TYPE_SCHEMAS[parsed.declaredType];
    const check = schema.safeParse(q.value);
    if (!check.success) {
      return {
        error: `Capture ${parsed.name}: value at ${parsed.path} failed ${parsed.declaredType} validation`,
      };
    }
  }
  return { name: parsed.name, value: q.value, secret: parsed.secret };
}

// ---------------------------------------------------------------------------
// Chain store (per-run, in-memory only)
// ---------------------------------------------------------------------------

export interface ChainRequestRecord {
  /**
   * The request body as recorded for `{{name.request.body.$…}}` references.
   * The core stores exactly what the adapter passes; the VS Code adapter
   * deliberately passes a SECRET-SCRUBBED copy of the sent body (issue #47
   * review F1-R3/r6) so a stored body can never re-surface a secret after
   * the environment rotates.
   */
  body: string;
}

export interface ChainResponseRecord {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A captured value stored for the run (capture values are never persisted). */
export interface CaptureRecord {
  value: unknown;
  secret: boolean;
}

interface StoredCapture extends CaptureRecord {
  /**
   * The `# @name` whose exchange originally recorded this capture, or
   * `undefined` for captures recorded by an unnamed exchange. Dedup is
   * owner-scoped: re-running the same named exchange with `replaceOwner`
   * REPLACES the capture set it owns — in the same atomic step as its
   * response overwrite — so a capture and `{{name.response…}}` always come
   * from the SAME last run (issue #47 review B4/F2). A DIFFERENT exchange
   * recording a name it does not own is a duplicate error.
   */
  owner: string | undefined;
}

export interface CaptureRecordResult {
  /** Index into the input array this result refers to. */
  index: number;
  name: string;
  /** True when this entry's value is what the store now holds for `name`. */
  stored: boolean;
  /** Rejection diagnostic when `stored` is false. */
  diagnostic?: string;
}

/** Options for `recordCaptures`; defaults keep the pure-append + reject shape. */
export interface RecordCapturesOptions {
  /** The `# @name` that owns this recording (undefined = unnamed). */
  owner?: string;
  /**
   * When true (named exchange re-record): the owner's previously stored
   * captures are REMOVED first, then this call's valid entries are stored
   * (first-wins within the call). A capture whose directive failed this
   * run therefore disappears instead of serving stale data (F2).
   * When false: owner-refresh only replaces a capture this owner already
   * owns; anything else collides.
   */
  replaceOwner?: boolean;
}

export interface ChainStore {
  recordRequest(name: string, record: ChainRequestRecord): void;
  recordResponse(name: string, record: ChainResponseRecord): void;
  getRequest(name: string): ChainRequestRecord | undefined;
  getResponse(name: string): ChainResponseRecord | undefined;
  recordedNames(): string[];
  /**
   * Store capture results for the run with per-entry outcomes
   * (`CaptureRecordResult[]`): every input index gets a result, `stored:
   * true` means the store now holds THIS entry's value for that name
   * (first-wins within the call; later duplicates are rejected). Invalid
   * names are rejected. Dedup/refresh is owner-scoped per
   * `RecordCapturesOptions` (see `StoredCapture` / `replaceOwner`).
   */
  recordCaptures(
    captures: readonly AppliedCapture[],
    options?: RecordCapturesOptions,
  ): CaptureRecordResult[];
  getCapture(name: string): CaptureRecord | undefined;
  captureNames(): string[];
  /**
   * Secret provenance hints (issue #47 review S4/L1): serialized values of
   * `secret`-flagged captures whose evaluation succeeded but whose STORE
   * was rejected (cross-owner/within-call duplicate). The exchange's
   * response is still recorded, so a later direct reference into it can
   * carry the rejected secret onto the wire — `prepareChainSend` sweeps
   * these values exactly like stored secret captures. Bounded, in memory
   * only, cleared with the store.
   */
  secretProvenance(): Array<{ name: string; value: string }>;
  clear(): void;
}

/**
 * Deep-copy a capture value defensively on store/retrieve. Uses structured
 * clone where available for JSON-shaped data; primitives and anything
 * structuredClone rejects (functions, symbols, class instances) are stored
 * by reference — captures come from `applyCapture`, whose values are
 * always JSON-parsed document fragments.
 */
function cloneCaptureValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * The store's duplicate-capture diagnostic, in one shared place so the
 * recording stage can reliably identify which captures were rejected.
 * Capture names match `NAME_RE` (no apostrophes), so `duplicateCaptureNameOf`
 * round-trips exactly.
 */
const DUPLICATE_CAPTURE_PREFIX = "duplicate capture name '";

export function duplicateCaptureDiagnostic(name: string): string {
  return `${DUPLICATE_CAPTURE_PREFIX}${name}' (captures must be unique per run)`;
}

/** The capture name a duplicate diagnostic refers to, or `undefined`. */
export function duplicateCaptureNameOf(diagnostic: string): string | undefined {
  if (!diagnostic.startsWith(DUPLICATE_CAPTURE_PREFIX)) return undefined;
  const end = diagnostic.indexOf("'", DUPLICATE_CAPTURE_PREFIX.length);
  return end === -1 ? undefined : diagnostic.slice(DUPLICATE_CAPTURE_PREFIX.length, end);
}

/** Cap on retained secret-provenance hints per run (hostile capture flood). */
export const MAX_SECRET_PROVENANCE = 64;

/**
 * Create an empty per-run chain store. Names are matched case-sensitively
 * (they are identifiers); response headers are matched case-insensitively.
 * Nothing here persists to disk and no values are treated as secrets by the
 * store itself — redaction is the caller's responsibility (see `secret`
 * flags on captures). Getters return defensive copies (capture values are
 * deep-copied for JSON-shaped data) so a caller mutating a returned record
 * can never rewrite stored history.
 */
export function createChainStore(): ChainStore {
  const requests = new Map<string, ChainRequestRecord>();
  const responses = new Map<string, ChainResponseRecord>();
  const captures = new Map<string, StoredCapture>();
  // Rejected-but-evaluated SECRET captures (issue #47 review S4/L1). The
  // exchange response IS recorded even when the capture store rejects the
  // name, so the value can return via a direct response reference; we keep
  // the serialized value as a redaction hint. In memory only, bounded.
  const secretProvenance: Array<{ name: string; value: string }> = [];
  const noteSecretRejected = (cap: AppliedCapture): void => {
    if (!cap.secret) return;
    const value = serializeValue(cap.value);
    if (value === '') return;
    if (secretProvenance.some((p) => p.name === cap.name && p.value === value)) return;
    if (secretProvenance.length >= MAX_SECRET_PROVENANCE) return;
    secretProvenance.push({ name: cap.name, value });
  };
  return {
    recordRequest(name, record) {
      requests.set(name, { body: record.body });
    },
    recordResponse(name, record) {
      // Copy defensively so later caller mutations cannot rewrite history.
      responses.set(name, {
        status: record.status,
        headers: { ...record.headers },
        body: record.body,
      });
    },
    getRequest(name) {
      const rec = requests.get(name);
      return rec ? { body: rec.body } : undefined;
    },
    getResponse(name) {
      const rec = responses.get(name);
      return rec ? { status: rec.status, headers: { ...rec.headers }, body: rec.body } : undefined;
    },
    recordedNames() {
      return [...responses.keys()];
    },
    recordCaptures(capturesToStore, options) {
      const results: CaptureRecordResult[] = [];
      const owner = options?.owner;
      const replace = options?.replaceOwner === true && owner !== undefined;
      // Replace-first: a named re-record removes EVERY capture this owner
      // held before storing anything, so a directive that failed (or was
      // removed) this run cannot leave a stale value disagreeing with the
      // fresh response (issue #47 review F2). Unnamed recordings never
      // replace anything.
      if (replace) {
        for (const [name, rec] of captures) {
          if (rec.owner === owner) captures.delete(name);
        }
      }
      const batchSeen = new Set<string>();
      capturesToStore.forEach((cap, index) => {
        if (!isValidChainName(cap.name)) {
          noteSecretRejected(cap);
          results.push({
            index,
            name: cap.name,
            stored: false,
            // clipped echo + length cap message (issue #47 review r7 S6)
            diagnostic: `Invalid capture name '${clipName(cap.name)}' (must start with a letter or underscore; letters, digits, underscore only; max ${MAX_CHAIN_NAME_LENGTH} chars)`,
          });
          return;
        }
        const existing = captures.get(cap.name);
        // Owner-scoped refresh: only a NAMED exchange may refresh captures
        // it originally recorded (never undefined === undefined — unnamed
        // exchanges can never co-opt or refresh, they only collide). Within
        // one call, a repeated name is still a duplicate regardless of owner.
        const refreshesOwn =
          owner !== undefined &&
          !batchSeen.has(cap.name) &&
          existing !== undefined &&
          existing.owner === owner;
        if (!refreshesOwn && (existing !== undefined || batchSeen.has(cap.name))) {
          noteSecretRejected(cap);
          results.push({
            index,
            name: cap.name,
            stored: false,
            diagnostic: duplicateCaptureDiagnostic(cap.name),
          });
          return;
        }
        batchSeen.add(cap.name);
        captures.set(cap.name, {
          value: cloneCaptureValue(cap.value),
          secret: cap.secret,
          owner,
        });
        results.push({ index, name: cap.name, stored: true });
      });
      return results;
    },
    getCapture(name) {
      const rec = captures.get(name);
      return rec ? { value: cloneCaptureValue(rec.value), secret: rec.secret } : undefined;
    },
    captureNames() {
      return [...captures.keys()];
    },
    secretProvenance() {
      return secretProvenance.map((p) => ({ name: p.name, value: p.value }));
    },
    clear() {
      requests.clear();
      responses.clear();
      captures.clear();
      secretProvenance.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ChainDiagnostic {
  /** The full `{{...}}` reference text. */
  reference: string;
  /** The inner reference, e.g. `login.response.body.$.token`. */
  variable: string;
  message: string;
}

export interface ResolvedCapture {
  /** Capture name that was substituted. */
  name: string;
  /** The exact text substituted into the request. */
  value: string;
  /** Whether the capture was declared `secret` (redaction boundary input). */
  secret: boolean;
}

export interface ChainSubstituteResult {
  text: string;
  diagnostics: ChainDiagnostic[];
  /**
   * Capture-name references (`{{captureName}}`) that were substituted in
   * this pass, with provenance. Adapters use `secret` entries to keep
   * secret capture values out of derived/rendered surfaces.
   */
  resolvedCaptures: ResolvedCapture[];
}

/**
 * Hard bound on how many chain references one resolution pass will act on.
 * Overflow references stay literal (with one diagnostic) so hostile text
 * cannot amplify work to O(references x body size).
 */
export const MAX_CHAIN_REFS_PER_PASS = 100;

export function serializeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? 'null';
}

function lookupHeader(headers: Record<string, string>, wanted: string): string | undefined {
  const lowered = wanted.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lowered) return value;
  }
  return undefined;
}

/**
 * Per-pass resolution context: caches parsed JSON bodies (each recorded body
 * is parsed at most once per pass) and enforces the reference bound.
 */
interface ResolutionContext {
  store: ChainStore;
  jsonCache: Map<string, { ok: true; doc: unknown } | { ok: false }>;
  chainRefs: number;
  /** Placeholder-CANDIDATE budget shared across every field of one request
   * pass (issue #47 review r9 LOGIC2): spreading junk `{{}}` candidates
   * across URL/headers/body cannot reset the bound field by field. */
  scanBudget: number;
  boundDiagPosted: boolean;
  resolvedCaptures: ResolvedCapture[];
}

function createResolutionContext(store: ChainStore): ResolutionContext {
  return {
    store,
    scanBudget: MAX_CHAIN_REFS_PER_PASS,
    jsonCache: new Map(),
    chainRefs: 0,
    boundDiagPosted: false,
    resolvedCaptures: [],
  };
}

function parsedBody(
  ctx: ResolutionContext,
  key: string,
  raw: string,
): { ok: true; doc: unknown } | { ok: false } {
  const cached = ctx.jsonCache.get(key);
  if (cached) return cached;
  let result: { ok: true; doc: unknown } | { ok: false };
  try {
    result = { ok: true, doc: JSON.parse(raw) };
  } catch {
    result = { ok: false };
  }
  ctx.jsonCache.set(key, result);
  return result;
}

/**
 * Classify a `{{...}}` inner reference for `store`:
 *  - a valid chain reference -> `{ ref }`
 *  - a malformed chain reference bound to a RECORDED name -> `{ malformed }`
 *    with an actionable message (fails loudly, never silently passed to env)
 *  - anything else -> `null` (ordinary env/built-in reference, passed through)
 *
 * Chain intent is recognized by EXACT namespace segments:
 * `<name>.response.…` / `<name>.request.…` where `<name>` has a recorded
 * entry under that namespace. Any non-valid remainder then produces a
 * diagnostic (missing part, empty/doubled dots, unknown part, bad path),
 * so `login.response`, `login.response.`, `login.response..status`, and
 * `login.response.1bad` can never hide as env variables. A segment like
 * `responseX` is NOT a namespace, so `login.responseX` stays an ordinary
 * dotted env name.
 */
export function classifyChainReference(
  inner: string,
  store: ChainStore,
): { ref: ChainReference } | { malformed: string } | null {
  const ref = parseChainReference(inner);
  if (ref !== null) return { ref };

  const firstDot = inner.indexOf('.');
  if (firstDot <= 0) return null;
  const name = inner.slice(0, firstDot);
  if (!NAME_RE.test(name)) return null;
  // Over-long names cannot be recorded (isValidChainName), so this can
  // never be chain intent — pass it through as an ordinary env name
  // instead of building an unbounded malformed diagnostic (r7 S6).
  if (name.length > MAX_CHAIN_NAME_LENGTH) return null;
  const rest = inner.slice(firstDot + 1);
  const ns = CHAIN_NAMESPACES.find((n) => rest === n || rest.startsWith(`${n}.`));
  if (ns === undefined) return null;

  const recorded = ns === 'response' ? store.getResponse(name) : store.getRequest(name);
  if (recorded === undefined) return null; // indistinguishable from a dotted env-var name

  const remainder = rest.slice(ns.length + 1); // text after `<name>.<ns>.`
  const expected =
    ns === 'request'
      ? `'${name}.request.body.$.path'`
      : `'${name}.response.status' | '${name}.response.headers.<Header-Name>' | '${name}.response.body.$.path'`;
  if (ns === 'request') {
    if (remainder === '' ) {
      return { malformed: `request chaining needs a body path: expected ${expected} (got '${inner}')` };
    }
    const part = remainder.split('.')[0];
    if (part !== 'body') {
      return { malformed: `request chaining only supports 'body' (got '${inner}'; expected ${expected})` };
    }
    return { malformed: `request body reference needs a JSONPath starting with '$': '${inner}'` };
  }
  if (remainder === '') {
    return { malformed: `response reference missing a part: expected ${expected} (got '${inner}')` };
  }
  const part = remainder.split('.')[0];
  if (part === '') {
    return { malformed: `empty chain part in '${inner}' (expected ${expected})` };
  }
  if (part === 'status') {
    return { malformed: `'${name}.response.status' takes no sub-path (got '${inner}')` };
  }
  if (part === 'headers') {
    return { malformed: `header reference missing a header name: '${inner}' (expected '${name}.response.headers.<Header-Name>')` };
  }
  if (part === 'body') {
    return { malformed: `response body reference needs a JSONPath starting with '$': '${inner}'` };
  }
  return {
    malformed: `unknown chain part '${part}' for '${name}.response' (expected ${expected})`,
  };
}

function resolveReference(ref: ChainReference, ctx: ResolutionContext): { value: string } | { error: string } {
  const { store } = ctx;
  if (ref.kind === 'request') {
    const rec = store.getRequest(ref.requestName);
    if (!rec) {
      return { error: `no recorded request named '${ref.requestName}' (run it first via a named file run)` };
    }
    const parsed = parsedBody(ctx, `req:${ref.requestName}`, rec.body);
    if (!parsed.ok) {
      return { error: `recorded request body for '${ref.requestName}' is not valid JSON` };
    }
    const q = queryJsonPath(parsed.doc, ref.path);
    if (!q.found) return { error: q.error };
    return { value: serializeValue(q.value) };
  }

  const rec = store.getResponse(ref.requestName);
  if (!rec) {
    return { error: `no recorded response for '${ref.requestName}' (send a request named '${ref.requestName}' first)` };
  }
  if (ref.part === 'status') return { value: String(rec.status) };
  if (ref.part === 'headers') {
    const v = lookupHeader(rec.headers, ref.headerName);
    if (v === undefined) {
      return { error: `no header '${ref.headerName}' in recorded response for '${ref.requestName}'` };
    }
    return { value: v };
  }
  const parsed = parsedBody(ctx, `resp:${ref.requestName}`, rec.body);
  if (!parsed.ok) {
    return { error: `recorded response body for '${ref.requestName}' is not valid JSON` };
  }
  const q = queryJsonPath(parsed.doc, ref.path);
  if (!q.found) return { error: q.error };
  return { value: serializeValue(q.value) };
}

/**
 * Scan `source` for `{{ ... }}` placeholders.
 *
 * Rules (fail-closed):
 *  - A candidate opens at `{{` and must close at the first top-level `}}`.
 *  - Quote mode is entered ONLY for a quote at a JSONPath `[` opener
 *    position (`[` + optional spaces + quote); a bare apostrophe in an
 *    env/header name (e.g. `X-O'Brien`) does NOT start a quoted span and
 *    cannot affect the `}}` terminator.
 *  - Inside a real quoted span ONLY the matching quote character closes it,
 *    so a JSON key may contain `]`, `}`, or even `}}`. An unterminated
 *    quoted span runs to end-of-input: the ENTIRE remaining text is
 *    abandoned (returned as untouched text, never rescanned).
 *  - A lone `}` inside a candidate (e.g. `{a}…`) abandons the candidate:
 *    scanning resumes AFTER the next `}}` terminator (or at end of input),
 *    so a placeholder nested inside the abandoned region can never resolve.
 *    The abandoned region is emitted byte-identically.
 *  - Empty placeholders (`{{}}`) are skipped and emitted verbatim.
 */
interface Placeholder {
  start: number;
  end: number;
  full: string;
  inner: string;
}

function nextDoubleBrace(source: string, from: number): number {
  for (let k = Math.max(from, 0); k < source.length - 1; k++) {
    if (source[k] === '}' && source[k + 1] === '}') return k;
  }
  return -1;
}

function findPlaceholders(
  source: string,
  maxCount: number,
): { list: Placeholder[]; truncated: boolean; last: Placeholder | null; opened: number } {
  const out: Placeholder[] = [];
  let last: Placeholder | null = null;
  let opened = 0;
  let i = 0;
  while (i < source.length - 1) {
    if (!(source[i] === '{' && source[i + 1] === '{')) {
      i += 1;
      continue;
    }
    // Bound counts EVERY opened candidate (issue #47 review r7 LOGIC2):
    // empty (`{{}}`) and abandoned (`{{a}`) candidates are hostile scan
    // work too and must consume the budget, or the bound is bypassable
    // behind a wall of junk placeholders. Stop scanning entirely at the
    // bound — the caller emits the remaining source verbatim, matching the
    // "left literal" overflow semantics of MAX_CHAIN_REFS_PER_PASS.
    if (opened >= maxCount) {
      return { list: out, truncated: true, last, opened };
    }
    opened += 1;
    // Candidate opened at i. Scan for the first top-level `}}`.
    let j = i + 2;
    let closed = -1;
    let abandoned = false;
    while (j < source.length) {
      const c = source[j];
      if (c === '}') {
        if (source[j + 1] === '}') {
          closed = j;
          break;
        }
        // lone `}` — not valid placeholder content; abandon candidate
        abandoned = true;
        break;
      }
      if (c === '[') {
        // possible JSONPath quoted key: '[' + optional spaces + quote
        let k = j + 1;
        while (k < source.length && source[k] === ' ') k += 1;
        const q = source[k];
        if (q === "'" || q === '"') {
          // Only the matching quote closes the span; `]`, `}`, `}}` are
          // ordinary key characters inside it.
          let m = k + 1;
          while (m < source.length && source[m] !== q) m += 1;
          if (m >= source.length) {
            // Unterminated quoted span reaches EOF: abandon through the end
            // of input. Advance j so recovery cannot resume after a nested
            // `}}` inside the still-open span.
            j = m;
            abandoned = true;
            break;
          }
          j = m + 1; // past the closing quote; `]` follows in the key text
          continue;
        }
        j = k; // plain subscript; continue scanning from after '['
        continue;
      }
      j += 1;
    }
    if (abandoned) {
      if (closed < 0 && j >= source.length) {
        // unterminated quoted span consumed everything
        break;
      }
      // Skip the whole abandoned region: resume after the next `}}`
      // terminator at/after the abandon point. Never resume INSIDE the
      // region — a nested placeholder there must not resolve.
      const term = nextDoubleBrace(source, j);
      i = term < 0 ? source.length : term + 2;
      continue;
    }
    if (closed < 0) {
      break; // unclosed candidate: nothing left that can resolve
    }
    const inner = source.slice(i + 2, closed).trim();
    if (inner.length > 0) {
      const ph = { start: i, end: closed + 2, full: source.slice(i, closed + 2), inner };
      out.push(ph);
      last = ph;
    }
    i = closed + 2;
  }
  return { list: out, truncated: false, last, opened };
}

/**
 * Substitute every chain reference in `source` using `store`. Non-chain
 * references are left untouched (with no diagnostics) so the ordinary
 * env/built-in substitution pass can process them later. Unresolved chain
 * references (and malformed chain references bound to a RECORDED name) are
 * reported as diagnostics and left in place so requests fail loudly instead
 * of silently sending a literal `{{...}}`. At most
 * MAX_CHAIN_REFS_PER_PASS references are acted on per pass; the overflow is
 * left literal with one diagnostic.
 */
export function resolveChainText(source: string, store: ChainStore): ChainSubstituteResult {
  return resolveChainTextWith(createResolutionContext(store), source);
}

function resolveChainTextWith(ctx: ResolutionContext, source: string): ChainSubstituteResult {
  const diagnostics: ChainDiagnostic[] = [];
  const captureStart = ctx.resolvedCaptures.length;
  // Scan bound (issue #47 review L2): placeholder DISCOVERY is bounded too,
  // so a hostile body's work/memory is O(bound) rather than O(body).
  // Remaining text after the bound is emitted verbatim, matching the
  // "left literal" overflow semantics of MAX_CHAIN_REFS_PER_PASS.
  // Spend from the SHARED per-pass candidate budget (r9 LOGIC2).
  const budget = Math.max(0, ctx.scanBudget);
  const scan = findPlaceholders(source, budget);
  ctx.scanBudget = budget - scan.opened;
  const placeholders = scan.list;
  if (placeholders.length === 0) {
    // Even with nothing listable, the candidate bound can already be hit
    // (all-empty/abandoned junk) — report it once (issue #47 r7 LOGIC2).
    if (scan.truncated && !ctx.boundDiagPosted) {
      ctx.boundDiagPosted = true;
      diagnostics.push({
        reference: '',
        variable: '',
        message: `Too many placeholder candidates in one pass (limit ${MAX_CHAIN_REFS_PER_PASS} scanned); remainder left literal`,
      });
    }
    return { text: source, diagnostics, resolvedCaptures: ctx.resolvedCaptures.slice(captureStart) };
  }

  let out = '';
  let cursor = 0;
  for (const ph of placeholders) {
    out += source.slice(cursor, ph.start);
    cursor = ph.end;

    const classified = classifyChainReference(ph.inner, ctx.store);
    if (classified === null) {
      // Capture-name reference: `{{token}}` where `token` was captured this
      // run. Resolution is single-pass, so this only ever sees captures
      // recorded BEFORE this send (never captures from the response being
      // prepared). A bound capture shadows a same-named env variable —
      // documented precedence; unresolved names stay silent (env stage owns
      // them).
      const capture = NAME_RE.test(ph.inner) ? ctx.store.getCapture(ph.inner) : undefined;
      if (capture !== undefined) {
        if (ctx.chainRefs >= MAX_CHAIN_REFS_PER_PASS) {
          if (!ctx.boundDiagPosted) {
            ctx.boundDiagPosted = true;
            diagnostics.push({
              reference: bounded(ph.full),
              variable: bounded(ph.inner),
              message: `Too many chain references in one pass (limit ${MAX_CHAIN_REFS_PER_PASS}); remaining chain references left literal`,
            });
          }
          out += ph.full;
          continue;
        }
        ctx.chainRefs += 1;
        const value = serializeValue(capture.value);
        const resolved: ResolvedCapture = {
          name: ph.inner,
          value,
          secret: capture.secret,
        };
        ctx.resolvedCaptures.push(resolved);
        out += value;
        continue;
      }
      out += ph.full; // ordinary env/built-in reference
      continue;
    }
    if (ctx.chainRefs >= MAX_CHAIN_REFS_PER_PASS) {
      if (!ctx.boundDiagPosted) {
        ctx.boundDiagPosted = true;
        diagnostics.push({
          reference: bounded(ph.full),
          variable: bounded(ph.inner),
          message: `Too many chain references in one pass (limit ${MAX_CHAIN_REFS_PER_PASS}); remaining chain references left literal`,
        });
      }
      out += ph.full;
      continue;
    }
    ctx.chainRefs += 1;

    if ('malformed' in classified) {
      diagnostics.push({
        reference: bounded(ph.full),
        variable: bounded(ph.inner),
        message: bounded(classified.malformed),
      });
      out += ph.full;
      continue;
    }
    const resolved = resolveReference(classified.ref, ctx);
    if ('error' in resolved) {
      diagnostics.push({
        reference: bounded(ph.full),
        variable: bounded(ph.inner),
        message: bounded(resolved.error),
      });
      out += ph.full;
      continue;
    }
    out += resolved.value;
  }
  out += source.slice(cursor);
  if (scan.truncated && !ctx.boundDiagPosted) {
    ctx.boundDiagPosted = true;
    // An all-empty/abandoned candidate list has no placeholder to echo;
    // report the bound generically (issue #47 review r7 LOGIC2).
    const anchor = scan.last;
    diagnostics.push(
      anchor !== null
        ? {
            reference: bounded(anchor.full),
            variable: bounded(anchor.inner),
            message: `Too many placeholders in one pass (limit ${MAX_CHAIN_REFS_PER_PASS} scanned); remainder left literal`,
          }
        : {
            reference: '',
            variable: '',
            message: `Too many placeholder candidates in one pass (limit ${MAX_CHAIN_REFS_PER_PASS} scanned); remainder left literal`,
          },
    );
  }
  return {
    text: out,
    diagnostics,
    resolvedCaptures: ctx.resolvedCaptures.slice(captureStart),
  };
}

export interface ChainRequestInput {
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: string;
}

export interface ChainRequestResult {
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: string;
  diagnostics: ChainDiagnostic[];
  /** Capture substitutions made across url, headers, and body. */
  resolvedCaptures: ResolvedCapture[];
}

/** Resolve chain references across a request's url, header values, and body. */
export function resolveChainRequest(
  req: ChainRequestInput,
  store: ChainStore,
): ChainRequestResult {
  const diagnostics: ChainDiagnostic[] = [];
  const ctx = createResolutionContext(store);
  const run = (text: string): string => {
    const r = resolveChainTextWith(ctx, text);
    for (const d of r.diagnostics) diagnostics.push(d);
    return r.text;
  };
  const url = run(req.url);
  const headers = req.headers.map((h) => ({ name: h.name, value: run(h.value) }));
  const body = run(req.body);
  return { url, headers, body, diagnostics, resolvedCaptures: ctx.resolvedCaptures };
}

// ---------------------------------------------------------------------------
// `# @name` validation
// ---------------------------------------------------------------------------

/**
 * Validate `# @name` identifiers across one file: alnum + underscore,
 * length-bounded, and unique per file (issue #47). Returns human-readable
 * diagnostics with clipped identifier echoes (review S6).
 */
export function validateRequestNames(names: readonly string[]): string[] {
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!isValidChainName(name)) {
      diagnostics.push(
        `Invalid request name '${clipName(name)}' (must start with a letter or underscore; letters, digits, underscore only; max ${MAX_CHAIN_NAME_LENGTH} chars)`,
      );
      continue;
    }
    if (seen.has(name)) {
      diagnostics.push(`duplicate request name '${clipName(name)}' (names must be unique per file)`);
      continue;
    }
    seen.add(name);
  }
  return diagnostics;
}
