import { describe, expect, it } from 'vitest';

import { SAMPLE_CHAIN_HTTP } from '../src/extension/sampleFiles.js';
import { parseHttpFile } from '../src/core/parser.js';
import {
  createChainStore,
  isValidChainName,
  prepareChainSend,
  recordChainExchange,
} from '../src/core/chain/index.js';

/**
 * The scaffolded `.requests/chain.http` sample (issue #47) must stay
 * valid against the real parser and the real send-path pipeline: if the
 * grammar or directive collection drifts, this test breaks, not the user.
 */
describe('chain.http sample', () => {
  it('parses into three named requests with captures collected', () => {
    const { requests, diagnostics } = parseHttpFile(SAMPLE_CHAIN_HTTP);
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.directives['name'])).toEqual(['login', 'me', 'logout']);
    for (const r of requests) expect(isValidChainName(r.directives['name'])).toBe(true);
    expect(requests[0].captures).toEqual(['tok: string secret = $.token']);
    expect(requests[1].captures).toEqual([]);
  });

  it('the documented login -> me -> logout sequence resolves end-to-end', () => {
    const { requests } = parseHttpFile(SAMPLE_CHAIN_HTTP);
    const [login, me, logout] = requests;
    const store = createChainStore();

    // login responds -> capture applied, exchange recorded
    const loginRecord = recordChainExchange(
      store,
      login.directives['name'],
      login.captures,
      login.body,
      {
        received: true,
        status: 200,
        headers: {},
        body: '{"token":"tk-1"}',
      },
    );
    expect(loginRecord.diagnostics).toEqual([]);

    // me resolves both the response-path ref and the header path
    const meSend = prepareChainSend(
      {
        url: me.url.replace('{{baseUrl}}', 'https://x.test'),
        headers: me.headers,
        body: me.body,
      },
      store,
    );
    expect(meSend.diagnostics).toEqual([]);
    expect(meSend.headers[0].value).toBe('Bearer tk-1');
    // The `me` request directly references the secret-captured field.
    // Provenance is now value-equality-based (issue #47 review B3): a
    // direct response ref whose substituted text EQUALS a secret capture
    // value is redaction-listed exactly like a bare `{{tok}}` ref.
    expect(meSend.resolvedSecrets).toEqual(['tk-1']);
    expect(meSend.resolvedSecretNames).toEqual(['tok']);

    // logout: the `me` exchange must be recorded first (it received a 200)
    const meRecord = recordChainExchange(
      store,
      me.directives['name'],
      me.captures,
      '',
      { received: true, status: 200, headers: {}, body: '{"id":7}' },
    );
    expect(meRecord.diagnostics).toEqual([]);

    // logout resolves the capture-name ref AND response/request refs in body
    const logoutSend = prepareChainSend(
      { url: logout.url, headers: logout.headers, body: logout.body },
      store,
    );
    expect(logoutSend.diagnostics).toEqual([]);
    expect(logoutSend.headers[0].value).toBe('Bearer tk-1');
    // `{{tok}}` IS the secret capture: provenance marks it for redaction.
    expect(logoutSend.resolvedSecrets).toEqual(['tk-1']);
    expect(logoutSend.resolvedSecretNames).toEqual(['tok']);
    expect(logoutSend.body).toBe('{ "status": "200", "via": "{{user}}" }');
  });

  it('recorded login request body is readable via name.request.body refs', () => {
    const { requests } = parseHttpFile(SAMPLE_CHAIN_HTTP);
    const [login] = requests;
    const store = createChainStore();
    recordChainExchange(
      store,
      'login',
      login.captures,
      '{ "user": "alice", "pass": "p" }',
      { received: true, status: 200, headers: {}, body: '{"token":"tk"}' },
    );
    const out = prepareChainSend(
      { url: 'https://x.test/u={{login.request.body.$.user}}', headers: [], body: '' },
      store,
    );
    expect(out.diagnostics).toEqual([]);
    expect(out.url).toBe('https://x.test/u=alice');
  });
});
