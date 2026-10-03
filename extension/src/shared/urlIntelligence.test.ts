import { describe, it, expect } from 'vitest';
import {
  isRestrictedUrlScheme,
  isSafeNavigationUrl,
  extractRegisteredDomain,
  parseUrlDetails,
  normalizeCanonicalUrl,
  inferPageTypeFromUrlAndDom
} from './urlIntelligence.js';

describe('urlIntelligence Module', () => {
  describe('isRestrictedUrlScheme', () => {
    it('detects restricted browser internal schemes', () => {
      expect(isRestrictedUrlScheme('chrome://extensions')).toBe(true);
      expect(isRestrictedUrlScheme('chrome-extension://abcdef/popup.html')).toBe(true);
      expect(isRestrictedUrlScheme('edge://settings')).toBe(true);
      expect(isRestrictedUrlScheme('about:blank')).toBe(true);
      expect(isRestrictedUrlScheme('devtools://devtools/bundled/inspector.html')).toBe(true);
      expect(isRestrictedUrlScheme('view-source:https://example.com')).toBe(true);
    });

    it('detects dangerous non-navigable schemes', () => {
      expect(isRestrictedUrlScheme('javascript:alert(1)')).toBe(true);
      expect(isRestrictedUrlScheme('data:text/html,<h1>Hello</h1>')).toBe(true);
      expect(isRestrictedUrlScheme('file:///C:/Users/madis/secret.txt')).toBe(true);
      expect(isRestrictedUrlScheme('blob:https://example.com/uuid')).toBe(true);
      expect(isRestrictedUrlScheme('ws://localhost:8080')).toBe(true);
    });

    it('allows valid web URLs', () => {
      expect(isRestrictedUrlScheme('https://www.amazon.in')).toBe(false);
      expect(isRestrictedUrlScheme('http://localhost:3000')).toBe(false);
      expect(isRestrictedUrlScheme('https://wikipedia.org/wiki/India')).toBe(false);
      expect(isRestrictedUrlScheme('')).toBe(false);
      expect(isRestrictedUrlScheme(undefined)).toBe(false);
    });
  });

  describe('isSafeNavigationUrl', () => {
    it('approves safe HTTPS destinations', () => {
      const res = isSafeNavigationUrl('https://www.amazon.in/s?k=laptops');
      expect(res.safe).toBe(true);
      expect(res.reason).toBeUndefined();
    });

    it('rejects restricted schemes', () => {
      const res = isSafeNavigationUrl('javascript:evil()');
      expect(res.safe).toBe(false);
      expect(res.reason).toContain('Restricted URL scheme');
    });

    it('rejects data and file URLs', () => {
      expect(isSafeNavigationUrl('data:text/plain;base64,SGVsbG8=').safe).toBe(false);
      expect(isSafeNavigationUrl('file:///etc/passwd').safe).toBe(false);
    });

    it('enforces same-domain navigation when cross-domain is disallowed', () => {
      const current = 'https://www.amazon.in/dp/B000123';
      const sameDomain = 'https://www.amazon.in/s?k=mouse';
      const crossDomain = 'https://www.evil.com/phish';

      expect(isSafeNavigationUrl(sameDomain, current, { allowCrossDomain: false }).safe).toBe(true);
      const crossRes = isSafeNavigationUrl(crossDomain, current, { allowCrossDomain: false });
      expect(crossRes.safe).toBe(false);
      expect(crossRes.reason).toContain('Cross-domain navigation not permitted');
    });
  });

  describe('extractRegisteredDomain', () => {
    it('extracts standard eTLD+1 domains', () => {
      expect(extractRegisteredDomain('www.amazon.com')).toBe('amazon.com');
      expect(extractRegisteredDomain('sub.example.org')).toBe('example.org');
      expect(extractRegisteredDomain('github.com')).toBe('github.com');
    });

    it('extracts multi-part TLD domains', () => {
      expect(extractRegisteredDomain('www.amazon.in')).toBe('amazon.in');
      expect(extractRegisteredDomain('sellercentral.amazon.co.uk')).toBe('amazon.co.uk');
      expect(extractRegisteredDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
      expect(extractRegisteredDomain('my.bank.co.in')).toBe('bank.co.in');
      expect(extractRegisteredDomain('shop.com.au')).toBe('shop.com.au');
    });

    it('handles localhost and IP addresses', () => {
      expect(extractRegisteredDomain('localhost')).toBe('localhost');
      expect(extractRegisteredDomain('127.0.0.1')).toBe('127.0.0.1');
      expect(extractRegisteredDomain('192.168.1.10')).toBe('192.168.1.10');
    });
  });

  describe('parseUrlDetails', () => {
    it('parses an Amazon search URL', () => {
      const details = parseUrlDetails('https://www.amazon.in/s?k=gaming+laptop+under+50000&ref=nb_sb_noss');
      expect(details).toBeDefined();
      expect(details?.protocol).toBe('https:');
      expect(details?.hostname).toBe('www.amazon.in');
      expect(details?.domain).toBe('amazon.in');
      expect(details?.pathname).toBe('/s');
      expect(details?.pathSegments).toEqual(['s']);
      expect(details?.searchParams['k']).toBe('gaming laptop under 50000');
      expect(details?.searchQuery).toBe('gaming laptop under 50000');
      expect(details?.isSearchUrl).toBe(true);
      expect(details?.isProductUrl).toBe(false);
      expect(details?.isRestricted).toBe(false);
    });

    it('parses an Amazon product detail URL', () => {
      const details = parseUrlDetails('https://www.amazon.in/Acer-Aspire-Gaming-Graphics-AL15-51G/dp/B0D5B5XN8G/');
      expect(details).toBeDefined();
      expect(details?.domain).toBe('amazon.in');
      expect(details?.isProductUrl).toBe(true);
      expect(details?.isSearchUrl).toBe(false);
    });

    it('parses a home page URL with no query', () => {
      const details = parseUrlDetails('https://www.amazon.in/');
      expect(details).toBeDefined();
      expect(details?.domain).toBe('amazon.in');
      expect(details?.pathname).toBe('/');
      expect(details?.isSearchUrl).toBe(false);
      expect(details?.isProductUrl).toBe(false);
    });

    it('marks restricted internal URLs', () => {
      const details = parseUrlDetails('chrome://settings');
      expect(details).toBeDefined();
      expect(details?.isRestricted).toBe(true);
      expect(details?.protocol).toBe('chrome:');
    });

    it('returns undefined for invalid or empty input', () => {
      expect(parseUrlDetails('')).toBeUndefined();
      expect(parseUrlDetails(undefined)).toBeUndefined();
      expect(parseUrlDetails('not-a-valid-url')).toBeUndefined();
    });
  });

  describe('normalizeCanonicalUrl', () => {
    it('normalizes relative canonical URLs using base URL', () => {
      const base = 'https://www.example.com/articles/ai-trends?tracking=123';
      const canonical = '/articles/ai-trends';
      expect(normalizeCanonicalUrl(canonical, base)).toBe('https://www.example.com/articles/ai-trends');
    });

    it('returns absolute canonical URLs directly', () => {
      const base = 'https://www.example.com/page?ref=test';
      const canonical = 'https://www.example.com/canonical-page';
      expect(normalizeCanonicalUrl(canonical, base)).toBe('https://www.example.com/canonical-page');
    });

    it('rejects javascript: canonical links', () => {
      expect(normalizeCanonicalUrl('javascript:evil()', 'https://example.com')).toBeUndefined();
    });
  });

  describe('inferPageTypeFromUrlAndDom', () => {
    it('infers home for clean root URLs', () => {
      const details = parseUrlDetails('https://www.amazon.in/');
      expect(inferPageTypeFromUrlAndDom(details)).toBe('home');
    });

    it('infers search_results from search queries', () => {
      const details = parseUrlDetails('https://www.amazon.in/s?k=laptop');
      expect(inferPageTypeFromUrlAndDom(details)).toBe('search_results');
    });

    it('infers product from product paths', () => {
      const details = parseUrlDetails('https://www.amazon.in/dp/B0D5B5XN8G');
      expect(inferPageTypeFromUrlAndDom(details)).toBe('product');
    });

    it('infers product from schema.org hints even when URL is ambiguous', () => {
      const details = parseUrlDetails('https://example.com/item123');
      expect(inferPageTypeFromUrlAndDom(details, { schemaType: 'Product' })).toBe('product');
    });

    it('infers article from article hints or path', () => {
      const details = parseUrlDetails('https://example.com/blog/understanding-ai');
      expect(inferPageTypeFromUrlAndDom(details)).toBe('article');
    });

    it('infers documentation from docs path', () => {
      const details = parseUrlDetails('https://example.com/docs/api-reference');
      expect(inferPageTypeFromUrlAndDom(details)).toBe('documentation');
    });

    it('infers restricted for browser system URLs', () => {
      const details = parseUrlDetails('chrome://extensions');
      expect(inferPageTypeFromUrlAndDom(details)).toBe('restricted');
    });
  });
});
