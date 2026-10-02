import { describe, it, expect } from 'vitest';
import {
  isRestrictedUrl,
  buildRestrictedPageContext,
  buildUnavailablePageContext,
  buildPageChatContext,
  buildChatUserPrompt,
  CHAT_SYSTEM_PROMPT
} from './chatContext.js';
import type { PageRepresentation, PageElement } from '../shared/types.js';

describe('chatContext Module', () => {
  describe('isRestrictedUrl', () => {
    it('returns true for restricted browser internal URLs', () => {
      expect(isRestrictedUrl('chrome://extensions')).toBe(true);
      expect(isRestrictedUrl('chrome://settings')).toBe(true);
      expect(isRestrictedUrl('chrome-extension://abcdefg/popup.html')).toBe(true);
      expect(isRestrictedUrl('edge://settings')).toBe(true);
      expect(isRestrictedUrl('about:blank')).toBe(true);
      expect(isRestrictedUrl('devtools://devtools/bundled/inspector.html')).toBe(true);
      expect(isRestrictedUrl('view-source:https://example.com')).toBe(true);
    });

    it('returns false for standard web URLs and invalid/empty values', () => {
      expect(isRestrictedUrl('https://wikipedia.org')).toBe(false);
      expect(isRestrictedUrl('https://en.wikipedia.org/wiki/Artificial_intelligence')).toBe(false);
      expect(isRestrictedUrl('https://github.com')).toBe(false);
      expect(isRestrictedUrl('http://localhost:3000')).toBe(false);
      expect(isRestrictedUrl('')).toBe(false);
      expect(isRestrictedUrl(undefined)).toBe(false);
    });
  });

  describe('buildRestrictedPageContext', () => {
    it('generates clear restriction notice with URL and title', () => {
      const result = buildRestrictedPageContext('chrome://extensions', 'Extensions - Chrome');
      expect(result).toContain('URL: chrome://extensions');
      expect(result).toContain('Title: Extensions - Chrome');
      expect(result).toContain('internal browser system page');
      expect(result).toContain('Browser security policies prevent extensions');
    });
  });

  describe('buildUnavailablePageContext', () => {
    it('generates context explaining why DOM was unavailable', () => {
      const result = buildUnavailablePageContext(
        'https://example.com',
        'Example Domain',
        'content script timeout'
      );
      expect(result).toContain('URL: https://example.com');
      expect(result).toContain('Title: Example Domain');
      expect(result).toContain('content script timeout');
    });
  });

  describe('buildPageChatContext', () => {
    it('handles empty page representation with a graceful note', () => {
      const emptyPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Blank Page',
          url: 'https://example.com/blank'
        },
        viewport: { width: 1280, height: 720 },
        elements: []
      };

      const result = buildPageChatContext(emptyPage);
      expect(result).toContain('URL: https://example.com/blank');
      expect(result).toContain('Title: Blank Page');
      expect(result).toContain('Note: This webpage currently has no visible text content');
    });

    it('extracts and formats headings, main content, and interactive controls', () => {
      const elements: PageElement[] = [
        {
          id: 'elem-1',
          tagName: 'h1',
          role: 'heading',
          visibleText: 'Wikipedia, the free encyclopedia',
          state: { visible: true }
        },
        {
          id: 'elem-2',
          tagName: 'h2',
          role: 'heading',
          visibleText: 'Welcome to Wikipedia',
          state: { visible: true }
        },
        {
          id: 'elem-3',
          tagName: 'p',
          role: 'generic',
          visibleText: 'Wikipedia is a free online encyclopedia written and maintained by a community of volunteers through open collaboration.',
          state: { visible: true }
        },
        {
          id: 'elem-4',
          tagName: 'input',
          role: 'searchbox',
          accessibleName: 'Search Wikipedia',
          placeholder: 'Search Wikipedia',
          state: { visible: true },
          interactive: true
        },
        {
          id: 'elem-5',
          tagName: 'button',
          role: 'button',
          accessibleName: 'Search',
          state: { visible: true },
          interactive: true
        },
        // Invisible element should be omitted
        {
          id: 'elem-6',
          tagName: 'p',
          role: 'generic',
          visibleText: 'Hidden secret text that should not appear',
          state: { visible: false }
        }
      ];

      const page: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Wikipedia, the free encyclopedia',
          url: 'https://en.wikipedia.org/wiki/Main_Page'
        },
        viewport: { width: 1280, height: 720 },
        elements
      };

      const result = buildPageChatContext(page);

      expect(result).toContain('URL: https://en.wikipedia.org/wiki/Main_Page');
      expect(result).toContain('Title: Wikipedia, the free encyclopedia');
      expect(result).toContain('Page Headings / Sections:');
      expect(result).toContain('- [H1] Wikipedia, the free encyclopedia');
      expect(result).toContain('- [H2] Welcome to Wikipedia');
      expect(result).toContain('Main Content / Visible Text:');
      expect(result).toContain('Wikipedia is a free online encyclopedia');
      expect(result).toContain('Key Controls & Actions:');
      expect(result).toContain('Search Wikipedia');
      expect(result).not.toContain('Hidden secret text');
    });

    it('preserves sanitized privacy tokens like [REDACTED_NAME]', () => {
      const elements: PageElement[] = [
        {
          id: 'elem-10',
          tagName: 'h1',
          role: 'heading',
          visibleText: 'Account Dashboard',
          state: { visible: true }
        },
        {
          id: 'elem-11',
          tagName: 'p',
          role: 'generic',
          visibleText: 'Welcome back, [REDACTED_NAME]. Your account number ends in 4321.',
          state: { visible: true }
        }
      ];

      const page: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'NexBank Synthetic Dashboard',
          url: 'https://bank.example/dashboard'
        },
        viewport: { width: 1280, height: 720 },
        elements
      };

      const result = buildPageChatContext(page);
      expect(result).toContain('[REDACTED_NAME]');
      expect(result).not.toContain('John Doe');
    });

    it('preserves short transaction IDs, currency amounts, and merchant names in modal and table', () => {
      const modalElements: PageElement[] = [
        {
          id: 'dlg-1',
          tagName: 'div',
          role: 'dialog',
          accessibleName: 'Transaction details',
          attributes: { role: 'dialog', 'aria-modal': 'true', class: 'txn-detail-overlay visible' },
          state: { visible: true }
        },
        {
          id: 'd-merchant',
          tagName: 'span',
          role: 'generic',
          visibleText: 'Amazon',
          attributes: { 'data-detail': 'merchant' },
          state: { visible: true }
        },
        {
          id: 'd-amount',
          tagName: 'span',
          role: 'generic',
          visibleText: '−₹4,299',
          attributes: { 'data-detail': 'amount' },
          state: { visible: true }
        },
        {
          id: 'd-date',
          tagName: 'span',
          role: 'generic',
          visibleText: '30 Sep 2026',
          attributes: { 'data-detail': 'date' },
          state: { visible: true }
        },
        {
          id: 'd-txnid',
          tagName: 'span',
          role: 'generic',
          visibleText: 'TXN-928374',
          attributes: { 'data-detail': 'txnId' },
          state: { visible: true }
        },
        {
          id: 'd-status',
          tagName: 'span',
          role: 'generic',
          visibleText: 'Completed',
          attributes: { 'data-detail': 'status' },
          state: { visible: true }
        },
        // Noise elements that must be filtered out
        {
          id: 'noise-1',
          tagName: 'span',
          role: 'generic',
          visibleText: '·',
          state: { visible: true }
        },
        {
          id: 'noise-2',
          tagName: 'span',
          role: 'generic',
          visibleText: ' | ',
          state: { visible: true }
        },
        {
          id: 'noise-3',
          tagName: 'span',
          role: 'generic',
          visibleText: '---',
          state: { visible: true }
        },
        {
          id: 'noise-4',
          tagName: 'span',
          role: 'generic',
          visibleText: ' ',
          state: { visible: true }
        }
      ];

      const page: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'NexBank — Personal Banking',
          url: 'https://bank.example/dashboard'
        },
        viewport: { width: 1280, height: 720 },
        elements: modalElements
      };

      const result = buildPageChatContext(page);

      // Verify active dialog section
      expect(result).toContain('Active Dialog / Modal Details:');
      expect(result).toContain('- Merchant: Amazon');
      expect(result).toContain('- Amount: −₹4,299');
      expect(result).toContain('- Date: 30 Sep 2026');
      expect(result).toContain('- TxnId: TXN-928374');
      expect(result).toContain('- Status: Completed');

      // Verify noise elements are filtered out
      expect(result).not.toContain('- [SPAN] ·');
      expect(result).not.toContain('\n·\n');
      expect(result).not.toContain('\n|\n');
    });
  });

  describe('buildChatUserPrompt', () => {
    it('builds comprehensive prompt with context, history, and current question', () => {
      const pageContext = 'URL: https://en.wikipedia.org\nTitle: Wikipedia\nMain Content: Online encyclopedia.';
      const history = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi! How can I help you today?' }
      ];
      const question = 'What is this webpage about?';

      const prompt = buildChatUserPrompt(question, history, pageContext);

      expect(prompt).toContain('[Current Webpage Context]');
      expect(prompt).toContain('URL: https://en.wikipedia.org');
      expect(prompt).toContain('[Conversation History]');
      expect(prompt).toContain('User: Hello');
      expect(prompt).toContain('Assistant: Hi! How can I help you today?');
      expect(prompt).toContain('User Question: What is this webpage about?');
    });

    it('builds valid prompt when history or context are absent', () => {
      const prompt = buildChatUserPrompt('What is this webpage about?');
      expect(prompt).toBe('User Question: What is this webpage about?');
      expect(prompt).not.toContain('[Current Webpage Context]');
      expect(prompt).not.toContain('[Conversation History]');
    });
  });

  describe('CHAT_SYSTEM_PROMPT', () => {
    it('instructs model not to ask for URL when provided in context', () => {
      expect(CHAT_SYSTEM_PROMPT).toContain('ground your answers in the provided [Current Webpage Context]');
      expect(CHAT_SYSTEM_PROMPT).toContain('Never ask the user for the URL or website name when it is already provided');
    });
  });
});
