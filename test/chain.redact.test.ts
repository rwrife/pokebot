import { describe, expect, it } from 'vitest';
import { deriveSecretVariants, MAX_DERIVED_ADDITIONS, redactSecretText, scrubRecordedBody } from '../src/core/chain/redact.js';

/**
 * Unwrap helper: assert the scrub produced a RECORDABLE body (issue #47
 * review r11: `scrubRecordedBody` returns `null` when it cannot produce a
 * secret-free, JSON-valid recording — callers must then refuse to record).
 */
function scrubbed(text: string, secrets: readonly string[]): string {
  const out = scrubRecordedBody(text, secrets);
  expect(out, `expected a recordable scrub for ${text}`).not.toBeNull();
  return out as string;
}

/**
 * Shared redaction primitive (issue #47). These cases pin the masking
 * order across raw and JSON-escaped forms — the leak classes the review
 * rounds surfaced (prefix remnants and escaped-form misses).
 */
describe('redactSecretText', () => {
  it('masks every secret occurrence', () => {
    expect(redactSecretText('a=SECRET b=SECRET', ['SECRET'])).toBe(
      'a=[REDACTED] b=[REDACTED]',
    );
  });

  it('masks overlapping secrets longest-first with no prefix remnant', () => {
    const out = redactSecretText('x ovlap-longerval y ovlap z', ['ovlap', 'ovlap-longerval']);
    expect(out).not.toContain('longerval');
    expect(out).not.toContain('ovlap');
    expect(out).toContain('[REDACTED]');
  });

  it('masks the JSON-escaped form (graphql re-serialization)', () => {
    const SECRET = 'sek' + 'r"et';
    const escaped = JSON.stringify(SECRET).slice(1, -1); // sek\\"ret
    const out = redactSecretText(`{\\"token\\":\\"${escaped}\\"}`, [SECRET]);
    expect(out).not.toContain(escaped);
    expect(out).not.toContain(SECRET);
  });

  it('a raw form that prefixes another secret\'s escaped form leaves no remnant (G-R3)', () => {
    // SECRET_A raw is a prefix of SECRET_B's escaped form; masking A first
    // used to expose B's escaped tail.
    const A = 'shared';
    const B = 'shared"tail'; // escapes to shared\\"tail
    const out = redactSecretText(`pre ${JSON.stringify(B).slice(1, -1)} mid ${A} end`, [A, B]);
    expect(out).not.toContain('shared');
    expect(out).not.toContain('tail');
  });

  it('ignores empty secrets and returns input unchanged when none apply', () => {
    expect(redactSecretText('clean text', ['', 'absent'])).toBe('clean text');
  });

  it('never emits a replacement marker containing the secret itself', () => {
    for (const secret of ['RED', 'REDACTED', '[REDACTED]']) {
      const out = redactSecretText(`before ${secret} after`, [secret]);
      expect(out).not.toContain(secret);
    }
  });

  it('never creates a secret across a replacement-marker boundary', () => {
    // Replacing X with the default marker used to turn `aX` into
    // `a[REDACTED]`, thereby CREATING the other active secret `a[` —
    // the replacement text itself re-exposed a known secret (r10b SEC1).
    const secrets = ['a[', 'X'];
    const raw = 'aX';
    expect(raw).toContain('X'); // non-vacuity: the raw input holds the secret
    const out = redactSecretText(raw, secrets);
    for (const secret of secrets) expect(out).not.toContain(secret);
  });
});

describe('deriveSecretVariants (issue #47 review S5)', () => {
  it('derives the complete post-substitution secret, not just components', () => {
    // Secret template whose embedded reference the env stage expanded.
    // Masking only the injected component left `prefix[REDACTED]suffix`;
    // the complete derived value must mask as a whole.
    const { variants } = deriveSecretVariants(['prefix{{inner}}suffix'], [
      { reference: '{{inner}}', value: 'IN' },
    ]);
    expect(variants).toContain('prefix{{inner}}suffix');
    expect(variants).toContain('prefixINsuffix');
    const out = redactSecretText('wire: prefixINsuffix end', variants);
    expect(out).not.toContain('prefixINsuffix');
    expect(out).toContain('[REDACTED]');
  });

  it('masks the full derived secret when an expansion is EMPTY', () => {
    // inner → '' collapses the template to `prefixsuffix`, which contains
    // neither the template nor any injected component as a substring.
    const { variants } = deriveSecretVariants(['prefix{{inner}}suffix'], [
      { reference: '{{inner}}', value: '' },
    ]);
    expect(variants).toContain('prefixsuffix');
    const out = redactSecretText('wire=prefixsuffix&x=1', variants);
    expect(out).not.toContain('prefixsuffix');
  });

  it('expands repeated references with distinct builtin values (per-occurrence)', () => {
    const { variants } = deriveSecretVariants(['{{$guid}}+{{$guid}}'], [
      { reference: '{{$guid}}', value: 'g1' },
      { reference: '{{$guid}}', value: 'g2' },
    ]);
    // Both orders are possible wire strings; the closure only needs to
    // cover each single expansion and the template itself.
    expect(variants).toContain('{{$guid}}+{{$guid}}');
    const out = redactSecretText('a=g1+g2', variants);
    expect(out).not.toContain('g1');
    expect(out).not.toContain('g2');
  });

  it('applies chained expansions (reference inside an expansion value)', () => {
    const { variants } = deriveSecretVariants(['k={{a}}'], [
      { reference: '{{a}}', value: 'z{{b}}z' },
      { reference: '{{b}}', value: 'Q' },
    ]);
    expect(variants).toContain('k=z{{b}}z');
    expect(variants).toContain('k=zQz');
    const out = redactSecretText('send k=zQz', variants);
    expect(out).not.toContain('zQz');
  });

  it('returns exactly the base list when nothing was injected into a secret', () => {
    expect(deriveSecretVariants(['abc'], [{ reference: '{{other}}', value: 'x' }]).variants).toEqual([
      'abc',
    ]);
  });

  it('does not blow up on self-referencing expansions (bounded additions, reports truncation)', () => {
    const c = deriveSecretVariants(['{{a}}'], [{ reference: '{{a}}', value: 'q{{a}}' }]);
    // Bounded growth; must terminate and still contain the base + first expansions.
    expect(c.variants).toContain('{{a}}');
    expect(c.variants).toContain('q{{a}}');
    expect(c.variants).toContain('qq{{a}}');
    expect(c.variants.length).toBeLessThanOrEqual(1 + MAX_DERIVED_ADDITIONS);
    // Non-vacuity: growth WAS cut off — callers must fail closed on it.
    expect(c.truncated).toBe(true);
  });

  it('closes TWENTY-link chained expansions despite the derived cap (fixpoint, not 4 passes)', () => {
    // Reviewer round-7 LOGIC1: a fixed 4-pass loop (and an early return at
    // 32 total variants) silently stopped before the wire value on a
    // legitimate 20-link chain. The closure must run to its fixpoint —
    // the cap only bounds total DERIVED work, it must not strand a chain
    // that completes inside the bound.
    const injections = Array.from({ length: 20 }, (_, i) =>
      i === 19 ? { reference: `{{r19}}`, value: 'END' } : { reference: `{{r${i}}}`, value: `p{{r${i + 1}}` + '}' },
    );
    const { variants } = deriveSecretVariants(['V-{{r0}}'], injections);
    // 20 injections: links r0..r18 inject 'p{{r..}}' (19 p's), r19 -> END.
    const final = `V-${'p'.repeat(19)}END`;
    expect(variants).toContain(final);
    const out = redactSecretText(`send ${final} end`, variants);
    expect(out).not.toContain(final);
  });
});

describe('scrubRecordedBody (issue #47 review r7 LOGIC3)', () => {
  it('keeps a JSON recorded body parseable when a numeric secret sat unquoted', () => {
    const out = scrubRecordedBody('{"n":1234567890,"keep":"ok"}', ['1234567890']);
    const parsed = JSON.parse(out) as { n: unknown; keep: string };
    expect(parsed.n).toBe('[REDACTED]');
    expect(parsed.keep).toBe('ok');
  });

  it('masks boolean secrets as valid JSON string values', () => {
    const out = scrubRecordedBody('{"flag":true,"k":"v"}', ['true']);
    const parsed = JSON.parse(out) as { flag: unknown; k: string };
    expect(parsed.flag).toBe('[REDACTED]');
  });

  it('masks null secrets as valid JSON string values', () => {
    const out = scrubRecordedBody('{"x":null,"k":"v"}', ['null']);
    const parsed = JSON.parse(out) as { x: unknown };
    expect(parsed.x).toBe('[REDACTED]');
  });

  it('scrubs secret substrings inside JSON string leaves (unchanged semantics)', () => {
    const out = scrubRecordedBody('{"t":"tok-42-suffix","k":"v"}', ['tok-42']);
    expect(out).not.toContain('tok-42');
    expect(JSON.parse(out).t).toBe('[REDACTED]-suffix');
  });

  it('keeps textual fast-path output byte-identical when the scrub stays valid JSON', () => {
    const out = scrubRecordedBody('{"t":"sec-ret"}', ['sec-ret']);
    expect(out).toBe('{"t":"[REDACTED]"}');
  });

  it('masks scalar leaves whose serialized value contains a secret substring', () => {
    // Secret rotation must not make a previously recorded numeric value
    // visible. Replace the whole scalar with a JSON string marker so the
    // document remains parseable without retaining the secret substring.
    const out = scrubRecordedBody('{"n":1234567890}', ['123']);
    expect(JSON.parse(out).n).toBe('[REDACTED]');
    expect(out).not.toContain('123');
  });

  it('non-JSON text falls back to the textual scrub (unchanged semantics)', () => {
    const out = scrubRecordedBody('raw tok-42 text', ['tok-42']);
    expect(out).toBe('raw [REDACTED] text');
  });

  it('handles nested objects and arrays', () => {
    const out = scrubRecordedBody('{"a":[{"v":777}],"b":{"v":1}}', ['777']);
    const parsed = JSON.parse(out) as { a: { v: unknown }[]; b: { v: unknown } };
    expect(parsed.a[0].v).toBe('[REDACTED]');
    expect(parsed.b.v).toBe(1);
  });

  it('empty secrets list returns text unchanged', () => {
    expect(scrubRecordedBody('{"a":1}', [])).toBe('{"a":1}');
  });
});

describe('review r9 fixes', () => {
  it('structured fallback scrubs secret-bearing JSON object keys (r9-LOGIC3)', () => {
    // Secret "123", body {"123":"v","n":123}: textual scrub breaks JSON,
    // so the structured fallback runs — and it must mask the KEY too, or a
    // later root-level body reference re-surfaces the secret.
    const out = scrubRecordedBody('{"123":"v","n":123}', ['123']);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain('123');
    expect(JSON.stringify(parsed)).not.toContain('123');
    expect(parsed['[REDACTED]']).toBe('v');
    expect(parsed.n).toBe('[REDACTED]');
  });

  it('real masked-key collisions use a deterministic raw-key winner independent of JS enumeration', () => {
    // Integer-like keys enumerate before ordinary keys regardless of source
    // order. Both keys below become the SAME masked key; the canonical
    // policy chooses the lexicographically-smallest raw key.
    const numeric = scrubRecordedBody(
      '{"[REDACTED]":"first","123":"second","n":123}',
      ['123'],
    );
    const numericParsed = JSON.parse(numeric) as Record<string, unknown>;
    expect(numericParsed['[REDACTED]']).toBe('second');
    expect(numeric).not.toContain('123');

    // Non-vacuity: ordinary source order deliberately disagrees with the
    // lexicographic winner. A naive last-write-wins collision handler keeps
    // "second" here; the canonical policy must keep a123's "first" value.
    const ordinary = scrubRecordedBody('{"a123":"first","b123":"second","n":123}', [
      'a123',
      'b123',
      '123',
    ]);
    const ordinaryParsed = JSON.parse(ordinary) as Record<string, unknown>;
    expect(ordinaryParsed['[REDACTED]']).toBe('first');
    expect(ordinary).not.toContain('a123');
    expect(ordinary).not.toContain('b123');
  });

  it('preserves __proto__ as inert own-key data during structured fallback', () => {
    const out = scrubRecordedBody(
      '{"__proto__":{"n":1234},"keep":"ok","n":1234}',
      ['123'],
    );
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect((parsed.__proto__ as { n: unknown }).n).toBe('[REDACTED]');
    expect(parsed.keep).toBe('ok');
    expect(out).not.toContain('123');
    expect(({} as { n?: unknown }).n).toBeUndefined();
  });

  it('uses a secret-free marker for structured scalar masking', () => {
    const secrets = ['123', 'RED'];
    const raw = '{"n":123,"s":"RED"}';
    for (const secret of secrets) expect(raw).toContain(secret);
    const out = scrubRecordedBody(raw, secrets);
    JSON.parse(out);
    for (const secret of secrets) expect(out).not.toContain(secret);
  });

  it('scrubs secrets that exist only after JSON decoding', () => {
    const raw = '{"s":"\\u0073ecret"}';
    expect(raw).not.toContain('secret');
    const out = scrubRecordedBody(raw, ['secret']);
    const parsed = JSON.parse(out) as { s: string };
    expect(parsed.s).not.toContain('secret');
    expect(out).not.toContain('secret');
  });

  it('keeps JSON valid when a secret is a quote escape sequence', () => {
    const serializationSecret = '\\"';
    const raw = '{"changed":"needle","quote":"\\u0022"}';
    expect(raw).toContain('needle');
    expect(raw).not.toContain(serializationSecret);
    const out = scrubRecordedBody(raw, ['needle', serializationSecret]);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toContain('needle');
  });

  it('applies the deterministic key-collision winner when textual masking stays parseable', () => {
    const raw = '{"123":"a","[REDACTED]":"b"}';
    expect(raw).toContain('123');
    const out = scrubRecordedBody(raw, ['123']);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(out).not.toContain('123');
    // Lexicographically-smallest raw key `123` wins over `[REDACTED]`.
    expect(parsed['[REDACTED]']).toBe('a');
  });
});

describe('deriveSecretVariants starvation closure (review r9 SEC)', () => {
  it('a hostile flood under ONE secret never starves a later base secret (r9)', () => {
    // Secret #1 expands into 300 variants; secret #2 has a single
    // expansion that reached the wire. The fixpoint must close per-secret
    // within the global bound and report truncation honestly.
    const manyRefs = Array.from({ length: 300 }, (_, i) => ({
      reference: `{{a${i}}}`,
      value: `A${i}`,
    }));
    const closures = deriveSecretVariants([
      Array.from({ length: 300 }, (_, i) => `{{a${i}}}`).join(''),
      'prefix{{lateRef}}suffix',
    ], [...manyRefs, { reference: '{{lateRef}}', value: 'WIREVAL' }]);
    // Closure-per-base: EVERY base secret gets its own closure result.
    expect(closures.perBase).toHaveLength(2);
    // Base #2's closure must contain the wire value even though base #1's
    // expansion hit the global bound.
    expect(closures.perBase[1].variants).toContain('prefixWIREVALsuffix');
    expect(closures.perBase[1].truncated).toBe(false);
    // Base #1 blew the bound -> truncation reported for it.
    expect(closures.perBase[0].truncated).toBe(true);
    // Aggregate variants are bounded and contain every base.
    expect(closures.variants.length).toBeLessThanOrEqual(2 + MAX_DERIVED_ADDITIONS);
    expect(closures.truncated).toBe(true);
  });

  it('reports truncated=false when everything closes inside the bound (control)', () => {
    const closures = deriveSecretVariants(['V-{{r0}}'], [
      { reference: '{{r0}}', value: 'END' },
    ]);
    expect(closures.truncated).toBe(false);
    expect(closures.variants).toContain('V-END');
  });

  it('does not report truncation for an exactly-full finite closure', () => {
    const secrets = Array.from({ length: 128 }, (_, i) => `{{r${i}}}`);
    const injected = secrets.map((reference, i) => ({ reference, value: `V${i}` }));
    const closures = deriveSecretVariants(secrets, injected);
    expect(closures.truncated).toBe(false);
    expect(closures.perBase.every((entry) => !entry.truncated)).toBe(true);
    expect(closures.variants).toHaveLength(256);
  });
});

describe('review r11 fix — fail-closed recorded-body contract', () => {
  it('refuses to record (null) instead of storing invalid JSON when a secret is JSON syntax', () => {
    // Reviewer r11 repro: secret `":"` sits BETWEEN tokens, so textual
    // masking corrupts the document and later references to UNRELATED
    // fields fail. Recording nothing is truthful; recording broken JSON
    // contradicts the documented parseability guarantee.
    const raw = '{"safe":42,"other":"ok"}';
    const secret = '":"';
    expect(raw).toContain(secret); // non-vacuity: the raw text holds the secret
    expect(() => JSON.parse(redactSecretText(raw, [secret]))).toThrow(); // and the textual scrub breaks it
    expect(scrubRecordedBody(raw, [secret])).toBeNull();
  });

  it('refuses every recorded JSON body whose secret lives in the JSON structure', () => {
    // Each fixture pair puts the secret BETWEEN tokens (key/value/member
    // boundaries) of a body that genuinely contains it (non-vacuity), so no
    // candidate — structured re-serialization, re-redaction, or textual
    // masking — can be both parseable and secret-free. Refusal (null) is
    // the only sound outcome (issue #47 review r11).
    const cases: Array<[raw: string, secret: string]> = [
      ['{"safe":42}', '":'], // between key-close-quote and colon
      ['{"a":"x","b":1}', '",'], // between value-close-quote and comma
      ['{"a":"x"}', ':"'], // between colon and value-open-quote
      ['{"a":{"b":1}}', '":{'], // between key colon and nested object
    ];
    for (const [raw, secret] of cases) {
      expect(raw).toContain(secret);
      expect(scrubRecordedBody(raw, [secret]), `secret ${JSON.stringify(secret)}`).toBeNull();
    }
  });

  it('uses the structured candidate when textual masking breaks JSON but a secret-free serialization exists', () => {
    // Whitespace-sensitive secret: present in the formatted raw text,
    // absent from the compact re-serialization. The recorder must NOT
    // refuse when a secret-free valid candidate exists.
    const raw = '{ "a": 1, "b": "keep" }';
    const secret = ', ';
    expect(raw).toContain(secret);
    expect(() => JSON.parse(redactSecretText(raw, [secret]))).toThrow();
    const out = scrubbed(raw, [secret]);
    expect(JSON.parse(out)).toEqual({ a: 1, b: 'keep' });
    expect(out).not.toContain(secret);
  });

  it('keeps recording NON-JSON bodies via the textual scrub (no parseability to protect)', () => {
    // The refusal contract applies only to JSON documents. A plain-text
    // body carrying a syntax-shaped secret still scrubs to secret-free
    // text (whatever its JSON validity, since the input was never JSON).
    const out = scrubRecordedBody('query { a, b }', [', ']);
    expect(out).not.toContain(', ');
    expect(out).toContain('[REDACTED]');
  });

  it('refuses a textual fallback whose DECODED JSON values contain an active secret (r12 Unicode escape)', () => {
    // Reviewer r12 repro: the raw bytes never contain the secret (`s` is
    // written as \u0073), and the structural secret never appears raw
    // either (whitespace between tokens), so textual masking is a no-op
    // and the ORIGINAL body passes a raw-byte-only check. But JSON.parse
    // decodes it to `secret` — storing that copy lets a later
    // {{name.request.body.$.s}} reference re-surface the secret after the
    // environment rotates. Candidates must be verified against the
    // DECODED content too, not just their raw bytes.
    const raw = '{"s" : "\\u0073ecret"}'; // raw bytes contain neither secret
    expect(raw).not.toContain('secret');
    expect(JSON.parse(raw)).toEqual({ s: 'secret' }); // non-vacuity: decodes to the secret
    // Reviewer's exact secret set: `secret` (decoded leaf) + `":"` (the
    // structural key/value delimiter, absent from this whitespace-padded
    // raw text but present in every compact re-serialization). The
    // structural secret blocks the structured/re-redacted candidates,
    // forcing the textual fallback — which passes a raw-byte-only check
    // while its DECODED values still carry the secret. Refusal is the
    // only sound outcome once candidates are verified after decoding.
    expect(scrubRecordedBody(raw, ['secret', '":"'])).toBeNull();
  });

  it('records Unicode-escaped secrets via the structured path when the decoded leaf scrubs clean (r12 positive control)', () => {
    // Positive control for the decoded-content gate: raw bytes never
    // contain the secret (it is \u0073-escaped), and the structured walk
    // scrubs the DECODED leaf before re-serializing — so a secret-free,
    // parseable candidate exists and recording must SUCCEED. The r12
    // refusal applies only when no candidate's decoded content is clean
    // (the textual fallback of the test above).
    const raw = '{"s":"\\u0073ecret"}';
    expect(raw).not.toContain('secret');
    expect(JSON.parse(raw)).toEqual({ s: 'secret' });
    const out = scrubbed(raw, ['secret']);
    expect(out).not.toContain('secret');
    expect(JSON.parse(out)).toEqual({ s: '[REDACTED]' });
  });

  it('pins the exact original r11 repro shapes (single-char structural secrets)', () => {
    // Review r11's literal family: the secret IS the key/value/member
    // delimiter; masking it breaks the document, leaving no candidate
    // that is both parseable and secret-free.
    const raw = '{"safe":42,"other":"ok"}';
    expect(raw).toContain('\":\"');
    expect(scrubRecordedBody(raw, ['\":\"'])).toBeNull();
    expect(scrubRecordedBody('{"safe":42}', [':'])).toBeNull();
  });
});
