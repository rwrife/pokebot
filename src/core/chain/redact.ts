/**
 * Shared secret-text redaction primitive (issue #47).
 *
 * One implementation for every derived surface: the VS Code render echo,
 * the recorded chain request body, clipboard/cURL output, and future CLI
 * reports. Adapters must not fork this behavior.
 */

/**
 * Replace every occurrence of each provided secret value in `text` with a
 * safe marker. The preferred marker is used unless it contains an active
 * secret; in that case a deterministic secret-free fallback is selected.
 *
 * - Every secret contributes two candidate forms: the raw value and its
 *   JSON-escaped form (`# @graphql` bodies are re-serialized as JSON, so a
 *   secret containing `"`/newlines crosses derived surfaces escaped as
 *   `sec\"ret`; issue #47 review F1).
 * - ALL forms across ALL secrets are masked longest-first: if any form is a
 *   prefix of another form (raw-vs-raw, raw-vs-escaped, escaped-vs-escaped),
 *   masking the shorter first would expose the longer one's tail as a
 *   remnant (issue #47 review F1 + round-3 suggestion).
 * - Empty values are ignored; order within equal lengths is stable.
 */
/**
 * Build a reusable masking function over a fixed secret set (issue #47
 * review S2): the cURL renderer and every other derived-surface adapter must
 * share these exact semantics — raw + JSON-escaped forms, longest form first
 * — so no surface can mask weaker than the canonical render echo. Only the
 * placeholder token differs per surface.
 */
/**
 * Pick a replacement marker that provably does NOT contain any candidate
 * secret (issue #47 review r9 SEC2). A fixed `[REDACTED]` marker re-exposes
 * the secret when the secret is a substring of the marker (e.g. secret
 * "RED" or "REDACTED") — the replacement would reintroduce the very text it
 * just removed. When the preferred marker is safe it is used unchanged;
 * otherwise a deterministic, secret-free marker is chosen.
 */
function pickSafePlaceholder(preferred: string, secrets: readonly string[]): string {
  const active = [...new Set(secrets.filter((s) => s.length > 0))];
  const containsAnySecret = (candidate: string): boolean =>
    active.some((secret) => candidate.includes(secret));
  if (!containsAnySecret(preferred)) return preferred;

  // Prefer short punctuation-like markers that are unlikely to overlap real
  // secrets. Keep trying until one provably excludes every active secret.
  const symbolCandidates = ['###', '***', '???', '~~~', '^^^', '^^', '##', '**'];
  for (const marker of symbolCandidates) {
    if (!containsAnySecret(marker)) return marker;
  }

  // Final bounded search in the Private Use Area for a marker absent from
  // all secrets. This stays deterministic and avoids alphanumeric remnants.
  for (let cp = 0xe000; cp <= 0xf8ff; cp += 1) {
    const marker = String.fromCodePoint(cp).repeat(3);
    if (!containsAnySecret(marker)) return marker;
  }

  // Degenerate fallback: no non-empty marker can satisfy the invariant when
  // the secret set contains every character available to the marker. Deletion
  // is the only universally safe replacement for non-empty secrets.
  return '';
}

export function secretRedactor(
  secrets: readonly string[],
  placeholder = '[REDACTED]',
): (text: string) => string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    forms.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) forms.add(escaped);
  }
  const replacement = pickSafePlaceholder(placeholder, [...forms]);
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const form of ordered) {
      out = out.split(form).join(replacement);
    }
    // Replacement can create a NEW active secret across marker boundaries
    // (r10b SEC1, e.g. replacing X in `aX` can create `a[` when `a[` is
    // another secret). Returning an empty derived surface is safer than
    // recursively rewriting attacker-controlled text or leaking a secret.
    if (ordered.some((form) => out.includes(form))) return '';
    return out;
  };
}

export function redactSecretText(text: string, secrets: readonly string[]): string {
  return secretRedactor(secrets)(text);
}

/** Hard bound on DERIVED variants added per deriveSecretVariants() call
 * (hostile self-referencing templates). The budget is shared but FAIRLY
 * divided across base secrets (issue #47 review r9): a flood expanding one
 * secret can truncate THAT secret's closure (reported via `truncated`) but
 * can never starve a later base secret — every base always appears in the
 * output, and every base gets its own closure pass with a reserved share of
 * the bound. Callers building a redaction set MUST fail closed on
 * `truncated === true` (an unexpanded variant may have reached the wire). */
export const MAX_DERIVED_ADDITIONS = 256;

export interface SecretVariantClosure {
  /** Union of every base secret and every derived variant. Always contains
   * every non-empty base secret, truncation or not. */
  variants: string[];
  /** True when at least one base secret's expansion was cut off by the
   * bound. Derived-surface adapters must refuse to send/export when this is
   * set and any secret is in play (r9 fail-closed rule). */
  truncated: boolean;
  /** Per-base closure (aligned with the non-empty input order), for tests
   * and diagnostics. */
  perBase: Array<{ base: string; variants: string[]; truncated: boolean }>;
}

/**
 * Expand a set of known-secret strings through the substitutions the env
 * stage actually performed (issue #47 review S5 + LOGIC1 + r9).
 *
 * A secret may itself be a template (`prefix{{inner}}suffix`) whose embedded
 * reference the env stage expanded — what reached the wire is the FULL
 * derived value, and masking only the injected component left
 * `prefix[REDACTED]suffix` (or, for an empty expansion, the entire secret
 * unmasked). For every base secret this closure returns the base itself,
 * each injected VALUE whose reference text appears inside a known variant
 * (empty expansions contribute nothing), and every expansion variant.
 *
 * Expansion runs as a FIFO of one-PASS substitutions per queued variant:
 * each variant has ALL participating substitutions applied at once (matching
 * how `substitute()` produces wire text), then the result is re-queued, so
 * chains of any length (`{{a}}` → `z{{b}}z` → `zQz`) reach their final wire
 * form. The additions bound (MAX_DERIVED_ADDITIONS) is divided fairly across
 * base secrets so one hostile self-referencing template terminates and
 * reports `truncated` without starving the remaining bases (r9).
 */
export function deriveSecretVariants(
  secrets: readonly string[],
  injected: ReadonlyArray<{ reference: string; value: string }>,
): SecretVariantClosure {
  const bases = [...new Set(secrets.filter((s) => s.length > 0))];
  const perBase: SecretVariantClosure['perBase'] = [];
  const out = new Set<string>(bases);
  let additions = 0;
  const share = Math.max(1, Math.floor(MAX_DERIVED_ADDITIONS / Math.max(1, bases.length)));
  let anyTruncated = false;

  for (const base of bases) {
    const local = new Set<string>([base]);
    let localAdditions = 0;
    const queue = [base];
    let truncated = false;
    const addVariant = (value: string): boolean => {
      if (value === '' || local.has(value)) return true;
      // Enforce both bounds at EACH insertion. Checking only between queue
      // iterations let one high-fanout variant add hundreds before the cap
      // was observed (issue #47 review r9 SEC1).
      if (localAdditions >= share || additions >= MAX_DERIVED_ADDITIONS) {
        truncated = true;
        return false;
      }
      local.add(value);
      out.add(value);
      queue.push(value);
      localAdditions += 1;
      additions += 1;
      return true;
    };
    while (queue.length > 0) {
      if (localAdditions >= share || additions >= MAX_DERIVED_ADDITIONS) {
        break;
      }
      let variant = queue.shift()!;
      let changed = false;
      // References present in THIS variant's text before substitution; every
      // injected value for a participating reference reached the wire for
      // some ordering of repeated references and joins the set (empty
      // expansions contribute nothing).
      const participating = injected
        .map((inj) => inj.reference)
        .filter((ref) => ref !== '' && variant.includes(ref));
      for (const inj of injected) {
        if (!participating.includes(inj.reference)) continue;
        addVariant(inj.value);
        if (variant.includes(inj.reference)) {
          variant = variant.split(inj.reference).join(inj.value);
          changed = true;
        }
      }
      if (changed) addVariant(variant);
    }
    // Only report truncation if there are unexpanded variants in the queue
    // that actually have participating injections.
    if (queue.length > 0) {
      const hasUnexpandedWork = queue.some((variant) =>
        injected.some((inj) => inj.reference !== '' && variant.includes(inj.reference)),
      );
      if (hasUnexpandedWork) truncated = true;
    }
    anyTruncated = anyTruncated || truncated;
    perBase.push({ base, variants: [...local], truncated });
  }

  return { variants: [...out], truncated: anyTruncated, perBase };
}

/**
 * Scrub secret values from a body the chain store is about to RECORD
 * (issue #47 review r7 LOGIC3 + r11).
 *
 * The plain-text scrub (`redactSecretText`) can invalidate a JSON body: an
 * unquoted numeric/boolean/null secret becomes a bare `[REDACTED]` token and
 * breaks parsing of the WHOLE document, so every later
 * `{{name.request.body.$…}}` reference to an unrelated field would fail.
 * A secret that IS JSON syntax (e.g. `":"`) corrupts the text between two
 * tokens, so no textual masking can keep the document valid either.
 *
 * Contract (fail-closed, review r11): return a recorded-body string that is
 * BOTH valid JSON AND secret-free, or `null` to refuse the recording —
 * the caller must then record no request body at all rather than store
 * invalid or secret-bearing JSON. Non-JSON inputs have no parseability to
 * protect and keep the textual scrub (returned unchanged-safe string).
 *
 * For a parsed JSON document:
 *  - String leaves get the textual scrub (their substrings may carry
 *    secrets); object KEYS are scrubbed too.
 *  - Non-string scalar leaves (numbers/booleans/null) are replaced wholesale
 *    with a JSON string marker when their serialized form contains a secret,
 *    so secret rotation cannot re-expose a previously recorded value.
 *  - The structured re-serialization is the primary candidate even when a
 *    textual replacement happens to stay parseable — required to resolve
 *    masked-key collisions by the documented deterministic winner and to
 *    scrub secrets that exist only after JSON decoding.
 *  - Candidate order: structured serialization → re-redacted serialization
 *    (secret bytes materialized by escaping) → textual scrub of the source.
 *    The first candidate that re-parses AND contains no active secret wins.
 *  - When no candidate satisfies both invariants (a secret lives in the
 *    JSON STRUCTURE itself, e.g. between array items or between key and
 *    value), return `null`: refuse the recording instead of storing
 *    corruptible or leaky bytes.
 */
export function scrubRecordedBody(
  text: string,
  secrets: readonly string[],
): string | null {
  const active = secrets.filter((s) => s.length > 0);
  if (active.length === 0) return text;

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return redactSecretText(text, active);
  }

  const redact = secretRedactor(active);
  const scalarMarker = redact('[REDACTED]');
  const maskScalar = (value: unknown): unknown => {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized !== undefined && active.some((secret) => serialized.includes(secret))) {
      return scalarMarker;
    }
    return value;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return redact(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      type Pair = { sourceKey: string; maskedKey: string; value: unknown };
      const pairs: Pair[] = [];
      for (const k of Object.keys(node).sort()) {
        const v = (node as Record<string, unknown>)[k];
        pairs.push({ sourceKey: k, maskedKey: redact(k), value: walk(v) });
      }

      // For collisions on the masked key, keep one winner by a stable rule
      // independent of JS property enumeration: lexicographically-smallest
      // source key wins; ties keep the earliest source occurrence.
      const winner = new Map<string, Pair>();
      const sourceOrder = new Map<string, number>();
      pairs.forEach((pair, idx) => {
        if (!sourceOrder.has(pair.sourceKey)) sourceOrder.set(pair.sourceKey, idx);
        const cur = winner.get(pair.maskedKey);
        if (!cur) {
          winner.set(pair.maskedKey, pair);
          return;
        }
        if (pair.sourceKey < cur.sourceKey) {
          winner.set(pair.maskedKey, pair);
          return;
        }
        if (pair.sourceKey === cur.sourceKey) {
          const curIdx = sourceOrder.get(cur.sourceKey) ?? Number.MAX_SAFE_INTEGER;
          const newIdx = sourceOrder.get(pair.sourceKey) ?? Number.MAX_SAFE_INTEGER;
          if (newIdx < curIdx) winner.set(pair.maskedKey, pair);
        }
      });

      // Preserve __proto__ as inert own data, never as prototype mutation.
      const out: Record<string, unknown> = Object.create(null);
      for (const pair of pairs) {
        const keep = winner.get(pair.maskedKey);
        if (keep !== pair) continue;
        Object.defineProperty(out, pair.maskedKey, {
          value: pair.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return maskScalar(node);
  };
  const scrubbed = walk(doc);
  const textual = redactSecretText(text, active);
  // A candidate is recordable ONLY when it satisfies ALL invariants:
  // re-parses as JSON, contains none of the active secrets in its RAW
  // bytes, AND none in its DECODED content (issue #47 review r12: a
  // Unicode-escaped secret — e.g. \u0073 for "s" — never appears in the
  // raw text but JSON.parse materializes it, so a raw-byte-only check
  // would accept a body whose decoded values re-surface the secret to
  // later {{name.request.body.$…}} references). Partial acceptance
  // (valid-but-leaky or secret-free-but-broken) is exactly the r11/r12
  // failure class and must fall through, never be returned.
  const decodedClean = (node: unknown, seen: Set<unknown>): boolean => {
    if (typeof node === 'string') return !active.some((s) => node.includes(s));
    if (node === null || node === undefined) return true;
    if (seen.has(node)) return true; // JSON is acyclic; defensive only
    seen.add(node);
    if (Array.isArray(node)) {
      return node.every((item) => decodedClean(item, seen));
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (active.some((s) => k.includes(s))) return false;
        if (!decodedClean((node as Record<string, unknown>)[k], seen)) return false;
      }
      return true;
    }
    // Non-string scalar: references serialize it (String()), so a secret
    // appearing in its text form is as leaky as in a string leaf.
    return !active.some((s) => String(node).includes(s));
  };
  const recordable = (candidate: string): boolean => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (active.some((s) => candidate.includes(s))) return false;
      return decodedClean(parsed, new Set());
    } catch {
      return false;
    }
  };
  try {
    const serialized = JSON.stringify(scrubbed);
    if (recordable(serialized)) return serialized;
    // If serialization materialized secret bytes (e.g. escaped quotes),
    // redact the serialization itself and re-check BOTH invariants.
    const reRedacted = redactSecretText(serialized, active);
    if (recordable(reRedacted)) return reRedacted;
  } catch {
    // fall through to the textual candidate below
  }
  // Textual masking of the source may still be both valid and secret-free
  // even when the structured path failed (e.g. masked-key serialization
  // threw). It gets the same fail-closed verification as every candidate.
  if (recordable(textual)) return textual;
  // No candidate satisfies both invariants — the secret lives in the JSON
  // STRUCTURE itself (between key and value, between members). Refuse the
  // recording rather than store invalid or secret-bearing JSON (r11).
  return null;
}
