import { describe, expect, it, vi } from 'vitest';
import type { PageElement, PageRepresentation } from '../shared/types.js';
import {
  detectPrivacyFindings,
  isValidLuhn,
  redactText,
  REDACTION_TOKENS,
  sanitizePageRepresentation,
  sanitizeUrl
} from './index.js';

describe('Local Privacy Engine (Phase 4)', () => {
  // Synthetic test data
  const SYNTHETIC_EMAIL = 'alice@example.com';
  const SYNTHETIC_PHONE = '+1-555-867-5309';
  const SYNTHETIC_CARD_VALID = '4000-0000-0000-0002'; // Luhn valid
  const SYNTHETIC_CARD_INVALID = '4000-0000-0000-0003'; // Luhn invalid

  const createBaseRepresentation = (elements: PageElement[] = []): PageRepresentation => ({
    schemaVersion: '1.0',
    metadata: {
      title: 'NexVision Test Page',
      url: 'https://example.org/dashboard'
    },
    viewport: { width: 1280, height: 800 },
    elements
  });

  // 1. Email detection
  it('detects emails in visibleText and accessibleName', () => {
    const page = createBaseRepresentation([
      {
        id: 'elem-1',
        tagName: 'p',
        role: 'generic',
        visibleText: `User email: ${SYNTHETIC_EMAIL}`
      },
      {
        id: 'elem-2',
        tagName: 'button',
        role: 'button',
        accessibleName: `Send message to ${SYNTHETIC_EMAIL}`
      }
    ]);

    const findings = detectPrivacyFindings(page);
    expect(findings.length).toBe(2);

    const finding1 = findings.find((f) => f.elementId === 'elem-1');
    expect(finding1).toBeDefined();
    expect(finding1?.category).toBe('email');
    expect(finding1?.confidence).toBe('high');
    expect(finding1?.sources).toContain('visible_text');

    const finding2 = findings.find((f) => f.elementId === 'elem-2');
    expect(finding2).toBeDefined();
    expect(finding2?.category).toBe('email');
    expect(finding2?.confidence).toBe('high');
    expect(finding2?.sources).toContain('accessible_name');
  });

  // 2. Phone detection
  it('detects phone numbers with appropriate formats', () => {
    const page = createBaseRepresentation([
      {
        id: 'elem-phone',
        tagName: 'span',
        role: 'generic',
        visibleText: `Call support at ${SYNTHETIC_PHONE} now.`
      }
    ]);

    const findings = detectPrivacyFindings(page);
    const phoneFinding = findings.find((f) => f.elementId === 'elem-phone');
    expect(phoneFinding).toBeDefined();
    expect(phoneFinding?.category).toBe('phone');
    expect(phoneFinding?.sources).toContain('visible_text');
  });

  // 3. Password structural detection
  it('detects password fields via inputType without reading values', () => {
    const page = createBaseRepresentation([
      {
        id: 'elem-pwd',
        tagName: 'input',
        role: 'textbox',
        inputType: 'password',
        placeholder: 'Enter secret password'
      }
    ]);

    const findings = detectPrivacyFindings(page);
    const pwdFinding = findings.find((f) => f.elementId === 'elem-pwd');
    expect(pwdFinding).toBeDefined();
    expect(pwdFinding?.category).toBe('password');
    expect(pwdFinding?.confidence).toBe('high');
    expect(pwdFinding?.sources).toContain('input_type');
    expect(pwdFinding?.semanticReference).toBe('profile.password');

    // Asserts no raw value field exists in finding
    expect((pwdFinding as any).value).toBeUndefined();
    expect((pwdFinding as any).rawValue).toBeUndefined();
    expect((pwdFinding as any).matchedText).toBeUndefined();
  });

  // 4. Sensitive autocomplete detection
  it('detects sensitive categories from autocomplete attributes', () => {
    const page = createBaseRepresentation([
      {
        id: 'elem-email-ac',
        tagName: 'input',
        role: 'textbox',
        attributes: { autocomplete: 'email' }
      },
      {
        id: 'elem-tel-ac',
        tagName: 'input',
        role: 'textbox',
        attributes: { autocomplete: 'tel' }
      },
      {
        id: 'elem-card-ac',
        tagName: 'input',
        role: 'textbox',
        attributes: { autocomplete: 'cc-number' }
      }
    ]);

    const findings = detectPrivacyFindings(page);
    expect(findings.some((f) => f.elementId === 'elem-email-ac' && f.category === 'email')).toBe(true);
    expect(findings.some((f) => f.elementId === 'elem-tel-ac' && f.category === 'phone')).toBe(true);
    expect(findings.some((f) => f.elementId === 'elem-card-ac' && f.category === 'card')).toBe(true);
  });

  // 5. Card detection and Luhn algorithm
  it('detects valid Luhn card numbers and rejects invalid ones', () => {
    expect(isValidLuhn(SYNTHETIC_CARD_VALID)).toBe(true);
    expect(isValidLuhn(SYNTHETIC_CARD_INVALID)).toBe(false);

    const page = createBaseRepresentation([
      {
        id: 'elem-card-valid',
        tagName: 'span',
        role: 'generic',
        visibleText: `Payment card: ${SYNTHETIC_CARD_VALID}`
      },
      {
        id: 'elem-card-invalid',
        tagName: 'span',
        role: 'generic',
        visibleText: `Invoice reference: ${SYNTHETIC_CARD_INVALID}`
      }
    ]);

    const findings = detectPrivacyFindings(page);
    expect(findings.some((f) => f.elementId === 'elem-card-valid' && f.category === 'card')).toBe(true);
    expect(findings.some((f) => f.elementId === 'elem-card-invalid' && f.category === 'card')).toBe(false);
  });

  // 6. Multiple sensitive elements
  it('handles multiple sensitive elements across different categories simultaneously', () => {
    const page = createBaseRepresentation([
      {
        id: 'elem-1',
        tagName: 'p',
        visibleText: `Contact: ${SYNTHETIC_EMAIL}`
      },
      {
        id: 'elem-2',
        tagName: 'p',
        visibleText: `Hotline: ${SYNTHETIC_PHONE}`
      },
      {
        id: 'elem-3',
        tagName: 'input',
        inputType: 'password'
      },
      {
        id: 'elem-4',
        tagName: 'div',
        visibleText: `Card on file: ${SYNTHETIC_CARD_VALID}`
      }
    ]);

    const sanitizedResult = sanitizePageRepresentation(page);
    expect(sanitizedResult.findings.length).toBe(4);
    expect(sanitizedResult.metadata.totalFindings).toBe(4);
    expect(sanitizedResult.metadata.categoryCounts.email).toBe(1);
    expect(sanitizedResult.metadata.categoryCounts.phone).toBe(1);
    expect(sanitizedResult.metadata.categoryCounts.password).toBe(1);
    expect(sanitizedResult.metadata.categoryCounts.card).toBe(1);
  });

  // 7. Normal text unchanged
  it('leaves ordinary non-sensitive text completely intact', () => {
    const normalText = 'Welcome to the dashboard. Please select an option below.';
    const page = createBaseRepresentation([
      {
        id: 'elem-normal',
        tagName: 'h1',
        role: 'heading',
        visibleText: normalText
      }
    ]);

    const sanitizedResult = sanitizePageRepresentation(page);
    expect(sanitizedResult.pageRepresentation.elements[0].visibleText).toBe(normalText);
    expect(sanitizedResult.findings.length).toBe(0);
  });

  // 8. Deterministic sanitization content
  it('produces identical sanitized PageRepresentation and findings across repeated executions', () => {
    const page = createBaseRepresentation([
      {
        id: 'elem-1',
        tagName: 'p',
        visibleText: `Email ${SYNTHETIC_EMAIL} and phone ${SYNTHETIC_PHONE}`
      }
    ]);

    const result1 = sanitizePageRepresentation(page);
    const result2 = sanitizePageRepresentation(page);

    // Verify sanitized PageRepresentation and findings are identical (excluding execution timestamp)
    expect(result1.pageRepresentation).toEqual(result2.pageRepresentation);
    expect(result1.findings).toEqual(result2.findings);
    expect(result1.metadata.totalFindings).toBe(result2.metadata.totalFindings);
    expect(result1.metadata.categoryCounts).toEqual(result2.metadata.categoryCounts);
  });

  // 9. Original sensitive values absent from sanitized representation
  it('ensures original sensitive values are completely absent from sanitized representation', () => {
    const page = createBaseRepresentation([
      {
        id: 'elem-1',
        tagName: 'p',
        visibleText: `Account email: ${SYNTHETIC_EMAIL}`
      },
      {
        id: 'elem-2',
        tagName: 'p',
        visibleText: `Account phone: ${SYNTHETIC_PHONE}`
      },
      {
        id: 'elem-3',
        tagName: 'p',
        visibleText: `Card number: ${SYNTHETIC_CARD_VALID}`
      }
    ]);

    const sanitizedResult = sanitizePageRepresentation(page);
    const serialized = JSON.stringify(sanitizedResult);

    expect(serialized.includes(SYNTHETIC_EMAIL)).toBe(false);
    expect(serialized.includes(SYNTHETIC_PHONE)).toBe(false);
    expect(serialized.includes(SYNTHETIC_CARD_VALID)).toBe(false);

    expect(serialized.includes(REDACTION_TOKENS.EMAIL)).toBe(true);
    expect(serialized.includes(REDACTION_TOKENS.PHONE)).toBe(true);
    expect(serialized.includes(REDACTION_TOKENS.CARD)).toBe(true);
  });

  // 10. Stable element IDs
  it('preserves element IDs accurately without alteration or re-indexing', () => {
    const page = createBaseRepresentation([
      { id: 'custom-btn-1', tagName: 'button', visibleText: `Send to ${SYNTHETIC_EMAIL}` },
      { id: 'custom-btn-2', tagName: 'button', visibleText: 'Cancel' }
    ]);

    const sanitizedResult = sanitizePageRepresentation(page);
    expect(sanitizedResult.pageRepresentation.elements[0].id).toBe('custom-btn-1');
    expect(sanitizedResult.pageRepresentation.elements[1].id).toBe('custom-btn-2');
  });

  // 11. Unchanged bounds
  it('strictly preserves element bounds without modification', () => {
    const bounds = { x: 10, y: 25, width: 200, height: 40 };
    const page = createBaseRepresentation([
      {
        id: 'elem-bounds',
        tagName: 'div',
        bounds,
        visibleText: `Email: ${SYNTHETIC_EMAIL}`
      }
    ]);

    const sanitizedResult = sanitizePageRepresentation(page);
    expect(sanitizedResult.pageRepresentation.elements[0].bounds).toEqual(bounds);
  });

  // 12. Unchanged tag/role/state/relationships
  it('preserves element tag, role, state, interactive flag, and hierarchical relationships', () => {
    const page = createBaseRepresentation([
      {
        id: 'elem-parent',
        tagName: 'form',
        role: 'form',
        state: { visible: true, enabled: true },
        interactive: false,
        childIds: ['elem-child'],
        provenance: 'dom'
      },
      {
        id: 'elem-child',
        tagName: 'button',
        role: 'button',
        state: { visible: true, enabled: true, focused: true },
        interactive: true,
        parentId: 'elem-parent',
        labelIds: ['lbl-1'],
        visibleText: `Sign in as ${SYNTHETIC_EMAIL}`,
        provenance: 'dom'
      }
    ]);

    const sanitizedResult = sanitizePageRepresentation(page);
    const parent = sanitizedResult.pageRepresentation.elements[0];
    const child = sanitizedResult.pageRepresentation.elements[1];

    expect(parent.tagName).toBe('form');
    expect(parent.role).toBe('form');
    expect(parent.childIds).toEqual(['elem-child']);
    expect(parent.interactive).toBe(false);

    expect(child.tagName).toBe('button');
    expect(child.role).toBe('button');
    expect(child.state).toEqual({ visible: true, enabled: true, focused: true });
    expect(child.interactive).toBe(true);
    expect(child.parentId).toBe('elem-parent');
    expect(child.labelIds).toEqual(['lbl-1']);
    expect(child.provenance).toBe('dom');
    expect(child.visibleText).toBe(`Sign in as ${REDACTION_TOKENS.EMAIL}`);
  });

  // 13. Empty representation handling
  it('handles empty elements safely without throwing exceptions', () => {
    const emptyPage = createBaseRepresentation([]);
    const sanitizedResult = sanitizePageRepresentation(emptyPage);

    expect(sanitizedResult.pageRepresentation.elements).toEqual([]);
    expect(sanitizedResult.findings).toEqual([]);
    expect(sanitizedResult.metadata.totalFindings).toBe(0);
  });

  // 14. Invalid or null representation handling
  it('gracefully handles invalid or undefined inputs', () => {
    const sanitizedResult = sanitizePageRepresentation(null as any);
    expect(sanitizedResult.pageRepresentation.elements).toEqual([]);
    expect(sanitizedResult.findings).toEqual([]);
    expect(sanitizedResult.metadata.totalFindings).toBe(0);

    const findings = detectPrivacyFindings(undefined);
    expect(findings).toEqual([]);
  });

  // 15. Deterministic findings ordering
  it('produces consistent findings ordering across runs', () => {
    const page = createBaseRepresentation([
      { id: 'elem-a', tagName: 'p', visibleText: SYNTHETIC_EMAIL },
      { id: 'elem-b', tagName: 'p', visibleText: SYNTHETIC_PHONE }
    ]);

    const findings1 = detectPrivacyFindings(page);
    const findings2 = detectPrivacyFindings(page);

    expect(findings1.map((f) => f.elementId)).toEqual(findings2.map((f) => f.elementId));
    expect(findings1.map((f) => f.category)).toEqual(findings2.map((f) => f.category));
  });

  // 16. Valid confidence values
  it('ensures all findings have validated typed confidence levels', () => {
    const validConfidences = new Set(['high', 'medium', 'low']);
    const page = createBaseRepresentation([
      { id: 'elem-1', tagName: 'input', inputType: 'password' },
      { id: 'elem-2', tagName: 'p', visibleText: SYNTHETIC_EMAIL },
      { id: 'elem-3', tagName: 'p', visibleText: SYNTHETIC_PHONE }
    ]);

    const findings = detectPrivacyFindings(page);
    for (const finding of findings) {
      expect(validConfidences.has(finding.confidence)).toBe(true);
    }
  });

  // 17. No network access invariant
  it('performs all processing locally with zero network calls', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const page = createBaseRepresentation([
      {
        id: 'elem-1',
        tagName: 'p',
        visibleText: `Contact ${SYNTHETIC_EMAIL}`
      }
    ]);

    sanitizePageRepresentation(page);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // 18. No sensitive values in error handling or findings objects
  it('ensures privacy findings strictly do not contain raw values', () => {
    const page = createBaseRepresentation([
      {
        id: 'elem-1',
        tagName: 'p',
        visibleText: `Card: ${SYNTHETIC_CARD_VALID}, Email: ${SYNTHETIC_EMAIL}`
      }
    ]);

    const findings = detectPrivacyFindings(page);
    for (const finding of findings) {
      expect(finding).not.toHaveProperty('value');
      expect(finding).not.toHaveProperty('rawValue');
      expect(finding).not.toHaveProperty('matchedText');
      expect(finding).not.toHaveProperty('originalValue');
    }
  });

  // 19. Explicit regression test specified in prompt
  it('satisfies explicit regression test: "Contact me at alice@example.com"', () => {
    const rawInput = 'Contact me at alice@example.com';
    const page = createBaseRepresentation([
      {
        id: 'elem-contact',
        tagName: 'span',
        visibleText: rawInput
      }
    ]);

    const sanitizedResult = sanitizePageRepresentation(page);
    const sanitizedText = sanitizedResult.pageRepresentation.elements[0].visibleText;

    // RAW: "Contact me at alice@example.com"
    // SANITIZED must not contain "alice@example.com"
    expect(sanitizedText).not.toContain('alice@example.com');
    // and should contain "[REDACTED_EMAIL]"
    expect(sanitizedText).toContain('[REDACTED_EMAIL]');
    expect(sanitizedText).toBe('Contact me at [REDACTED_EMAIL]');
  });

  // 20. URL and metadata sanitization
  it('sanitizes URL query tokens and page title appropriately', () => {
    const page: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: {
        title: `Dashboard - ${SYNTHETIC_EMAIL}`,
        url: `https://example.com/callback?token=secret123456&email=${encodeURIComponent(SYNTHETIC_EMAIL)}&tab=settings`
      },
      viewport: { width: 1000, height: 800 },
      elements: []
    };

    const sanitizedResult = sanitizePageRepresentation(page);

    // Title email redacted
    expect(sanitizedResult.pageRepresentation.metadata.title).not.toContain(SYNTHETIC_EMAIL);
    expect(sanitizedResult.pageRepresentation.metadata.title).toContain(REDACTION_TOKENS.EMAIL);

    // URL token and email redacted, harmless tab param preserved
    const sanitizedUrl = sanitizedResult.pageRepresentation.metadata.url || '';
    expect(sanitizedUrl).not.toContain('secret123456');
    expect(sanitizedUrl).not.toContain(SYNTHETIC_EMAIL);
    expect(sanitizedUrl).toContain('tab=settings');
    expect(sanitizedUrl).toContain(REDACTION_TOKENS.PARAM);
  });

  // 21. Phone regression suite (Fix 2)
  describe('Phone regression suite (Fix 2)', () => {
    // A. Indian international format
    it('sanitizes Indian international format (+91 98765 43210) completely with no trailing digits', () => {
      const rawPhone = '+91 98765 43210';
      const page = createBaseRepresentation([
        { id: 'elem-in-intl', tagName: 'p', visibleText: `Reach us at ${rawPhone} for inquiries` }
      ]);

      const result = sanitizePageRepresentation(page);
      const text = result.pageRepresentation.elements[0].visibleText || '';

      expect(text).toContain(REDACTION_TOKENS.PHONE);
      expect(text).not.toContain(rawPhone);
      expect(text).toBe(`Reach us at ${REDACTION_TOKENS.PHONE} for inquiries`);
    });

    // B. Indian hyphenated format
    it('sanitizes Indian hyphenated format (+91-98765-43210) completely', () => {
      const rawPhone = '+91-98765-43210';
      const page = createBaseRepresentation([
        { id: 'elem-in-hyphen', tagName: 'span', visibleText: `Helpdesk: ${rawPhone}` }
      ]);

      const result = sanitizePageRepresentation(page);
      const text = result.pageRepresentation.elements[0].visibleText || '';

      expect(text).toContain(REDACTION_TOKENS.PHONE);
      expect(text).not.toContain(rawPhone);
      expect(text).toBe(`Helpdesk: ${REDACTION_TOKENS.PHONE}`);
    });

    // C. Indian domestic spaced format
    it('sanitizes Indian domestic spaced format (98765 43210) completely', () => {
      const rawPhone = '98765 43210';
      const page = createBaseRepresentation([
        { id: 'elem-in-spaced', tagName: 'div', visibleText: `Call ${rawPhone} today.` }
      ]);

      const result = sanitizePageRepresentation(page);
      const text = result.pageRepresentation.elements[0].visibleText || '';

      expect(text).toContain(REDACTION_TOKENS.PHONE);
      expect(text).not.toContain(rawPhone);
      expect(text).toBe(`Call ${REDACTION_TOKENS.PHONE} today.`);
    });

    // D. Indian domestic compact format
    it('sanitizes Indian domestic compact format (9876543210) completely', () => {
      const rawPhone = '9876543210';
      const page = createBaseRepresentation([
        { id: 'elem-in-compact', tagName: 'p', visibleText: `Mobile: ${rawPhone}` }
      ]);

      const result = sanitizePageRepresentation(page);
      const text = result.pageRepresentation.elements[0].visibleText || '';

      expect(text).toContain(REDACTION_TOKENS.PHONE);
      expect(text).not.toContain(rawPhone);
      expect(text).toBe(`Mobile: ${REDACTION_TOKENS.PHONE}`);
    });

    // E. Existing international format
    it('sanitizes existing international format (+1-555-867-5309) completely', () => {
      const rawPhone = '+1-555-867-5309';
      const page = createBaseRepresentation([
        { id: 'elem-us-intl', tagName: 'p', visibleText: `US Office: ${rawPhone}` }
      ]);

      const result = sanitizePageRepresentation(page);
      const text = result.pageRepresentation.elements[0].visibleText || '';

      expect(text).toContain(REDACTION_TOKENS.PHONE);
      expect(text).not.toContain(rawPhone);
      expect(text).toBe(`US Office: ${REDACTION_TOKENS.PHONE}`);
    });

    // F. Partial / malformed candidates
    it('rejects malformed or incomplete phone candidates without classifying or redacting them', () => {
      const page = createBaseRepresentation([
        { id: 'elem-short-1', tagName: 'span', visibleText: 'Postal code: 12345' },
        { id: 'elem-short-2', tagName: 'span', visibleText: 'Invalid country code: +91 123' },
        { id: 'elem-short-3', tagName: 'span', visibleText: 'Incomplete sequence: 555-43' }
      ]);

      const result = sanitizePageRepresentation(page);

      expect(result.pageRepresentation.elements[0].visibleText).toBe('Postal code: 12345');
      expect(result.pageRepresentation.elements[1].visibleText).toBe('Invalid country code: +91 123');
      expect(result.pageRepresentation.elements[2].visibleText).toBe('Incomplete sequence: 555-43');
      expect(result.findings.some((f) => f.category === 'phone')).toBe(false);
    });

    // G. Longer numeric sequence (catching the original partial-match bug)
    it('prevents partial phone redaction when phone-like substrings appear inside larger numeric sequences', () => {
      const page = createBaseRepresentation([
        { id: 'elem-order', tagName: 'p', visibleText: 'Order 9999876543210000 processed.' },
        { id: 'elem-tracking', tagName: 'p', visibleText: 'Tracking: 9998765432101234' },
        { id: 'elem-continuous', tagName: 'p', visibleText: 'ID 12345678901234567890' }
      ]);

      const result = sanitizePageRepresentation(page);

      // Verify that larger sequences are NOT partially redacted with [REDACTED_PHONE]
      expect(result.pageRepresentation.elements[0].visibleText).toBe('Order 9999876543210000 processed.');
      expect(result.pageRepresentation.elements[1].visibleText).toBe('Tracking: 9998765432101234');
      expect(result.pageRepresentation.elements[2].visibleText).toBe('ID 12345678901234567890');
      expect(result.findings.some((f) => f.category === 'phone')).toBe(false);
    });

    // Stage 4 Regression Tests: IFSC code and alphanumeric identifier boundary handling
    it('does not detect synthetic IFSC code NEXB0001234 as a phone number', () => {
      const page = createBaseRepresentation([
        { id: 'elem-ifsc', tagName: 'span', visibleText: 'IFSC: NEXB0001234' }
      ]);
      const findings = detectPrivacyFindings(page);
      expect(findings.some((f) => f.category === 'phone')).toBe(false);

      const sanitized = sanitizePageRepresentation(page);
      expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('IFSC: NEXB0001234');
    });

    it('does not detect customer ID CUST9998888 as a phone number', () => {
      const page = createBaseRepresentation([
        { id: 'elem-cust', tagName: 'span', visibleText: 'Customer ID: CUST9998888' }
      ]);
      const findings = detectPrivacyFindings(page);
      expect(findings.some((f) => f.category === 'phone')).toBe(false);

      const sanitized = sanitizePageRepresentation(page);
      expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('Customer ID: CUST9998888');
    });

    it('does not detect transaction reference TXN-928374 as a phone number', () => {
      const page = createBaseRepresentation([
        { id: 'elem-txn', tagName: 'span', visibleText: 'Reference: TXN-928374' }
      ]);
      const findings = detectPrivacyFindings(page);
      expect(findings.some((f) => f.category === 'phone')).toBe(false);

      const sanitized = sanitizePageRepresentation(page);
      expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('Reference: TXN-928374');
    });

    it('detects and sanitizes legitimate Indian formatted phone number +91 98765 43210', () => {
      const rawPhone = '+91 98765 43210';
      const page = createBaseRepresentation([
        { id: 'elem-in-phone', tagName: 'span', visibleText: `Support: ${rawPhone}` }
      ]);
      const findings = detectPrivacyFindings(page);
      const phoneFinding = findings.find((f) => f.category === 'phone');
      expect(phoneFinding).toBeDefined();

      const sanitized = sanitizePageRepresentation(page);
      expect(sanitized.pageRepresentation.elements[0].visibleText).toBe(`Support: ${REDACTION_TOKENS.PHONE}`);
      expect(sanitized.pageRepresentation.elements[0].visibleText).not.toContain(rawPhone);
    });

    it('detects and sanitizes legitimate landline formatted phone number (040) 2345-6789', () => {
      const rawPhone = '(040) 2345-6789';
      const page = createBaseRepresentation([
        { id: 'elem-landline', tagName: 'span', visibleText: `Hyderabad Office: ${rawPhone}` }
      ]);
      const findings = detectPrivacyFindings(page);
      const phoneFinding = findings.find((f) => f.category === 'phone');
      expect(phoneFinding).toBeDefined();

      const sanitized = sanitizePageRepresentation(page);
      expect(sanitized.pageRepresentation.elements[0].visibleText).toBe(`Hyderabad Office: ${REDACTION_TOKENS.PHONE}`);
      expect(sanitized.pageRepresentation.elements[0].visibleText).not.toContain(rawPhone);
    });

    // Stage 2 Regression Tests: Attribute sanitization (aria-label, title, placeholder, alt, aria-description)
    it('sanitizes synthetic emails and phones across aria-label, title, placeholder, alt, and aria-description attributes', () => {
      const rawEmail = 'sensitive.user@example.com';
      const rawPhone = '+91 98765 43210';
      const page = createBaseRepresentation([
        {
          id: 'elem-aria-label',
          tagName: 'button',
          attributes: {
            'aria-label': `Contact ${rawEmail} directly`
          }
        },
        {
          id: 'elem-title',
          tagName: 'a',
          attributes: {
            title: `Reach helpline at ${rawPhone}`
          }
        },
        {
          id: 'elem-placeholder-attr',
          tagName: 'input',
          placeholder: `e.g. ${rawEmail}`,
          attributes: {
            placeholder: `e.g. ${rawEmail}`
          }
        },
        {
          id: 'elem-alt',
          tagName: 'img',
          attributes: {
            alt: `Profile photo of ${rawEmail} (${rawPhone})`
          }
        },
        {
          id: 'elem-aria-desc',
          tagName: 'div',
          attributes: {
            'aria-description': `User verification sent to ${rawEmail} and ${rawPhone}`
          }
        }
      ]);

      const sanitized = sanitizePageRepresentation(page);
      const elements = sanitized.pageRepresentation.elements;

      // elem-aria-label
      expect(elements[0].attributes?.['aria-label']).toBe(`Contact ${REDACTION_TOKENS.EMAIL} directly`);
      expect(elements[0].attributes?.['aria-label']).not.toContain(rawEmail);

      // elem-title
      expect(elements[1].attributes?.['title']).toBe(`Reach helpline at ${REDACTION_TOKENS.PHONE}`);
      expect(elements[1].attributes?.['title']).not.toContain(rawPhone);

      // elem-placeholder-attr
      expect(elements[2].placeholder).toBe(`e.g. ${REDACTION_TOKENS.EMAIL}`);
      expect(elements[2].attributes?.['placeholder']).toBe(`e.g. ${REDACTION_TOKENS.EMAIL}`);
      expect(elements[2].placeholder).not.toContain(rawEmail);
      expect(elements[2].attributes?.['placeholder']).not.toContain(rawEmail);

      // elem-alt
      expect(elements[3].attributes?.['alt']).toBe(
        `Profile photo of ${REDACTION_TOKENS.EMAIL} (${REDACTION_TOKENS.PHONE})`
      );
      expect(elements[3].attributes?.['alt']).not.toContain(rawEmail);
      expect(elements[3].attributes?.['alt']).not.toContain(rawPhone);

      // elem-aria-desc
      expect(elements[4].attributes?.['aria-description']).toBe(
        `User verification sent to ${REDACTION_TOKENS.EMAIL} and ${REDACTION_TOKENS.PHONE}`
      );
      expect(elements[4].attributes?.['aria-description']).not.toContain(rawEmail);
      expect(elements[4].attributes?.['aria-description']).not.toContain(rawPhone);

      // Verify findings were recorded with correct sources
      expect(sanitized.findings.length).toBeGreaterThan(0);
      const emailFindings = sanitized.findings.filter((f) => f.category === 'email');
      const phoneFindings = sanitized.findings.filter((f) => f.category === 'phone');
      expect(emailFindings.length).toBeGreaterThan(0);
      expect(phoneFindings.length).toBeGreaterThan(0);
    });

    it('sanitizes password placeholder attribute to REDACTION_TOKENS.PASSWORD', () => {
      const page = createBaseRepresentation([
        {
          id: 'elem-pwd-attr',
          tagName: 'input',
          inputType: 'password',
          placeholder: 'Enter your ultra secret password',
          attributes: {
            placeholder: 'Enter your ultra secret password',
            type: 'password'
          }
        }
      ]);

      const sanitized = sanitizePageRepresentation(page);
      const elem = sanitized.pageRepresentation.elements[0];

      expect(elem.placeholder).toBe(REDACTION_TOKENS.PASSWORD);
      expect(elem.attributes?.['placeholder']).toBe(REDACTION_TOKENS.PASSWORD);
      expect(elem.attributes?.['placeholder']).not.toContain('ultra secret password');
    });

    it('preserves harmless attribute values without alteration', () => {
      const page = createBaseRepresentation([
        {
          id: 'elem-harmless',
          tagName: 'button',
          attributes: {
            'aria-label': 'Submit Transaction',
            title: 'Click to confirm your order',
            placeholder: 'Search store catalog',
            alt: 'Company corporate logo',
            'aria-description': 'Activates the checkout sequence'
          }
        }
      ]);

      const sanitized = sanitizePageRepresentation(page);
      const attrs = sanitized.pageRepresentation.elements[0].attributes;

      expect(attrs?.['aria-label']).toBe('Submit Transaction');
      expect(attrs?.['title']).toBe('Click to confirm your order');
      expect(attrs?.['placeholder']).toBe('Search store catalog');
      expect(attrs?.['alt']).toBe('Company corporate logo');
      expect(attrs?.['aria-description']).toBe('Activates the checkout sequence');
      expect(sanitized.findings.length).toBe(0);
    });
  });

  // 23. Phase 2.6 Residual Privacy Exposure Remediation Suite
  describe('Phase 2.6 Residual Privacy Exposure Remediation Suite', () => {
    describe('A. Masked financial identifiers', () => {
      it('redacts space-separated masked card (XXXX XXXX 4821) while preserving 4-digit suffix for grounding', () => {
        const rawText = 'Payment card: XXXX XXXX 4821';
        const page = createBaseRepresentation([
          {
            id: 'elem-card-x-space',
            tagName: 'span',
            visibleText: rawText,
            attributes: { 'aria-label': rawText }
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        const elem = sanitized.pageRepresentation.elements[0];

        expect(elem.visibleText).toBe('Payment card: [CARD_ENDING_4821]');
        expect(elem.attributes?.['aria-label']).toBe('Payment card: [CARD_ENDING_4821]');
        expect(elem.visibleText).not.toContain('XXXX XXXX 4821');
        expect(elem.visibleText).not.toContain('XXXX');
      });

      it('redacts asterisk-masked card (**** 4821) while preserving 4-digit suffix for grounding', () => {
        const rawText = 'Primary card: **** 4821';
        const page = createBaseRepresentation([
          {
            id: 'elem-card-star',
            tagName: 'button',
            visibleText: rawText,
            attributes: { title: rawText }
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        const elem = sanitized.pageRepresentation.elements[0];

        expect(elem.visibleText).toBe('Primary card: [CARD_ENDING_4821]');
        expect(elem.attributes?.['title']).toBe('Primary card: [CARD_ENDING_4821]');
        expect(elem.visibleText).not.toContain('**** 4821');
      });

      it('redacts bullet-masked card (•••• 4821) while preserving 4-digit suffix for grounding', () => {
        const rawText = 'Debit card: •••• 4821';
        const page = createBaseRepresentation([
          {
            id: 'elem-card-bullet',
            tagName: 'div',
            visibleText: rawText
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        const elem = sanitized.pageRepresentation.elements[0];

        expect(elem.visibleText).toBe('Debit card: [CARD_ENDING_4821]');
        expect(elem.visibleText).not.toContain('••••');
      });

      it('redacts dash-separated masked card (XXXX-XXXX-XXXX-4821)', () => {
        const rawText = 'Account: XXXX-XXXX-XXXX-4821';
        const page = createBaseRepresentation([
          {
            id: 'elem-card-dash',
            tagName: 'span',
            visibleText: rawText
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        const elem = sanitized.pageRepresentation.elements[0];

        expect(elem.visibleText).toBe('Account: [CARD_ENDING_4821]');
      });

      it('redacts compact masked card (XX4821)', () => {
        const rawText = 'Card ending: XX4821';
        const page = createBaseRepresentation([
          {
            id: 'elem-card-compact',
            tagName: 'span',
            visibleText: rawText
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        const elem = sanitized.pageRepresentation.elements[0];

        expect(elem.visibleText).toBe('Card ending: [CARD_ENDING_4821]');
      });

      it('redacts fully masked cards (XXXX XXXX XXXX XXXX and ••••••••••••) to REDACTION_TOKENS.CARD', () => {
        const page = createBaseRepresentation([
          {
            id: 'elem-card-full-x',
            tagName: 'span',
            visibleText: 'Card: XXXX XXXX XXXX XXXX'
          },
          {
            id: 'elem-card-full-bullet',
            tagName: 'span',
            visibleText: 'Card: ••••••••••••'
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('Card: [REDACTED_CARD]');
        expect(sanitized.pageRepresentation.elements[1].visibleText).toBe('Card: [REDACTED_CARD]');
      });
    });

    describe('B. Customer names', () => {
      it('redacts contextual name in button text ("Welcome, Arjun Reddy")', () => {
        const page = createBaseRepresentation([
          {
            id: 'elem-welcome-btn',
            tagName: 'button',
            visibleText: 'Welcome, Arjun Reddy',
            attributes: { 'aria-label': 'Welcome, Arjun Reddy' }
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        const elem = sanitized.pageRepresentation.elements[0];

        expect(elem.visibleText).toBe('Welcome, [REDACTED_NAME]');
        expect(elem.attributes?.['aria-label']).toBe('Welcome, [REDACTED_NAME]');
        expect(elem.visibleText).not.toContain('Arjun Reddy');
      });

      it('redacts contextual name in accessible names and labels ("Search records for Arjun Reddy")', () => {
        const page = createBaseRepresentation([
          {
            id: 'elem-search-target',
            tagName: 'button',
            visibleText: 'Search records for Arjun Reddy',
            attributes: {
              title: 'Search records for Arjun Reddy',
              'aria-description': 'Search records for Arjun Reddy'
            }
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        const elem = sanitized.pageRepresentation.elements[0];

        expect(elem.visibleText).toBe('Search records for [REDACTED_NAME]');
        expect(elem.attributes?.['title']).toBe('Search records for [REDACTED_NAME]');
        expect(elem.attributes?.['aria-description']).toBe('Search records for [REDACTED_NAME]');
        expect(elem.visibleText).not.toContain('Arjun Reddy');
      });

      it('redacts user profile and logged in notices', () => {
        const page = createBaseRepresentation([
          {
            id: 'elem-profile-photo',
            tagName: 'img',
            attributes: { alt: 'Profile photo of Arjun Reddy' }
          },
          {
            id: 'elem-logged-in',
            tagName: 'div',
            visibleText: 'Signed in as Priya Sharma'
          },
          {
            id: 'elem-user-label',
            tagName: 'span',
            visibleText: 'Customer Name: Rohan Verma'
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].attributes?.['alt']).toBe('Profile photo of [REDACTED_NAME]');
        expect(sanitized.pageRepresentation.elements[1].visibleText).toBe('Signed in as [REDACTED_NAME]');
        expect(sanitized.pageRepresentation.elements[2].visibleText).toBe('Customer Name: [REDACTED_NAME]');
      });

      it('redacts semantic customer name inputs based on element metadata (autocomplete="name")', () => {
        const page = createBaseRepresentation([
          {
            id: 'elem-cust-input',
            tagName: 'input',
            visibleText: 'Arjun Reddy',
            placeholder: 'Arjun Reddy',
            attributes: {
              autocomplete: 'name',
              name: 'customer_name',
              value: 'Arjun Reddy'
            }
          }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        const elem = sanitized.pageRepresentation.elements[0];

        expect(elem.visibleText).toBe('[REDACTED_NAME]');
        expect(elem.placeholder).toBe('[REDACTED_NAME]');
        expect(elem.attributes?.['value']).toBe('[REDACTED_NAME]');
        expect(elem.visibleText).not.toContain('Arjun Reddy');
      });

      it('preserves non-sensitive titles, action buttons, and merchants (zero false positives)', () => {
        const page = createBaseRepresentation([
          { id: 'btn-1', tagName: 'button', visibleText: 'Submit Order' },
          { id: 'btn-2', tagName: 'button', visibleText: 'Amazon Pay' },
          { id: 'btn-3', tagName: 'button', visibleText: 'Swiggy Delivery' },
          { id: 'btn-4', tagName: 'button', visibleText: 'Netflix Subscription' },
          { id: 'btn-5', tagName: 'button', visibleText: 'Order History' },
          { id: 'btn-6', tagName: 'span', visibleText: 'Find my latest Amazon transaction' },
          { id: 'btn-7', tagName: 'span', visibleText: 'Find Swiggy transaction' }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('Submit Order');
        expect(sanitized.pageRepresentation.elements[1].visibleText).toBe('Amazon Pay');
        expect(sanitized.pageRepresentation.elements[2].visibleText).toBe('Swiggy Delivery');
        expect(sanitized.pageRepresentation.elements[3].visibleText).toBe('Netflix Subscription');
        expect(sanitized.pageRepresentation.elements[4].visibleText).toBe('Order History');
        expect(sanitized.pageRepresentation.elements[5].visibleText).toBe('Find my latest Amazon transaction');
        expect(sanitized.pageRepresentation.elements[6].visibleText).toBe('Find Swiggy transaction');
      });
    });

    describe('C. Banking identifier false-positive regression guarantees', () => {
      it('strictly preserves IFSC code (NEXB0001234) without alteration', () => {
        const page = createBaseRepresentation([
          { id: 'elem-ifsc', tagName: 'span', visibleText: 'IFSC: NEXB0001234' }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('IFSC: NEXB0001234');
      });

      it('strictly preserves synthetic Customer ID (CUST-99214) and Transaction ID (TXN-8849201)', () => {
        const page = createBaseRepresentation([
          { id: 'elem-cust-id', tagName: 'span', visibleText: 'Customer ID: CUST-99214' },
          { id: 'elem-txn-id', tagName: 'span', visibleText: 'Transaction: TXN-8849201' }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('Customer ID: CUST-99214');
        expect(sanitized.pageRepresentation.elements[1].visibleText).toBe('Transaction: TXN-8849201');
      });
    });

    describe('D. Phase 2.8 Standalone customer-name boundary tests', () => {
      it('redacts standalone name in ordinary table cells (<td>Arjun Reddy</td>)', () => {
        const page = createBaseRepresentation([
          { id: 'cell-name', tagName: 'td', visibleText: 'Arjun Reddy' }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('[REDACTED_NAME]');
      });

      it('redacts standalone name in ARIA labels (<div aria-label="Arjun Reddy">Profile</div>)', () => {
        const page = createBaseRepresentation([
          { id: 'div-profile', tagName: 'div', visibleText: 'Profile', attributes: { 'aria-label': 'Arjun Reddy' } }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].attributes?.['aria-label']).toBe('[REDACTED_NAME]');
        expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('Profile');
      });

      it('redacts standalone name with non-standard prefix ("Account belonging to Arjun Reddy")', () => {
        const page = createBaseRepresentation([
          { id: 'p-account', tagName: 'p', visibleText: 'Account belonging to Arjun Reddy' }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('Account belonging to [REDACTED_NAME]');
      });

      it('redacts 3-word standalone customer names', () => {
        const page = createBaseRepresentation([
          { id: 'btn-switch', tagName: 'button', visibleText: 'Arjun Kumar Reddy' }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('[REDACTED_NAME]');
      });

      it('preserves ordinary interface labels and locations', () => {
        const page = createBaseRepresentation([
          { id: 'l1', tagName: 'button', visibleText: 'Submit' },
          { id: 'l2', tagName: 'button', visibleText: 'Continue' },
          { id: 'l3', tagName: 'button', visibleText: 'Submit Order' },
          { id: 'l4', tagName: 'button', visibleText: 'Amazon Pay' },
          { id: 'l5', tagName: 'button', visibleText: 'Swiggy Delivery' },
          { id: 'l6', tagName: 'button', visibleText: 'Netflix Subscription' },
          { id: 'l7', tagName: 'span', visibleText: 'Hyderabad Office: Open' },
          { id: 'l8', tagName: 'span', visibleText: 'Customer ID: CUST-99214' },
          { id: 'l9', tagName: 'span', visibleText: 'Transaction: TXN-8849201' }
        ]);

        const sanitized = sanitizePageRepresentation(page);
        expect(sanitized.pageRepresentation.elements[0].visibleText).toBe('Submit');
        expect(sanitized.pageRepresentation.elements[1].visibleText).toBe('Continue');
        expect(sanitized.pageRepresentation.elements[2].visibleText).toBe('Submit Order');
        expect(sanitized.pageRepresentation.elements[3].visibleText).toBe('Amazon Pay');
        expect(sanitized.pageRepresentation.elements[4].visibleText).toBe('Swiggy Delivery');
        expect(sanitized.pageRepresentation.elements[5].visibleText).toBe('Netflix Subscription');
        expect(sanitized.pageRepresentation.elements[6].visibleText).toBe('Hyderabad Office: Open');
        expect(sanitized.pageRepresentation.elements[7].visibleText).toBe('Customer ID: CUST-99214');
        expect(sanitized.pageRepresentation.elements[8].visibleText).toBe('Transaction: TXN-8849201');
      });
    });
  });
});
