/**
 * Pure `{{var}}` substitution. No VS Code dependencies — unit-testable.
 *
 * Substitution rules:
 *   - `{{name}}`               → resolver(name) — env var or secret
 *   - `{{$guid}}`              → RFC 4122 v4 UUID
 *   - `{{$timestamp}}`         → unix seconds (UTC)
 *   - `{{$datetime iso}}`      → ISO-8601 UTC string
 *   - `{{$datetime rfc1123}}`  → RFC-1123 UTC string
 *   - `{{$randomInt min max}}` → integer in [min, max] inclusive
 *
 * Unresolved references are returned as diagnostics; the original `{{...}}`
 * text is left in place so the caller can decide whether to fail loudly or
 * forward verbatim.
 */

export interface SubstituteDiagnostic {
  /** The full reference, e.g. `{{baseUrl}}`. */
  reference: string;
  variable: string;
  message: string;
}

export interface SubstituteOptions {
  /** Resolve a plain variable name to its value, or `undefined` if missing. */
  resolve: (name: string) => string | undefined;
  /** Optional RNG override for deterministic tests. */
  random?: () => number;
  /** Optional clock override for deterministic tests. Returns ms since epoch. */
  now?: () => number;
}

export interface SubstituteResult {
  text: string;
  diagnostics: SubstituteDiagnostic[];
  /**
   * Every successful substitution this call made, up to
   * `MAX_INJECTED_RECORDS`: the literal reference text (e.g. `{{inner}}`
   * or `{{$guid}}`) and the value injected in its place. Adapters use
   * this for taint tracking (issue #47 review F1-R3): if a SECRET value
   * contains one of these reference texts, the injected value (env or
   * builtin — including random ones that cannot be recomputed) is what
   * actually reached the wire and must join the redaction set. One entry
   * PER OCCURRENCE (issue #47 review L3): repeated builtins like
   * `{{$guid}}` produce distinct values per occurrence, so dedup would
   * drop real wire values; the list is capped instead (issue #47 review
   * L2) so a hostile flood cannot grow adapter work without bound — the
   * substituted text itself is always complete.
   */
  injected: Array<{ reference: string; value: string }>;
  /**
   * True when recording stopped at `MAX_INJECTED_RECORDS` and at least one
   * substitution was NOT recorded. Adapters that build a secret taint
   * closure from `injected` MUST fail closed on this flag when any secret
   * is in play (issue #47 review r7 SEC1): an omitted entry could be the
   * expansion of a secret template, so the request is blocked rather than
   * sent with an incomplete redaction set.
   */
  injectedOverflow: boolean;
}

/**
 * Hard bound on recorded injections per call/result (issue #47 review L2).
 * The bound exists for the PROVENANCE list, not the substitution: text is
 * still substituted everywhere; recording stops once the cap is reached.
 */
export const MAX_INJECTED_RECORDS = 1000;

const REF_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function defaultRandom(): number {
  return Math.random();
}

function defaultNow(): number {
  return Date.now();
}

function randomHex(rand: () => number, bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i++) {
    const b = Math.floor(rand() * 256);
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/** RFC 4122 v4 UUID using the supplied RNG. */
export function makeUuidV4(rand: () => number = defaultRandom): string {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) bytes.push(Math.floor(rand() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatDatetime(now: Date, fmt: string | undefined): string {
  switch ((fmt ?? 'iso').toLowerCase()) {
    case 'iso':
      return now.toISOString();
    case 'rfc1123':
      return now.toUTCString();
    case 'unix':
      return Math.floor(now.getTime() / 1000).toString();
    default:
      // Unknown formats fall through to ISO so users see *something* useful.
      return now.toISOString();
  }
}

function evalBuiltin(
  expr: string,
  rand: () => number,
  now: () => number,
): { value: string } | { error: string } {
  // expr is the raw inner text after `$`, e.g. "guid" or "randomInt 1 10".
  const [head, ...rest] = expr.split(/\s+/);
  switch (head) {
    case 'guid':
    case 'uuid':
      return { value: makeUuidV4(rand) };
    case 'timestamp':
      return { value: Math.floor(now() / 1000).toString() };
    case 'datetime':
      return { value: formatDatetime(new Date(now()), rest[0]) };
    case 'randomInt': {
      const min = Number(rest[0]);
      const max = Number(rest[1]);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        return { error: `Invalid $randomInt args: "${rest.join(' ')}"` };
      }
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      const v = lo + Math.floor(rand() * (hi - lo + 1));
      return { value: v.toString() };
    }
    case 'randomHex': {
      const n = Number(rest[0] ?? '16');
      if (!Number.isFinite(n) || n <= 0 || n > 1024) {
        return { error: `Invalid $randomHex bytes: "${rest[0]}"` };
      }
      return { value: randomHex(rand, Math.floor(n)) };
    }
    default:
      return { error: `Unknown built-in: $${head}` };
  }
}

/** Substitute `{{...}}` references inside `source` using `opts.resolve`. */
export function substitute(source: string, opts: SubstituteOptions): SubstituteResult {
  const diagnostics: SubstituteDiagnostic[] = [];
  const injected: Array<{ reference: string; value: string }> = [];
  // Bounded recording (issue #47 review L2 + r7 SEC1): substitution always
  // completes, but provenance recording stops at MAX_INJECTED_RECORDS and
  // the overflow is FLAGGED so adapters fail closed on it.
  let injectedOverflow = false;
  const record = (reference: string, value: string): void => {
    if (injected.length < MAX_INJECTED_RECORDS) injected.push({ reference, value });
    else injectedOverflow = true;
  };
  const rand = opts.random ?? defaultRandom;
  const now = opts.now ?? defaultNow;

  const text = source.replace(REF_RE, (match, raw: string) => {
    const expr = raw.trim();
    if (expr.startsWith('$')) {
      const result = evalBuiltin(expr.slice(1), rand, now);
      if ('value' in result) {
        record(match, result.value);
        return result.value;
      }
      diagnostics.push({ reference: match, variable: expr, message: result.error });
      return match;
    }
    const resolved = opts.resolve(expr);
    if (resolved === undefined) {
      diagnostics.push({
        reference: match,
        variable: expr,
        message: `Unresolved variable: ${expr}`,
      });
      return match;
    }
    record(match, resolved);
    return resolved;
  });

  return { text, diagnostics, injected, injectedOverflow };
}

/** Convenience: substitute over a request's URL, header values, and body in one pass. */
export interface RequestSubstitutionInput {
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: string;
}

export interface RequestSubstitutionResult {
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: string;
  diagnostics: SubstituteDiagnostic[];
  /** Union of every successful substitution across url/headers/body,
   * capped at `MAX_INJECTED_RECORDS` across the whole request (review L2). */
  injected: Array<{ reference: string; value: string }>;
  /**
   * True when recording stopped at `MAX_INJECTED_RECORDS` and at least one
   * substitution was NOT recorded. Adapters that build a secret taint
   * closure from `injected` MUST fail closed on this flag when any secret
   * is in play (issue #47 review r7 SEC1): an omitted entry could be the
   * expansion of a secret template, so the request is blocked rather than
   * sent with an incomplete redaction set.
   */
  injectedOverflow: boolean;
}

export function substituteRequest(
  req: RequestSubstitutionInput,
  opts: SubstituteOptions,
): RequestSubstitutionResult {
  const diagnostics: SubstituteDiagnostic[] = [];
  const injected: Array<{ reference: string; value: string }> = [];
  // Overflow propagates when any stage dropped a recording OR the union
  // merge had to drop already-recorded per-stage entries (review r7 SEC1).
  let injectedOverflow = false;
  const push = (d: SubstituteDiagnostic[]): void => {
    for (const x of d) diagnostics.push(x);
  };
  const merge = (items: Array<{ reference: string; value: string }>): void => {
    for (const item of items) {
      if (injected.length >= MAX_INJECTED_RECORDS) {
        injectedOverflow = true;
        break;
      }
      injected.push(item);
    }
  };

  const url = substitute(req.url, opts);
  push(url.diagnostics);
  merge(url.injected);
  const headers = req.headers.map((h) => {
    const v = substitute(h.value, opts);
    push(v.diagnostics);
    merge(v.injected);
    if (v.injectedOverflow) injectedOverflow = true;
    return { name: h.name, value: v.text };
  });
  const body = substitute(req.body, opts);
  push(body.diagnostics);
  merge(body.injected);
  if (url.injectedOverflow || body.injectedOverflow) injectedOverflow = true;

  return { url: url.text, headers, body: body.text, diagnostics, injected, injectedOverflow };
}
