/**
 * Scaffolded sample files for `Reqit: Init Workspace`.
 *
 * Pure strings — no VS Code imports — so tests can validate every sample
 * against the real parser/pipeline without the extension host.
 */

/**
 * Request-chaining showcase (issue #47): login -> protected call ->
 * logout, wired with `# @name`, `# @capture`, and `{{ref}}` references.
 * Captures live in memory for the window session only.
 */
export const SAMPLE_CHAIN_HTTP = [
  '### login',
  '# @name login',
  '# @capture tok: string secret = $.token',
  'POST {{baseUrl}}/auth/login',
  'Content-Type: application/json',
  '',
  '{ "user": "{{user}}", "pass": "{{pass}}" }',
  '',
  '### me',
  '# @name me',
  'GET {{baseUrl}}/me',
  'Authorization: Bearer ' + '{{login.' + 'response.body.$.token}}',
  '',
  '### logout',
  '# @name logout',
  'POST {{baseUrl}}/auth/logout',
  'Authorization: Bearer {{tok}}',
  '',
  '{ "status": "{{me.response.status}}", "via": "{{login.request.body.$.user}}" }',
  '',
].join('\n');
