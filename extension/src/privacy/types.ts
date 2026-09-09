/**
 * Types and token definitions for the local privacy engine.
 */

export type {
  PrivacyCategory,
  PrivacyConfidence,
  PrivacyFinding,
  PrivacySanitizationMetadata,
  PrivacySignalSource,
  SanitizedPageRepresentation
} from '../shared/types.js';

/**
 * Standard deterministic redaction tokens used across the local privacy boundary.
 */
export const REDACTION_TOKENS = {
  EMAIL: '[REDACTED_EMAIL]',
  PHONE: '[REDACTED_PHONE]',
  CARD: '[REDACTED_CARD]',
  PASSWORD: '[REDACTED_PASSWORD]',
  AUTH_TOKEN: '[REDACTED_TOKEN]',
  PARAM: '[REDACTED_PARAM]',
  NAME: '[REDACTED_NAME]',
  ADDRESS: '[REDACTED_ADDRESS]',
  GENERIC: '[REDACTED]'
} as const;

export type RedactionToken = typeof REDACTION_TOKENS[keyof typeof REDACTION_TOKENS];
