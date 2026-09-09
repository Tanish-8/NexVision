/**
 * Local deterministic multi-signal privacy detector.
 *
 * Scans PageRepresentation elements and page metadata using structural signals,
 * accessibility hints, and conservative bounded patterns.
 *
 * CRITICAL SAFETY INVARIANT:
 * PrivacyFinding objects NEVER retain detected raw sensitive values.
 */

import type {
  PageElement,
  PageMetadata,
  PageRepresentation
} from '../shared/types.js';
import { isValidLuhn } from './luhn.js';
import type {
  PrivacyCategory,
  PrivacyConfidence,
  PrivacyFinding,
  PrivacySignalSource
} from './types.js';

/** Bounded email pattern matching standard email formats without catastrophic backtracking. */
export const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
export const GLOBAL_EMAIL_PATTERN = new RegExp(EMAIL_PATTERN.source, 'gi');

/**
 * Bounded phone pattern matching international and national numbers.
 * Requires at least 7 digits and standard delimiters to prevent false positives on short numbers.
 */
export const PHONE_PATTERN = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/;
export const GLOBAL_PHONE_PATTERN = new RegExp(PHONE_PATTERN.source, 'g');

/** Candidate card number pattern: 13-19 digits with optional spaces or hyphens. */
export const CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]*?){13,19}\b/;
export const GLOBAL_CARD_CANDIDATE_PATTERN = new RegExp(CARD_CANDIDATE_PATTERN.source, 'g');

/** Query parameter names commonly carrying authentication credentials or secrets. */
const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'auth',
  'key',
  'api_key',
  'apikey',
  'password',
  'pass',
  'secret',
  'jwt',
  'bearer',
  'session',
  'session_id',
  'sessionid',
  'access_token',
  'refresh_token',
  'id_token'
]);

/** Sensitive autocomplete tokens defined in the HTML specification. */
const AUTOCOMPLETE_MAP: Record<string, { category: PrivacyCategory; semanticRef?: string }> = {
  email: { category: 'email', semanticRef: 'profile.email' },
  tel: { category: 'phone', semanticRef: 'profile.phone' },
  'tel-national': { category: 'phone', semanticRef: 'profile.phone' },
  'tel-country-code': { category: 'phone', semanticRef: 'profile.phone' },
  'current-password': { category: 'password', semanticRef: 'profile.password' },
  'new-password': { category: 'password', semanticRef: 'profile.password' },
  'cc-number': { category: 'card', semanticRef: 'profile.paymentCard' },
  'cc-csc': { category: 'card', semanticRef: 'profile.paymentCard' },
  'cc-exp': { category: 'card', semanticRef: 'profile.paymentCard' },
  'cc-type': { category: 'card', semanticRef: 'profile.paymentCard' },
  name: { category: 'name', semanticRef: 'profile.name' },
  'given-name': { category: 'name', semanticRef: 'profile.firstName' },
  'family-name': { category: 'name', semanticRef: 'profile.lastName' },
  'additional-name': { category: 'name', semanticRef: 'profile.middleName' },
  'street-address': { category: 'address', semanticRef: 'profile.address' },
  'address-line1': { category: 'address', semanticRef: 'profile.addressLine1' },
  'address-line2': { category: 'address', semanticRef: 'profile.addressLine2' },
  'postal-code': { category: 'address', semanticRef: 'profile.postalCode' }
};

interface InterimFinding {
  elementId?: string;
  category: PrivacyCategory;
  confidence: PrivacyConfidence;
  source: PrivacySignalSource;
  semanticReference?: string;
}

/**
 * Checks if a text string contains a valid Luhn payment card number.
 */
function containsValidCard(text: string): boolean {
  const matches = text.match(GLOBAL_CARD_CANDIDATE_PATTERN);
  if (!matches) return false;

  for (const match of matches) {
    if (isValidLuhn(match)) {
      return true;
    }
  }
  return false;
}

/**
 * Verifies digit count for phone candidates to avoid flagging simple numbers or dates.
 * Excludes substrings that are valid Luhn payment cards.
 */
function containsValidPhone(text: string): boolean {
  // Strip out valid card matches to prevent card numbers from being misidentified as phones
  let candidateText = text;
  const cardMatches = text.match(GLOBAL_CARD_CANDIDATE_PATTERN);
  if (cardMatches) {
    for (const card of cardMatches) {
      if (isValidLuhn(card)) {
        candidateText = candidateText.split(card).join(' ');
      }
    }
  }

  const matches = candidateText.match(GLOBAL_PHONE_PATTERN);
  if (!matches) return false;

  for (const match of matches) {
    const digitsOnly = match.replace(/\D/g, '');
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      return true;
    }
  }
  return false;
}

/**
 * Inspects a single PageElement and produces intermediate findings.
 */
function scanElement(element: PageElement): InterimFinding[] {
  const findings: InterimFinding[] = [];

  // 1. Structural Signal: inputType
  const inputType = element.inputType?.toLowerCase();
  if (inputType === 'password') {
    findings.push({
      elementId: element.id,
      category: 'password',
      confidence: 'high',
      source: 'input_type',
      semanticReference: 'profile.password'
    });
  } else if (inputType === 'email') {
    findings.push({
      elementId: element.id,
      category: 'email',
      confidence: 'high',
      source: 'input_type',
      semanticReference: 'profile.email'
    });
  } else if (inputType === 'tel') {
    findings.push({
      elementId: element.id,
      category: 'phone',
      confidence: 'high',
      source: 'input_type',
      semanticReference: 'profile.phone'
    });
  }

  // 2. Structural Signal: autocomplete attribute
  const autocomplete = element.attributes?.autocomplete?.toLowerCase().trim();
  if (autocomplete) {
    for (const token of autocomplete.split(/\s+/)) {
      const match = AUTOCOMPLETE_MAP[token];
      if (match) {
        findings.push({
          elementId: element.id,
          category: match.category,
          confidence: 'high',
          source: 'autocomplete',
          semanticReference: match.semanticRef
        });
      }
    }
  }

  // 3. Accessibility / Semantic Attributes: name, aria-label, title
  const nameAttr = element.attributes?.name?.toLowerCase();
  if (nameAttr) {
    if (nameAttr.includes('password') || nameAttr.includes('passwd')) {
      findings.push({
        elementId: element.id,
        category: 'password',
        confidence: 'high',
        source: 'attribute',
        semanticReference: 'profile.password'
      });
    } else if (nameAttr === 'cvv' || nameAttr === 'cvc' || nameAttr.includes('cardnumber')) {
      findings.push({
        elementId: element.id,
        category: 'card',
        confidence: 'high',
        source: 'attribute',
        semanticReference: 'profile.paymentCard'
      });
    }
  }

  // 4. Text and Label Signals
  const textSignals: Array<{ text: string | undefined; source: PrivacySignalSource }> = [
    { text: element.visibleText, source: 'visible_text' },
    { text: element.accessibleName, source: 'accessible_name' },
    { text: element.placeholder, source: 'placeholder' }
  ];

  for (const { text, source } of textSignals) {
    if (!text) continue;

    // Email pattern check
    if (EMAIL_PATTERN.test(text)) {
      findings.push({
        elementId: element.id,
        category: 'email',
        confidence: 'high',
        source,
        semanticReference: 'profile.email'
      });
    }

    // Phone pattern check
    if (containsValidPhone(text)) {
      findings.push({
        elementId: element.id,
        category: 'phone',
        confidence: 'medium',
        source,
        semanticReference: 'profile.phone'
      });
    }

    // Payment card pattern check with Luhn validation
    if (containsValidCard(text)) {
      findings.push({
        elementId: element.id,
        category: 'card',
        confidence: 'high',
        source,
        semanticReference: 'profile.paymentCard'
      });
    }
  }

  return findings;
}

/**
 * Scans PageMetadata (URL and document title) for sensitive findings.
 */
function scanMetadata(metadata: PageMetadata | undefined): InterimFinding[] {
  if (!metadata) return [];
  const findings: InterimFinding[] = [];

  // Title scan
  if (metadata.title) {
    if (EMAIL_PATTERN.test(metadata.title)) {
      findings.push({
        elementId: 'page-metadata',
        category: 'email',
        confidence: 'high',
        source: 'visible_text',
        semanticReference: 'profile.email'
      });
    }
    if (containsValidPhone(metadata.title)) {
      findings.push({
        elementId: 'page-metadata',
        category: 'phone',
        confidence: 'medium',
        source: 'visible_text',
        semanticReference: 'profile.phone'
      });
    }
  }

  // URL query scan
  if (metadata.url) {
    try {
      const parsedUrl = new URL(metadata.url);
      parsedUrl.searchParams.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_QUERY_KEYS.has(lowerKey)) {
          findings.push({
            elementId: 'page-url',
            category: lowerKey.includes('pass') ? 'password' : 'auth_token',
            confidence: 'high',
            source: 'url_query'
          });
        } else if (EMAIL_PATTERN.test(value)) {
          findings.push({
            elementId: 'page-url',
            category: 'email',
            confidence: 'high',
            source: 'url_query',
            semanticReference: 'profile.email'
          });
        }
      });
    } catch {
      // Invalid URL format; ignore gracefully without crashing
    }
  }

  return findings;
}

/**
 * Merges and aggregates multi-signal findings per element and category.
 *
 * For example, if an element has both `input_type` and `visible_text` indicating an email,
 * they are merged into a single PrivacyFinding with `sources: ['input_type', 'visible_text']`.
 */
function aggregateFindings(interimList: InterimFinding[]): PrivacyFinding[] {
  const map = new Map<string, PrivacyFinding>();

  const confidenceRank: Record<PrivacyConfidence, number> = {
    high: 3,
    medium: 2,
    low: 1
  };

  for (const item of interimList) {
    const key = `${item.elementId || 'root'}:${item.category}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        elementId: item.elementId,
        category: item.category,
        confidence: item.confidence,
        sources: [item.source],
        semanticReference: item.semanticReference
      });
    } else {
      if (!existing.sources.includes(item.source)) {
        existing.sources.push(item.source);
      }
      if (confidenceRank[item.confidence] > confidenceRank[existing.confidence]) {
        existing.confidence = item.confidence;
      }
      if (!existing.semanticReference && item.semanticReference) {
        existing.semanticReference = item.semanticReference;
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Detects all privacy findings across a PageRepresentation.
 *
 * @param pageRepresentation The representation to scan.
 * @returns Array of deduplicated, multi-signal PrivacyFindings.
 */
export function detectPrivacyFindings(
  pageRepresentation: PageRepresentation | undefined | null
): PrivacyFinding[] {
  if (!pageRepresentation || !Array.isArray(pageRepresentation.elements)) {
    return [];
  }

  const interimFindings: InterimFinding[] = [];

  // 1. Scan metadata
  interimFindings.push(...scanMetadata(pageRepresentation.metadata));

  // 2. Scan elements
  for (const element of pageRepresentation.elements) {
    interimFindings.push(...scanElement(element));
  }

  return aggregateFindings(interimFindings);
}
