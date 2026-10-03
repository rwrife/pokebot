import { describe, expect, it } from 'vitest';

import { parseHttpFile, MAX_CAPTURES_PER_REQUEST } from '../src/core/parser.js';

/**
 * `# @capture` directive collection (issue #47 send-path slice).
 *
 * The existing `directives` record keeps only the LAST value for a repeated
 * key, which loses captures — a request commonly declares several. Captures
 * therefore get their own ordered array, mirroring the `@test` precedent.
 */
describe('parseHttpFile capture directive collection', () => {
  it('collects multiple # @capture lines in source order', () => {
    const { requests } = parseHttpFile(
      [
        '# @name login',
        '# @capture token = $.access_token',
        '# @capture count: number = $.meta.count',
        'POST https://example.test/login',
        '',
        '{}',
      ].join('\n'),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].captures).toEqual([
      'token = $.access_token',
      'count: number = $.meta.count',
    ]);
  });

  it('collects captures from the header area and // comments too', () => {
    const { requests } = parseHttpFile(
      [
        'GET https://example.test/x',
        '# @capture a = $.a',
        'X-Trace: on',
        '// @capture b = $.b',
        '',
      ].join('\n'),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].captures).toEqual(['a = $.a', 'b = $.b']);
  });

  it('request with no captures gets an empty array', () => {
    const { requests } = parseHttpFile('GET https://example.test/x\n');
    expect(requests).toHaveLength(1);
    expect(requests[0].captures).toEqual([]);
  });

  it('capture lines never leak into the request body', () => {
    const { requests } = parseHttpFile(
      [
        'POST https://example.test/x',
        'Content-Type: application/json',
        '',
        '{ "a": 1 }',
        '# @capture token = $.access_token',
      ].join('\n'),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toBe('{ "a": 1 }');
    expect(requests[0].captures).toEqual(['token = $.access_token']);
  });

  it('the `capture` directive key no longer keeps only the last value in directives', () => {
    // Guards the deliberate split: repeated `@capture` must not silently
    // collapse to the last value the way other directives do.
    const { requests } = parseHttpFile(
      ['# @capture a = $.a', '# @capture b = $.b', 'GET https://example.test/x', ''].join('\n'),
    );
    expect(requests[0].captures).toHaveLength(2);
  });

  it('caps capture directives per request at MAX_CAPTURES_PER_REQUEST with a diagnostic', () => {
    // Hostile-input bound (issue #47 review B5): a section declaring an
    // unbounded number of `# @capture` lines must not turn every send into
    // unbounded per-directive work. The parser keeps the first
    // MAX_CAPTURES_PER_REQUEST and says so instead of silently truncating.
    const lines: string[] = [];
    for (let i = 0; i < MAX_CAPTURES_PER_REQUEST + 8; i++) lines.push(`# @capture c${i} = $.c${i}`);
    lines.push('GET https://example.test/x', '');
    const { requests, diagnostics } = parseHttpFile(lines.join('\n'));
    expect(requests).toHaveLength(1);
    expect(requests[0].captures).toHaveLength(MAX_CAPTURES_PER_REQUEST);
    expect(requests[0].captures[0]).toBe('c0 = $.c0');
    const capDiags = diagnostics.filter((d) => d.message.includes('capture directives'));
    expect(capDiags).toHaveLength(1);
    expect(capDiags[0].message).toContain(`more than ${MAX_CAPTURES_PER_REQUEST}`);
  });
});
