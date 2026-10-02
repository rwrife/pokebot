import { describe, expect, it } from 'vitest';
import {
  parseChainReference,
  parseCaptureDirective,
  createChainStore,
  resolveChainText,
  resolveChainRequest,
  applyCapture,
  validateRequestNames,
  isValidChainName,
  MAX_CHAIN_REFS_PER_PASS,
} from '../src/core/chain/resolver.js';

describe('parseChainReference', () => {
  it('parses response body JSONPath refs', () => {
    const r = parseChainReference('login.response.body.$.data.token');
    expect(r).toEqual({
      kind: 'response',
      part: 'body',
      requestName: 'login',
      path: '$.data.token',
    });
  });

  it('parses response status refs', () => {
    expect(parseChainReference('login.response.status')).toEqual({
      kind: 'response',
      part: 'status',
      requestName: 'login',
    });
  });

  it('parses response header refs preserving the header name', () => {
    expect(parseChainReference('login.response.headers.X-Trace-Id')).toEqual({
      kind: 'response',
      part: 'headers',
      requestName: 'login',
      headerName: 'X-Trace-Id',
    });
  });

  it('parses request body JSONPath refs', () => {
    expect(parseChainReference('login.request.body.$.correlation_id')).toEqual({
      kind: 'request',
      part: 'body',
      requestName: 'login',
      path: '$.correlation_id',
    });
  });

  it('returns null for non-chain references', () => {
    expect(parseChainReference('baseUrl')).toBeNull();
    expect(parseChainReference('$guid')).toBeNull();
    expect(parseChainReference('login.response.body')).toBeNull(); // body needs $.path
    expect(parseChainReference('login.request.status')).toBeNull(); // status is response-only
    expect(parseChainReference('1bad.response.status')).toBeNull();
  });
});

describe('parseCaptureDirective', () => {
  it('parses an untyped capture', () => {
    expect(parseCaptureDirective('token = $.access_token')).toEqual({
      name: 'token',
      declaredType: null,
      secret: false,
      path: '$.access_token',
    });
  });

  it('parses a typed capture', () => {
    expect(parseCaptureDirective('count: number = $.meta.count')).toEqual({
      name: 'count',
      declaredType: 'number',
      secret: false,
      path: '$.meta.count',
    });
  });

  it('parses a typed secret capture', () => {
    expect(parseCaptureDirective('tok: string secret = $.auth.token')).toEqual({
      name: 'tok',
      declaredType: 'string',
      secret: true,
      path: '$.auth.token',
    });
  });

  it('rejects invalid names, types, and shapes', () => {
    expect('error' in parseCaptureDirective('bad name = $.x')).toBe(true);
    expect('error' in parseCaptureDirective('tok: jsonp = $.x')).toBe(true);
    expect('error' in parseCaptureDirective('tok = notapath')).toBe(true);
    expect('error' in parseCaptureDirective('= $.x')).toBe(true);
    expect('error' in parseCaptureDirective('tok: string secret extra = $.x')).toBe(true);
  });
});

describe('validateRequestNames', () => {
  it('accepts unique alnum+underscore names', () => {
    expect(validateRequestNames(['login', 'me_v2', 'logout'])).toEqual([]);
  });

  it('flags duplicates and invalid identifiers', () => {
    const diags = validateRequestNames(['login', 'login', '1bad', 'ok']);
    expect(diags.some((d) => d.includes('duplicate'))).toBe(true);
    expect(diags.some((d) => d.includes('1bad'))).toBe(true);
  });

  it('caps identifier length so hostile names cannot flood diagnostics (issue #47 review S6)', () => {
    const long = `x${'y'.repeat(200)}`;
    expect(isValidChainName(long)).toBe(false);
    expect(isValidChainName(`x${'y'.repeat(127)}`)).toBe(true);
    const diags = validateRequestNames([long]);
    expect(diags).toHaveLength(1);
    // The diagnostic echoes the offending name — it must be clipped, not a
    // verbatim 200-char embed (bounded toast requirement).
    expect(diags[0]!.length).toBeLessThan(300);
    expect(diags[0]).toContain('…');
  });
});

describe('parseCaptureDirective name bound (review S6)', () => {
  it('rejects capture names over the length cap with a bounded diagnostic', () => {
    const long = `c${'z'.repeat(200)}`;
    const res = parseCaptureDirective(`${long} = $.a`);
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error.length).toBeLessThan(300);
      expect(res.error).toContain('…');
    }
  });
});

describe('resolveChainText / resolveChainRequest', () => {
  const store = () => {
    const s = createChainStore();
    s.recordRequest('login', { body: JSON.stringify({ correlation_id: 'cid-9', nested: { a: 1 } }) });
    s.recordResponse('login', {
      status: 201,
      headers: { 'content-type': 'application/json', 'X-Trace-Id': 'trace-abc' },
      body: JSON.stringify({
        access_token: 'tok-123',
        meta: { count: 7, flag: true, nothing: null },
        items: [{ id: 10 }, { id: 20 }],
      }),
    });
    return s;
  };

  it('substitutes status, headers, body JSONPath, and request body JSONPath', () => {
    const s = store();
    const r = resolveChainText(
      'S {{login.response.status}} {{login.response.headers.x-trace-id}} {{login.response.body.$.access_token}} {{login.request.body.$.correlation_id}}',
      s,
    );
    expect(r.text).toBe('S 201 trace-abc tok-123 cid-9');
    expect(r.diagnostics).toEqual([]);
  });

  it('header lookup is case-insensitive both directions', () => {
    const s = store();
    expect(resolveChainText('{{login.response.headers.X-TRACE-ID}}', s).text).toBe('trace-abc');
    expect(resolveChainText('{{login.response.headers.Content-Type}}', s).text).toBe('application/json');
  });

  it('serializes JSON values: numbers/booleans plain, objects/arrays compact JSON', () => {
    const s = store();
    expect(resolveChainText('{{login.response.body.$.meta.count}}', s).text).toBe('7');
    expect(resolveChainText('{{login.response.body.$.meta.flag}}', s).text).toBe('true');
    expect(resolveChainText('{{login.response.body.$.meta.nothing}}', s).text).toBe('null');
    expect(resolveChainText('{{login.response.body.$.items[1].id}}', s).text).toBe('20');
    expect(resolveChainText('{{login.response.body.$.items}}', s).text).toBe('[{"id":10},{"id":20}]');
  });

  it('leaves non-chain references untouched for later env substitution', () => {
    const s = store();
    const r = resolveChainText('{{baseUrl}}/x {{$guid}} {{unknown}}', s);
    expect(r.text).toBe('{{baseUrl}}/x {{$guid}} {{unknown}}');
    expect(r.diagnostics).toEqual([]);
  });

  it('reports actionable diagnostics for unresolved chains and leaves the ref in place', () => {
    const s = store();
    const r = resolveChainText(
      '{{missing.response.status}} {{login.response.body.$.nope.deep}} {{login.response.headers.X-Absent}} {{login.response.body.$.notjson}}',
      s,
    );
    expect(r.text).toContain('{{missing.response.status}}');
    expect(r.text).toContain('{{login.response.body.$.nope.deep}}');
    expect(r.diagnostics.map((d) => d.variable)).toEqual([
      'missing.response.status',
      'login.response.body.$.nope.deep',
      'login.response.headers.X-Absent',
      'login.response.body.$.notjson',
    ]);
    expect(r.diagnostics[0].message).toContain('no recorded response');
    expect(r.diagnostics[1].message).toContain('Path miss');
    expect(r.diagnostics[2].message).toContain('X-Absent');
    expect(r.diagnostics[3].message).toContain('Path miss');
  });

  it('diagnoses malformed body paths and invalid JSON request bodies', () => {
    const s = createChainStore();
    s.recordRequest('weird', { body: 'not json' });
    const r = resolveChainText('{{weird.request.body.$.x}}', s);
    expect(r.text).toBe('{{weird.request.body.$.x}}');
    expect(r.diagnostics[0].message).toContain('not valid JSON');
  });

  it('diagnoses an invalid recorded RESPONSE body as not valid JSON', () => {
    const s = createChainStore();
    s.recordResponse('weird', { status: 200, headers: {}, body: 'not json' });
    const r = resolveChainText('{{weird.response.body.$.x}}', s);
    expect(r.text).toBe('{{weird.response.body.$.x}}');
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toContain('not valid JSON');
  });

  it('flags chain-shaped references bound to a recorded name even when malformed', () => {
    const s = store();
    // `login` is recorded and the ref is chain-shaped, so chain intent wins:
    // these must NOT silently pass through to env substitution.
    const r = resolveChainText(
      '{{login.response.status.extra}} {{login.request.status}} {{login.response.body.notjson.$}}',
      s,
    );
    expect(r.diagnostics.map((d) => d.variable)).toEqual([
      'login.response.status.extra',
      'login.request.status',
      'login.response.body.notjson.$',
    ]);
    // literal stays in place
    expect(r.text).toContain('{{login.response.status.extra}}');
    expect(r.diagnostics[0].message).toMatch(/status/);
    expect(r.diagnostics[1].message).toMatch(/request/);
    expect(r.diagnostics[2].message).toMatch(/JSONPath/);
  });

  it('flags incomplete or irregular chain shapes for recorded names (doubled dots, missing parts, digit parts)', () => {
    const s = store();
    const r = resolveChainText(
      '{{login.response}} {{login.response.}} {{login.response..status}} {{login.response.1bad}} {{login.request}}',
      s,
    );
    expect(r.diagnostics.map((d) => d.variable)).toEqual([
      'login.response',
      'login.response.',
      'login.response..status',
      'login.response.1bad',
      'login.request',
    ]);
    for (const d of r.diagnostics) expect(d.message).not.toBe('');
    // text passes through byte-identically (literals stay)
    expect(r.text).toBe(
      '{{login.response}} {{login.response.}} {{login.response..status}} {{login.response.1bad}} {{login.request}}',
    );
  });

  it('does not treat same-prefix namespaces as chain shapes', () => {
    const s = store();
    // `login.responseX` / `loginx.requestY` are ordinary dotted env names.
    const r = resolveChainText('{{login.responseX}} {{loginx.requestY}}', s);
    expect(r.diagnostics).toEqual([]);
    expect(r.text).toBe('{{login.responseX}} {{loginx.requestY}}');
  });

  it('parses a header name containing an apostrophe (quote mode is bracket-scoped only)', () => {
    const s2 = createChainStore();
    s2.recordResponse('login', {
      status: 200,
      headers: { "X-O'Brien": 'aye' },
      body: '{}',
    });
    const r = resolveChainText("{{login.response.headers.X-O'Brien}}", s2);
    expect(r.text).toBe('aye');
    expect(r.diagnostics).toEqual([]);
  });

  it('fails closed on candidates with unterminated quotes or lone braces (byte-identical pass-through)', () => {
    const s = store();
    // Exact full-output assertions: nothing nested inside an abandoned
    // candidate may resolve, and text outside the abandoned region is
    // processed normally.
    const cases: Array<[string, string]> = [
      // bracket-scoped unterminated quote: whole region literal, incl. nested ref
      ["{{broken [' {{login.response.status}}", "{{broken [' {{login.response.status}}"],
      // bare apostrophe: candidate closes at the nested ref's `}}`, classify
      // fails, whole thing passes through byte-identically
      ["{{broken ' {{login.response.status}}", "{{broken ' {{login.response.status}}"],
      // lone `}` before nested ref: region skip covers the nested ref too
      ['{{a} {{login.response.status}}', '{{a} {{login.response.status}}'],
      // lone `}` with in-region terminator BEFORE nested ref: region skips to
      // its own `}}`, trailing valid ref resolves normally
      ['{{a}b}} {{login.response.status}}', '{{a}b}} 201'],
      // bracket + immediate terminator: own placeholder passthrough, nested resolves
      ['{{oops [}} {{login.response.status}}', '{{oops [}} 201'],
      // empty placeholder skipped, valid ref resolves
      ['{{}} {{login.response.status}}', '{{}} 201'],
      // unterminated bracket-quote that swallows a later placeholder
      ["{{oops ['unclosed {{login.response.status}}", "{{oops ['unclosed {{login.response.status}}"],
      // unterminated bracket-quote must abandon through END OF INPUT: two
      // later placeholders, neither may resolve
      [
        "{{oops ['unclosed {{first}} {{login.response.status}}",
        "{{oops ['unclosed {{first}} {{login.response.status}}",
      ],
      // bracket + lone-brace interaction
      ['{{a[}b}} {{login.response.status}}', '{{a[}b}} 201'],
    ];
    for (const [input, expected] of cases) {
      const r = resolveChainText(input, s);
      expect(r.text, input).toBe(expected);
    }
  });

  it('passes through bracketed non-chain placeholders untouched', () => {
    const s = store();
    const r = resolveChainText('{{a[1]}} and {{a[}}', s);
    expect(r.text).toBe('{{a[1]}} and {{a[}}');
    expect(r.diagnostics).toEqual([]);
  });

  it('resolves a quoted JSONPath key containing }}', () => {
    const s2 = createChainStore();
    s2.recordResponse('login', {
      status: 200,
      headers: {},
      body: JSON.stringify({ 'a}}b': 'brace' }),
    });
    const r = resolveChainText("{{login.response.body.$['a}}b']}}", s2);
    expect(r.text).toBe('brace');
    expect(r.diagnostics).toEqual([]);
  });

  it('resolves adjacent placeholders independently', () => {
    const s = store();
    const r = resolveChainText('{{login.response.status}}{{login.response.status}}', s);
    expect(r.text).toBe('201201');
    expect(r.diagnostics).toEqual([]);
  });

  it('parses a recorded body at most once per resolution pass', async () => {
    const { vi } = await import('vitest');
    const s = store();
    const spy = vi.spyOn(JSON, 'parse');
    resolveChainText(
      '{{login.response.body.$.meta.count}} {{login.response.body.$.meta.flag}} {{login.response.body.$.meta.nothing}}',
      s,
    );
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(calls).toBe(1);
  });

  it('deep-copies object capture values on record and retrieval', () => {
    const s = store();
    const obj = { nested: { tok: 'original' } };
    const diags = s.recordCaptures([{ name: 'objcap', value: obj, secret: false }]);
    expect(diags.filter((r) => !r.stored)).toEqual([]);
    obj.nested.tok = 'tampered-source';
    const got = s.getCapture('objcap')!;
    expect((got.value as typeof obj).nested.tok).toBe('original');
    (got.value as typeof obj).nested.tok = 'tampered-read';
    expect((s.getCapture('objcap')!.value as typeof obj).nested.tok).toBe('original');
  });

  it('leaves malformed chain-shaped refs to UNKNOWN names for env substitution', () => {
    const s = store();
    // `checkout` was never recorded and the ref is malformed chain-shaped:
    // indistinguishable from an ordinary (possibly dotted) env var name, so
    // it passes through untouched per the pass-through contract.
    const r = resolveChainText('{{checkout.response.status.extra}}', s);
    expect(r.text).toBe('{{checkout.response.status.extra}}');
    expect(r.diagnostics).toEqual([]);
  });

  it('diagnoses validly-shaped refs to unknown names (no recorded response)', () => {
    const s = store();
    const r = resolveChainText('{{checkout.response.status}}', s);
    expect(r.text).toBe('{{checkout.response.status}}');
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toContain('no recorded response');
  });

  it('parses a body ref with a quoted key containing }', () => {
    // 'weird}key' survives the placeholder scan and resolves.
    const s2 = createChainStore();
    s2.recordResponse('login', {
      status: 200,
      headers: {},
      body: JSON.stringify({ 'weird}key': 'ok' }),
    });
    const r = resolveChainText("{{login.response.body.$['weird}key']}}", s2);
    expect(r.text).toBe('ok');
    expect(r.diagnostics).toEqual([]);
  });

  it('bounds the number of references resolved in one text', () => {
    const s = store();
    const hostile = Array(101)
      .fill('a{{login.response.status}}')
      .join('');
    const r = resolveChainText(hostile, s);
    // First 100 resolve normally; the overflow is left literal with one diagnostic.
    const resolvedCount = (r.text.match(/a201/g) ?? []).length;
    expect(resolvedCount).toBe(100);
    expect(r.text).toContain('a{{login.response.status}}'); // overflow stays literal
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toMatch(/too many/i);
  });

  it('returns defensive copies from store getters (no stored-history mutation)', () => {
    const s = store();
    const rec = s.getResponse('login')!;
    rec.status = 500;
    rec.headers['X-Trace-Id'] = 'tampered';
    rec.body = 'tampered';
    const again = s.getResponse('login')!;
    expect(again.status).toBe(201);
    expect(again.headers['X-Trace-Id']).toBe('trace-abc');
    expect(again.body).not.toBe('tampered');

    const req = s.getRequest('login')!;
    req.body = 'tampered';
    expect(s.getRequest('login')!.body).not.toBe('tampered');
  });

  it('stores captures per run with duplicate detection and secret flags', () => {
    const s = store();
    const results = s.recordCaptures([
      { name: 'token', value: 'tok', secret: true },
      { name: 'count', value: 7, secret: false },
    ]);
    expect(results.every((r) => r.stored)).toBe(true);
    expect(s.getCapture('token')).toEqual({ value: 'tok', secret: true });
    expect(s.getCapture('count')).toEqual({ value: 7, secret: false });
    expect(s.getCapture('absent')).toBeUndefined();
    expect(s.captureNames().sort()).toEqual(['count', 'token']);

    // duplicate names are rejected per-run (must be caught before wiring)
    const dup = s.recordCaptures([{ name: 'token', value: 'tok2', secret: true }]);
    expect(dup).toHaveLength(1);
    expect(dup[0]!.stored).toBe(false);
    expect(dup[0]!.diagnostic).toContain('duplicate capture');
    expect(s.getCapture('token')).toEqual({ value: 'tok', secret: true }); // first wins

    // invalid names rejected
    const bad = s.recordCaptures([{ name: '1bad', value: 'x', secret: false }]);
    expect(bad.some((r) => !r.stored && r.diagnostic!.includes('1bad'))).toBe(true);

    // clear() wipes captures too
    s.clear();
    expect(s.getCapture('token')).toBeUndefined();
    expect(s.captureNames()).toEqual([]);
  });

  it('resolveChainRequest covers url, header values, and body', () => {
    const s = store();
    const r = resolveChainRequest(
      {
        url: 'https://api/{{login.response.body.$.meta.count}}',
        headers: [
          { name: 'Authorization', value: 'Bearer {{login.response.body.$.access_token}}' },
          { name: 'X-Trace', value: '{{login.response.headers.X-Trace-Id}}' },
          { name: 'X-Static', value: 'plain' },
        ],
        body: '{"cid":"{{login.request.body.$.correlation_id}}"}',
      },
      s,
    );
    expect(r.url).toBe('https://api/7');
    expect(r.headers[0].value).toBe('Bearer tok-123');
    expect(r.headers[1].value).toBe('trace-abc');
    expect(r.headers[2].value).toBe('plain');
    expect(r.body).toBe('{"cid":"cid-9"}');
    expect(r.diagnostics).toEqual([]);
  });
});

describe('applyCapture', () => {
  const response = {
    status: 200,
    headers: {},
    body: JSON.stringify({
      access_token: 'tok',
      meta: { count: 7, flag: false, name: 'ada' },
    }),
  };

  it('captures untyped values with the raw JSON type preserved', () => {
    const c = applyCapture('token = $.access_token', response);
    expect('error' in c).toBe(false);
    if (!('error' in c)) {
      expect(c).toEqual({ name: 'token', value: 'tok', secret: false });
    }
  });

  it('validates declared types with zod and reports mismatches', () => {
    const okNum = applyCapture('n: number = $.meta.count', response);
    expect('error' in okNum).toBe(false);
    const badNum = applyCapture('n: number = $.meta.name', response);
    expect('error' in badNum).toBe(true);
    if ('error' in badNum) expect(badNum.error).toContain('number');
    const badBool = applyCapture('b: boolean = $.meta.count', response);
    expect('error' in badBool).toBe(true);
  });

  it('propagates the secret flag', () => {
    const c = applyCapture('tok: string secret = $.access_token', response);
    if ('error' in c) throw new Error('should parse');
    expect(c.secret).toBe(true);
  });

  it('reports path misses and parse errors as errors', () => {
    expect('error' in applyCapture('x = $.missing.path', response)).toBe(true);
    expect('error' in applyCapture('bad name = $.x', response)).toBe(true);
  });
});

describe('review r7 bounds (LOGIC2 + S6)', () => {
  const store = () => {
    const s = createChainStore();
    s.recordResponse('login', { status: 201, headers: {}, body: '{}' });
    return s;
  };
  it('EMPTY and ABANDONED placeholder candidates consume the scan bound (LOGIC2)', () => {
    // Round-7 LOGIC2: the bound counted only non-empty parsed placeholders,
    // so 100 `{{}}` candidates followed by a chain ref still resolved with
    // no overflow diagnostic — a trivially bypassed bound. Every `{{`
    // candidate opened must count toward the scan limit.
    const s = store();
    const hostile = '{{}}'.repeat(MAX_CHAIN_REFS_PER_PASS) + '{{login.response.status}}';
    const r = resolveChainText(hostile, s);
    expect(r.text).toContain('{{login.response.status}}'); // left literal
    expect(r.text).not.toContain('201');
    expect(r.diagnostics.some((d) => /too many/i.test(d.message))).toBe(true);
  });

  it('abandoned malformed candidates consume the scan bound too (LOGIC2)', () => {
    const s = store();
    // `{{a}` candidates (lone `}`) are abandoned regions; they must still
    // burn scan-bound budget.
    // Each repetition opens AND abandons one candidate (the `}}` at the
    // repetition end is the resume terminator), so 100 candidates really do
    // open before the final chain reference.
    const hostile = '{{a}x}}'.repeat(MAX_CHAIN_REFS_PER_PASS) + '{{login.response.status}}';
    const r = resolveChainText(hostile, s);
    expect(r.text).toContain('{{login.response.status}}');
    expect(r.diagnostics.some((d) => /too many/i.test(d.message))).toBe(true);
  });

  it('scan-bound diagnostic survives an all-empty candidate list (LOGIC2 crash guard)', () => {
    const s = store();
    const r = resolveChainText('{{}}'.repeat(MAX_CHAIN_REFS_PER_PASS + 5), s);
    // Must not throw and must report the bound.
    expect(r.diagnostics.some((d) => /too many/i.test(d.message))).toBe(true);
  });

  it('over-length names are not chain refs and never reach diagnostics (S6)', () => {
    const s = store();
    const huge = 'x'.repeat(10_000);
    const r = resolveChainText(`{{${huge}.response.status}}`, s);
    // Not chain-intent (name can never be recorded) -> passed to env stage.
    expect(r.diagnostics).toEqual([]);
    expect(r.text).toBe(`{{${huge}.response.status}}`);
  });

  it('malformed chain diagnostics clip echoed text (S6)', () => {
    const s = store();
    const huge = 'z'.repeat(10_000);
    const r = resolveChainText(`{{login.response.body.$.${huge}}}`, s);
    expect(r.diagnostics.length).toBe(1);
    const d = r.diagnostics[0];
    expect(d.message.length).toBeLessThanOrEqual(320);
    expect(d.reference.length).toBeLessThanOrEqual(320);
    expect(d.variable.length).toBeLessThanOrEqual(320);
    // Non-vacuity: the raw inner text WAS over the bound.
    expect(huge.length).toBeGreaterThan(1000);
  });

  it('unresolved recorded-name error messages clip the name (S6)', () => {
    const s = store();
    const r = resolveChainText('{{ghost.response.body.$.a}}' + 'y'.repeat(0), s);
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0].message.length).toBeLessThanOrEqual(320);
  });

  it('parseChainReference rejects over-length request names (S6)', () => {
    expect(parseChainReference(`${'x'.repeat(200)}.response.status`)).toBeNull();
    expect(parseChainReference('login.response.status')).not.toBeNull();
  });

  it('recordCaptures enforces the name LENGTH cap, not just the shape (S6)', () => {
    const s = createChainStore();
    const results = s.recordCaptures(
      [{ name: `a${'b'.repeat(200)}`, value: 'v', secret: false }],
      { owner: 'login' },
    );
    expect(results[0].stored).toBe(false);
    // Diagnostic must clip the hostile name.
    expect(results[0].diagnostic!.length).toBeLessThanOrEqual(400);
    expect(results[0].diagnostic).toContain('max 128');
  });
});

describe('cross-field scan budget (review r9 LOGIC2)', () => {
  it('empty candidates in one header consume the budget for the whole request pass', () => {
    // The advertised bound is PER REQUEST PASS (resolveChainRequest), so
    // spreading junk candidates across fields cannot reset it (r9).
    const s = createChainStore();
    s.recordResponse('scan', { status: 207, headers: {}, body: '{}' });
    const r = resolveChainRequest(
      {
        url: 'https://x.test/',
        headers: [
          { name: 'X-Junk', value: '{{}}'.repeat(MAX_CHAIN_REFS_PER_PASS) },
          { name: 'X-Ref', value: '{{scan.response.status}}' },
        ],
        body: '',
      },
      s,
    );
    expect(r.headers[1].value).toBe('{{scan.response.status}}'); // left literal
    expect(r.diagnostics.some((d) => /too many/i.test(d.message))).toBe(true);
  });

  it('a normal request uses one shared budget without false positives (control)', () => {
    const s = createChainStore();
    s.recordResponse('scan', { status: 207, headers: {}, body: '{}' });
    const r = resolveChainRequest(
      {
        url: 'https://x.test/?a={{scan.response.status}}',
        headers: [{ name: 'X-Ref', value: '{{scan.response.status}}' }],
        body: '{{scan.response.status}}',
      },
      s,
    );
    expect(r.url).toBe('https://x.test/?a=207');
    expect(r.headers[0].value).toBe('207');
    expect(r.body).toBe('207');
    expect(r.diagnostics).toEqual([]);
  });
});
