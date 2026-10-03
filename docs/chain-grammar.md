# Request chaining grammar (core contract)

**Status:** Implemented as the pure core module `src/core/chain/` (issue
[#47](https://github.com/rwrife/reqit/issues/47)) and wired into the VS Code
send path (`▶ Send Request`): the extension resolves chain references before
sending, records named requests/responses + captures per window session, and
refuses to send when a chain reference is unresolved. `Run file`
orchestration, codelens previews, and CLI `reqit run` integration are the
remaining slices of #47.

Reqit chaining lets one named request feed another:

```http
# @name login
POST {{host}}/auth/login
Content-Type: application/json

{ "user": "{{user}}", "pass": "{{pass}}" }

###

# @name me
GET {{host}}/me
Authorization: Bearer {{login.response.body.$.access_token}}
```

## Chain references

Inside `{{ ... }}`, a reference is treated as a chain reference only when it
matches one of these shapes; anything else falls through to ordinary
environment/built-in substitution untouched:

| Reference                                   | Resolves to                                        |
| ------------------------------------------- | -------------------------------------------------- |
| `{{name.response.status}}`                  | numeric status of the recorded response (as text)  |
| `{{name.response.headers.<Header-Name>}}`   | header value; lookup is case-insensitive           |
| `{{name.response.body.$.path}}`             | JSONPath subset into the recorded JSON body        |
| `{{name.request.body.$.path}}`              | JSONPath subset into the recorded request body (secret values scrubbed at record time; see redaction below) |
| `{{captureName}}`                           | value of a `# @capture` stored earlier in the run (see below) |

Names follow the `# @name` identifier rules: `[A-Za-z_][A-Za-z0-9_]*`, at most
`MAX_CHAIN_NAME_LENGTH` (128) characters (over-long names are rejected so
diagnostics never echo an unbounded hostile name), unique
per file (`validateRequestNames`). A name with no recorded entry produces an
actionable diagnostic (`no recorded response for 'login' …`) and the literal
`{{...}}` stays in place so the request fails loudly rather than sending a
raw placeholder.

A **malformed** chain-shaped reference bound to a **recorded** name is
reported with an actionable diagnostic and left literal — it never silently
passes through to env substitution. Chain intent is recognized by exact
namespace segments: anything under `login.response.…` or `login.request.…`
once `login` has run (including incomplete or irregular shapes such as
`{{login.response}}`, `{{login.response.}}`, `{{login.response..status}}`,
`{{login.response.1bad}}`) produces a diagnostic; same-prefix names that are
not exact namespaces (`login.responseX`) and references to names that were
**never recorded** stay silent so ordinary dotted env-var names keep working.

Placeholder scanning is quote-aware in a bracket-scoped way: a body path may
contain a quoted key with `]`, `}`, or even `}}` inside it
(`{{login.response.body.$['a}}b']}` resolves — only the matching quote closes
a bracket-opened quoted span), while an apostrophe in an ordinary env/header
name (`X-O'Brien`) does NOT start a quoted span. A malformed candidate — a
lone `}` inside `{{ … }}`, or an unterminated bracket-quoted span — is
abandoned as a whole region: scanning resumes only after that region's `}}`
terminator (or at end of input for an unterminated span), so a placeholder
nested inside abandoned text can never resolve and the region passes through
byte-identically.

## JSONPath subset

Deliberately bounded so hostile imported data cannot cause unbounded scans:

- `$` — root
- `.key` — key of `[A-Za-z0-9_-]+`
- `['key']` / `["key"]` — quoted key (any inner characters except the quote;
  `]` and `}` are fine)
- `[3]` — non-negative array index
- Composable: `$.a.b[0]['c-d']`

Wildcards, slices, filters, recursive descent, and functions are **not**
supported and are rejected at parse time. Hard bounds: at most
`MAX_JSONPATH_DEPTH` (64) segments per path (enforced at both parse and
evaluate time), and reserved prototype names — `__proto__`, `constructor`,
`prototype` — are rejected as segment names at **both** parse and evaluate
time, so a path can never traverse them even when hostile JSON contains them
as own keys. Resolution otherwise uses strict own-property checks, so a path
can never climb onto `Object.prototype` (`toString`, …). Explicit `null` is a
value; a missing key or an `undefined`-valued own property is a
`Path miss at $.…` diagnostic; sparse-array holes resolve like JSON
serialization (`null`).

## Resolution bounds

A single resolution pass (`resolveChainText` / `resolveChainRequest`) acts on
at most `MAX_CHAIN_REFS_PER_PASS` (100) chain references; the overflow is left
literal with one `Too many chain references` diagnostic. Recorded JSON bodies
are parsed at most once per pass (parse cache), so many references into one
body cannot amplify work to O(references × body size).

## Capture directives

`# @capture` records a value from a response into the run store:

```http
# @capture token = $.access_token
# @capture count: number = $.meta.count
# @capture tok: string secret = $.auth.token
```

- Type suffix (`: string | number | boolean`) validates the captured value
  with a zod schema; mismatches are errors, not silent coercions.
- `secret` requires a declared type. Secret-marked captures are substituted
  into the request that is actually sent (that is the point of chaining) but
  must never appear in derived/rendered surfaces: the VS Code extension
  redacts them from EVERY string field of the rendered request echo (url,
  header values, and body) with a secret-free marker (normally
  `[REDACTED]`; a deterministic fallback is used when that marker itself
  contains an active secret), and adapters get per-send
  redaction material (`resolvedSecrets` / `resolvedSecretNames` from
  `prepareChainSend`) to enforce the same boundary for hovers, history,
  exports, and clipboard output. Redaction provenance is VALUE-EQUALITY
  based: a direct response reference (`{{login.response.body.$.token}}`)
  whose substituted text equals a secret capture's value is listed for
  redaction exactly like a bare `{{tok}}` reference — the ref style cannot
  bypass the boundary. Boundary scope (issue #47): the raw RESPONSE view
  shows the body the user explicitly fetched (primary data, shown
  truthfully); everything DERIVED from the request/response — request echo,
  notifications, error/stack text, SSE transcripts, and clipboard/cURL
  output — passes through the one canonical redactor (raw + JSON-escaped
  forms, longest-first, plus the complete post-substitution derived values
  of template secrets). The recorded request body is the scrubbed copy, not
  the raw wire body, so a `{{name.request.body.$…}}` reference can never
  re-surface a secret after the environment rotates. The store scrub is
  JSON-aware: for a JSON body, string leaves are masked textually while a
  non-string scalar is replaced wholesale when its serialized form contains
  a secret substring. The recorded copy therefore stays parseable, cannot
  re-expose a larger numeric/boolean/null value after secret rotation, and
  keeps unrelated fields referenceable. JSON object keys are scrubbed too;
  output uses inert own-data properties (including `__proto__`), and keys
  that mask identically collapse by a deterministic raw-key ordering
  (lexicographically-smallest source key wins) rather than JavaScript's
  integer-key enumeration order. Every candidate (structured
  re-serialization, re-redacted serialization, textual masking) must
  re-parse AND contain no active secret in its RAW BYTES **or its DECODED
  content** (Unicode-escaped secrets decode before any reference reads
  them); when none qualifies — a secret lives in the JSON STRUCTURE
  itself, e.g. `":"` between a key and its value, or an escaped secret
  only surfaces after decoding — the scrubber refuses the recording and
  the store keeps an EMPTY
  body: later `{{name.request.body.$…}}` references then fail closed with
  the actionable not-valid-JSON diagnostic instead of ever serving invalid
  or secret-bearing JSON (review r11/r12 fail-closed contract). Persisted SSE
  transcripts
  apply the same redactor to every string field of each event (`type`,
  `data`, `lastEventId`) at capture time, and a numeric `retry:` whose
  serialized form contains a known secret substring is dropped; the live stream view
  keeps raw event data (accepted display boundary). The adapter refuses to
  send or copy a request while any secret candidate is in play AND either
  the substitution-provenance recording overflowed or the derived-variant
  closure was truncated (incomplete taint closure ⇒ fail closed). The store
  refuses to record a named exchange whose secret capture directives would
  cross the bounded rejected-secret provenance quota (64/run), reserving one
  slot per directive up front. The placeholder candidate bound
  (MAX_CHAIN_REFS_PER_PASS=100) is shared across URL, headers, and body
  within one resolution pass, so junk candidates cannot reset it by
  spreading across fields. Codelens previews are a remaining #47 slice.
- At most `MAX_CAPTURES_PER_REQUEST` (32) capture directives are collected
  per request; beyond that the parser keeps the first 32 and emits a parse
  diagnostic instead of silently truncating (hostile-import bound).
- Captures are **per-run, in-memory only**. `applyCapture` evaluates a
  directive against a recorded response (the response body is JSON-parsed
  at most once per exchange regardless of directive count);
  `store.recordCaptures(captures, owner?)` stores the results and returns
  diagnostics for invalid or duplicate names. Dedup is OWNER-SCOPED: a
  named exchange re-recording (re-running `# @name login`) REFRESHES the
  captures it owns — its response record is overwritten in the same atomic
  step, so a capture and `{{login.response…}}` can never disagree — while
  recording a name owned by a different exchange (or repeating a name
  within one call) is a duplicate error and the existing value stands.
  Unnamed exchanges never own captures and never refresh.
  `store.getCapture()` / `captureNames()` retrieve them, and `store.clear()`
  wipes them. Nothing is persisted to disk; there is no `@capture-persist`
  implementation yet.
- A capture is referenced downstream by its bare name: `{{tok}}` resolves to
  the stored capture value. Because the chain stage runs **before**
  environment substitution, a bound capture shadows a same-named env
  variable; names that were never captured pass through silently to the env
  stage. `# @capture` lines are collected in source order (like `@test`)
  and are stripped from the request body by the parser.

## Send-path semantics (VS Code wiring)

- Chain resolution happens before environment substitution. Unresolved or
  malformed chain references **block the send** with an actionable error —
  a raw `{{...}}` on the wire is never intended.
- A named request's exchange is recorded only when a response was genuinely
  received. Transport failures and cancellations record nothing, so
  downstream references keep failing loudly against the last real response.
- Capture evaluation problems (path miss, failed type validation, duplicate
  name) warn but never block the response render — the exchange itself
  succeeded (partial-success semantics).
- The store lives for the VS Code window session (reload clears it);
  `Run file` orchestration will snapshot/reset it per file run.

Store getters (`getRequest` / `getResponse` / `getCapture`) return defensive
copies — a caller mutating a returned record can never rewrite stored
history.

## Module map

| File                      | Role                                                    |
| ------------------------- | ------------------------------------------------------- |
| `src/core/chain/jsonpath.ts` | Parser + evaluator for the bounded JSONPath subset.  |
| `src/core/chain/resolver.ts` | Reference parsing/classification, chain store (records + captures), text/request resolution (incl. capture-name refs), capture application, name validation. |
| `src/core/chain/send.ts` | Send-path pipeline: `prepareChainSend` (pre-send resolution + secret-substitution provenance) and `recordChainExchange` (post-response recording with failure-safe semantics). |
| `src/core/chain/index.ts` | Barrel of the pure surface.                             |

Tests: `test/chain.jsonpath.test.ts`, `test/chain.resolver.test.ts`,
`test/chain.send.test.ts`, `test/chain.sample.test.ts`,
`test/parser.captures.test.ts`, `test/extension.chainWiring.test.ts`
(activate-path wiring on the simulated VS Code host).
No new runtime dependencies (zod, already a direct dependency, is used for
capture type validation).
