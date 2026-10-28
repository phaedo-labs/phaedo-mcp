// Phaedo MCP — shared error type + the §9.5 error codes.
//
// Standalone (no other imports) so the PURE consultation core (consult-core.js)
// can throw the SAME PhaedoError class that projection.js and server.js use for
// `instanceof` checks — without importing the injection renderer (context-block.js).
// projection.js re-exports these, so existing `import { PhaedoError } from
// './projection.js'` sites keep working and keep one class identity.

export const ERROR_CODES = [
  'mode_not_supported',
  'layer_not_available',
  'decryption_failed',
  'persona_strength_below_threshold',
  'request_malformed',
  'internal_error',
];

export class PhaedoError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}
