/**
 * Local privacy sanitization and redaction engine.
 *
 * Produces a SanitizedPageRepresentation by deep-cloning the input representation,
 * redacting sensitive textual values with deterministic tokens, and strictly preserving
 * all UI grounding structures (id, tagName, role, bounds, state, relationships).
 */

import type {
  PageElement,
  PageMetadata,
  PageRepresentation
} from '../shared/types.js';
import {
  detectPrivacyFindings,
  GLOBAL_CARD_CANDIDATE_PATTERN,
  GLOBAL_EMAIL_PATTERN,
  getValidPhoneMatches,
  MASKED_FINANCIAL_PATTERN,
  FULLY_MASKED_FINANCIAL_PATTERN,
  NAME_CONTEXT_PATTERN,
  isLikelyPersonName
} from './detector.js';
import { isValidLuhn } from './luhn.js';
import {
  REDACTION_TOKENS,
  type PrivacyCategory,
  type PrivacyFinding,
  type PrivacySanitizationMetadata,
  type SanitizedPageRepresentation
} from './types.js';

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

/**
 * Redacts email, payment card, and phone substrings within a text string.
 * Leaves surrounding non-sensitive text completely intact.
 */
export function redactText(text: string | undefined): string | undefined {
  if (text === undefined || text === null || text === '') {
    return text;
  }

  let result = text;

  // 1. Redact email addresses
  result = result.replace(GLOBAL_EMAIL_PATTERN, REDACTION_TOKENS.EMAIL);

  // 2. Redact payment cards (only if validated by Luhn algorithm)
  const cardMatches = result.match(GLOBAL_CARD_CANDIDATE_PATTERN);
  if (cardMatches) {
    for (const candidate of cardMatches) {
      if (isValidLuhn(candidate)) {
        // Replace exact candidate occurrences
        result = result.split(candidate).join(REDACTION_TOKENS.CARD);
      }
    }
  }

  // 3. Redact masked payment cards / financial identifiers (e.g. XXXX XXXX 4821, •••• 4821, **** 4821)
  result = result.replace(MASKED_FINANCIAL_PATTERN, (_match, suffix) => {
    return `[CARD_ENDING_${suffix}]`;
  });
  result = result.replace(FULLY_MASKED_FINANCIAL_PATTERN, REDACTION_TOKENS.CARD);

  // 4. Redact phone numbers (validated complete candidates)
  const phoneMatches = getValidPhoneMatches(result);
  for (const candidate of phoneMatches) {
    result = result.split(candidate).join(REDACTION_TOKENS.PHONE);
  }

  // 5. Redact person names preceded by explicit contextual prefixes
  result = result.replace(NAME_CONTEXT_PATTERN, (_match, prefix) => {
    return `${prefix}${REDACTION_TOKENS.NAME}`;
  });

  // 6. Redact standalone person names (e.g. "Arjun Reddy", "Priya Sharma", "Rohan Verma")
  result = redactStandalonePersonNames(result) ?? result;

  return result;
}

/**
 * Redacts standalone customer/person names within text strings while preserving
 * common interface labels, action verbs, and brand names.
 */
export function redactStandalonePersonNames(text: string | undefined): string | undefined {
  if (text === undefined || text === null || text === '') {
    return text;
  }

  // Exact standalone name match
  if (isLikelyPersonName(text)) {
    return REDACTION_TOKENS.NAME;
  }

  // Scan capitalized word clusters (e.g. "Sanitized AI Input Arjun Reddy")
  return text.replace(/\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})+)\b/g, (cluster) => {
    if (isLikelyPersonName(cluster)) {
      return REDACTION_TOKENS.NAME;
    }
    const words = cluster.split(/\s+/);
    let modified = cluster;

    // Check 3-word windows
    for (let i = 0; i <= words.length - 3; i++) {
      const window3 = words.slice(i, i + 3).join(' ');
      if (isLikelyPersonName(window3)) {
        modified = modified.replace(window3, REDACTION_TOKENS.NAME);
      }
    }

    // Check 2-word windows
    for (let i = 0; i <= words.length - 2; i++) {
      const window2 = words.slice(i, i + 2).join(' ');
      if (isLikelyPersonName(window2)) {
        modified = modified.replace(window2, REDACTION_TOKENS.NAME);
      }
    }

    return modified;
  });
}


/**
 * Sanitizes a URL by preserving scheme, domain, and path while redacting
 * sensitive query parameter values.
 */
export function sanitizeUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;

  try {
    const url = new URL(rawUrl);

    url.searchParams.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_QUERY_KEYS.has(lowerKey)) {
        url.searchParams.set(key, REDACTION_TOKENS.PARAM);
      } else {
        const redacted = redactText(value);
        if (redacted !== value && redacted !== undefined) {
          url.searchParams.set(key, redacted);
        }
      }
    });

    return url.toString().replace(/%5B/gi, '[').replace(/%5D/gi, ']');
  } catch {
    // If not a valid standard URL, apply plain text redaction
    return redactText(rawUrl);
  }
}

/**
 * Sanitizes page-level metadata.
 */
function sanitizeMetadata(metadata: PageMetadata | undefined): PageMetadata {
  if (!metadata) {
    return {};
  }

  return {
    title: redactText(metadata.title),
    url: sanitizeUrl(metadata.url)
  };
}

function isCustomerNameAttribute(attr?: string): boolean {
  if (!attr) return false;
  const lower = attr.toLowerCase();
  return (
    lower === 'name' ||
    lower.includes('fullname') ||
    lower.includes('full_name') ||
    lower.includes('customername') ||
    lower.includes('customer_name') ||
    lower.includes('cardholder')
  );
}

/**
 * Sanitizes a single PageElement while preserving 100% of structural layout,
 * IDs, roles, bounding box, state, and relationship hierarchy.
 */
function sanitizeElement(element: PageElement): PageElement {
  // Password element determination
  const isPassword =
    element.inputType === 'password'
    || element.attributes?.autocomplete?.toLowerCase().includes('password');

  const isSemanticNameField = Boolean(
    element.attributes?.autocomplete?.toLowerCase().split(/\s+/).some(t => t === 'name' || t === 'given-name' || t === 'family-name') ||
    isCustomerNameAttribute(element.attributes?.name) ||
    isCustomerNameAttribute(element.id)
  );

  const SENSITIVE_TEXT_ATTRIBUTES = new Set([
    'aria-label',
    'title',
    'placeholder',
    'alt',
    'aria-description'
  ]);

  // Deep copy and sanitize attributes
  const attributes: Record<string, string> = {};
  if (element.attributes) {
    for (const [key, value] of Object.entries(element.attributes)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'placeholder' && isPassword) {
        attributes[key] = REDACTION_TOKENS.PASSWORD;
      } else if (lowerKey === 'placeholder' && isSemanticNameField) {
        attributes[key] = REDACTION_TOKENS.NAME;
      } else if (lowerKey === 'value' && isSemanticNameField) {
        attributes[key] = REDACTION_TOKENS.NAME;
      } else if (SENSITIVE_TEXT_ATTRIBUTES.has(lowerKey)) {
        attributes[key] = redactText(value) || '';
      } else {
        attributes[key] = value;
      }
    }
  }

  let placeholder = element.placeholder;
  if (isPassword && placeholder) {
    placeholder = REDACTION_TOKENS.PASSWORD;
  } else if (isSemanticNameField && placeholder) {
    placeholder = REDACTION_TOKENS.NAME;
  } else {
    placeholder = redactText(placeholder);
  }

  // Deep copy state
  const state = element.state ? { ...element.state } : undefined;

  // Deep copy bounds
  const bounds = element.bounds ? { ...element.bounds } : undefined;

  // Deep copy relationship arrays
  const childIds = element.childIds ? [...element.childIds] : undefined;
  const labelIds = element.labelIds ? [...element.labelIds] : undefined;

  const visibleText = isSemanticNameField && element.visibleText
    ? (redactText(element.visibleText) === element.visibleText ? REDACTION_TOKENS.NAME : redactText(element.visibleText))
    : redactText(element.visibleText);

  const accessibleName = isSemanticNameField && element.accessibleName
    ? (redactText(element.accessibleName) === element.accessibleName ? REDACTION_TOKENS.NAME : redactText(element.accessibleName))
    : redactText(element.accessibleName);

  return {
    id: element.id,
    tagName: element.tagName,
    role: element.role,
    visibleText,
    accessibleName,
    placeholder,
    inputType: element.inputType,
    bounds,
    state,
    interactive: element.interactive,
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    parentId: element.parentId,
    childIds,
    labelIds,
    provenance: element.provenance
  };
}

/**
 * Sanitizes a PageRepresentation and produces a SanitizedPageRepresentation.
 *
 * @param pageRepresentation The raw PageRepresentation from perception.
 * @returns Complete SanitizedPageRepresentation including findings and metadata.
 */
export function sanitizePageRepresentation(
  pageRepresentation: PageRepresentation
): SanitizedPageRepresentation {
  if (!pageRepresentation || typeof pageRepresentation !== 'object') {
    return {
      pageRepresentation: {
        schemaVersion: '1.0',
        metadata: {},
        viewport: { width: 0, height: 0 },
        elements: []
      },
      findings: [],
      metadata: {
        sanitizedAt: Date.now(),
        totalFindings: 0,
        categoryCounts: {
          email: 0,
          phone: 0,
          card: 0,
          password: 0,
          address: 0,
          name: 0,
          auth_token: 0,
          other: 0
        }
      }
    };
  }

  // 1. Detect findings across original representation
  const findings = detectPrivacyFindings(pageRepresentation);

  // 2. Compute category counts
  const categoryCounts: Record<PrivacyCategory, number> = {
    email: 0,
    phone: 0,
    card: 0,
    password: 0,
    address: 0,
    name: 0,
    auth_token: 0,
    other: 0
  };

  for (const finding of findings) {
    categoryCounts[finding.category] = (categoryCounts[finding.category] || 0) + 1;
  }

  // 3. Sanitize elements and metadata into a deep-cloned representation
  const sanitizedElements = Array.isArray(pageRepresentation.elements)
    ? pageRepresentation.elements.map(el => sanitizeElement(el))
    : [];

  const sanitizedMetadata = sanitizeMetadata(pageRepresentation.metadata);

  const sanitizedRepresentation: PageRepresentation = {
    schemaVersion: pageRepresentation.schemaVersion || '1.0',
    metadata: sanitizedMetadata,
    viewport: pageRepresentation.viewport ? { ...pageRepresentation.viewport } : { width: 0, height: 0 },
    elements: sanitizedElements
  };

  const metadata: PrivacySanitizationMetadata = {
    sanitizedAt: Date.now(),
    totalFindings: findings.length,
    categoryCounts
  };

  return {
    pageRepresentation: sanitizedRepresentation,
    findings,
    metadata
  };
}
