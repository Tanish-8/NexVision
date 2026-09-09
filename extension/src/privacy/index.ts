/**
 * Local Privacy Engine for NexVision (SIH26171).
 *
 * Implements the Phase 4 Local Privacy Boundary:
 * Raw PageRepresentation → Local Privacy Engine → SanitizedPageRepresentation
 *
 * Guaranteed invariants:
 * 1. Operates 100% on-device with zero network requests.
 * 2. Emits privacy findings that NEVER retain raw detected PII values.
 * 3. Sanitizes sensitive text using deterministic redaction tokens.
 * 4. Preserves all UI grounding structure (id, tagName, role, bounds, state, relationships).
 */

export { detectPrivacyFindings } from './detector.js';
export { isValidLuhn } from './luhn.js';
export { redactText, sanitizePageRepresentation, sanitizeUrl } from './sanitizer.js';
export { REDACTION_TOKENS } from './types.js';
export type {
  PrivacyCategory,
  PrivacyConfidence,
  PrivacyFinding,
  PrivacySanitizationMetadata,
  PrivacySignalSource,
  RedactionToken,
  SanitizedPageRepresentation
} from './types.js';
