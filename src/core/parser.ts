/**
 * Pure .http file parser. No VS Code dependencies — unit-testable.
 *
 * Format (REST Client-compatible subset):
 *   - Requests separated by lines starting with `###`
 *   - Optional comments: `#` or `//` at column 0
 *   - Request line: `METHOD URL [HTTP/x.y]`
 *   - Headers: `Name: value` until a blank line
 *   - Blank line, then body (rest of the section)
 */

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS'
  | 'TRACE';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'TRACE',
];

export interface ParsedHeader {
  name: string;
  value: string;
}

export interface ParsedRequest {
  /** Optional name from `### name` separator line, trimmed. */
  name?: string;
  method: HttpMethod;
  url: string;
  httpVersion?: string;
  headers: ParsedHeader[];
  /** Raw body string (no trailing newline). Empty string if no body. */
  body: string;
  /**
   * Directives parsed from `# @key value` / `// @key value` lines in this
   * section's preamble (before the request line). Multi-occurrence keys keep
   * the last value. Common keys: `auth`, `name`.
   */
  directives: Record<string, string>;
  /**
   * Test assertion expressions collected from `# @test <expr>` /
   * `// @test <expr>` comment lines anywhere in the section (preamble or
   * trailing). Order is source order. Each entry is a single-line
   * JavaScript expression to be evaluated against the response context
   * (see `src/core/assertions.ts`).
   */
  tests: string[];
  /**
   * Capture directive sources collected from `# @capture <name...>` /
   * `// @capture <name...>` comment lines anywhere in the section. Order
   * is source order; each entry is the raw text after `@capture` (parsed
   * by `parseCaptureDirective` from `src/core/chain/`). Unlike other
   * directives, captures accumulate instead of keeping only the last value
   * — a request commonly declares several.
   */
  captures: string[];
  /** 0-indexed line in source where the request line starts. */
  requestLineIndex: number;
  /** 0-indexed line range [start, endExclusive) covering this request section. */
  startLine: number;
  endLine: number;
}

export interface ParseDiagnostic {
  line: number;
  message: string;
}

export interface ParseResult {
  requests: ParsedRequest[];
  diagnostics: ParseDiagnostic[];
}

const METHOD_SET = new Set<string>(HTTP_METHODS);

/**
 * Upper bound on `# @capture` directives collected per request
 * (issue #47 review B5: hostile imported files must not turn every send
 * into unbounded per-directive capture work). Requests beyond the cap keep
 * their first `MAX_CAPTURES_PER_REQUEST` directives and get an explicit
 * parse diagnostic — never silent truncation.
 */
export const MAX_CAPTURES_PER_REQUEST = 32;

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  // `###` is a separator, not a comment — handled before this.
  return t.startsWith('#') || t.startsWith('//');
}

function isSeparator(line: string): boolean {
  return /^###/.test(line);
}

function parseRequestLine(
  line: string,
): { method: HttpMethod; url: string; httpVersion?: string } | null {
  const m = line.trim().match(/^([A-Z]+)\s+(\S+)(?:\s+(HTTP\/\S+))?\s*$/);
  if (!m) return null;
  const method = m[1];
  if (!METHOD_SET.has(method)) return null;
  const result: { method: HttpMethod; url: string; httpVersion?: string } = {
    method: method as HttpMethod,
    url: m[2],
  };
  if (m[3]) result.httpVersion = m[3];
  return result;
}

function parseHeaderLine(line: string): ParsedHeader | null {
  const idx = line.indexOf(':');
  if (idx <= 0) return null;
  const name = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  if (!name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return null;
  return { name, value };
}

/**
 * Split source into request sections. A section is the lines from one `###`
 * (or start of file) up to (but not including) the next `###`.
 */
function splitSections(lines: string[]): Array<{ start: number; end: number; name?: string }> {
  const sections: Array<{ start: number; end: number; name?: string }> = [];
  let current: { start: number; end: number; name?: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSeparator(line)) {
      if (current) {
        current.end = i;
        sections.push(current);
      }
      const name = line.replace(/^###/, '').trim() || undefined;
      current = name === undefined ? { start: i + 1, end: lines.length } : { start: i + 1, end: lines.length, name };
    } else if (!current) {
      // No `###` yet — implicit first section starts at line 0.
      current = { start: 0, end: lines.length };
    }
  }
  if (current) sections.push(current);
  return sections;
}

export function parseHttpFile(source: string): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const requests: ParsedRequest[] = [];

  // Normalize line endings, keep line indices stable.
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const sections = splitSections(lines);

  for (const section of sections) {
    // Find the request line: first non-blank, non-comment line in section.
    // Along the way, collect `@key value` directives from comment lines.
    const directives: Record<string, string> = {};
    const tests: string[] = [];
    const captures: string[] = [];
    let captureOverflow = 0;
    const collectDirective = (line: string): void => {
      const stripped = line.trimStart().replace(/^(#|\/\/)\s*/, '');
      const m = stripped.match(/^@([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.+?))?\s*$/);
      if (!m) return;
      const key = m[1];
      const value = (m[2] ?? '').trim();
      if (key === 'test') {
        if (value !== '') tests.push(value);
        return;
      }
      if (key === 'capture') {
        // Accumulates like `@test`; the last-value collapse for other
        // directive keys would silently drop all but the final capture.
        if (value !== '') {
          if (captures.length < MAX_CAPTURES_PER_REQUEST) captures.push(value);
          else captureOverflow++;
        }
        return;
      }
      directives[key] = value;
    };
    let i = section.start;
    while (i < section.end) {
      const l = lines[i];
      if (l.trim() === '') {
        i++;
        continue;
      }
      if (isCommentLine(l)) {
        collectDirective(l);
        i++;
        continue;
      }
      break;
    }
    if (i >= section.end) continue; // empty section

    const reqLineIdx = i;
    const parsed = parseRequestLine(lines[i]);
    if (!parsed) {
      diagnostics.push({
        line: i,
        message: `Expected request line "METHOD URL [HTTP/x.y]", got: ${lines[i]}`,
      });
      continue;
    }
    i++;

    // Headers until blank line or end-of-section.
    const headers: ParsedHeader[] = [];
    while (i < section.end) {
      const l = lines[i];
      if (l.trim() === '') {
        i++;
        break;
      }
      if (isCommentLine(l)) {
        collectDirective(l);
        i++;
        continue;
      }
      const h = parseHeaderLine(l);
      if (!h) {
        diagnostics.push({ line: i, message: `Invalid header line: ${l}` });
        i++;
        continue;
      }
      headers.push(h);
      i++;
    }

    // Body is the rest, with leading/trailing blank lines stripped.
    // `# @test ...` / `// @test ...` and `# @capture ...` /
    // `// @capture ...` lines inside the body region are pulled out as
    // assertions / captures and removed from the body so the request still
    // serializes cleanly.
    const bodyLines: string[] = [];
    for (; i < section.end; i++) {
      const bl = lines[i];
      if (isCommentLine(bl)) {
        const stripped = bl.trimStart().replace(/^(#|\/\/)\s*/, '');
        const m = stripped.match(/^@(test|capture)(?:\s+(.+?))?\s*$/);
        if (m) {
          const expr = (m[2] ?? '').trim();
          if (expr !== '') {
            if (m[1] === 'test') tests.push(expr);
            else if (captures.length < MAX_CAPTURES_PER_REQUEST) captures.push(expr);
            else captureOverflow++;
          }
          continue;
        }
      }
      bodyLines.push(bl);
    }
    while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
    const body = bodyLines.join('\n');

    const req: ParsedRequest = {
      method: parsed.method,
      url: parsed.url,
      headers,
      body,
      directives,
      tests,
      captures,
      requestLineIndex: reqLineIdx,
      startLine: section.start,
      endLine: section.end,
    };
    if (parsed.httpVersion !== undefined) req.httpVersion = parsed.httpVersion;
    if (section.name !== undefined) req.name = section.name;
    requests.push(req);
    if (captureOverflow > 0) {
      diagnostics.push({
        line: reqLineIdx,
        message:
          `request declares more than ${MAX_CAPTURES_PER_REQUEST} capture directives: ` +
          `kept the first ${MAX_CAPTURES_PER_REQUEST}, ignored ${captureOverflow} ` +
          `(capture limit)`,
      });
    }
  }

  return { requests, diagnostics };
}
