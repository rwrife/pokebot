/**
 * Barrel for the request-chaining core module. Pure, VS Code-free surface
 * only — extension/CLI adapters must reuse these helpers rather than fork
 * the resolution behavior.
 */
export {
  parseJsonPath,
  evaluateJsonPath,
  queryJsonPath,
  MAX_JSONPATH_DEPTH,
  type JsonPathSegment,
  type JsonPathParsed,
  type JsonPathError,
  type ParseJsonPathResult,
  type JsonPathResult,
} from './jsonpath.js';
export {
  parseChainReference,
  classifyChainReference,
  parseCaptureDirective,
  applyCapture,
  createChainStore,
  resolveChainText,
  resolveChainRequest,
  validateRequestNames,
  isValidChainName,
  MAX_CHAIN_REFS_PER_PASS,
  type ChainReference,
  type CaptureType,
  type ParsedCapture,
  type CaptureParseError,
  type AppliedCapture,
  type CaptureApplyError,
  type CaptureRecord,
  type ChainStore,
  type ChainRequestRecord,
  type ChainResponseRecord,
  type ChainDiagnostic,
  type ChainSubstituteResult,
  type ChainRequestInput,
  type ChainRequestResult,
  type ResolvedCapture,
} from './resolver.js';
export { redactSecretText, scrubRecordedBody, secretRedactor } from './redact.js';
export {
  prepareChainSend,
  recordChainExchange,
  type ChainSendResult,
  type ChainRecordResult,
  type SendExchange,
} from './send.js';
