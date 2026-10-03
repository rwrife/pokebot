import { describe, expect, it } from 'vitest';

import {
  prepareChainSend,
  recordChainExchange,
  type SendExchange,
} from '../src/core/chain/send.js';
import { createChainStore } from '../src/core/chain/resolver.js';
import { MAX_CAPTURES_PER_REQUEST } from '../src/core/parser.js';

/**
 * Send-path chaining pipeline (issue #47 send-path slice).
 *
 * `prepareChainSend` resolves chain references against the run store BEFORE
 * environment substitution; `recordChainExchange` applies `# @capture`
 * directives and records the exchange after a response is received. Both
 * are pure — the extension/CLI adapters only call them and render results.
 */

function exchange(overrides: Partial<SendExchange> = {}): SendExchange {
  return {
    received: true,
    status: 200,
    headers: {},
    body: '{}',
    ...overrides,
  };
}

describe('prepareChainSend', () => {
  it('resolves response refs and leaves non-chain refs untouched', () => {
    const store = createChainStore();
    store.recordResponse('login', {
      status: 201,
      headers: { 'x-trace': 'T1' },
      body: JSON.stringify({ access_token: 'tok-42' }),
    });
    const out = prepareChainSend(
      {
        url: 'https://api.test/me?trace={{login.response.headers.X-TRACE}}',
        headers: [
          { name: 'Authorization', value: 'Bearer {{login.response.body.$.access_token}}' },
          { name: 'X-Keep', value: '{{envVar}}' },
        ],
        body: '',
      },
      store,
    );
    expect(out.diagnostics).toEqual([]);
    expect(out.url).toBe('https://api.test/me?trace=T1');
    expect(out.headers).toEqual([
      { name: 'Authorization', value: 'Bearer tok-42' },
      { name: 'X-Keep', value: '{{envVar}}' },
    ]);
  });

  it('reports unresolved chain refs with the original {{...}} text', () => {
    const store = createChainStore();
    store.recordResponse('login', { status: 200, headers: {}, body: '{}' });
    const out = prepareChainSend(
      {
        url: 'https://api.test/me',
        headers: [{ name: 'Authorization', value: `Bearer ${'{{login.response.body.$.token}}'}` }],
        body: '',
      },
      store,
    );
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0].reference).toBe('{{login.response.body.$.token}}');
    expect(out.diagnostics[0].message).toContain('Path miss');
    // Literal stays so the adapter can fail loudly instead of sending raw refs.
    expect(out.headers[0].value).toBe('Bearer {{login.response.body.$.token}}');
  });

  it('resolves capture-name references from the store', () => {
    const store = createChainStore();
    store.recordCaptures([{ name: 'tok', value: 'cap-1', secret: false }]);
    const out = prepareChainSend(
      {
        url: 'https://api.test/x',
        headers: [{ name: 'Authorization', value: 'Bearer {{tok}}' }],
        body: '{"n": {{count}}}{"literal":"{{untouched}}"}',
      },
      store,
    );
    expect(out.headers[0].value).toBe('Bearer cap-1');
    expect(out.body).toBe('{"n": {{count}}}{"literal":"{{untouched}}"}');
    expect(out.diagnostics).toEqual([]);
  });

  it('substitutes secret captures at send time and records them as secret resolutions', () => {
    // Sanctioned outlet: secret captures are substituted into the request
    // that actually goes out (login -> protected call is the whole point of
    // the feature). They stay OUT of every derived/rendered surface, which
    // callers enforce via store.getCapture(name).secret.
    const store = createChainStore();
    store.recordCaptures([{ name: 'tok', value: 's3cr3t', secret: true }]);
    const out = prepareChainSend(
      {
        url: 'https://api.test/x',
        headers: [{ name: 'Authorization', value: 'Bearer {{tok}}' }],
        body: '',
      },
      store,
    );
    expect(out.headers[0].value).toBe('Bearer s3cr3t');
    expect(out.diagnostics).toEqual([]);
    expect(out.resolvedSecrets).toEqual(['s3cr3t']);
    expect(out.resolvedSecretNames).toEqual(['tok']);
  });

  it('serializes non-string capture values like response values', () => {
    const store = createChainStore();
    store.recordCaptures([
      { name: 'n', value: 42, secret: false },
      { name: 'obj', value: { a: 1 }, secret: false },
    ]);
    const out = prepareChainSend(
      { url: 'https://api.test/{{n}}', headers: [], body: 'x={{obj}}' },
      store,
    );
    expect(out.url).toBe('https://api.test/42');
    expect(out.body).toBe('x={"a":1}');
  });

  it('a capture name shadows a same-named non-chain reference', () => {
    // Chain stage runs before env substitution, so `{{tok}}` bound to a
    // capture never falls through to the env resolver (documented precedence).
    const store = createChainStore();
    store.recordCaptures([{ name: 'tok', value: 'from-capture', secret: false }]);
    const out = prepareChainSend(
      { url: 'https://api.test/{{tok}}', headers: [], body: '' },
      store,
    );
    expect(out.url).toBe('https://api.test/from-capture');
  });

  it('a DIRECT response ref whose value equals a secret capture is provenance-tracked (B3)', () => {
    // `{{login.response.body.$.access_token}}` bypasses capture-name
    // provenance entirely — but it puts the SAME secret text on the wire.
    // prepareChainSend must sweep substituted values against the store's
    // secret captures so the adapter's redaction boundary still catches it
    // (issue #47 review blocker B3: direct refs are not a redaction hole).
    const SECRET = 'direct' + '-secret-5';
    const store = createChainStore();
    recordChainExchange(
      store,
      'login',
      ['tok: string secret = $.access_token'],
      '',
      exchange({ body: JSON.stringify({ access_token: SECRET }) }),
    );
    const out = prepareChainSend(
      { url: `https://api.test/me?tk=${'{{login.response.body.$.access_token}}'}`, headers: [], body: '' },
      store,
    );
    expect(out.diagnostics).toEqual([]);
    expect(out.url).toBe(`https://api.test/me?tk=${SECRET}`);
    // Non-vacuity: the wire value IS the secret capture's value...
    expect(store.getCapture('tok')).toEqual({ value: SECRET, secret: true });
    // ...and must therefore be redaction-listed even though no capture-name
    // reference was used.
    expect(out.resolvedSecrets).toEqual([SECRET]);
    expect(out.resolvedSecretNames).toEqual(['tok']);
  });

  it('a capture whose value is not present in the substituted request adds no redaction entry', () => {
    // Control for the value-equality sweep: a secret capture never
    // referenced by this request must not appear in resolvedSecrets
    // (redaction lists are per-send, not global).
    const store = createChainStore();
    recordChainExchange(
      store,
      'login',
      ['tok: string secret = $.t', 'unused: string secret = $.u'],
      '',
      exchange({ body: '{"t":"used-1","u":"never-1"}' }),
    );
    const out = prepareChainSend(
      { url: 'https://api.test/x?a={{tok}}', headers: [], body: '' },
      store,
    );
    expect(out.url).toBe('https://api.test/x?a=used-1');
    expect(out.resolvedSecrets).toEqual(['used-1']);
    expect(out.resolvedSecretNames).toEqual(['tok']);
  });
});

describe('recordChainExchange', () => {
  it('records named request+response and evaluates captures', () => {
    const store = createChainStore();
    const res = recordChainExchange(
      store,
      'login',
      ['token = $.access_token', 'count: number = $.meta.count'],
      '{"user":"u"}',
      exchange({
        headers: { 'x-trace': 'T9' },
        body: JSON.stringify({ access_token: 'tok-9', meta: { count: 3 } }),
      }),
    );
    expect(res.diagnostics).toEqual([]);
    expect(res.applied.map((c) => c.name)).toEqual(['token', 'count']);
    expect(store.getCapture('token')).toEqual({ value: 'tok-9', secret: false });
    expect(store.getResponse('login')).toEqual({
      status: 200,
      headers: { 'x-trace': 'T9' },
      body: JSON.stringify({ access_token: 'tok-9', meta: { count: 3 } }),
    });
    expect(store.getRequest('login')).toEqual({ body: '{"user":"u"}' });
  });

  it('captures evaluate against the CURRENT response even without a name', () => {
    const store = createChainStore();
    const res = recordChainExchange(
      store,
      undefined,
      ['tok = $.t'],
      'body',
      exchange({ body: '{"t":"v"}' }),
    );
    expect(res.diagnostics).toEqual([]);
    expect(store.getCapture('tok')).toEqual({ value: 'v', secret: false });
    // Unnamed exchanges cannot be referenced by name — nothing is recorded.
    expect(store.recordedNames()).toEqual([]);
  });

  it('capture evaluation errors surface as diagnostics but still record the exchange', () => {
    const store = createChainStore();
    const res = recordChainExchange(
      store,
      'login',
      ['missing = $.nope', 'bad: number = $.name', 'ok = $.name'],
      '',
      exchange({ body: '{"name":"not-a-number"}' }),
    );
    expect(res.diagnostics.some((d) => d.includes('missing'))).toBe(true);
    expect(res.diagnostics.some((d) => d.includes('bad'))).toBe(true);
    expect(res.applied.map((c) => c.name)).toEqual(['ok']);
    expect(store.getCapture('missing')).toBeUndefined();
    expect(store.getCapture('ok')).toEqual({ value: 'not-a-number', secret: false });
    expect(store.getResponse('login')).toBeDefined();
  });

  it('non-JSON bodies fail captures without blocking the exchange record', () => {
    const store = createChainStore();
    const res = recordChainExchange(store, 'n', ['x = $.a'], '', exchange({ body: 'plain text' }));
    expect(res.diagnostics.some((d) => d.includes('not valid JSON'))).toBe(true);
    expect(store.getResponse('n')).toBeDefined();
  });

  it('a duplicate capture name across exchanges is a diagnostic, first value wins', () => {
    const store = createChainStore();
    recordChainExchange(store, 'a', ['tok = $.t'], '', exchange({ body: '{"t":"first"}' }));
    const second = recordChainExchange(
      store,
      'b',
      ['tok = $.t'],
      '',
      exchange({ body: '{"t":"second"}' }),
    );
    expect(second.diagnostics.some((d) => d.includes("duplicate capture name 'tok'"))).toBe(true);
    expect(store.getCapture('tok')).toEqual({ value: 'first', secret: false });
  });

  it('re-recording the SAME named exchange refreshes its own captures (B4)', () => {
    // Owner-scoped dedup (issue #47 review blocker B4): re-running `# @name
    // login` after a token expires must UPDATE the captures that exchange
    // owns — response and captures land together atomically, so
    // `{{login.response.body.$.token}}` and `{{tok}}` can never disagree.
    const store = createChainStore();
    recordChainExchange(store, 'login', ['tok = $.t'], 'body1', exchange({ body: '{"t":"v1"}' }));
    const second = recordChainExchange(
      store,
      'login',
      ['tok = $.t'],
      'body2',
      exchange({ body: '{"t":"v2"}' }),
    );
    expect(second.diagnostics).toEqual([]);
    expect(store.getCapture('tok')).toEqual({ value: 'v2', secret: false });
    expect(store.getResponse('login')).toEqual({ status: 200, headers: {}, body: '{"t":"v2"}' });
    expect(store.getRequest('login')).toEqual({ body: 'body2' });
    // Downstream, the capture and the direct response ref now agree.
    const out = prepareChainSend(
      {
        url: 'https://api.test/a?cap={{tok}}&dir={{login.response.body.$.t}}',
        headers: [],
        body: '',
      },
      store,
    );
    expect(out.url).toBe('https://api.test/a?cap=v2&dir=v2');
  });

  it('a capture owned by one exchange is still a duplicate for a DIFFERENT exchange', () => {
    // Owner scoping must not weaken cross-exchange collision detection —
    // exchange 'b' silently overwriting 'a'\'s capture would reintroduce
    // the divergence B4 fixes.
    const store = createChainStore();
    recordChainExchange(store, 'a', ['tok = $.t'], '', exchange({ body: '{"t":"a1"}' }));
    const second = recordChainExchange(
      store,
      'b',
      ['tok = $.t'],
      '',
      exchange({ body: '{"t":"b1"}' }),
    );
    expect(second.diagnostics.some((d) => d.includes("duplicate capture name 'tok'"))).toBe(true);
    expect(store.getCapture('tok')).toEqual({ value: 'a1', secret: false });
    // S1: `applied` reports only what was STORED — the rejected capture is
    // excluded even though it was evaluated successfully.
    expect(second.applied.map((c) => c.name)).toEqual([]);
  });

  it('captures from UNNAMED exchanges still collide with every later capture', () => {
    // Unnamed exchanges have no owner; their captures take nothing's name
    // hostage and cannot be refreshed by a later named exchange.
    const store = createChainStore();
    recordChainExchange(store, undefined, ['tok = $.t'], '', exchange({ body: '{"t":"anon"}' }));
    const second = recordChainExchange(
      store,
      'login',
      ['tok = $.t'],
      '',
      exchange({ body: '{"t":"named"}' }),
    );
    expect(second.diagnostics.some((d) => d.includes("duplicate capture name 'tok'"))).toBe(true);
    expect(store.getCapture('tok')).toEqual({ value: 'anon', secret: false });
  });

  it('an invalid request name records nothing and says so', () => {
    const store = createChainStore();
    const res = recordChainExchange(store, '1bad-name', ['tok = $.t'], 'b', exchange({ body: '{"t":"v"}' }));
    expect(res.diagnostics.some((d) => d.includes("Invalid request name '1bad-name'"))).toBe(true);
    expect(store.recordedNames()).toEqual([]);
    // A malformed name makes the whole named recording ambiguous — captures
    // for that exchange are skipped too, with one clear diagnostic instead
    // of half-applied state.
    expect(store.getCapture('tok')).toBeUndefined();
  });

  it('received=false performs NO store mutation at all', () => {
    const store = createChainStore();
    recordChainExchange(store, 'seed', ['seed = $.s'], '', exchange({ body: '{"s":"keep"}' }));
    const res = recordChainExchange(
      store,
      'seed',
      ['seed2 = $.s'],
      'new-body',
      exchange({ received: false, status: 500, body: 'ignored' }),
    );
    expect(res.diagnostics).toEqual([]);
    expect(res.applied).toEqual([]);
    // Seed state untouched: same response, same request body, no new captures.
    expect(store.getResponse('seed')).toEqual({ status: 200, headers: {}, body: '{"s":"keep"}' });
    expect(store.getRequest('seed')).toEqual({ body: '' });
    expect(store.getCapture('seed2')).toBeUndefined();
  });

  it('invalid capture directive text is a diagnostic with the raw source', () => {
    const store = createChainStore();
    const res = recordChainExchange(store, 'n', ['= $. broken'], '', exchange({ body: '{}' }));
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toContain('= $. broken');
  });

  it('a within-call duplicate keeps the FIRST stored entry in applied (F3)', () => {
    // First-wins storage means the FIRST entry of a repeated name IS stored;
    // `applied` must report it. Removing every entry sharing the name would
    // claim nothing was stored when something was (issue #47 review F3).
    const store = createChainStore();
    const res = recordChainExchange(
      store,
      'x',
      ['tok = $.a', 'tok = $.b'],
      '',
      exchange({ body: '{"a":1,"b":2}' }),
    );
    expect(res.diagnostics.filter((d) => d.includes("duplicate capture name 'tok'"))).toHaveLength(1);
    expect(store.getCapture('tok')).toEqual({ value: 1, secret: false });
    expect(res.applied).toEqual([{ name: 'tok', value: 1, secret: false }]);
  });

  it('a named re-record CLEARS its stale captures when its directive now fails (F2)', () => {
    // Response + captures must always come from the SAME last run of the
    // name: if `tok` fails to evaluate this time, the old value must not
    // survive to disagree with the fresh response (issue #47 review F2).
    const store = createChainStore();
    recordChainExchange(store, 'login', ['tok = $.t'], '', exchange({ body: '{"t":"v1"}' }));
    const second = recordChainExchange(
      store,
      'login',
      ['tok = $.t'],
      '',
      exchange({ body: '{"gone":1}' }),
    );
    expect(second.diagnostics.some((d) => d.includes('Path miss'))).toBe(true);
    expect(store.getResponse('login')).toEqual({ status: 200, headers: {}, body: '{"gone":1}' });
    expect(store.getCapture('tok')).toBeUndefined();
  });

  it('a named re-record with NO directives clears its previously owned captures (F2)', () => {
    const store = createChainStore();
    recordChainExchange(store, 'login', ['tok = $.t'], '', exchange({ body: '{"t":"v1"}' }));
    recordChainExchange(store, 'login', [], '', exchange({ body: '{"t":"v2"}' }));
    expect(store.getCapture('tok')).toBeUndefined();
    expect(store.getResponse('login')?.body).toBe('{"t":"v2"}');
  });

  it('a named re-record does NOT clear another exchange\'s captures (F2 scope)', () => {
    const store = createChainStore();
    recordChainExchange(store, 'login', ['tok = $.t'], '', exchange({ body: '{"t":"v1"}' }));
    recordChainExchange(store, 'other', ['keep = $.k'], '', exchange({ body: '{"k":"k1"}' }));
    recordChainExchange(store, 'login', [], '', exchange({ body: '{"t":"v2"}' }));
    expect(store.getCapture('tok')).toBeUndefined();
    expect(store.getCapture('keep')).toEqual({ value: 'k1', secret: false });
  });

  it('an UNNAMED exchange records nothing owned and never clears (F2 scope)', () => {
    const store = createChainStore();
    recordChainExchange(store, 'login', ['tok = $.t'], '', exchange({ body: '{"t":"v1"}' }));
    recordChainExchange(store, undefined, [], '', exchange({ body: '{}' }));
    expect(store.getCapture('tok')).toEqual({ value: 'v1', secret: false });
  });

  it('enforces the capture-directive cap itself, even for direct callers (F4)', () => {
    // The parser caps `# @capture` lines, but recordChainExchange is public
    // API for future CLI/runner adapters — it must not evaluate an
    // unbounded directive list (issue #47 review F4: bound the work, not
    // just the file format).
    const directives = Array.from(
      { length: MAX_CAPTURES_PER_REQUEST + 20 },
      (_, i) => `c${i} = $.c${i}`,
    );
    const body = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: MAX_CAPTURES_PER_REQUEST + 20 }, (_, i) => [`c${i}`, i]),
      ),
    );
    const store = createChainStore();
    const res = recordChainExchange(store, 'bulk', directives, '', exchange({ body }));
    expect(res.applied).toHaveLength(MAX_CAPTURES_PER_REQUEST);
    expect(store.captureNames()).toHaveLength(MAX_CAPTURES_PER_REQUEST);
    const capDiag = res.diagnostics.filter((d) => d.includes('capture limit'));
    expect(capDiag).toHaveLength(1);
    expect(capDiag[0]).toContain('ignored 20');
  });

  it('a rejected SECRET capture keeps value-equality provenance (issue #47 review S4/L1)', () => {
    // Collision-rejected secret captures must not lose provenance: the
    // exchange's response IS recorded, so a later direct reference into it
    // can carry the rejected secret onto the wire. The store must retain
    // the secret VALUE (not just successfully stored captures) so the
    // prepareChainSend value-equality sweep still lists it for redaction.
    const store = createChainStore();
    const FIRST = 'own' + 'erfirst';
    const SECOND = 'colli' + 'sionsecond';
    const ok1 = recordChainExchange(
      store,
      'loginA',
      ['tok: string secret = $.t'],
      '',
      exchange({ body: JSON.stringify({ t: FIRST }) }),
    );
    expect(ok1.applied).toHaveLength(1);
    const ok2 = recordChainExchange(
      store,
      'loginB',
      ['tok: string secret = $.t'], // same name, DIFFERENT owner -> rejected
      '',
      exchange({ body: JSON.stringify({ t: SECOND }) }),
    );
    expect(ok2.applied).toHaveLength(0);
    expect(ok2.diagnostics.some((d) => d.includes('duplicate capture name'))).toBe(true);
    // loginB's response is recorded (atomicity) — direct refs into it must
    // still be treated as the secret value.
    const out = prepareChainSend(
      { url: `https://api.test/x?v={{loginB.response.body.$.t}}`, headers: [], body: '' },
      store,
    );
    expect(out.url).toBe(`https://api.test/x?v=${SECOND}`);
    expect(out.resolvedSecrets).toContain(SECOND);
    expect(out.resolvedSecretNames).toContain('tok');
  });

  it('a rejected NON-SECRET capture contributes no provenance hint', () => {
    const store = createChainStore();
    recordChainExchange(store, 'loginA', ['tok = $.t'], '', exchange({ body: '{"t":"one"}' }));
    recordChainExchange(
      store,
      'loginB',
      ['tok = $.t'],
      '',
      exchange({ body: '{"t":"two"}' }),
    );
    const out = prepareChainSend(
      { url: 'https://api.test/x?v={{loginB.response.body.$.t}}', headers: [], body: '' },
      store,
    );
    expect(out.url).toBe('https://api.test/x?v=two');
    expect(out.resolvedSecrets).toEqual([]);
  });

  it('exchange recording FAILS CLOSED once the secret-provenance quota is exhausted (review r7 SEC2)', () => {
    // Beyond MAX_SECRET_PROVENANCE (64) REJECTED secret captures, silently
    // dropping further hints is fail-open: the recorded response would let
    // a later direct reference carry the 65th secret unredacted. Once the
    // quota is exhausted, any exchange carrying a SECRET capture directive
    // must be REFUSED outright, so the value is never referenceable at all.
    const store = createChainStore();
    recordChainExchange(store, 'seed', ['tok: string secret = $.t'], '', exchange({ body: '{"t":"seed0"}' }));
    for (let i = 1; i <= 64; i++) {
      const r = recordChainExchange(
        store,
        `c${i}`,
        ['tok: string secret = $.t'], // same name, different owner -> rejected
        '',
        exchange({ body: `{"t":"secretval${i}"}` }),
      );
      expect(r.applied).toHaveLength(0);
    }
    // Quota now exhausted. A further exchange with a secret capture
    // directive must fail closed (nothing recorded).
    const blocked = recordChainExchange(
      store,
      'late',
      ['tok: string secret = $.t'],
      '',
      exchange({ body: '{"t":"hiddenval"}' }),
    );
    expect(blocked.applied).toHaveLength(0);
    expect(blocked.diagnostics.some((d) => d.includes('secret-provenance'))).toBe(true);
    const out = prepareChainSend(
      { url: 'https://api.test/x?v={{late.response.body.$.t}}', headers: [], body: '' },
      store,
    );
    // The reference fails loudly (nothing recorded), never resolving to the
    // hidden value (issue #47 error semantics: unresolved refs stay literal).
    expect(out.url).not.toContain('hiddenval');
    expect(out.diagnostics.length).toBeGreaterThan(0);
    // A NON-secret-capture exchange still records normally at exhaustion.
    recordChainExchange(store, 'plain', ['ptok = $.t'], '', exchange({ body: '{"t":"plainval"}' }));
    const ok = prepareChainSend(
      { url: 'https://api.test/x?v={{plain.response.body.$.t}}', headers: [], body: '' },
      store,
    );
    expect(ok.url).toBe('https://api.test/x?v=plainval');
  });

  it('an UNNAMED secret capture rejected as duplicate keeps provenance too', () => {
    const store = createChainStore();
    recordChainExchange(
      store,
      'loginA',
      ['tok: string secret = $.t'],
      '',
      exchange({ body: '{"t":"one"}' }),
    );
    const anon = recordChainExchange(
      store,
      undefined,
      ['tok: string secret = $.t'],
      '',
      exchange({ body: '{"t":"anonsecret"}' }),
    );
    expect(anon.applied).toHaveLength(0);
    const out = prepareChainSend(
      { url: 'https://api.test/x?q=anonsecret', headers: [], body: '' },
      store,
    );
    expect(out.resolvedSecrets).toContain('anonsecret');
  });

  it('evaluates N capture directives against ONE JSON parse of the response body (B5)', () => {
    // Hostile-input bound (issue #47 review B5): capture evaluation must not
    // re-parse the (potentially large) response body once per directive.
    // Count real JSON.parse calls while recording one exchange with 8
    // directives — the body may be parsed at most once for that exchange.
    const directives = Array.from({ length: 8 }, (_, i) => `c${i} = $.v${i}`);
    const body = JSON.stringify(
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`v${i}`, `x${i}`])),
    );
    const realParse = JSON.parse;
    let parseCalls = 0;
    (JSON as { parse: typeof JSON.parse }).parse = ((text: unknown, ...rest: unknown[]) => {
      if (text === body) parseCalls++;
      return (realParse as (t: unknown, ...r: unknown[]) => unknown)(text, ...rest);
    }) as typeof JSON.parse;
    try {
      const store = createChainStore();
      const res = recordChainExchange(store, 'bulk', directives, '', exchange({ body }));
      expect(res.diagnostics).toEqual([]);
      expect(res.applied).toHaveLength(8);
      expect(parseCalls).toBe(1);
    } finally {
      (JSON as { parse: typeof JSON.parse }).parse = realParse;
    }
  });
});

  it('an exchange whose secret directives WOULD CROSS the quota is refused (review r9 SEC2)', () => {
    // Batch-crossing canary: quota at 63, one exchange with TWO rejected
    // secret captures. Pre-fix, the guard only fired at a FULL quota, the
    // exchange recorded, and the 2nd hint was silently dropped — leaving a
    // recorded response carrying a secret the sweep no longer knows.
    const store = createChainStore();
    recordChainExchange(store, 'seed', ['tok: string secret = $.t'], '', exchange({ body: '{"t":"seed0"}' }));
    for (let i = 1; i <= 63; i++) {
      const r = recordChainExchange(store, `c${i}`, ['tok: string secret = $.t'], '', exchange({ body: `{"t":"secretval${i}"}` }));
      expect(r.applied).toHaveLength(0); // name 'tok' owned by seed -> rejected -> hint
    }
    // 63 rejected secret hints; quota has exactly ONE slot left (64).
    expect(store.secretProvenance().length).toBe(63);
    const crossing = recordChainExchange(
      store,
      'late',
      ['a: string secret = $.a', 'b: string secret = $.b'],
      '',
      exchange({ body: '{"a":"quota64","b":"quota65-canary"}' }),
    );
    expect(crossing.applied).toHaveLength(0);
    expect(crossing.diagnostics.some((d) => d.includes('secret-provenance'))).toBe(true);
    // The response must NOT be referenceable at all.
    const out = prepareChainSend(
      { url: 'https://api.test/x?v={{late.response.body.$.b}}', headers: [], body: '' },
      store,
    );
    expect(out.url).not.toContain('quota65-canary');
  });
