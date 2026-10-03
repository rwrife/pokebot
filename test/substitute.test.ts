import { describe, expect, it } from 'vitest';
import {
  makeUuidV4,
  substitute,
  substituteRequest,
} from '../src/core/substitute.js';

const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5); // 2026-01-02T03:04:05.000Z

function seqRandom(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
}

describe('substitute', () => {
  it('resolves a simple variable', () => {
    const r = substitute('GET {{baseUrl}}/users', {
      resolve: (n) => (n === 'baseUrl' ? 'https://api.test' : undefined),
    });
    expect(r.text).toBe('GET https://api.test/users');
    expect(r.diagnostics).toEqual([]);
  });

  it('handles multiple references in one string', () => {
    const r = substitute('{{a}}-{{b}}-{{a}}', {
      resolve: (n) => ({ a: '1', b: '2' })[n],
    });
    expect(r.text).toBe('1-2-1');
  });

  it('reports unresolved variables as diagnostics and leaves placeholder', () => {
    const r = substitute('{{missing}}/x', { resolve: () => undefined });
    expect(r.text).toBe('{{missing}}/x');
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].variable).toBe('missing');
  });

  it('ignores whitespace inside {{ ... }}', () => {
    const r = substitute('{{  baseUrl  }}', { resolve: (n) => (n === 'baseUrl' ? 'ok' : undefined) });
    expect(r.text).toBe('ok');
  });

  it('$guid produces a v4 UUID', () => {
    const r = substitute('{{$guid}}', {
      resolve: () => undefined,
      random: seqRandom(Array(16).fill(0.5)),
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('$timestamp produces unix seconds', () => {
    const r = substitute('{{$timestamp}}', {
      resolve: () => undefined,
      now: () => FIXED_NOW,
    });
    expect(r.text).toBe(Math.floor(FIXED_NOW / 1000).toString());
  });

  it('$datetime supports iso and rfc1123', () => {
    const iso = substitute('{{$datetime iso}}', {
      resolve: () => undefined,
      now: () => FIXED_NOW,
    });
    expect(iso.text).toBe(new Date(FIXED_NOW).toISOString());
    const rfc = substitute('{{$datetime rfc1123}}', {
      resolve: () => undefined,
      now: () => FIXED_NOW,
    });
    expect(rfc.text).toBe(new Date(FIXED_NOW).toUTCString());
  });

  it('$randomInt is in [min, max] inclusive', () => {
    const r = substitute('{{$randomInt 5 7}}', {
      resolve: () => undefined,
      random: seqRandom([0, 0.5, 0.9999]),
    });
    expect(r.text).toBe('5');
  });

  it('$randomInt rejects bad args with diagnostic', () => {
    const r = substitute('{{$randomInt foo bar}}', {
      resolve: () => undefined,
    });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.text).toBe('{{$randomInt foo bar}}');
  });

  it('unknown built-in produces diagnostic and leaves placeholder', () => {
    const r = substitute('{{$nope}}', { resolve: () => undefined });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.text).toBe('{{$nope}}');
  });

  it('caps recorded injections against a hostile substitution flood (issue #47 review L2)', () => {
    // A hostile body with thousands of resolvable references must not make
    // the adapter's taint-closure input grow without bound. Text is still
    // fully substituted; only the recorded provenance list is capped — and
    // the overflow is FLAGGED so adapters fail closed (review r7 SEC1).
    const source = Array.from({ length: 2500 }, () => '{{v}}').join(',');
    const r = substitute(source, { resolve: (n) => (n === 'v' ? 'x' : undefined) });
    expect(r.text.split('x').length - 1).toBe(2500);
    expect(r.injected.length).toBeLessThanOrEqual(1000);
    expect(r.injected.length).toBeGreaterThan(0);
    expect(r.injectedOverflow).toBe(true);
  });

  it('flags no overflow when recording stays under the cap (SEC1 control)', () => {
    const source = Array.from({ length: 10 }, () => '{{v}}').join(',');
    const r = substitute(source, { resolve: (n) => (n === 'v' ? 'x' : undefined) });
    expect(r.injectedOverflow).toBe(false);
  });

  it('makeUuidV4 sets version + variant bits', () => {
    const uuid = makeUuidV4(seqRandom(Array(16).fill(0.123)));
    expect(uuid[14]).toBe('4');
    expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
  });
});

describe('substituteRequest', () => {
  it('substitutes URL, headers, and body and aggregates diagnostics', () => {
    const resolve = (n: string): string | undefined =>
      ({ baseUrl: 'https://api.test', token: 'abc' })[n];
    const r = substituteRequest(
      {
        url: '{{baseUrl}}/users/{{userId}}',
        headers: [
          { name: 'Authorization', value: 'Bearer {{token}}' },
          { name: 'X-Trace', value: 'static' },
        ],
        body: '{"id":"{{userId}}"}',
      },
      { resolve },
    );
    expect(r.url).toBe('https://api.test/users/{{userId}}');
    expect(r.headers[0].value).toBe('Bearer abc');
    expect(r.headers[1].value).toBe('static');
    expect(r.body).toBe('{"id":"{{userId}}"}');
    // userId is unresolved — should appear twice in diagnostics (url + body).
    expect(r.diagnostics.filter((d) => d.variable === 'userId')).toHaveLength(2);
  });
});
