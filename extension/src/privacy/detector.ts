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
 * Bounded phone pattern matching complete international and national numbers.
 * Enforces non-digit and non-alphanumeric boundaries on both sides so substrings
 * inside identifiers (such as IFSC codes or customer IDs) cannot match.
 */
export const PHONE_PATTERN =
  /(?<!\d[-.\s]?)(?<![a-zA-Z0-9+])(?<![a-zA-Z]-)(?:\+\d{1,4}[-.\s]?)?(?:\(?\d{2,5}\)?[-.\s]?)?\d{3,5}[-.\s]?\d{4,5}(?![-.\s]?\d)(?![a-zA-Z0-9])/;
export const GLOBAL_PHONE_PATTERN = new RegExp(PHONE_PATTERN.source, 'g');

/** Candidate card number pattern: 13-19 digits with optional spaces or hyphens. */
export const CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]*?){13,19}\b/;
export const GLOBAL_CARD_CANDIDATE_PATTERN = new RegExp(CARD_CANDIDATE_PATTERN.source, 'g');

/** Masked card/account pattern matching prefixes of X, *, or bullets followed by 2-4 digits. */
export const MASKED_FINANCIAL_PATTERN =
  /(?<=^|[\s,;:(])(?:[X*•\u2022]{2,}[ -]?)+(\d{2,4})\b/gu;

/** Fully masked card pattern without trailing digits (e.g. •••••••••••••••• or XXXX-XXXX-XXXX-XXXX). */
export const FULLY_MASKED_FINANCIAL_PATTERN =
  /(?<=^|[\s,;:(])(?:[X*•\u2022]{4}[ -]?){3,4}(?=$|[\s,;:!?.])/gu;

/** Contextual person name pattern matching names preceded by explicit person-identifying prefixes. */
export const NAME_CONTEXT_PATTERN =
  /(?<prefix>\b(?:welcome(?: back)?,|hello,|user:|customer(?: name)?:|account holder:|cardholder(?: name)?:|profile of|profile photo of|logged in as|signed in as|search records for)\s+)(?<name>[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/gi;

/**
 * Common UI actions, web domain nouns, brands, sentence particles, and control words.
 * Used to avoid false positive name detection on buttons and interface labels
 * (e.g. "Submit Order", "Amazon Pay", "Swiggy Delivery", "Netflix Subscription", "Order History").
 */
export const COMMON_UI_AND_BRAND_WORDS: ReadonlySet<string> = new Set([
  // Pronouns, determiners, sentence starters, conversational particles
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'dear', 'hello', 'hi', 'hey', 'welcome', 'thanks', 'thank', 'please',

  // Prepositions, conjunctions, particles
  'and', 'or', 'but', 'nor', 'for', 'yet', 'so', 'in', 'on', 'at', 'to', 'from',
  'with', 'by', 'about', 'against', 'between', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'under', 'over', 'of', 'off', 'up', 'down', 'out',
  'as', 'than',

  // Auxiliaries & common verbs
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
  'might', 'must', 'get', 'got', 'set', 'make', 'made', 'know', 'see', 'look',
  'take', 'give', 'use', 'find', 'tell', 'ask', 'work', 'seem', 'feel', 'try',
  'leave', 'call', 'keep',

  // Action verbs
  'submit', 'cancel', 'save', 'continue', 'next', 'previous', 'prev', 'back',
  'confirm', 'delete', 'edit', 'update', 'add', 'create', 'remove', 'apply',
  'select', 'choose', 'change', 'pay', 'search', 'view', 'show', 'hide',
  'sign', 'log', 'open', 'close', 'send', 'download', 'upload', 'print',
  'manage', 'review', 'proceed', 'go', 'done', 'finish', 'clear', 'reset',
  'filter', 'sort', 'checkout', 'subscribe', 'explore', 'learn', 'more',
  'shop', 'buy', 'order', 'track', 'help', 'contact', 'transfer', 'deposit',
  'withdraw', 'copy', 'paste', 'share', 'export', 'import', 'refresh', 'reload',
  'retry', 'start', 'stop', 'play', 'pause', 'resume', 'enter', 'join',
  'agree', 'decline', 'accept', 'reject', 'dismiss',

  // UI & domain nouns
  'button', 'link', 'input', 'field', 'form', 'text', 'label', 'menu', 'nav',
  'navigation', 'tab', 'tabs', 'page', 'pages', 'item', 'items', 'list', 'table',
  'row', 'card', 'cards', 'details', 'history', 'summary', 'settings', 'options',
  'preferences', 'account', 'profile', 'home', 'dashboard', 'status',
  'center', 'support', 'service', 'services', 'policy', 'terms', 'conditions',
  'privacy', 'security', 'cookie', 'cookies', 'report', 'reports', 'receipt',
  'receipts', 'transaction', 'transactions', 'balance', 'funds', 'category',
  'categories', 'delivery', 'address', 'shipping', 'billing', 'information', 'info',
  'total', 'subtotal', 'tax', 'discount', 'offer', 'offers', 'coupon', 'coupons',
  'feedback', 'faq', 'guide', 'overview', 'activity', 'insight', 'insights',
  'wallet', 'points', 'rewards', 'prime', 'pass', 'subscription', 'subscriptions',
  'plan', 'plans', 'cart', 'basket', 'statement', 'statements', 'result',
  'results', 'notification', 'notifications', 'message', 'messages', 'inbox',
  'feed', 'query', 'header', 'footer', 'sidebar', 'dialog', 'modal', 'popup',
  'alert', 'error', 'warning', 'success', 'date', 'time', 'amount', 'currency',
  'price', 'rate', 'fee', 'charge', 'limit', 'code', 'number', 'ref', 'reference',
  'mode', 'theme', 'dark', 'light', 'grid', 'column', 'switch', 'toggle',
  'checkbox', 'radio', 'dropdown', 'user', 'customer', 'member',
  'office', 'branch', 'headquarters', 'desk', 'dept', 'department', 'team',
  'group', 'division', 'unit', 'building', 'floor', 'suite', 'room', 'tower',
  'hub', 'location', 'region', 'area', 'zone', 'city', 'state', 'country',
  'station', 'portal', 'website', 'app', 'site', 'bank', 'banking',

  // Merchants & Brands
  'amazon', 'swiggy', 'netflix', 'google', 'apple', 'microsoft', 'nexbank',
  'flipkart', 'uber', 'zomato', 'visa', 'mastercard', 'rupay', 'amex',
  'paypal', 'paytm', 'phonepe', 'gpay', 'youtube', 'facebook', 'instagram',
  'twitter', 'github', 'linkedin', 'spotify', 'walmart', 'ebay', 'target',
  'bestbuy', 'costco', 'samsung', 'sony', 'lg',

  // Common qualifiers / adjectives
  'all', 'any', 'new', 'old', 'current', 'recent', 'latest', 'popular', 'top',
  'best', 'featured', 'related', 'similar', 'other', 'another', 'first', 'last',
  'online', 'offline', 'public', 'private', 'general', 'standard', 'custom',
  'default', 'primary', 'secondary', 'active', 'inactive', 'pending',
  'completed', 'failed', 'available', 'unavailable', 'free', 'premium', 'pro',
  'plus', 'basic', 'advanced', 'daily', 'weekly', 'monthly', 'annual', 'yearly'
]);

/**
 * Checks whether a text string represents a standalone customer/person name
 * (e.g. "Arjun Reddy", "Priya Sharma", "Rohan Verma", "John Smith").
 *
 * Rules:
 * 1. Must match 2 to 3 capitalized words (each word 2-20 characters: /^[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,2}$/).
 * 2. If ANY word matches COMMON_UI_AND_BRAND_WORDS (e.g. "Submit", "Order", "Amazon", "Pay"), it is rejected.
 *
 * This cleanly intercepts standalone customer names in buttons, account switchers,
 * accessible names, candidate descriptions, and table cells without false positives on UI actions.
 */
export function isLikelyPersonName(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 60) return false;

  const wordsMatch = trimmed.match(/^[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,2}$/);
  if (!wordsMatch) return false;

  const words = trimmed.split(/\s+/);
  for (const word of words) {
    if (COMMON_UI_AND_BRAND_WORDS.has(word.toLowerCase())) {
      return false;
    }
  }

  return true;
}

/** Pattern matching explicit customer identifiers (e.g. CUST-99214, NB-CUST-847291). */
export const CUSTOMER_ID_PATTERN =
  /\b(?:customer[-_\s]?id|cust[-_\s]?id|user[-_\s]?id|account[-_\s]?no|account[-_\s]?number)\s*[:#-]?\s*([A-Za-z0-9_-]+)\b|\b(?:CUST|NB-CUST)[-_][A-Za-z0-9]+\b/i;

/** Pattern matching structured postal address indicators in DOM text. */
export const POSTAL_ADDRESS_PATTERN =
  /\b\d{1,5}\s+[A-Za-z0-9\s,.-]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Residency|Apartments|Lane|Drive|Dr|Marg|Nagar|Colony|Sector)\b/i;

/** Conservative page-context pattern matching high-risk account, billing, profile, and payment pages. */
export const SENSITIVE_PAGE_CONTEXT_PATTERN =
  /\b(account(?:s)?|profile|billing|payment(?:s)?|checkout|statement(?:s)?|customer[-_]?management|wallet|card[-_]?details|security[-_]?settings)\b/i;

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
 * Extracts all valid complete phone number candidates from a text string.
 * Enforces ITU-T E.164 digit length rules (7-15 digits), rejects malformed
 * fragments and longer digit sequences, and excludes payment cards.
 */
export function getValidPhoneMatches(text: string | undefined): string[] {
  if (!text) return [];
  const matches = text.match(GLOBAL_PHONE_PATTERN);
  if (!matches) return [];

  const results: string[] = [];
  for (const match of matches) {
    const digitsOnly = match.replace(/\D/g, '');
    // Phone numbers must have between 7 and 15 digits
    if (digitsOnly.length < 7 || digitsOnly.length > 15) continue;

    // Compact numbers without country prefix or formatting delimiters should not exceed 11 digits
    const hasDelimiters = /[\s().-]/.test(match);
    const hasCountryPrefix = match.trim().startsWith('+');
    if (!hasDelimiters && !hasCountryPrefix && digitsOnly.length > 11) {
      continue;
    }

    // Must not be a valid Luhn payment card
    if (isValidLuhn(match)) continue;

    results.push(match);
  }
  return results;
}

/**
 * Verifies if text contains at least one valid complete phone number.
 */
function containsValidPhone(text: string): boolean {
  return getValidPhoneMatches(text).length > 0;
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
    } else if (
      nameAttr === 'name' ||
      nameAttr.includes('fullname') ||
      nameAttr.includes('full_name') ||
      nameAttr.includes('customername') ||
      nameAttr.includes('customer_name') ||
      nameAttr.includes('cardholder')
    ) {
      findings.push({
        elementId: element.id,
        category: 'name',
        confidence: 'high',
        source: 'attribute',
        semanticReference: 'profile.name'
      });
    }
  }

  // 4. Text, Label, and Attribute Signals
  const textSignals: Array<{ text: string | undefined; source: PrivacySignalSource }> = [
    { text: element.visibleText, source: 'visible_text' },
    { text: element.accessibleName, source: 'accessible_name' },
    { text: element.placeholder, source: 'placeholder' }
  ];

  if (element.attributes) {
    if (element.attributes['aria-label']) {
      textSignals.push({ text: element.attributes['aria-label'], source: 'attribute' });
    }
    if (element.attributes['title']) {
      textSignals.push({ text: element.attributes['title'], source: 'attribute' });
    }
    if (element.attributes['alt']) {
      textSignals.push({ text: element.attributes['alt'], source: 'attribute' });
    }
    if (element.attributes['aria-description']) {
      textSignals.push({ text: element.attributes['aria-description'], source: 'attribute' });
    }
    if (element.attributes['placeholder'] && element.attributes['placeholder'] !== element.placeholder) {
      textSignals.push({ text: element.attributes['placeholder'], source: 'placeholder' });
    }
  }

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

    // Payment card pattern check with Luhn validation or masked card format
    MASKED_FINANCIAL_PATTERN.lastIndex = 0;
    FULLY_MASKED_FINANCIAL_PATTERN.lastIndex = 0;
    if (
      containsValidCard(text) ||
      MASKED_FINANCIAL_PATTERN.test(text) ||
      FULLY_MASKED_FINANCIAL_PATTERN.test(text)
    ) {
      MASKED_FINANCIAL_PATTERN.lastIndex = 0;
      FULLY_MASKED_FINANCIAL_PATTERN.lastIndex = 0;
      findings.push({
        elementId: element.id,
        category: 'card',
        confidence: 'high',
        source,
        semanticReference: 'profile.paymentCard'
      });
    }

    // Person name contextual pattern check
    NAME_CONTEXT_PATTERN.lastIndex = 0;
    if (NAME_CONTEXT_PATTERN.test(text)) {
      NAME_CONTEXT_PATTERN.lastIndex = 0;
      findings.push({
        elementId: element.id,
        category: 'name',
        confidence: 'medium',
        source,
        semanticReference: 'profile.name'
      });
    } else if (isLikelyPersonName(text)) {
      findings.push({
        elementId: element.id,
        category: 'name',
        confidence: 'medium',
        source,
        semanticReference: 'profile.name'
      });
    }

    // Postal address pattern check
    if (POSTAL_ADDRESS_PATTERN.test(text)) {
      findings.push({
        elementId: element.id,
        category: 'address',
        confidence: 'medium',
        source,
        semanticReference: 'profile.address'
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
