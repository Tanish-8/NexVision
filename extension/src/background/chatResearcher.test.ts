import { describe, it, expect } from 'vitest';
import {
  extractSiteSearchQuery,
  evaluateInformationSufficiency,
  extractFactsFromPage,
  buildEvidenceGroundedPrompt,
  executeChatResearch,
  type SufficiencyDecision
} from './chatResearcher.js';
import type { PageRepresentation } from '../shared/types.js';

describe('chatResearcher Module', () => {
  describe('extractSiteSearchQuery', () => {
    it('extracts product search queries with budget constraints', () => {
      const q = 'What is the best gaming laptop under ₹50,000 available on this page?';
      const extracted = extractSiteSearchQuery(q);
      expect(extracted).toContain('gaming laptop');
      expect(extracted).toContain('50,000');
      expect(extracted).not.toContain('available on this page');
      expect(extracted).not.toContain('What is the best');
    });

    it('extracts queries from polite conversational phrasing', () => {
      const q = 'Please find me running shoes under 2000';
      const extracted = extractSiteSearchQuery(q);
      expect(extracted).toBe('running shoes under 2000');
    });
  });

  describe('evaluateInformationSufficiency', () => {
    it('flags product discovery query on home page as INSUFFICIENT and proposes site_search', () => {
      const homePage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Online Shopping site in India: Shop Online for Mobiles, Books, Watches & More - Amazon.in',
          url: 'https://www.amazon.in/',
          domain: 'amazon.in',
          pageType: 'home'
        },
        viewport: { width: 1280, height: 720 },
        elements: []
      };

      const decision = evaluateInformationSufficiency(
        'What is the best gaming laptop under ₹50,000 available on this page?',
        homePage
      );

      expect(decision.isSufficient).toBe(false);
      expect(decision.intent).toBe('product_discovery');
      expect(decision.requiredAction).toBe('site_search');
      expect(decision.searchQuery).toContain('gaming laptop');
      expect(decision.missingEvidence.length).toBeGreaterThan(0);
    });

    it('flags product discovery query on search results page as SUFFICIENT', () => {
      const searchPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Amazon.in : gaming laptop under 50000',
          url: 'https://www.amazon.in/s?k=gaming+laptop+under+50000',
          domain: 'amazon.in',
          pageType: 'search_results'
        },
        viewport: { width: 1280, height: 720 },
        elements: []
      };

      const decision = evaluateInformationSufficiency(
        'What is the best gaming laptop under ₹50,000?',
        searchPage
      );

      expect(decision.isSufficient).toBe(true);
      expect(decision.intent).toBe('product_discovery');
      expect(decision.requiredAction).toBe('none');
    });

    it('classifies current-page summary questions as SUFFICIENT', () => {
      const articlePage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Deep Learning Revolution',
          url: 'https://techblog.example/deep-learning',
          domain: 'techblog.example',
          pageType: 'article'
        },
        viewport: { width: 1280, height: 720 },
        elements: [
          { id: 'e1', tagName: 'h1', role: 'heading', visibleText: 'Deep Learning Revolution' }
        ]
      };

      const decision = evaluateInformationSufficiency(
        'What is this article about?',
        articlePage
      );

      expect(decision.isSufficient).toBe(true);
      expect(decision.intent).toBe('article_analysis');
      expect(decision.requiredAction).toBe('none');
    });

    it('classifies direct URL inputs as url_analysis', () => {
      const decision = evaluateInformationSufficiency('https://github.com/Tanish-8/NexVision');
      expect(decision.isSufficient).toBe(true);
      expect(decision.intent).toBe('url_analysis');
      expect(decision.requiredAction).toBe('none');
    });

    it('treats restricted browser URLs as sufficient without external action', () => {
      const restrictedPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Extensions',
          url: 'chrome://extensions',
          pageType: 'restricted'
        },
        viewport: { width: 1280, height: 720 },
        elements: []
      };

      const decision = evaluateInformationSufficiency(
        'What extensions are installed?',
        restrictedPage
      );

      expect(decision.isSufficient).toBe(true);
      expect(decision.requiredAction).toBe('none');
    });
  });

  describe('extractFactsFromPage', () => {
    it('extracts structured facts from schema.org JSON-LD product data', () => {
      const page: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Acer Predator Helios 300 - Amazon.in',
          url: 'https://www.amazon.in/dp/B08XYZ',
          productData: {
            name: 'Acer Predator Helios 300',
            price: '48,990',
            priceCurrency: 'INR',
            brand: 'Acer',
            ratingValue: '4.4',
            reviewCount: 312
          }
        },
        viewport: { width: 1280, height: 720 },
        elements: []
      };

      const facts = extractFactsFromPage(page);
      expect(facts.length).toBeGreaterThanOrEqual(4);
      expect(facts.some(f => f.field === 'product_name' && f.value === 'Acer Predator Helios 300')).toBe(true);
      expect(facts.some(f => f.field === 'price' && f.value.includes('48,990'))).toBe(true);
      expect(facts.some(f => f.field === 'brand' && f.value === 'Acer')).toBe(true);
      expect(facts.some(f => f.field === 'rating' && f.value.includes('4.4'))).toBe(true);
    });

    it('extracts product candidate items with prices from DOM elements', () => {
      const page: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Amazon.in : gaming laptop under 50000',
          url: 'https://www.amazon.in/s?k=gaming+laptop+under+50000'
        },
        viewport: { width: 1280, height: 720 },
        elements: [
          { id: 'e1', role: 'heading', tagName: 'h2', visibleText: 'Lenovo IdeaPad Gaming 3 AMD Ryzen 5' },
          { id: 'e2', role: 'generic', tagName: 'span', visibleText: '₹46,990' },
          { id: 'e3', role: 'heading', tagName: 'h2', visibleText: 'HP Victus Gaming Laptop Intel Core i5' },
          { id: 'e4', role: 'generic', tagName: 'span', visibleText: '₹49,990' }
        ]
      };

      const facts = extractFactsFromPage(page);
      expect(facts.length).toBeGreaterThanOrEqual(2);
      expect(facts.some(f => f.entityName?.includes('Lenovo') && f.value.includes('46,990'))).toBe(true);
      expect(facts.some(f => f.entityName?.includes('HP') && f.value.includes('49,990'))).toBe(true);
    });
  });

  describe('buildEvidenceGroundedPrompt', () => {
    it('structures verified facts and enforces clear evidence boundaries', () => {
      const prompt = buildEvidenceGroundedPrompt(
        'What is the best gaming laptop under ₹50,000?',
        '[Current Webpage Context]\nTitle: Amazon.in\nURL: https://www.amazon.in/',
        {
          intent: 'product_discovery',
          searchQuery: 'gaming laptop under ₹50,000',
          pageTitle: 'Amazon.in : gaming laptop under 50000',
          pageUrl: 'https://www.amazon.in/s?k=gaming+laptop+under+50000',
          facts: [
            {
              id: 'f1',
              entityName: 'Lenovo IdeaPad Gaming 3',
              field: 'price',
              value: '₹46,990',
              sourceUrl: 'https://www.amazon.in/s?k=gaming+laptop+under+50000',
              sourceTitle: 'Amazon.in',
              evidenceType: 'search_result',
              verified: true
            }
          ]
        }
      );

      expect(prompt).toContain('[Verified Research Evidence Ledger]');
      expect(prompt).toContain('Research Intent: product_discovery');
      expect(prompt).toContain('Site Search Query: "gaming laptop under ₹50,000"');
      expect(prompt).toContain('Lenovo IdeaPad Gaming 3: price = ₹46,990');
    });
  });

  describe('executeChatResearch', () => {
    it('returns immediately without execution if page is already sufficient', async () => {
      const searchPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Amazon.in : gaming laptop under 50000',
          url: 'https://www.amazon.in/s?k=gaming+laptop+under+50000',
          pageType: 'search_results'
        },
        viewport: { width: 1280, height: 720 },
        elements: [
          { id: 'e1', role: 'heading', tagName: 'h2', visibleText: 'Lenovo IdeaPad Gaming 3' },
          { id: 'e2', role: 'generic', tagName: 'span', visibleText: '₹46,990' }
        ]
      };

      const result = await executeChatResearch({
        userMessage: 'What is the best gaming laptop under ₹50,000?',
        tabId: 101,
        initialPage: searchPage
      });

      expect(result.status).toBe('sufficient');
      expect(result.isResearched).toBe(false);
      expect(result.facts.length).toBeGreaterThan(0);
    });

    it('executes bounded site search when page is home and search control is present', async () => {
      const homePage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Online Shopping site in India: Shop Online for Mobiles, Books, Watches & More - Amazon.in',
          url: 'https://www.amazon.in/',
          domain: 'amazon.in',
          pageType: 'home',
          searchControls: [
            {
              elementId: 'elem-search-box',
              role: 'searchbox',
              placeholder: 'Search Amazon.in',
              actionUrl: '/s'
            }
          ]
        },
        viewport: { width: 1280, height: 720 },
        elements: [
          { id: 'elem-search-box', role: 'searchbox', tagName: 'input', visibleText: '' }
        ]
      };

      const searchResultsPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Amazon.in : gaming laptop under 50000',
          url: 'https://www.amazon.in/s?k=gaming+laptop+under+50000',
          domain: 'amazon.in',
          pageType: 'search_results'
        },
        viewport: { width: 1280, height: 720 },
        elements: [
          { id: 'r1', role: 'heading', tagName: 'h2', visibleText: 'Acer Aspire 5 Gaming Laptop Intel Core i5' },
          { id: 'r2', role: 'generic', tagName: 'span', visibleText: '₹47,990' }
        ]
      };

      const executedActions: any[] = [];
      const mockActionExecutor = async (req: any): Promise<any> => {
        executedActions.push(req);
        return {
          success: true,
          actionType: 'type',
          elementId: 'elem-search-box',
          timestamp: Date.now()
        };
      };

      const mockDomProvider = async () => searchResultsPage;

      const result = await executeChatResearch({
        userMessage: 'What is the best gaming laptop under ₹50,000 available on this page?',
        tabId: 101,
        initialPage: homePage,
        domProvider: mockDomProvider,
        actionExecutor: mockActionExecutor
      });

      expect(result.status).toBe('researched');
      expect(result.isResearched).toBe(true);
      expect(executedActions.length).toBe(1);
      expect(executedActions[0].action.type).toBe('type');
      expect(executedActions[0].action.target.elementId).toBe('elem-search-box');
      expect(executedActions[0].action.payload.pressEnter).toBe(true);
      expect(executedActions[0].action.payload.text).toContain('gaming laptop');
      expect(result.facts.some(f => f.entityName?.includes('Acer Aspire 5'))).toBe(true);
      expect(result.sourcesVisited.length).toBe(2);
    });
  });
});

