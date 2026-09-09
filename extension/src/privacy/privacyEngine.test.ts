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
  });
});
