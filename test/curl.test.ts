import { describe, expect, it } from 'vitest';
import { requestToCurl } from '../src/core/curl.js';
import type { UndiciRequestOptions } from '../src/core/request.js';

const base: UndiciRequestOptions = {
  method: 'GET',
  url: 'https://example.com/api',
  headers: {},
};

describe('requestToCurl', () => {
  it('renders a bare GET without an explicit method flag', () => {
    expect(requestToCurl(base)).toBe(`curl 'https://example.com/api'`);
  });

  it('emits headers as -H flags with single-quoted values', () => {
    const out = requestToCurl({
      ...base,
      headers: { Accept: 'application/json', 'X-Trace': 'abc 123' },
    });
    expect(out).toContain(`-H 'Accept: application/json'`);
    expect(out).toContain(`-H 'X-Trace: abc 123'`);
  });

  it('uses -X and --data-raw for non-GET with a body', () => {
    const out = requestToCurl({
      method: 'POST',
      url: 'https://example.com/x',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(out).toContain(`-X POST`);
    expect(out).toContain(`--data-raw '{"a":1}'`);
  });

  it('emits -X GET when a GET carries a body (rare but legal)', () => {
    const out = requestToCurl({ ...base, body: 'hello' });
    expect(out).toContain(`-X GET`);
    expect(out).toContain(`--data-raw 'hello'`);
  });

  it("escapes embedded single quotes via the '\\'' trick", () => {
    const out = requestToCurl({
      ...base,
      headers: { 'X-Note': "it's fine" },
    });
    expect(out).toContain(`-H 'X-Note: it'\\''s fine'`);
  });

  it('redacts secret values everywhere they appear', () => {
    const out = requestToCurl(
      {
        method: 'POST',
        url: 'https://example.com/secret/s3cr3t',
        headers: { Authorization: 'Bearer s3cr3t' },
        body: 'token=s3cr3t&id=1',
      },
      { redact: ['s3cr3t'] },
    );
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('***REDACTED***');
    // Should be redacted in URL, header, and body.
    expect(out.match(/\*\*\*REDACTED\*\*\*/g)?.length).toBe(3);
  });

  it('honours a custom redaction placeholder', () => {
    const out = requestToCurl(
      { ...base, headers: { Authorization: 'Bearer abc' } },
      { redact: ['abc'], redactPlaceholder: '<redacted>' },
    );
    expect(out).toContain('<redacted>');
    expect(out).not.toContain('abc');
  });

  it('ignores empty redact strings (never produces a degenerate split)', () => {
    const out = requestToCurl(
      { ...base, headers: { 'X-A': 'one' } },
      { redact: ['', 'one'] },
    );
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain(`X-A: one`);
  });

  // Issue #47 review S2: default cURL must match the canonical
  // `redactSecretText` semantics — JSON-escaped forms and longest-first
  // masking — or escaped secrets leak through to the clipboard.
  it('masks the JSON-escaped form of a secret (GraphQL variable re-serialization)', () => {
    const SECRET = 'sek' + 'r"et';
    const escaped = JSON.stringify(SECRET).slice(1, -1); // sek\"ret
    const out = requestToCurl(
      {
        method: 'POST',
        url: 'https://example.com/gql',
        headers: { 'content-type': 'application/json' },
        // Body as it goes on the wire: the secret embedded escaped inside a
        // JSON string value.
        body: `{"query":"mutation { login(token: \\"${escaped}\\") }"}`,
      },
      { redact: [SECRET] },
    );
    expect(out).not.toContain(escaped);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('***REDACTED***');
  });

  it('masks overlapping secrets longest-first with no longer-secret tail remnant', () => {
    const out = requestToCurl(
      {
        method: 'POST',
        url: 'https://example.com/x',
        headers: {},
        body: 'a=ovlap-longerval&b=ovlap',
      },
      { redact: ['ovlap', 'ovlap-longerval'] },
    );
    expect(out).not.toContain('ovlap');
    expect(out).not.toContain('longerval');
  });

  it('masks a raw form that prefixes another secret\'s escaped form (G-R3 class)', () => {
    const A = 'shared';
    const B = 'shared"tail'; // escapes to shared\"tail
    const out = requestToCurl(
      { ...base, url: `https://example.com/q?d=${JSON.stringify(B).slice(1, -1)}&a=${A}` },
      { redact: [A, B] },
    );
    expect(out).not.toContain('shared');
    expect(out).not.toContain('tail');
  });
});
