import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the VS Code host + socket boundaries are simulated; the activate
// path, parsers, chain core, substitution, and command wiring below are
// production code.
const host = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  createTreeView: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  openTextDocument: vi.fn(),
  undiciRequest: vi.fn(),
  renderResponse: vi.fn(),
  renderSseResponse: vi.fn(),
  renderGrpcInfo: vi.fn(),
  env: new Map<string, string>(),
  secrets: [] as string[],
  clipboardWrite: vi.fn(),
  showSaveDialog: vi.fn(),
  fsWriteFile: vi.fn(),
  fsCreateDirectory: vi.fn(),
}));

vi.mock('vscode', () => {
  class Uri {
    constructor(readonly path: string) {}
    toString() {
      return `file://${this.path}`;
    }
    static parse(value: string) {
      return new Uri(value.replace(/^file:\/\//, ''));
    }
    static joinPath(base: Uri, ...parts: string[]) {
      return new Uri([base.path, ...parts].join('/'));
    }
  }
  return {
    Uri,
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    TreeItem: class {
      constructor(
        public label: string,
        public collapsibleState: number,
      ) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    FileType: { File: 1, Directory: 2 },
    EventEmitter: class {
      event = vi.fn();
      fire = vi.fn();
    },
    RelativePattern: class {},
    commands: { registerCommand: host.registerCommand },
    window: {
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
      showErrorMessage: host.showErrorMessage,
      showWarningMessage: host.showWarningMessage,
      showInformationMessage: host.showInformationMessage,
      createTreeView: host.createTreeView,
      showSaveDialog: host.showSaveDialog,
    },
    languages: { registerCodeLensProvider: vi.fn() },
    workspace: {
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {} }),
      workspaceFolders: undefined,
      openTextDocument: host.openTextDocument,
      fs: {
        readFile: vi.fn(),
        readDirectory: vi.fn(),
        stat: vi.fn(),
        createDirectory: (...a: unknown[]) => host.fsCreateDirectory(...a),
        writeFile: (...a: unknown[]) => host.fsWriteFile(...a),
      },
    },
    env: { clipboard: { writeText: (...a: unknown[]) => host.clipboardWrite(...a) } },
    StatusBarAlignment: { Right: 2 },
  };
});

vi.mock('../src/extension/envManager.js', () => ({
  EnvManager: class {
    readonly active = 'default';
    async init() {}
    async buildResolver() {
      return {
        resolve: (name: string) => host.env.get(name),
        secretValues: [...host.secrets],
      };
    }
    listSecrets() {
      return [];
    }
    dispose() {}
  },
}));

vi.mock('../src/extension/responseView.js', () => ({
  renderResponse: host.renderResponse,
  renderSseResponse: host.renderSseResponse,
  renderGrpcInfo: host.renderGrpcInfo,
}));

vi.mock('undici', () => ({
  request: (...args: unknown[]) => host.undiciRequest(...args),
}));

import { activate } from '../src/extension/extension.js';
import type { ExtensionContext } from 'vscode';

/** Minimal undici response shape the extension consumes. */
function jsonResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', ...headers },
    body: { text: async () => body },
  };
}

/**
 * Hostile placeholder fixture: 1200 built-in candidates spread across 15
 * headers. Since the r9 request-wide scan-budget fix, this is rejected by the
 * chain-stage 100-candidate bound BEFORE env substitution. That ordering is
 * intentional: an attacker cannot bypass the scan bound by spreading junk
 * across fields, and no request/clipboard side effect occurs.
 */
function floodDoc(requestLine: string): string {
  const headers = Array.from(
    { length: 15 },
    (_, i) => `X-Flood${i}: ` + Array.from({ length: 80 }, () => '{{$guid}}').join(','),
  );
  return [requestLine, ...headers, '', 'ok'].join('\n');
}

function docWith(source: string) {
  host.openTextDocument.mockResolvedValue({
    getText: () => source,
    uri: { toString: () => 'file:///workspace/api.http' },
  });
}

function sendHandler(): (arg?: { documentUri: string; requestLineIndex: number }) => Promise<void> {
  return host.registerCommand.mock.calls.find(([name]) => name === 'reqit.sendRequest')![1];
}

beforeEach(() => {
  vi.resetAllMocks();
  host.env = new Map<string, string>();
  host.secrets = [];
  host.showSaveDialog.mockReset();
  host.fsWriteFile.mockReset();
  host.fsCreateDirectory.mockReset();
  host.clipboardWrite = vi.fn();
  host.createTreeView.mockReturnValue({ description: undefined, dispose: vi.fn() });
});

describe('extension send-path chaining wiring', () => {
  it('captures feed the next send; the secret never reaches a DERIVED render surface (raw view shows fetched data)', async () => {
    // Distinctive secret value built by concatenation so it is checkable
    // against rendered output without relying on transcript-level masking.
    // Scope boundary (issue #47 review r6, S1/S3): the login RESPONSE view
    // displays the raw body the user explicitly fetched — that is primary
    // data, not a derived surface, and it is pinned below so neither side
    // of the boundary can silently drift. DERIVED surfaces (the next
    // send's rendered request echo) must never carry the secret value.
    const SECRET = 'sek' + 'ret-77';
    docWith(
      [
        '### Login',
        '# @name login',
        '# @capture tok: string secret = $.access_token',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        '{ "u": "{{user}}" }',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('user', 'u1');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET, id: 42 })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    // Send 1: env-substituted, chain-clean request goes out normally.
    const [loginUrl, loginOpts] = host.undiciRequest.mock.calls[0];
    expect(loginUrl).toBe('https://api.test/login');
    expect(loginOpts.body).toBe('{ "u": "u1" }');

    // Boundary pin: the FIRST render is the login response view — the raw
    // body the user explicitly fetched. Per the recorded scope call this is
    // primary data and shows truthfully; pin it so the decision is explicit
    // and drift either way fails a test (issue #47 review r6 S1/S3).
    const loginRender = host.renderResponse.mock.calls[0]![1] as { body: string };
    expect(loginRender.body).toContain(SECRET);

    // Send 2: references both the recorded response and the secret capture.
    docWith(
      [
        '### Me',
        '# @name me',
        'GET {{host}}/me?ref={{login.response.body.$.id}}&t={{tok}}',
      ].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"ok":true}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    const [meUrl, meOpts] = host.undiciRequest.mock.calls[1];
    // The request that ACTUALLY goes out carries the real captured values.
    expect(meUrl).toBe(`https://api.test/me?ref=42&t=${SECRET}`);
    expect(meOpts).toBeDefined();

    // The rendered response view shows a redacted URL — the secret capture
    // value must not appear in derived surfaces.
    const rendered = host.renderResponse.mock.calls[1]![1] as {
      request: { url: string };
    };
    expect(rendered.request.url).not.toContain(SECRET);
    expect(rendered.request.url).toContain('[REDACTED]');
    // Non-secret chained value is fine to render.
    expect(rendered.request.url).toContain('ref=42');
  });

  it('unresolved chain references block the send with an actionable error', async () => {
    docWith(
      ['# @name login', '# @capture t = $.a', 'GET https://api.test/login', ''].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"a":1}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    docWith(['GET https://api.test/x?n={{login.response.body.$.missing}}'].join('\n'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    expect(host.undiciRequest).toHaveBeenCalledTimes(1);
    const msg = host.showErrorMessage.mock.calls.map((c) => c[0]).join('\n');
    expect(msg).toContain('chain');
    expect(msg).toContain('login.response.body.$.missing');
  });

  it('a failed request records nothing; later references fail loudly instead of reading a phantom response', async () => {
    docWith(['# @name flaky', 'GET https://api.test/flaky', ''].join('\n'));
    host.undiciRequest.mockRejectedValueOnce(new Error('connection reset'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 1 });
    expect(host.undiciRequest).toHaveBeenCalledTimes(1);

    docWith(['GET https://api.test/x?s={{flaky.response.status}}'].join('\n'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    expect(host.undiciRequest).toHaveBeenCalledTimes(1); // blocked, nothing sent
    const msg = host.showErrorMessage.mock.calls.map((c) => c[0]).join('\n');
    // Chain-stage diagnostic specifically (not the generic env-variable
    // fallback), naming the recorded request that has no stored response.
    expect(msg).toContain('chain');
    expect(msg).toContain('flaky');
  });

  it('capture evaluation errors warn but do not block the response render', async () => {
    docWith(
      [
        '# @name bad',
        '# @capture n: number = $.name',
        'GET https://api.test/x',
        '',
      ].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"name":"text"}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    expect(host.renderResponse).toHaveBeenCalledTimes(1);
    const notices = [
      ...host.showErrorMessage.mock.calls,
      ...host.showWarningMessage.mock.calls,
    ]
      .map((c) => c[0])
      .join('\n');
    expect(notices).toContain('n');
    expect(notices).toMatch(/number validation|failed number/);
  });

  it('ordinary requests without chain features behave exactly as before', async () => {
    docWith(['GET https://api.test/plain', ''].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(204, ''));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    expect(host.undiciRequest).toHaveBeenCalledTimes(1);
    expect(host.showErrorMessage).not.toHaveBeenCalled();
    expect(host.showWarningMessage).not.toHaveBeenCalled();
    expect(host.renderResponse).toHaveBeenCalledTimes(1);
    const rendered = host.renderResponse.mock.calls[0]![1] as { status: number };
    expect(rendered.status).toBe(204);
  });

  it('SSE reconnect re-sends the REAL wire request, never the redacted view copy', async () => {
    vi.useRealTimers();
    // Same send-then-reference flow as test 1, but the second response is
    // an SSE stream whose body ends immediately, forcing the transport's
    // reconnect path (default 3s backoff) to fire a real second request.
    const SECRET = 'sse' + 'cret-88';
    docWith(
      [
        '### Login',
        '# @name slogin',
        '# @capture stok: string secret = $.access_token',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        '{ "u": "{{user}}" }',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('user', 'u1');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET })),
    );
    host.renderSseResponse.mockReturnValue({ update: vi.fn(), dispose: vi.fn() });
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(
      [
        '### Stream',
        '# @name sstream',
        'GET {{host}}/events?tok={{stok}}',
      ].join('\n'),
    );
    // First SSE response: one frame, then the body ends -> reconnect.
    const firstBody = (async function* () {
      yield 'data: one\n\n';
    })();
    host.undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: firstBody,
    });
    // Reconnect response: headers resolve, body never delivers another
    // frame (the test aborts the stream instead of looping reconnects).
    const hang = () => new Promise<never>(() => {});
    const neverBody = {
      [Symbol.asyncIterator]: () => ({ next: hang }),
      setEncoding() {
        return this;
      },
    };
    host.undiciRequest.mockImplementation(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: neverBody,
    }));
    const streamPromise = sendHandler()({
      documentUri: 'file:///workspace/api.http',
      requestLineIndex: 2,
    });

    // Wait for the reconnect request (3s clamp backoff + margin).
    await vi.waitUntil(() => host.undiciRequest.mock.calls.length >= 3, { timeout: 6000 });
    const reconnectCall = host.undiciRequest.mock.calls[2] as [string, { headers: Record<string, string> }];
    // The wire request the reconnect replays must carry the REAL secret —
    // a literal `[REDACTED]` here would break the stream (issue #47 review
    // blocker B1: the redacted view copy must never feed the transport).
    expect(reconnectCall[0]).toBe(`https://api.test/events?tok=${SECRET}`);
    expect(String(reconnectCall[0]).includes('[REDACTED]')).toBe(false);

    // Stop the stream so the driver settles and later tests start clean.
    const stopCommand = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.stopSseStreams',
    );
    if (stopCommand) await (stopCommand[1] as () => Promise<unknown> | unknown)();
    await Promise.race([streamPromise, new Promise((r) => setTimeout(r, 1500))]);
    host.undiciRequest.mockReset();
    host.undiciRequest.mockImplementation(async () => jsonResponse(200, '{}'));
  }, 15_000);

  it('a secret capture substituted into the BODY is absent from the ENTIRE rendered request object', async () => {
    const SECRET = 'bod' + 'ysecret-99';
    docWith(
      [
        '### LoginBody',
        '# @name blogin',
        '# @capture btok: string secret = $.access_token',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        '{ "u": "{{user}}" }',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('user', 'u1');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    // The SECOND send puts the secret capture into the request BODY, and
    // the SAME options object that goes on the wire is what crosses the
    // render boundary (extension.ts renderRequest). The secret must be
    // provenance-tracked and scrubbed from EVERY string in that object —
    // url, header values, AND body (issue #47 review blocker B2: whole
    // object scrub, not url+headers only).
    docWith(
      ['### Pay', '# @name bpay', 'POST {{host}}/pay', '', '{"token":"{{btok}}"}'].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(201, '{"ok":1}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });
    const [, payOpts] = host.undiciRequest.mock.calls[1] as [string, { body: string }];
    expect(String(payOpts.body)).toContain(SECRET);

    // The object handed to the renderer must not contain the secret ANYWHERE.
    const rendered = host.renderResponse.mock.calls[1]![1] as {
      request: Record<string, unknown>;
    };
    const renderedRequestText = JSON.stringify(rendered.request);
    expect(renderedRequestText).not.toContain(SECRET);
    // Non-vacuity: the value the boundary DID sanitize is the real secret,
    // so absence can only come from redaction (fixture present on the wire).
    expect(String(payOpts.body)).toContain(SECRET);
    expect(renderedRequestText).toContain('[REDACTED]');
  });

  it('re-sending a named request REFRESHES its own captures instead of deadlocking on duplicates', async () => {
    // Interactive reality: users re-run `# @name login` after the token
    // expires. The same named exchange must update the captures IT owns
    // (issue #47 review blocker B4: owner-keyed capture recording); the
    // window store is shared across every earlier test in this file, so
    // the pre-fix first-wins rule would pin the stale token here.
    docWith(
      [
        '### Login100',
        '# @name login100',
        '# @capture l100tok: string secret = $.access_token',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    const FIRST = 'tok-' + 'first';
    const SECOND = 'tok-' + 'second';
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, JSON.stringify({ access_token: FIRST })));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, JSON.stringify({ access_token: SECOND })));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });
    const duplicateWarnings = host.showWarningMessage.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('duplicate capture name'));
    expect(duplicateWarnings).toEqual([]);

    // The downstream request must carry the REFRESHED token, not the stale one.
    docWith(['GET {{host}}/me?tk={{l100tok}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });
    const [meUrl] = host.undiciRequest.mock.calls.at(-1) as [string];
    expect(meUrl).toBe(`https://api.test/me?tk=${SECOND}`);
    expect(meUrl).not.toContain(FIRST);
  });

  it('a secret capture reaching the wire through GraphQL JSON-escaping is still scrubbed from the rendered copy (F1)', async () => {
    // toUndiciRequest re-serializes `# @graphql` bodies as JSON, so a
    // captured secret containing `"` crosses the wire as `sec\"ret` — the
    // raw string no longer appears, but the ESCAPED form does. The render
    // boundary must scrub both forms (issue #47 review F1).
    const SECRET = 'sek' + 'r"et-88';
    docWith(
      [
        '### GqlLogin',
        '# @name glogin',
        '# @capture gtok: string secret = $.access_token',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        '{ "u": "u1" }',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(
      [
        '### Gql',
        '# @name gpay',
        '# @graphql',
        'POST {{host}}/graphql',
        '',
        'query Q { f(token: "{{gtok}}") }',
      ].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"data":{}}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    const [, wireOpts] = host.undiciRequest.mock.calls[1] as [string, { body: string }];
    // Non-vacuity: the wire body carries the secret in SOME form (escaped).
    const wireBody = String(wireOpts.body);
    expect(wireBody.includes(SECRET) || wireBody.includes(JSON.stringify(SECRET).slice(1, -1))).toBe(true);

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(SECRET);
    expect(renderedText).not.toContain(JSON.stringify(SECRET).slice(1, -1));
    expect(renderedText).toContain('[REDACTED]');
  });

  it('an env-SECRET expanded through a chained capture is scrubbed from the rendered copy (F1)', async () => {
    // Chained substitution: the capture VALUE is `{{inner}}`, and the env
    // stage later expands it into the real env secret. The listed capture
    // value never appears on the wire — the final env secret does — so the
    // render boundary must redact env secret values too (issue #47 F1).
    const ENV_SECRET = 'env' + '-final-99';
    docWith(
      [
        '### ChainedLogin',
        '# @name clogin',
        '# @capture ctok: string secret = $.tpl',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('inner', ENV_SECRET);
    host.secrets.push(ENV_SECRET);
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ tpl: '{{inner}}' })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(['GET {{host}}/me?tk={{ctok}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const [wireUrl] = host.undiciRequest.mock.calls[1] as [string];
    // Non-vacuity: the env secret IS the final wire value.
    expect(wireUrl).toBe(`https://api.test/me?tk=${ENV_SECRET}`);

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(ENV_SECRET);
    expect(renderedText).toContain('[REDACTED]');
  });

  it('a secret capture expanded through a PLAIN env value (not SecretStorage) is still scrubbed (F1-R3)', async () => {
    // Reviewer round-3 finding: taint must survive the env substitution
    // stage even when the final value comes from an ORDINARY env entry.
    // A SecretStorage-only redaction list would miss this exact path.
    const PLAIN_FINAL = 'plain' + '-env-77';
    docWith(
      [
        '### PlainLogin',
        '# @name plogin',
        '# @capture ptok: string secret = $.tpl',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('inner', PLAIN_FINAL); // deliberately NOT in host.secrets
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ tpl: '{{inner}}' })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(['GET {{host}}/me?tk={{ptok}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const [wireUrl] = host.undiciRequest.mock.calls[1] as [string];
    // Non-vacuity: the plain env value IS the final wire value.
    expect(wireUrl).toBe(`https://api.test/me?tk=${PLAIN_FINAL}`);

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(PLAIN_FINAL);
    expect(renderedText).toContain('[REDACTED]');
  });

  it('a recorded request body never retains env-secret material after rotation (F1-R3)', async () => {
    // The store records `{{name.request.body.$…}}` sources. If the recorded
    // copy kept the post-substitution secret, rotating the env would drop
    // the value from the current redaction set while a later reference
    // re-emits the OLD secret (issue #47 review F1-R3: provenance lost
    // across rotation). Recording must scrub known secret values instead.
    const OLD = 'rot' + 'ate-old';
    docWith(
      [
        '### RotateLogin',
        '# @name rlogin',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        '{ "pass": "{{pw}}" }',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('pw', OLD);
    host.secrets.push(OLD);
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    // Rotate: the env now holds a different value and the old one is gone
    // from SecretStorage — the current redaction set knows nothing of OLD.
    host.secrets.length = 0;
    host.env.set('pw', 'rot-new');

    docWith(['GET {{host}}/x?b={{rlogin.request.body.$.pass}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(OLD);
    // The reference itself must carry the scrubbed form, proving the STORE
    // (not just this render) excluded the secret: wire URL shows it too.
    const [wireUrl] = host.undiciRequest.mock.calls[1] as [string];
    expect(wireUrl).not.toContain(OLD);
    expect(wireUrl).toContain('[REDACTED]');
  });

  it('copy-as-cURL resolves chain refs and never leaks a secret capture (D-R3)', async () => {
    // The clipboard is an export surface: it must reproduce what Send
    // Request WOULD send (chain refs resolved) while scrubbing secret
    // provenance (issue #47 review D).
    const SECRET = 'curl' + 'secret-66';
    docWith(
      [
        '### CurlLogin',
        '# @name clogin',
        '# @capture ctok: string secret = $.access_token',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(['GET {{host}}/me?tk={{ctok}}'].join('\n'));
    const curlHandler = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.copyAsCurl',
    )![1] as (a: { documentUri: string; requestLineIndex: number }) => Promise<void>;
    await curlHandler({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const copied = host.clipboardWrite.mock.calls.map((c: unknown[]) => String(c[0]));
    // Non-vacuity: something was copied and it is the chained request.
    expect(copied.length).toBe(1);
    expect(copied[0]).toContain('https://api.test/me');
    expect(copied[0]).not.toContain('{{ctok}}');
    // The secret itself must not reach the clipboard by default...
    expect(copied[0]).not.toContain(SECRET);
    // ...but its placeholder in the resolved target proves scrubbing
    // happened (otherwise 'not.toContain(SECRET)' would pass vacuously on a
    // broken copy). The cURL exporter uses its own marker.
    expect(copied[0]).toContain('***REDACTED***');
  });

  it('duplicate # @name declarations in the file block the send with an actionable error (E-R3)', async () => {
    // The store is name-keyed: two source requests sharing one name would
    // silently overwrite each other's exchange/captures (issue #47 review
    // E). Production must enforce the documented per-file uniqueness.
    docWith(
      [
        '### One',
        '# @name dup',
        'GET {{host}}/a',
        '',
        '### Two',
        '# @name dup',
        'GET {{host}}/b',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    const texts = host.showErrorMessage.mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => t.includes("duplicate request name 'dup'"))).toBe(true);
    expect(host.undiciRequest.mock.calls.length).toBe(0);
  });

  it('capture-overflow parser diagnostics surface as a bounded warning (F-R3)', async () => {
    // The parser truncates >32 capture directives but says so only in
    // parse diagnostics; the send path must report that, not truncate
    // silently (issue #47 review F).
    const caps = Array.from({ length: 40 }, (_, i) => `# @capture c${i} = $.c${i}`);
    docWith(['### Flood', '# @name flood', 'GET {{host}}/x', ...caps].join('\n'));
    host.env.set('host', 'https://api.test');
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    const warnings = host.showWarningMessage.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('capture limit'))).toBe(true);
  });

  it('a hostile oversized directive yields a LENGTH-BOUNDED warning (G-R3)', async () => {
    const huge = 'x'.repeat(5000);
    // Invalid type: the diagnostic echoes the directive text, so an
    // unbounded toast would embed the full hostile payload.
    docWith(
      ['### Hostile', '# @name hostile', 'GET {{host}}/x', `# @capture tok: ${huge} = $.a`].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{\"a\":1}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    const warnings = host.showWarningMessage.mock.calls.map((c) => String(c[0]));
    // Non-vacuity: the hostile directive DID produce a diagnostic toast.
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) expect(w.length).toBeLessThan(1200);
  });

  it('a transport error whose message embeds the secret is redacted everywhere (C-R3)', async () => {
    // undici embeds the full request target in some failure messages. The
    // notification AND the rendered error body must not echo a secret even
    // when the raw exception text contains it (issue #47 review C).
    const SECRET = 'boom' + 'secret-31';
    docWith(['POST {{host}}/x?tk={{tk}}'].join('\n'));
    host.env.set('host', 'https://api.test');
    host.env.set('tk', SECRET);
    host.secrets.push(SECRET);
    host.undiciRequest.mockRejectedValueOnce(
      new Error(`connect ECONNREFUSED https://api.test/x?tk=${SECRET}`),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    // Non-vacuity: the send genuinely reached the transport layer.
    expect(host.undiciRequest.mock.calls.length).toBe(1);
    for (const call of host.showErrorMessage.mock.calls) {
      expect(String(call[0])).not.toContain(SECRET);
    }
    expect(host.showErrorMessage.mock.calls.length).toBeGreaterThan(0);
    // The rendered error surface MUST exist (unconditional assertion — the
    // panel copy is part of the redaction contract, issue #47 review r6).
    expect(host.renderResponse.mock.calls.length).toBeGreaterThan(0);
    const rendered = host.renderResponse.mock.calls[0]![1] as { body: string };
    expect(rendered.body).not.toContain(SECRET);
  });

  it('a transport error embedding a raw (non-URL-shaped) secret is scrubbed (C-R3)', async () => {
    // sanitizeSseErrorText strips URL queries and key=value assignments, but
    // a secret embedded bare in failure text (reflected by a proxy/socket
    // layer) survives it. The notification must still be secret-free.
    const SECRET = 'bare' + 'embed-57';
    docWith(['POST {{host}}/x?tk={{tk}}'].join('\n'));
    host.env.set('host', 'https://api.test');
    host.env.set('tk', SECRET);
    host.secrets.push(SECRET);
    host.undiciRequest.mockRejectedValueOnce(
      new Error(`socket hang up near ${SECRET} while writing`),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    expect(host.undiciRequest.mock.calls.length).toBe(1);
    const texts = host.showErrorMessage.mock.calls.map((c) => String(c[0]));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).not.toContain(SECRET);
    // Unconditional: the rendered error panel copy must also be scrubbed.
    expect(host.renderResponse.mock.calls.length).toBeGreaterThan(0);
    const rendered = host.renderResponse.mock.calls[0]![1] as { body: string };
    expect(rendered.body).not.toContain(SECRET);
  });

  it('a pre-transport validation error containing a secret is redacted (C-R3)', async () => {
    // toUndiciRequest throws a ZodError whose text embeds the INVALID
    // INPUT (the substituted URL with the secret in its query). The
    // 'invalid request' notification must scrub it (issue #47 review C).
    const SECRET = 'zval' + 'id-42';
    docWith(['POST /relative-only?tk={{tk}}'].join('\n'));
    host.env.set('tk', SECRET);
    host.secrets.push(SECRET);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const texts = host.showErrorMessage.mock.calls.map((c) => String(c[0]));
    // Non-vacuity: this must be the invalid-request path, not a silent skip.
    expect(texts.some((t) => t.includes('invalid request'))).toBe(true);
    for (const t of texts) expect(t).not.toContain(SECRET);
  });

  it('two overlapping secret captures leave no prefix remnant in the rendered copy (F1)', async () => {
    // `short` is a prefix of `short-long`: redaction must apply the LONGER
    // value first, or masking the prefix exposes the tail of the long one.
    const SHORT = 'ov' + 'lap';
    const LONG = SHORT + '-longerval';
    docWith(
      [
        '### OverlapLogin',
        '# @name ologin',
        '# @capture s1: string secret = $.a',
        '# @capture s2: string secret = $.b',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ a: SHORT, b: LONG })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 4 });

    docWith(['GET {{host}}/x?a={{s1}}&b={{s2}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(LONG);
    expect(renderedText).not.toContain(SHORT);
    expect(renderedText).not.toContain('-longerval'); // no prefix-remnant leak
  });

  it('a flood of capture diagnostics produces a BOUNDED warning message (B5)', async () => {
    // Hostile-input bound (issue #47 review B5): diagnostics must never be
    // joined into one unbounded toast. With the parser cap (32) each
    // duplicate capture yields its own diagnostic; the adapter must render
    // a bounded summary, not a megabyte-long warning.
    const n = 32;
    const lines = ['### flood', '# @name flood'];
    for (let i = 0; i < n; i++) lines.push(`# @capture dup${i} = $.dup${i}`);
    lines.push('GET {{host}}/flood', '');
    docWith(lines.join('\n'));
    host.env.set('host', 'https://api.test');
    // Seed every capture name under a DIFFERENT owner so all 32 collide.
    const seeded = ['### seed', '# @name seeder'];
    for (let i = 0; i < n; i++) seeded.push(`# @capture dup${i} = $.dup${i}`);
    seeded.push('POST {{host}}/seed', '', '{}');
    docWith(seeded.join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, JSON.stringify({
      ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`dup${i}`, `v${i}`])),
    })));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: n + 2 });

    docWith(lines.join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, JSON.stringify(
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`dup${i}`, `w${i}`])),
    )));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: n + 2 });

    const captureWarnings = host.showWarningMessage.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('capture issues'));
    expect(captureWarnings.length).toBeGreaterThan(0);
    for (const w of captureWarnings) {
      // Bounded output: a bounded list plus an "... and N more" summary —
      // never 32 verbatim joined diagnostics.
      expect(w.length).toBeLessThan(2000);
      if (w.includes('duplicate')) expect(w).toMatch(/\d+ more/);
    }
  });

  it('a COMPOSITE secret template with an EMPTY env expansion is masked whole on the render copy (S5)', async () => {
    // Reviewer round-6 finding S5: the capture value is the template
    // `prefix{{inner}}suffix`; the env stage collapses `{{inner}}` to '' so
    // the wire carries `prefixsuffix` — neither the template nor any
    // injected component appears in it. The derived-variant closure must
    // mask the complete derived value, not just components.
    const COLLAPSED = 'pre' + 'fixsuffix';
    docWith(
      [
        '### TplLogin',
        '# @name tlogin',
        '# @capture ttok: string secret = $.tpl',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('inner', ''); // empty expansion
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ tpl: `pre{{inner}}fixsuffix` })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(['GET {{host}}/me?tk={{ttok}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const [wireUrl] = host.undiciRequest.mock.calls[1] as [string];
    // Non-vacuity: the collapsed composite IS the wire value.
    expect(wireUrl).toBe(`https://api.test/me?tk=${COLLAPSED}`);

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(COLLAPSED);
    expect(renderedText).toContain('[REDACTED]');
  });

  it('a builtin ($guid) expansion inside a secret capture is scrubbed from the render copy (r6 doc claim)', async () => {
    // The CHANGELOG claims builtin taint coverage. Production path: the
    // captured value is a template holding `{{$guid}}`; the chain stage
    // emits it literally and the env stage expands the builtin to a random
    // value that CANNOT be recomputed — only the substitution provenance
    // (`injected`) reveals it, and the derived-variant closure must add the
    // FULL derived value (component + `gtag-` prefix intact).
    docWith(
      [
        '### GuidLogin',
        '# @name glogin',
        '# @capture gtok: string secret = $.tpl',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ tpl: 'gtag-{{$guid}}' })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(['GET {{host}}/me?t={{gtok}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const [wireUrl] = host.undiciRequest.mock.calls[1] as [string];
    // Non-vacuity: a concrete guid went out through the chain+env stages.
    const m = /\?t=gtag-([0-9a-f-]{36})$/.exec(wireUrl);
    expect(m).not.toBeNull();
    const GUID = m![1]!;
    expect(wireUrl).not.toContain('{{$guid}}');

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(GUID);
    expect(renderedText).not.toContain('gtag-' + GUID);
    expect(renderedText).toContain('[REDACTED]');
  });

  it('copy-as-cURL with revealSecrets=true is an EXPLICIT reveal and carries the secret (r6 gap)', async () => {
    // revealSecrets=true is the documented explicit-reveal path: the
    // clipboard must contain the real value (proving default redaction is
    // an actual mask, not a copy that simply never resolves refs).
    const SECRET = 'rev' + 'eal-13';
    docWith(
      [
        '### RevLogin',
        '# @name vlogin',
        '# @capture rtok: string secret = $.access_token',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(['GET {{host}}/me?tk={{rtok}}'].join('\n'));
    const curlHandler = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.copyAsCurl',
    )![1] as (a: { documentUri: string; requestLineIndex: number; revealSecrets?: boolean }) => Promise<void>;
    await curlHandler({
      documentUri: 'file:///workspace/api.http',
      requestLineIndex: 0,
      revealSecrets: true,
    });

    const copied = host.clipboardWrite.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(copied.length).toBe(1);
    expect(copied[0]).toContain(SECRET);
    expect(copied[0]).not.toContain('***REDACTED***');
  });

  it('copy-as-cURL on an invalid request reports a scrubbed error and copies nothing (r6 gap)', async () => {
    // Validation errors embed the substituted URL; the clipboard must stay
    // untouched and the toast secret-free.
    const SECRET = 'cinval' + '-88';
    docWith(['POST /relative-only?tk={{tk}}'].join('\n'));
    host.env.set('tk', SECRET);
    host.secrets.push(SECRET);
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const handler = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.copyAsCurl',
    )![1] as (a: { documentUri: string; requestLineIndex: number }) => Promise<void>;
    await handler({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const texts = host.showErrorMessage.mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => t.includes('invalid request'))).toBe(true);
    for (const t of texts) expect(t).not.toContain(SECRET);
    expect(host.clipboardWrite.mock.calls.length).toBe(0);
  });

  it('request-wide placeholder bound blocks hostile cross-field junk before substitution (r9 LOGIC2 reachability)', async () => {
    docWith(floodDoc('POST {{host}}/x?tk={{tk}}'));
    host.env.set('host', 'https://api.test');
    host.env.set('tk', 'sec' + 'ret-42');
    host.secrets.push('sec' + 'ret-42');
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    expect(host.undiciRequest.mock.calls.length).toBe(0);
    const texts = host.showErrorMessage.mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => /too many placeholders in one pass/i.test(t))).toBe(true);
  });

  it('copy-as-cURL also blocks on request-wide placeholder candidate overflow (r9 LOGIC2 copy path)', async () => {
    docWith(floodDoc('POST {{host}}/x?tk={{tk}}'));
    host.env.set('host', 'https://api.test');
    host.env.set('tk', 'sec' + 'ret-43');
    host.secrets.push('sec' + 'ret-43');
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const handler = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.copyAsCurl',
    )![1] as (a: { documentUri: string; requestLineIndex: number }) => Promise<void>;
    await handler({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });
    expect(host.clipboardWrite.mock.calls.length).toBe(0);
    const texts = host.showErrorMessage.mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => /unresolved chain references/i.test(t))).toBe(true);
  });

  it('a declared-but-invalid @name warns on the activate path and records nothing', async () => {
    docWith(['# @name 1bad-name', 'GET https://api.test/x', ''].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"a":1}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 1 });

    // The request itself still goes out (the name is not on the wire).
    expect(host.undiciRequest).toHaveBeenCalledTimes(1);
    const warnings = host.showWarningMessage.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnings).toContain('1bad-name');

    // ...and nothing was recorded for it. `1bad-name` is not a legal chain
    // identifier, so a `{{1bad-name.response.status}}` reference is not
    // chain-shaped and falls through to the ENV stage: it must fail as an
    // UNRESOLVED VARIABLE (env wording), never resolve and never produce a
    // chain-stage diagnostic — proving no chain record exists for the name.
    docWith(['GET https://api.test/y?n={{1bad-name.response.status}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });
    expect(host.undiciRequest).toHaveBeenCalledTimes(1); // blocked by env stage
    const errors = host.showErrorMessage.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errors).toContain('unresolved variables');
    expect(errors).not.toContain('unresolved chain references');
  });
});

  it('SSE transcript records are scrubbed of render secrets (review r7 SEC3)', async () => {
    // The explicitly-accepted boundary is the LIVE view (raw fetched data
    // shows truthfully). The TRANSCRIPT is a persisted derived surface:
    // event data echoed into the saved .jsonl must carry the redaction the
    // documented boundary requires.
    const SECRET = 'sse' + 'ret-77';
    const RETRY_SECRET = '2' + '3';
    host.env.set('host', 'https://api.test');
    host.env.set('echo', SECRET);
    host.secrets.push(SECRET, RETRY_SECRET);
    docWith(['GET {{host}}/events?e={{echo}}', '# @sse-max-events 1', ''].join('\n'));
    host.renderSseResponse.mockReturnValue({ update: vi.fn(), dispose: vi.fn() });
    // One event whose data echoes the secret, then a clean end-of-stream.
    const rawFrame = `id: ${SECRET}\nevent: ${SECRET}-type\nretry: 123\ndata: token=${SECRET}\n\n`;
    // Non-vacuity: the exact raw frame consumed by the parser carries both
    // the string secret and the retry-secret substring.
    expect(rawFrame).toContain(SECRET);
    expect(rawFrame).toContain(RETRY_SECRET);
    const body = (async function* () {
      // Hostile event: secret echoed in data AND smuggled into the id:
      // field (type/lastEventId are attacker-controlled strings), while a
      // numeric retry contains another secret as a substring.
      yield rawFrame;
    })();
    host.undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body,
    });
    // Save dialog accepts; capture the transcript bytes written to disk.
    host.showSaveDialog.mockResolvedValue({ fsPath: '/tmp/x.jsonl', path: '/tmp/x.jsonl' });
    // The completion toast offers 'Save transcript'; answering it drives the
    // production save path whose bytes we assert below.
    host.showInformationMessage.mockImplementation(async (_msg: unknown, ...choices: unknown[]) =>
      choices.includes('Save transcript') ? 'Save transcript' : undefined,
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    // The transcript content held for "Save transcript" (via the info toast
    // path) — inspect what would be written: buildLastSseTranscript output
    // is captured through the save dialog mock above; assert via writeFile.
    const writes = host.fsWriteFile.mock.calls.map(
      (c) => new TextDecoder().decode(c[1] as Uint8Array),
    );
    expect(writes.length).toBeGreaterThan(0);
    const content = writes.join('\n');
    expect(content).toContain('token=');
    expect(content).not.toContain(SECRET);
    // The retry value (123) carries the second secret as a substring, so
    // the persisted record must omit the retry field entirely. (Asserting
    // the absence of the digit substring itself would be flaky against the
    // record's own wall-clock timestamp.)
    expect(content).not.toContain('"retry"');
    expect(content).toContain('[REDACTED]');
  });

  it('a JSON request body with an unquoted secret stays referenceable after recording (r7 LOGIC3)', async () => {
    // The store copy of the recorded request body must remain valid JSON:
    // masking the numeric secret as a STRING keeps unrelated fields
    // resolvable through {{name.request.body.$…}} for the rest of the run.
    const NUM_SECRET = '987654321';
    docWith([
      '### Login',
      '# @name mlogin',
      'POST {{host}}/login',
      'content-type: application/json',
      '',
      `{ "pin": ${NUM_SECRET}, "user": "u1" }`,
    ].join('\n'));
    host.env.set('host', 'https://api.test');
    host.secrets.push(NUM_SECRET);
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"ok":true}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    // Reference an UNRELATED field of the recorded body — impossible if the
    // scrub broke JSON validity.
    docWith(['GET {{host}}/x?u={{mlogin.request.body.$.user}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const secondCall = host.undiciRequest.mock.calls[1] as [string];
    expect(secondCall[0]).toBe('https://api.test/x?u=u1');
    // Non-vacuity: the wire body carried the raw secret; only the store copy
    // is scrubbed.
    const firstCall = host.undiciRequest.mock.calls[0] as [string, { body?: string }];
    expect(String(firstCall[1].body)).toContain(NUM_SECRET);
  });

  it('a JSON body whose secret lives in the JSON structure records NO body and fails references closed (r11)', async () => {
    // Reviewer r11 repro end-to-end: the secret `":"` sits between the key
    // and value tokens of the wire body, so NO scrub candidate can be both
    // valid JSON and secret-free. The scrubber must refuse (null) and the
    // adapter must then store the empty "no recordable body" state — a
    // later {{name.request.body.$…}} reference fails with the actionable
    // not-valid-JSON diagnostic and blocks the send, while the real wire
    // request is unaffected.
    const SYNTAX_SECRET = '":"' + ''; // concat: survives transcript redaction
    docWith(
      [
        '### SyntaxLogin',
        '# @name slogin',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        // Non-vacuity: the wire body genuinely contains the secret at the
        // key/value boundary (`"pin" : "123"` without whitespace), and the
        // decoded JSON strings never contain it — it lives ONLY in the
        // serialization structure, which no leaf-level scrub can remove.
        '{"pin":"123"}',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.secrets.push(SYNTAX_SECRET);
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"ok":true}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    // Non-vacuity: the FIRST wire request genuinely carried the secret and
    // succeeded — the exchange WAS received, so recording was attempted.
    const firstCall = host.undiciRequest.mock.calls[0] as [string, { body?: string }];
    expect(String(firstCall[1].body)).toContain(SYNTAX_SECRET);

    // Reference a body field: the store refused the body, so the chain
    // reference must fail loudly and block the send (no second wire call).
    docWith(['GET {{host}}/x?b={{slogin.request.body.$.pin}}'].join('\n'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });
    expect(host.undiciRequest.mock.calls.length).toBe(1);
    const texts = host.showErrorMessage.mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => t.includes('not valid JSON'))).toBe(true);
    // The secret never reached any rendered surface: no second render echo
    // exists at all (the send was blocked before rendering).
    expect(host.renderResponse.mock.calls.length).toBe(1);
  });

  it('a secret template whose derivation hits the closure bound BLOCKS the send (r9 fail-closed)', async () => {
    // The secret is a self-referencing template: its expansion closure is
    // cut off at MAX_DERIVED_ADDITIONS, so the adapter cannot prove it knows
    // every wire form -> block rather than redact from a partial set.
    // The request references the secret template so the env stage injects
    // `{{loop}}` -> `L{{loop}}`; the closure then self-expands until the
    // derived-additions bound cuts it off.
    docWith(['POST {{host}}/x', '', '{{loop}}'].join('\n'));
    host.env.set('host', 'https://api.test');
    host.env.set('loop', 'L{{loop}}');
    host.secrets.push('L{{loop}}');
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });
    expect(host.undiciRequest.mock.calls.length).toBe(0);
    const texts = host.showErrorMessage.mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => t.includes('too many substitutions'))).toBe(true);
  });

  it('copy-as-cURL blocks on truncated derivation closure too (r9 copy path)', async () => {
    docWith(['POST {{host}}/x', '', '{{loop}}'].join('\n'));
    host.env.set('host', 'https://api.test');
    host.env.set('loop', 'L{{loop}}');
    host.secrets.push('L{{loop}}');
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    const handler = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.copyAsCurl',
    )![1] as (a: { documentUri: string; requestLineIndex: number }) => Promise<void>;
    await handler({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });
    expect(host.clipboardWrite.mock.calls.length).toBe(0);
  });
