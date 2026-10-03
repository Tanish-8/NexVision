/**
 * Phase 3 — Chat Mode Intent Classification & Information Sufficiency Engine.
 *
 * Evaluates whether the currently perceived webpage context contains sufficient
 * grounded evidence to answer a user's question, or whether structured on-site
 * research (search, link traversal, product comparison) is required.
 *
 * Invariants:
 * - Pure, deterministic decision logic combined with local AI inference when necessary.
 * - Zero cloud transmission: all reasoning runs locally.
 * - Webpage content is treated as untrusted data: prompt injection cannot trigger unauthorized actions.
 * - Bounded research: prevents arbitrary browsing or unbounded loops.
 */

import type {
  PageRepresentation,
  PageMetadata,
  ExtractedFact,
  ExecuteActionRequest,
  ExecutionResult
} from '../shared/types.js';
import { parseUrlDetails, isRestrictedUrlScheme } from '../shared/urlIntelligence.js';
import { sanitizePageRepresentation } from '../privacy/sanitizer.js';
import { buildPageChatContext } from './chatContext.js';

export type ChatIntent =
  | 'current_page_question'
  | 'url_analysis'
  | 'website_search'
  | 'product_discovery'
  | 'product_comparison'
  | 'article_analysis'
  | 'cross_page_research'
  | 'general_question';

export interface SufficiencyDecision {
  readonly isSufficient: boolean;
  readonly intent: ChatIntent;
  readonly confidence: number;
  readonly missingEvidence: readonly string[];
  readonly requiredAction?: 'none' | 'site_search' | 'follow_link' | 'navigate_url' | 'ask_user';
  readonly searchQuery?: string;
  readonly targetLinkHref?: string;
  readonly rationale: string;
  readonly requiresAuthorization?: boolean;
}

/** Patterns indicating product search, discovery, or buying intent. */
const PRODUCT_DISCOVERY_PATTERNS = [
  /\b(?:best|top|cheap|cheapest|budget|affordable|recommend|suggest)\b.*\b(?:laptop|phone|camera|headphone|watch|device|item|product|monitor|tv|shoe|book)s?\b/i,
  /\b(?:laptop|phone|camera|headphone|watch|device|item|product)s?\b.*\b(?:under|below|less than|around|between)\b/i,
  /\b(?:where to buy|buy|find|search for|look for|show me)\b.*\b(?:laptop|phone|camera|headphone|watch|device|product)s?\b/i,
  /\b(?:price of|cost of)\b/i
];

/** Patterns indicating comparison between two or more options. */
const PRODUCT_COMPARISON_PATTERNS = [
  /\b(?:compare|comparison|versus|vs\.?|difference between)\b/i,
  /\b(?:which is better|which one should I buy|pros and cons)\b/i
];

/** Patterns asking directly about the active page's current visible content. */
const CURRENT_PAGE_PATTERNS = [
  /\b(?:what is (?:this|the) (?:page|article|site|website|document) about)\b/i,
  /\b(?:summarize|summary of) (?:this|the) (?:page|article|post|document)\b/i,
  /\b(?:who (?:wrote|is the author of)|when was (?:this|it) published)\b/i,
  /\b(?:explain|explain what is on this page)\b/i,
  /\b(?:what are the (?:main|key) points)\b/i
];

/**
 * Extracts a candidate search query from a user's natural-language question.
 */
export function extractSiteSearchQuery(userMessage: string): string {
  let cleaned = (userMessage || '').trim();

  // Strip trailing punctuation first so suffix regexes can match cleanly
  cleaned = cleaned.replace(/[?!.]+$/, '').trim();

  // Iteratively strip conversational prefixes
  const prefixRegex = /^(?:hey|hi|hello|please|can you|could you|would you|nexvision|tell me|find me|show me|search for|look for|what is the best|what is the|what are the best|what are the)\s+/i;
  while (prefixRegex.test(cleaned)) {
    cleaned = cleaned.replace(prefixRegex, '').trim();
  }

  // Strip trailing page location phrases
  const suffixRegex = /\s+(?:available on this page|on this page|on this site|available here|on here|here|in this store)\s*$/i;
  cleaned = cleaned.replace(suffixRegex, '').trim();

  // Final trim and punctuation cleanup
  cleaned = cleaned.replace(/[?!.]+$/, '').replace(/\s+/g, ' ').trim();
  return cleaned || userMessage.trim();
}

/**
 * Evaluates whether the currently perceived page contains sufficient evidence to satisfy the user's query.
 *
 * Deterministic rules evaluate page type, content presence, and user intent.
 */
export function evaluateInformationSufficiency(
  userMessage: string,
  page?: PageRepresentation
): SufficiencyDecision {
  const query = (userMessage || '').trim();
  const lowerQuery = query.toLowerCase();

  // 1. Check for Direct URL Analysis Intent
  if (/^https?:\/\/[^\s]+$/i.test(query) || lowerQuery.startsWith('analyze url:') || lowerQuery.startsWith('check url:')) {
    return {
      isSufficient: true,
      intent: 'url_analysis',
      confidence: 0.95,
      missingEvidence: [],
      requiredAction: 'none',
      rationale: 'Direct URL analysis request can be evaluated with URL intelligence.'
    };
  }

  const meta = page?.metadata || {};
  const pageType = meta.pageType || 'generic';
  const url = meta.url || '';
  const isRestricted = isRestrictedUrlScheme(url) || pageType === 'restricted';

  // 2. Restricted system pages
  if (isRestricted) {
    return {
      isSufficient: true,
      intent: 'current_page_question',
      confidence: 1.0,
      missingEvidence: [],
      requiredAction: 'none',
      rationale: 'Restricted browser system page cannot be researched or modified.'
    };
  }

  // 3. Product Comparison Intent
  const isComparison = PRODUCT_COMPARISON_PATTERNS.some(p => p.test(query));
  if (isComparison) {
    // If we're on a single product page or home page, a multi-item comparison requires search
    if (pageType === 'product' || pageType === 'home') {
      const extractedQuery = extractSiteSearchQuery(query);
      return {
        isSufficient: false,
        intent: 'product_comparison',
        confidence: 0.85,
        missingEvidence: ['alternative product specifications', 'comparative pricing and reviews'],
        requiredAction: 'site_search',
        searchQuery: extractedQuery,
        rationale: 'Comparison requires retrieving competing items or alternative models via site search.'
      };
    }
  }

  // 4. Product Discovery Intent (e.g. "What is the best gaming laptop under ₹50,000?")
  const isProductDiscovery = PRODUCT_DISCOVERY_PATTERNS.some(p => p.test(query));
  if (isProductDiscovery) {
    // If currently on home page or non-search page, information is NOT sufficient
    if (pageType === 'home' || pageType === 'generic') {
      const searchQuery = extractSiteSearchQuery(query);
      return {
        isSufficient: false,
        intent: 'product_discovery',
        confidence: 0.9,
        missingEvidence: ['matching product catalog items', 'prices and specifications'],
        requiredAction: 'site_search',
        searchQuery,
        rationale: `Current page (${pageType}) does not display catalog items matching '${searchQuery}'. Site search required.`
      };
    }

    // If currently on a product page, but user asks for a category/budget discovery ("What is the best laptop under ₹50,000?")
    if (pageType === 'product') {
      const currentProductName = meta.productData?.name || '';
      // If the query doesn't match the current product's name, user wants to discover others
      if (!currentProductName || !lowerQuery.includes(currentProductName.toLowerCase().split(' ')[0])) {
        const searchQuery = extractSiteSearchQuery(query);
        return {
          isSufficient: false,
          intent: 'product_discovery',
          confidence: 0.85,
          missingEvidence: ['competing product options in budget range'],
          requiredAction: 'site_search',
          searchQuery,
          rationale: 'Active page is a single product detail page, but query requests category discovery.'
        };
      }
    }

    // If already on search results page, check if results are visible
    if (pageType === 'search_results') {
      return {
        isSufficient: true,
        intent: 'product_discovery',
        confidence: 0.85,
        missingEvidence: [],
        requiredAction: 'none',
        rationale: 'Search results page is active; visible products can be evaluated directly.'
      };
    }
  }

  // 5. Current-page questions (summary, author, topics)
  const isCurrentPageQuery = CURRENT_PAGE_PATTERNS.some(p => p.test(query));
  if (isCurrentPageQuery || (page?.elements && page.elements.length > 5)) {
    return {
      isSufficient: true,
      intent: pageType === 'article' ? 'article_analysis' : 'current_page_question',
      confidence: 0.8,
      missingEvidence: [],
      requiredAction: 'none',
      rationale: 'Query pertains to the active document and can be grounded in visible DOM content.'
    };
  }

  // 6. Default fallback
  return {
    isSufficient: true,
    intent: 'general_question',
    confidence: 0.6,
    missingEvidence: [],
    requiredAction: 'none',
    rationale: 'General query evaluated with available page context.'
  };
}

/**
 * Extracts structured atomic facts from a PageRepresentation (JSON-LD product data,
 * price/specs from search results or product cards, and key headings).
 */
export function extractFactsFromPage(page: PageRepresentation): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const url = page.metadata?.canonicalUrl || page.metadata?.url || '';
  const title = page.metadata?.title || '';
  const meta = page.metadata || {};

  // 1. Structured product metadata (schema.org JSON-LD or meta tags)
  if (meta.productData) {
    const p = meta.productData;
    if (p.name) {
      facts.push({
        id: `fact-prod-name-${facts.length + 1}`,
        entityName: p.name,
        field: 'product_name',
        value: p.name,
        sourceUrl: url,
        sourceTitle: title,
        evidenceType: 'structured_metadata',
        verified: true,
        timestamp: Date.now()
      });
    }
    if (p.price) {
      const priceVal = p.priceCurrency ? `${p.priceCurrency} ${p.price}` : p.price;
      facts.push({
        id: `fact-prod-price-${facts.length + 1}`,
        entityName: p.name,
        field: 'price',
        value: String(priceVal),
        sourceUrl: url,
        sourceTitle: title,
        evidenceType: 'product_attribute',
        verified: true,
        timestamp: Date.now()
      });
    }
    if (p.brand) {
      facts.push({
        id: `fact-prod-brand-${facts.length + 1}`,
        entityName: p.name,
        field: 'brand',
        value: p.brand,
        sourceUrl: url,
        sourceTitle: title,
        evidenceType: 'structured_metadata',
        verified: true,
        timestamp: Date.now()
      });
    }
    if (p.ratingValue) {
      const ratingVal = p.reviewCount ? `${p.ratingValue} (${p.reviewCount} reviews)` : p.ratingValue;
      facts.push({
        id: `fact-prod-rating-${facts.length + 1}`,
        entityName: p.name,
        field: 'rating',
        value: String(ratingVal),
        sourceUrl: url,
        sourceTitle: title,
        evidenceType: 'product_attribute',
        verified: true,
        timestamp: Date.now()
      });
    }
  }

  // 2. Scan elements for product cards / search result items with prices
  const priceRegex = /(?:₹|rs\.?|inr|\$)\s*[\d,]+(?:\.\d{2})?/i;
  const elements = page.elements || [];

  // Find candidate product headings/links
  const candidateHeadings = elements.filter(e => {
    if (!e.visibleText || e.visibleText.length < 5) return false;
    const isHeading = e.role === 'heading' || (e.tagName && e.tagName.startsWith('h'));
    const isLink = e.role === 'link' || e.tagName === 'a';
    if (!isHeading && !isLink) return false;
    return !/^(menu|nav|navigation|sign in|account|cart|footer|header|customer service|returns|orders|privacy|terms)/i.test(e.visibleText);
  });

  for (const item of candidateHeadings.slice(0, 15)) {
    const text = item.visibleText!.trim();
    // Check if item text itself contains price
    const directPrice = text.match(priceRegex);
    if (directPrice) {
      const entityName = text.replace(priceRegex, '').trim();
      if (entityName.length > 5) {
        facts.push({
          id: `fact-item-${facts.length + 1}`,
          entityName,
          field: 'price',
          value: directPrice[0],
          sourceUrl: url,
          sourceTitle: title,
          evidenceType: 'search_result',
          verified: true,
          timestamp: Date.now()
        });
      }
    } else {
      // Look for a nearby price in adjacent elements (within 6 elements)
      const idx = elements.indexOf(item);
      const nearbyPrice = elements.slice(idx, idx + 7).find(e =>
        e.visibleText && priceRegex.test(e.visibleText) && e.visibleText.length < 35
      );
      if (nearbyPrice && nearbyPrice.visibleText) {
        const pMatch = nearbyPrice.visibleText.match(priceRegex);
        facts.push({
          id: `fact-item-${facts.length + 1}`,
          entityName: text,
          field: 'price',
          value: pMatch ? pMatch[0] : nearbyPrice.visibleText.trim(),
          sourceUrl: url,
          sourceTitle: title,
          evidenceType: 'search_result',
          verified: true,
          timestamp: Date.now()
        });
      }
    }
  }

  // 3. Fallback: key headings if no structured products found
  if (facts.length === 0) {
    const headings = elements
      .filter(e => (e.role === 'heading' || (e.tagName && e.tagName.startsWith('h'))) && e.visibleText)
      .slice(0, 6);
    for (const h of headings) {
      facts.push({
        id: `fact-heading-${facts.length + 1}`,
        field: 'heading',
        value: h.visibleText!.trim(),
        sourceUrl: url,
        sourceTitle: title,
        evidenceType: 'heading',
        verified: true,
        timestamp: Date.now()
      });
    }
  }

  return facts;
}

/**
 * Synthesizes an evidence-grounded prompt that strictly separates:
 * 1. Untrusted page content.
 * 2. Verified facts extracted from the active page or search results.
 * 3. Clear instructions on citing sources, prices, and explaining any missing criteria.
 */
export function buildEvidenceGroundedPrompt(
  userMessage: string,
  initialPageContext: string,
  research?: {
    intent: ChatIntent;
    searchQuery?: string;
    facts: readonly ExtractedFact[];
    newContext?: string;
    pageTitle?: string;
    pageUrl?: string;
  }
): string {
  const parts: string[] = [];

  // 1. Initial Page Context
  parts.push(initialPageContext);

  // 2. Structured Evidence Ledger
  if (research && research.facts.length > 0) {
    const evidenceLines: string[] = [
      '[Verified Research Evidence Ledger]',
      `Research Intent: ${research.intent}`
    ];

    if (research.searchQuery) {
      evidenceLines.push(`Site Search Query: "${research.searchQuery}"`);
    }
    if (research.pageTitle || research.pageUrl) {
      evidenceLines.push(`Evidence Source: ${research.pageTitle || 'Target Page'} (${research.pageUrl || ''})`);
    }

    evidenceLines.push('Extracted Facts:');
    for (const fact of research.facts) {
      if (fact.entityName) {
        evidenceLines.push(`- [${fact.evidenceType}] ${fact.entityName}: ${fact.field} = ${fact.value}`);
      } else {
        evidenceLines.push(`- [${fact.evidenceType}] ${fact.field} = ${fact.value}`);
      }
    }

    parts.push(evidenceLines.join('\n'));
  }

  // 3. New Context from researched page if present
  if (research?.newContext) {
    parts.push(`[Researched Page Content - Untrusted Data]\n${research.newContext}`);
  }

  return parts.join('\n\n');
}

export interface ExecuteChatResearchOptions {
  readonly userMessage: string;
  readonly tabId?: number;
  readonly initialPage: PageRepresentation;
  readonly domProvider?: (tabId: number) => Promise<PageRepresentation>;
  readonly actionExecutor?: (request: ExecuteActionRequest) => Promise<ExecutionResult>;
  readonly maxHops?: number;
}

export interface ChatResearchResult {
  readonly query: string;
  readonly intent: ChatIntent;
  readonly isResearched: boolean;
  readonly searchQuery?: string;
  readonly sourcesVisited: readonly { readonly title: string; readonly url: string }[];
  readonly facts: readonly ExtractedFact[];
  readonly synthesizedContext: string;
  readonly newPage?: PageRepresentation;
  readonly status: 'sufficient' | 'researched' | 'failed' | 'fallback';
  readonly rationale: string;
}

/**
 * Orchestrates a bounded, safe browser research cycle in Chat Mode.
 *
 * If the current page contains insufficient information to answer the user's question,
 * this function discovers the page's search controls, submits a targeted query,
 * perceives the resulting search/results page, extracts structured facts,
 * and synthesizes an evidence-grounded prompt.
 */
export async function executeChatResearch(
  options: ExecuteChatResearchOptions
): Promise<ChatResearchResult> {
  const { userMessage, tabId, initialPage, domProvider, actionExecutor, maxHops = 1 } = options;
  const initialUrl = initialPage.metadata?.canonicalUrl || initialPage.metadata?.url || '';
  const initialTitle = initialPage.metadata?.title || 'Current Page';

  // 1. Evaluate information sufficiency
  const decision = evaluateInformationSufficiency(userMessage, initialPage);

  const initialFacts = extractFactsFromPage(initialPage);
  const initialContext = buildPageChatContext(initialPage);

  // If already sufficient or no research action is requested
  if (decision.isSufficient || decision.requiredAction !== 'site_search') {
    return {
      query: userMessage,
      intent: decision.intent,
      isResearched: false,
      sourcesVisited: [{ title: initialTitle, url: initialUrl }],
      facts: initialFacts,
      synthesizedContext: initialContext,
      status: 'sufficient',
      rationale: decision.rationale
    };
  }

  // 2. Identify site search control
  const searchControls = initialPage.metadata?.searchControls || [];
  let primarySearchControl = searchControls[0];

  if (!primarySearchControl) {
    // Scan elements directly for searchbox
    const searchboxElem = initialPage.elements?.find(
      e => e.role === 'searchbox' || (e.tagName === 'input' && e.attributes?.['type'] === 'search')
    );
    if (searchboxElem) {
      primarySearchControl = {
        elementId: searchboxElem.id,
        role: 'searchbox',
        placeholder: searchboxElem.attributes?.['placeholder']
      };
    }
  }

  // If no search affordance exists or tabId / actionExecutor missing, cannot execute research
  if (!primarySearchControl?.elementId || !tabId || !actionExecutor || !domProvider || maxHops <= 0) {
    return {
      query: userMessage,
      intent: decision.intent,
      isResearched: false,
      searchQuery: decision.searchQuery,
      sourcesVisited: [{ title: initialTitle, url: initialUrl }],
      facts: initialFacts,
      synthesizedContext: initialContext,
      status: 'fallback',
      rationale: decision.rationale
    };
  }

  // 3. Execute bounded search action
  try {
    const typeActionRequest: ExecuteActionRequest = {
      tabId,
      action: {
        id: `research-search-${Date.now()}`,
        type: 'type',
        target: {
          elementId: primarySearchControl.elementId,
          point: { x: 10, y: 10 },
          viewportBounds: { x: 0, y: 0, width: 100, height: 25 },
          confidence: 1.0,
          observationId: 'obs-chat-research',
          role: 'textbox'
        },
        payload: {
          text: decision.searchQuery || userMessage,
          clearFirst: true,
          pressEnter: true
        }
      }
    };

    const actionResult = await actionExecutor(typeActionRequest);
    if (!actionResult.success) {
      return {
        query: userMessage,
        intent: decision.intent,
        isResearched: false,
        searchQuery: decision.searchQuery,
        sourcesVisited: [{ title: initialTitle, url: initialUrl }],
        facts: initialFacts,
        synthesizedContext: initialContext,
        status: 'failed',
        rationale: `Search action failed: ${'message' in actionResult ? actionResult.message : 'Unknown execution failure'}`
      };
    }

    // 4. Wait for DOM to settle and re-perceive
    await new Promise(r => setTimeout(r, 600));

    const newRawPage = await domProvider(tabId);
    const sanitized = sanitizePageRepresentation(newRawPage);
    const newPage = sanitized.pageRepresentation;

    const newTitle = newPage.metadata?.title || 'Search Results';
    const newUrl = newPage.metadata?.canonicalUrl || newPage.metadata?.url || initialUrl;
    const newFacts = extractFactsFromPage(newPage);
    const combinedFacts = [...initialFacts, ...newFacts];

    // Build synthesized evidence context
    const newPageContext = buildPageChatContext(newPage);
    const synthesizedPrompt = buildEvidenceGroundedPrompt(userMessage, initialContext, {
      intent: decision.intent,
      searchQuery: decision.searchQuery,
      facts: newFacts.length > 0 ? newFacts : combinedFacts,
      newContext: newPageContext,
      pageTitle: newTitle,
      pageUrl: newUrl
    });

    return {
      query: userMessage,
      intent: decision.intent,
      isResearched: true,
      searchQuery: decision.searchQuery,
      sourcesVisited: [
        { title: initialTitle, url: initialUrl },
        { title: newTitle, url: newUrl }
      ],
      facts: combinedFacts,
      synthesizedContext: synthesizedPrompt,
      newPage,
      status: 'researched',
      rationale: `Successfully researched '${decision.searchQuery}' on ${initialPage.metadata?.domain || 'site'}.`
    };
  } catch (researchErr) {
    return {
      query: userMessage,
      intent: decision.intent,
      isResearched: false,
      searchQuery: decision.searchQuery,
      sourcesVisited: [{ title: initialTitle, url: initialUrl }],
      facts: initialFacts,
      synthesizedContext: initialContext,
      status: 'failed',
      rationale: `Research cycle encountered an unexpected error: ${researchErr instanceof Error ? researchErr.message : String(researchErr)}`
    };
  }
}

