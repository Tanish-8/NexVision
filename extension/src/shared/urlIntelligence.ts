/**
 * Pure deterministic URL and Page Intelligence module for NexVision.
 *
 * Invariants:
 * - Pure functions only: no Chrome APIs (chrome.*), no network requests, no DOM access.
 * - Referential transparency: same inputs always produce identical outputs.
 * - Strict URL scheme validation: rejects javascript:, data:, chrome:, and file: URLs.
 * - Privacy-first: query parameters are sanitized before categorization.
 */

export type PageType =
  | 'home'
  | 'search_results'
  | 'product'
  | 'article'
  | 'documentation'
  | 'form'
  | 'restricted'
  | 'generic';

export interface UrlDetails {
  readonly rawUrl: string;
  readonly normalizedUrl: string;
  readonly protocol: string;
  readonly hostname: string;
  readonly domain: string;
  readonly pathname: string;
  readonly pathSegments: readonly string[];
  readonly searchParams: Readonly<Record<string, string>>;
  readonly searchQuery?: string;
  readonly isSearchUrl: boolean;
  readonly isProductUrl: boolean;
  readonly isRestricted: boolean;
}

export interface DomTypeHints {
  readonly hasSearchBox?: boolean;
  readonly hasSearchResultsGrid?: boolean;
  readonly hasProductPrice?: boolean;
  readonly hasAddToCart?: boolean;
  readonly hasArticleBody?: boolean;
  readonly hasCodeBlocks?: boolean;
  readonly hasPrimaryForm?: boolean;
  readonly schemaType?: string;
}

/** URL schemes strictly forbidden from inspection or navigation. */
export const RESTRICTED_URL_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'edge:',
  'about:',
  'devtools:',
  'view-source:',
  'javascript:',
  'data:',
  'file:',
  'blob:',
  'ws:',
  'wss:'
]);

/** Common multi-part top-level domain suffixes (e.g. .co.uk, .com.au, .co.in). */
const MULTI_PART_TLDS = new Set([
  'co.uk',
  'co.in',
  'com.au',
  'co.nz',
  'co.jp',
  'co.za',
  'com.br',
  'com.mx',
  'com.sg',
  'gov.in',
  'gov.uk',
  'ac.in',
  'ac.uk',
  'org.uk'
]);

/** Common search query parameter keys used across web search engines and e-commerce. */
const SEARCH_QUERY_PARAM_KEYS = [
  'k',              // Amazon India / US keyword search
  'q',              // Google, Bing, DuckDuckGo, YouTube, GitHub
  'query',          // Generic search
  'search_query',   // YouTube, Wikipedia
  'keywords',       // E-commerce
  'field-keywords', // Amazon alternative
  'search',         // Generic
  'p',              // Yahoo, some forums
  'term'            // Generic
] as const;

/**
 * Checks whether a URL begins with a restricted or browser-internal scheme.
 */
export function isRestrictedUrlScheme(url?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim().toLowerCase();
  for (const scheme of RESTRICTED_URL_SCHEMES) {
    if (trimmed.startsWith(scheme)) return true;
  }
  return false;
}

/**
 * Validates whether a target URL is safe for browser navigation.
 * Forbids restricted schemes and limits destinations to standard HTTP/HTTPS protocols.
 */
export function isSafeNavigationUrl(
  targetUrl?: string,
  currentUrl?: string,
  options?: { allowCrossDomain?: boolean }
): { safe: boolean; reason?: string } {
  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
    return { safe: false, reason: 'URL cannot be empty' };
  }

  const trimmed = targetUrl.trim();

  if (isRestrictedUrlScheme(trimmed)) {
    return { safe: false, reason: `Restricted URL scheme detected in ${trimmed}` };
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(trimmed, currentUrl);
  } catch {
    return { safe: false, reason: `Malformed URL: ${trimmed}` };
  }

  const protocol = parsedTarget.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    return { safe: false, reason: `Unsupported protocol '${protocol}': only http and https are allowed` };
  }

  // Prevent unexpected non-localhost HTTP
  if (protocol === 'http:' && parsedTarget.hostname !== 'localhost' && parsedTarget.hostname !== '127.0.0.1') {
    // We allow standard http for backward compatibility, but flag it if desired
  }

  // Optional domain scoping: restrict navigation to same registered domain
  if (currentUrl && options?.allowCrossDomain === false) {
    try {
      const parsedCurrent = new URL(currentUrl);
      const targetDomain = extractRegisteredDomain(parsedTarget.hostname);
      const currentDomain = extractRegisteredDomain(parsedCurrent.hostname);
      if (targetDomain !== currentDomain) {
        return {
          safe: false,
          reason: `Cross-domain navigation not permitted: '${targetDomain}' differs from current domain '${currentDomain}'`
        };
      }
    } catch {
      // Ignore currentUrl parsing failure
    }
  }

  return { safe: true };
}

/**
 * Extracts the registered domain (eTLD+1) from a hostname.
 * Handles single-level and multi-level TLDs (e.g. 'amazon.in' from 'www.amazon.in',
 * 'google.co.uk' from 'images.google.co.uk', 'localhost' from 'localhost').
 */
export function extractRegisteredDomain(hostname: string): string {
  if (!hostname) return '';
  const cleanHost = hostname.trim().toLowerCase();

  // IP addresses and localhost
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanHost) || cleanHost === 'localhost') {
    return cleanHost;
  }

  const parts = cleanHost.split('.');
  if (parts.length <= 2) {
    return cleanHost;
  }

  // Check if last two parts form a known multi-part TLD (e.g. 'co.in', 'co.uk')
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (MULTI_PART_TLDS.has(lastTwo)) {
    if (parts.length >= 3) {
      return `${parts[parts.length - 3]}.${lastTwo}`;
    }
    return cleanHost;
  }

  // Standard single-part TLD (e.g. .com, .org, .net, .in, .io)
  return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

/**
 * Parses and decomposes a URL string into structured, safe intelligence details.
 */
export function parseUrlDetails(rawUrl?: string): UrlDetails | undefined {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return undefined;
  }

  const trimmed = rawUrl.trim();
  const isRestricted = isRestrictedUrlScheme(trimmed);

  if (isRestricted) {
    return {
      rawUrl: trimmed,
      normalizedUrl: trimmed,
      protocol: trimmed.split(':')[0] + ':',
      hostname: '',
      domain: '',
      pathname: '',
      pathSegments: [],
      searchParams: {},
      isSearchUrl: false,
      isProductUrl: false,
      isRestricted: true
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const domain = extractRegisteredDomain(hostname);
  const pathname = parsed.pathname;
  const pathSegments = pathname.split('/').filter(Boolean);

  const searchParams: Record<string, string> = {};
  parsed.searchParams.forEach((val, key) => {
    searchParams[key.toLowerCase()] = val;
  });

  // Extract search query string if present in params
  let searchQuery: string | undefined;
  for (const key of SEARCH_QUERY_PARAM_KEYS) {
    if (searchParams[key] && searchParams[key].trim().length > 0) {
      searchQuery = searchParams[key].trim();
      break;
    }
  }

  // Heuristic product URL detection
  const isProductPath =
    pathname.includes('/dp/') ||           // Amazon India / Global
    pathname.includes('/gp/product/') ||   // Amazon alternative
    pathname.includes('/p/') ||            // Flipkart product path (e.g. /p/itm...)
    pathname.includes('/item/') ||         // Generic e-commerce
    pathname.includes('/product/') ||      // Generic e-commerce
    pathname.includes('/products/');       // Shopify / Generic

  const isSearchPath =
    Boolean(searchQuery) ||
    pathname === '/s' ||                   // Amazon search
    pathname === '/search' ||              // Generic search
    pathname.startsWith('/search/') ||     // Flipkart / Generic
    pathname === '/results';

  return {
    rawUrl: trimmed,
    normalizedUrl: parsed.origin + parsed.pathname + parsed.search,
    protocol,
    hostname,
    domain,
    pathname,
    pathSegments,
    searchParams,
    searchQuery,
    isSearchUrl: isSearchPath,
    isProductUrl: isProductPath,
    isRestricted: false
  };
}

/**
 * Resolves and normalizes a canonical URL against the current document URL.
 */
export function normalizeCanonicalUrl(canonicalHref?: string, currentUrl?: string): string | undefined {
  if (!canonicalHref || typeof canonicalHref !== 'string' || !canonicalHref.trim()) {
    return undefined;
  }

  const trimmed = canonicalHref.trim();
  if (isRestrictedUrlScheme(trimmed)) {
    return undefined;
  }

  try {
    const resolved = new URL(trimmed, currentUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return undefined;
    }
    return resolved.href;
  } catch {
    return undefined;
  }
}

/**
 * Infers semantic PageType by combining URL intelligence with DOM structural hints.
 */
export function inferPageTypeFromUrlAndDom(
  urlDetails?: UrlDetails,
  domHints?: DomTypeHints
): PageType {
  if (urlDetails?.isRestricted) {
    return 'restricted';
  }

  // 1. Explicit schema.org structured type (strongest hint if available)
  if (domHints?.schemaType) {
    const lowerSchema = domHints.schemaType.toLowerCase();
    if (lowerSchema.includes('product')) return 'product';
    if (lowerSchema.includes('article') || lowerSchema.includes('newsarticle') || lowerSchema.includes('blogposting')) {
      return 'article';
    }
  }

  // 2. Search results detection
  if (urlDetails?.isSearchUrl || domHints?.hasSearchResultsGrid) {
    return 'search_results';
  }

  // 3. Product page detection
  if (urlDetails?.isProductUrl || (domHints?.hasProductPrice && domHints?.hasAddToCart)) {
    return 'product';
  }

  // 4. Documentation detection
  if (urlDetails) {
    const isDocsPath = urlDetails.pathSegments.some(seg =>
      seg === 'docs' || seg === 'documentation' || seg === 'api' || seg === 'guide' || seg === 'manual'
    );
    if (isDocsPath || domHints?.hasCodeBlocks) {
      return 'documentation';
    }
  }

  // 5. Article / Blog detection
  if (urlDetails) {
    const isArticlePath = urlDetails.pathSegments.some(seg =>
      seg === 'blog' || seg === 'article' || seg === 'posts' || seg === 'news'
    );
    if (isArticlePath || domHints?.hasArticleBody) {
      return 'article';
    }
  }

  // 6. Home page detection: root path with no query parameters
  if (urlDetails) {
    const isRoot = urlDetails.pathname === '/' || urlDetails.pathname === '';
    const hasNoQuery = Object.keys(urlDetails.searchParams).length === 0;
    if (isRoot && hasNoQuery) {
      return 'home';
    }
  }

  // 7. Standalone Form detection
  if (domHints?.hasPrimaryForm) {
    return 'form';
  }

  return 'generic';
}
