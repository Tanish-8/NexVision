/**
 * DOM Perception module for SIH26171.
 * Extracts a PageRepresentation from the current DOM.
 */

import {
  PAGE_REPRESENTATION_SCHEMA_VERSION,
  type ElementBounds,
  type ElementProvenance,
  type ElementRole,
  type ElementState,
  type PageElement,
  type PageMetadata,
  type PageRepresentation,
  type Viewport,
  type PageType,
  type PageProductData,
  type PageRelevantLink,
  type PageSearchControl
} from '../shared/types.js';
import {
  parseUrlDetails,
  normalizeCanonicalUrl,
  inferPageTypeFromUrlAndDom,
  isRestrictedUrlScheme,
  type DomTypeHints
} from '../shared/urlIntelligence.js';

/** Roles that can be represented without copying an arbitrary role value. */
const SUPPORTED_ARIA_ROLES = new Set<ElementRole>([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'heading',
  'image',
  'navigation',
  'form',
  'alert',
  'dialog',
  'menuitem',
  'progressbar',
  'region',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'treeitem',
  'generic',
  'container',
  'unknown'
]);

/** ARIA roles that intentionally remove or neutralize native semantics. */
const PRESENTATION_ROLES = new Set(['none', 'presentation']);

/** Native elements with useful semantics or interaction affordances. */
const NATIVE_CANDIDATE_TAGS = new Set([
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'option',
  'label',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'img',
  'form',
  'nav',
  'dialog',
  'progress',
  'summary',
  'video',
  'audio'
]);

/** Text-bearing structural elements worth exposing when they contain content. */
const MEANINGFUL_CONTENT_TAGS = new Set([
  'main',
  'article',
  'section',
  'aside',
  'header',
  'footer',
  'p',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'li',
  'dt',
  'dd',
  'table',
  'caption',
  'output'
]);

/** Elements that may contribute to the page representation. */
const PERCEPTION_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'option',
  'label',
  'h1, h2, h3, h4, h5, h6',
  'img',
  'form',
  'nav',
  'dialog',
  'progress',
  'summary',
  'video, audio',
  'main, article, section, aside, header, footer',
  'p, blockquote, pre, figure, figcaption, li, dt, dd, table, caption, output',
  '[role]',
  '[tabindex]',
  '[data-detail]'
].join(', ');

/**
 * Normalizes text by collapsing whitespace, formatting punctuation spacing, and trimming.
 */
function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.:;!?])/g, '$1')
    .trim();
}

/** Gets the first explicit ARIA role token without preserving arbitrary values. */
function getExplicitRole(element: Element): string | undefined {
  const role = normalizeText(element.getAttribute('role') || '').toLowerCase();
  return role ? role.split(/\s+/)[0] : undefined;
}

/**
 * Determines whether a candidate is a native semantic element. An anchor is
 * useful here only when it has an href; an anchor without one is not a native
 * link and needs an independent role or tabindex to be represented.
 */
function isNativeCandidate(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  if (!NATIVE_CANDIDATE_TAGS.has(tagName)) {
    return false;
  }
  return tagName !== 'a' || element.hasAttribute('href');
}

/**
 * Presentation roles are ignored on native interactive controls because those
 * controls retain an actionable accessibility semantic.
 */
function isNativeInteractiveElement(element: Element): boolean {
  return element.matches(
    'input:not([type="hidden"]), textarea, select, button, summary, a[href], video, audio'
  );
}

/**
 * Determines whether a structural element contributes meaningful text or an
 * accessible name, without promoting arbitrary layout containers.
 */
function isMeaningfulContentCandidate(element: Element): boolean {
  if (!MEANINGFUL_CONTENT_TAGS.has(element.tagName.toLowerCase())) {
    return false;
  }
  return Boolean(getVisibleText(element) || getAccessibleName(element));
}

/**
 * Selects useful representation candidates while excluding role-only noise.
 * Negative tabindex elements remain candidates for representation, but their
 * interactivity is decided separately by isInteractive().
 */
function isRepresentationCandidate(element: Element): boolean {
  const explicitRole = getExplicitRole(element);
  const hasTabindex = element.hasAttribute('tabindex');
  const nativeCandidate = isNativeCandidate(element);
  const meaningfulContent = isMeaningfulContentCandidate(element);
  const hasStructuredDetail = element.hasAttribute('data-detail');

  if (explicitRole && PRESENTATION_ROLES.has(explicitRole)) {
    return isNativeInteractiveElement(element) || hasTabindex;
  }

  if (
    explicitRole === 'img'
    || (explicitRole && SUPPORTED_ARIA_ROLES.has(explicitRole as ElementRole))
  ) {
    return true;
  }

  return nativeCandidate || hasTabindex || meaningfulContent || hasStructuredDetail;
}

/** Tags whose content is not user-facing rendered text. */
const IGNORED_TEXT_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template'
]);

/**
 * Checks CSS visibility without requiring layout. This is used for text nodes
 * below a visible element; the root element still goes through the layout check
 * in isElementVisible().
 */
function hasVisibleCss(element: Element): boolean {
  if (element.hasAttribute('hidden')) {
    return false;
  }

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const style = window.getComputedStyle(element);
      if (style) {
        if (style.display === 'none') {
          return false;
        }
        if (style.visibility === 'hidden' || style.visibility === 'collapse') {
          return false;
        }
        if (style.opacity === '0' || parseFloat(style.opacity) === 0) {
          // Distinguish a genuinely hidden modal from an element transitioning into view.
          // An element is transitioning into view if:
          // 1. It has an active transition on opacity or all
          // 2. AND it has an explicit active visibility class/state
          const hasTransition = Boolean(
            (style.transitionProperty && (style.transitionProperty.includes('opacity') || style.transitionProperty.includes('all'))) ||
            (style.transition && (style.transition.includes('opacity') || style.transition.includes('all')))
          );
          const hasActiveVisibleClass = element instanceof HTMLElement && (
            element.classList.contains('visible') ||
            element.classList.contains('open') ||
            element.classList.contains('show') ||
            element.classList.contains('active')
          );
          if (!(hasTransition && hasActiveVisibleClass)) {
            return false;
          }
        }
      }
    } catch {
      // In case getComputedStyle fails in mock environments
    }
  }

  if (element instanceof HTMLElement) {
    const inlineDisplay = element.style?.display;
    if (inlineDisplay === 'none') {
      return false;
    }
    const inlineVisibility = element.style?.visibility;
    if (inlineVisibility === 'hidden' || inlineVisibility === 'collapse') {
      return false;
    }
    const inlineOpacity = element.style?.opacity;
    if (inlineOpacity === '0' || (inlineOpacity !== '' && inlineOpacity !== undefined && parseFloat(inlineOpacity) === 0)) {
      const hasActiveVisibleClass =
        element.classList.contains('visible') ||
        element.classList.contains('open') ||
        element.classList.contains('show') ||
        element.classList.contains('active');
      if (!hasActiveVisibleClass) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Determines whether an element or any of its ancestors is inert.
 */
function isInert(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      current.hasAttribute('inert')
      || ('inert' in current && Boolean((current as HTMLElement).inert))
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * Determines if an element is visible. A non-zero layout rectangle is required
 * in production so that displayable but zero-sized elements are not actionable.
 * Off-screen elements that are rendered retain positive dimensions and are not
 * considered invisible merely because they lie outside the viewport.
 */
function isElementVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement || (typeof SVGElement !== 'undefined' && element instanceof SVGElement))) {
    return false;
  }

  // Hidden inputs have no user-visible representation even if a test or page
  // supplies a synthetic rectangle.
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === 'hidden') {
    return false;
  }

  let current: Element | null = element;
  while (current) {
    if (!hasVisibleCss(current)) {
      return false;
    }
    current = current.parentElement;
  }

  // Keep this layout check: happy-dom tests mock this method because it has no
  // browser layout engine, while the extension uses the real browser result.
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Collects rendered text while excluding hidden descendants, script/style/template
 * content, and sensitive form control values.
 */
function getVisibleText(element: Element): string | undefined {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || IGNORED_TEXT_TAGS.has(tagName)) {
    return undefined;
  }

  if (tagName === 'select') {
    const selectedOptions = Array.from((element as HTMLSelectElement).options)
      .filter((option) => option.selected)
      .map((option) => getVisibleText(option) || '');
    const selectedText = normalizeText(selectedOptions.join(' '));
    return selectedText || undefined;
  }

  function collectText(node: Node, isRoot = false): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }

    if (node instanceof Element) {
      const childTag = node.tagName.toLowerCase();
      if (IGNORED_TEXT_TAGS.has(childTag)) {
        return '';
      }
      // Exclude user-entered controls even when they are descendants of a
      // represented container such as a form.
      if (
        !isRoot
        && (childTag === 'input' || childTag === 'textarea')
      ) {
        return '';
      }
      if (!isRoot && !hasVisibleCss(node)) {
        return '';
      }
      return Array.from(node.childNodes)
        .map((child) => collectText(child, false))
        .join(' ');
    }

    return '';
  }

  const text = normalizeText(collectText(element, true));
  return text || undefined;
}

/**
 * Determines the semantic role of an element from ARIA and native semantics.
 */
function getElementRole(element: Element): ElementRole {
  const explicitRole = getExplicitRole(element);

  if (
    explicitRole
    && PRESENTATION_ROLES.has(explicitRole)
    && !isNativeInteractiveElement(element)
  ) {
    return 'generic';
  }

  if (explicitRole && !PRESENTATION_ROLES.has(explicitRole)) {
    if (explicitRole === 'img') {
      return 'image';
    }
    if (SUPPORTED_ARIA_ROLES.has(explicitRole as ElementRole)) {
      return explicitRole as ElementRole;
    }
  }

  const tagName = element.tagName.toLowerCase();
  const inputType = tagName === 'input'
    ? (element as HTMLInputElement).type.toLowerCase()
    : '';

  if (tagName === 'button') {
    return 'button';
  }
  if (tagName === 'a' && element.hasAttribute('href')) {
    return 'link';
  }
  if (tagName === 'input') {
    switch (inputType) {
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'search':
        return 'searchbox';
      case 'text':
      case 'email':
      case 'password':
      case 'tel':
      case 'url':
      case 'number':
        return 'textbox';
      case 'submit':
      case 'reset':
      case 'button':
        return 'button';
      case 'image':
        return 'image';
      case 'hidden':
      case 'file':
        return 'generic';
      default:
        return 'textbox';
    }
  }
  if (tagName === 'textarea') {
    return 'textbox';
  }
  if (tagName === 'select') {
    return (element as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  }
  if (tagName === 'option') {
    return 'option';
  }
  if (/^h[1-6]$/.test(tagName)) {
    return 'heading';
  }
  if (tagName === 'img') {
    return 'image';
  }
  if (tagName === 'form') {
    return 'form';
  }
  if (tagName === 'nav') {
    return 'navigation';
  }
  if (tagName === 'dialog') {
    return 'dialog';
  }
  if (tagName === 'progress') {
    return 'progressbar';
  }
  if (tagName === 'summary') {
    return 'button';
  }

  return 'generic';
}

/**
 * Resolves all <label> elements associated with an element through native
 * form control relationship, explicit label[for] matching, or wrapping labels.
 */
function getAssociatedLabels(element: Element): Element[] {
  const labels: Element[] = [];
  const seen = new Set<Element>();

  // A label element itself does not have associated labels
  if (element.tagName.toLowerCase() === 'label') {
    return labels;
  }

  // 1. Native form control .labels property if available
  if ('labels' in element) {
    const nativeLabels = (element as HTMLInputElement).labels;
    if (nativeLabels) {
      for (const label of Array.from(nativeLabels)) {
        if (!seen.has(label)) {
          seen.add(label);
          labels.push(label);
        }
      }
    }
  }

  // 2. Explicit label[for="id"] matching
  const id = element.getAttribute('id');
  if (id) {
    try {
      const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(id)
        : id.replace(/["\\]/g, '\\$&');
      const matchingLabels = document.querySelectorAll(`label[for="${escapedId}"]`);
      for (const label of Array.from(matchingLabels)) {
        if (!seen.has(label)) {
          seen.add(label);
          labels.push(label);
        }
      }
    } catch {
      // Ignore selector errors if any
    }
  }

  // 3. Wrapping label ancestor
  let parent = element.parentElement;
  while (parent) {
    if (parent.tagName.toLowerCase() === 'label') {
      if (!seen.has(parent)) {
        seen.add(parent);
        labels.push(parent);
      }
      break;
    }
    parent = parent.parentElement;
  }

  return labels;
}

/**
 * Gets text from an element that can safely be used as an accessible name.
 */
function getNameText(element: Element): string | undefined {
  const ariaLabel = normalizeText(element.getAttribute('aria-label') || '');
  if (ariaLabel) {
    return ariaLabel;
  }
  return getVisibleText(element);
}

/**
 * Extracts an accessible name using lightweight deterministic precedence rules.
 * Supports aria-labelledby, aria-label, associated and wrapping labels, button/link text
 * (and child img alt), img alt, and placeholder fallback.
 */
function getAccessibleName(element: Element): string | undefined {
  const labelledBy = normalizeText(element.getAttribute('aria-labelledby') || '');
  if (labelledBy) {
    const names = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((labelledElement): labelledElement is HTMLElement => labelledElement !== null)
      .map((labelledElement) => getNameText(labelledElement) || '')
      .filter(Boolean);
    const labelledName = normalizeText(names.join(' '));
    if (labelledName) {
      return labelledName;
    }
  }

  const ariaLabel = normalizeText(element.getAttribute('aria-label') || '');
  if (ariaLabel) {
    return ariaLabel;
  }

  if (element.matches('input, textarea, select, progress, meter, output')) {
    const labels = getAssociatedLabels(element);
    if (labels.length > 0) {
      const labelNames = labels
        .map((label) => getNameText(label) || '')
        .filter(Boolean);
      const combinedLabelName = normalizeText(labelNames.join(' '));
      if (combinedLabelName) {
        return combinedLabelName;
      }
    }
  }

  const tagName = element.tagName.toLowerCase();
  if (tagName === 'img' || (tagName === 'input' && (element as HTMLInputElement).type === 'image')) {
    const alt = normalizeText(element.getAttribute('alt') || '');
    if (alt) {
      return alt;
    }
  }

  const role = getElementRole(element);
  if (
    role === 'button'
    || role === 'link'
    || role === 'heading'
    || role === 'option'
    || role === 'tab'
    || role === 'menuitem'
    || role === 'checkbox'
    || role === 'radio'
    || role === 'switch'
  ) {
    const visibleText = getVisibleText(element);
    if (visibleText) {
      return visibleText;
    }
    const childImg = element.querySelector('img[alt]');
    if (childImg) {
      const childAlt = normalizeText(childImg.getAttribute('alt') || '');
      if (childAlt) {
        return childAlt;
      }
    }
  }

  if (element.matches('input, textarea')) {
    const placeholder = normalizeText(
      (element as HTMLInputElement | HTMLTextAreaElement).placeholder || ''
    );
    if (placeholder) {
      return placeholder;
    }
  }

  const title = normalizeText(element.getAttribute('title') || '');
  return title || undefined;
}

/**
 * Copies only selected attributes useful for grounding and state. In
 * particular, value, checked, and selected are never copied.
 */
function extractAttributes(element: Element): Record<string, string> {
  const relevantAttributes = [
    'type',
    'name',
    'placeholder',
    'href',
    'alt',
    'title',
    'role',
    'class',
    'data-detail',
    'data-txn',
    'data-date',
    'data-timestamp',
    'data-amount',
    'data-merchant',
    'datetime',
    'aria-autocomplete',
    'autocomplete',
    'aria-controls',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'aria-expanded',
    'aria-checked',
    'aria-selected',
    'aria-disabled',
    'aria-hidden',
    'aria-modal',
    'disabled',
    'readonly',
    'inert'
  ];

  const attributes: Record<string, string> = {};
  for (const attributeName of relevantAttributes) {
    const value = element.getAttribute(attributeName);
    if (value !== null && value !== '') {
      attributes[attributeName] = normalizeText(value);
    }
  }

  return attributes;
}

/**
 * Determines whether a native or ARIA element is disabled or inert.
 */
function isElementDisabled(element: Element): boolean {
  if (
    element.hasAttribute('disabled')
    || element.getAttribute('aria-disabled')?.toLowerCase() === 'true'
    || isInert(element)
  ) {
    return true;
  }

  if ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)) {
    return true;
  }

  // Native controls inside a disabled fieldset are disabled unless they are
  // descendants of that fieldset's first legend.
  let ancestor = element.parentElement;
  while (ancestor) {
    if (ancestor.tagName.toLowerCase() === 'fieldset' && ancestor.hasAttribute('disabled')) {
      const firstLegend = Array.from(ancestor.children)
        .find((child) => child.tagName.toLowerCase() === 'legend');
      if (!firstLegend || !firstLegend.contains(element)) {
        return true;
      }
    }
    ancestor = ancestor.parentElement;
  }

  return false;
}

/**
 * Extracts interaction state without reading user-entered control values.
 */
function extractState(element: Element): ElementState {
  const role = getElementRole(element);
  const disabled = isElementDisabled(element);
  const state: ElementState = {
    visible: isElementVisible(element),
    disabled,
    enabled: !disabled,
    focused: element === document.activeElement
  };

  if (element.matches('input[type="checkbox"], input[type="radio"]')) {
    state.checked = (element as HTMLInputElement).checked;
  } else if (
    role === 'checkbox'
    || role === 'radio'
    || role === 'switch'
  ) {
    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked !== null) {
      state.checked = ariaChecked.toLowerCase() === 'true';
    }
  }

  if (element.tagName.toLowerCase() === 'option') {
    state.selected = (element as HTMLOptionElement).selected;
  } else {
    const ariaSelected = element.getAttribute('aria-selected');
    if (ariaSelected !== null) {
      state.selected = ariaSelected.toLowerCase() === 'true';
    }
  }

  const ariaExpanded = element.getAttribute('aria-expanded');
  if (ariaExpanded !== null) {
    state.expanded = ariaExpanded.toLowerCase() === 'true';
  }

  return state;
}

/**
 * Safe identity bridge between DOM perception and DOM execution.
 * Ephemerally maps perception-assigned element IDs (e.g. 'elem-1') to live DOM Elements.
 * Cleared and refreshed each time extractPageRepresentationFromDom() runs.
 */
const perceptionElementRegistry = new Map<string, Element>();

/**
 * Registers an element in the perception identity bridge (for testing or grounding binding).
 */
export function registerPerceptionElement(id: string, element: Element): void {
  perceptionElementRegistry.set(id, element);
}

/**
 * Clears the perception identity bridge registry.
 */
export function clearPerceptionElementRegistry(): void {
  perceptionElementRegistry.clear();
}

/**
 * Returns a readonly view of the perception identity bridge.
 */
export function getPerceptionElementRegistry(): ReadonlyMap<string, Element> {
  return perceptionElementRegistry;
}

/**
 * Safely extracts schema.org structured JSON-LD and product data from document.
 */
function extractStructuredData(doc: Document = document): {
  structuredData?: Record<string, any>[];
  productData?: PageProductData;
  schemaType?: string;
} {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  if (!scripts || scripts.length === 0) return {};

  const structuredData: Record<string, any>[] = [];
  let productData: PageProductData | undefined;
  let schemaType: string | undefined;

  for (const script of Array.from(scripts)) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed)
        ? parsed
        : (parsed?.['@graph'] && Array.isArray(parsed['@graph']))
        ? parsed['@graph']
        : [parsed];

      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item['@type'] || '');
        if (type && !schemaType) {
          schemaType = type;
        }

        // Bounded capture of structured items (max 5 items)
        if (structuredData.length < 5) {
          structuredData.push(item);
        }

        if (type.toLowerCase() === 'product' && !productData) {
          const offers = item.offers;
          const offerObj = Array.isArray(offers) ? offers[0] : (typeof offers === 'object' ? offers : undefined);
          const brandObj = item.brand;
          const brandName = typeof brandObj === 'string'
            ? brandObj
            : (typeof brandObj?.name === 'string' ? brandObj.name : undefined);
          const ratingObj = item.aggregateRating;

          productData = {
            name: typeof item.name === 'string' ? normalizeText(item.name) : undefined,
            description: typeof item.description === 'string' ? normalizeText(item.description).slice(0, 300) : undefined,
            brand: brandName ? normalizeText(brandName) : undefined,
            price: offerObj?.price !== undefined ? String(offerObj.price) : undefined,
            priceCurrency: typeof offerObj?.priceCurrency === 'string' ? offerObj.priceCurrency : undefined,
            availability: typeof offerObj?.availability === 'string' ? offerObj.availability : undefined,
            ratingValue: ratingObj?.ratingValue !== undefined ? String(ratingObj.ratingValue) : undefined,
            reviewCount: typeof ratingObj?.reviewCount === 'number' ? ratingObj.reviewCount : undefined,
            sku: typeof item.sku === 'string' ? item.sku : undefined
          };
        }
      }
    } catch {
      // Ignore malformed JSON-LD gracefully
    }
  }

  return {
    structuredData: structuredData.length > 0 ? structuredData : undefined,
    productData,
    schemaType
  };
}

/**
 * Detects search input controls and associated form actions.
 */
function extractSearchControls(elementsArray: Element[], elementIdMap: Map<Element, string>): PageSearchControl[] {
  const controls: PageSearchControl[] = [];
  const seenIds = new Set<string>();

  for (const el of elementsArray) {
    const tagName = el.tagName.toLowerCase();
    const role = getElementRole(el);
    const isSearchInput =
      role === 'searchbox' ||
      (tagName === 'input' && (el as HTMLInputElement).type?.toLowerCase() === 'search') ||
      (tagName === 'input' && (
        el.getAttribute('placeholder')?.toLowerCase().includes('search') ||
        el.getAttribute('name')?.toLowerCase().includes('search') ||
        el.getAttribute('name')?.toLowerCase() === 'k' ||
        el.getAttribute('name')?.toLowerCase() === 'q'
      ));

    if (isSearchInput) {
      const elementId = elementIdMap.get(el);
      if (elementId && !seenIds.has(elementId)) {
        seenIds.add(elementId);
        const form = el.closest('form');
        const actionUrl = form?.getAttribute('action') || undefined;
        const method = form?.getAttribute('method')?.toUpperCase() === 'POST' ? 'POST' : 'GET';
        const name = el.getAttribute('name') || undefined;
        const placeholder = el.getAttribute('placeholder') || undefined;

        controls.push({
          elementId,
          role,
          name,
          placeholder: placeholder ? normalizeText(placeholder) : undefined,
          actionUrl,
          method
        });
        if (controls.length >= 3) break;
      }
    }
  }
  return controls;
}

/**
 * Extracts top relevant semantic links (product, search, navigation) from perceived elements.
 */
function extractRelevantLinks(elementsArray: Element[], elementIdMap: Map<Element, string>): PageRelevantLink[] {
  const links: PageRelevantLink[] = [];
  const seenHrefs = new Set<string>();

  for (const el of elementsArray) {
    if (el.tagName.toLowerCase() === 'a' && el.hasAttribute('href')) {
      const href = el.getAttribute('href')?.trim();
      if (!href || href === '#' || isRestrictedUrlScheme(href)) continue;

      let fullHref = href;
      try {
        const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost';
        fullHref = new URL(href, base).href;
      } catch {
        continue;
      }

      if (seenHrefs.has(fullHref)) continue;
      seenHrefs.add(fullHref);

      const text = (getVisibleText(el) || getAccessibleName(el) || '').trim();
      if (!text || text.length < 2) continue;

      let category: PageRelevantLink['category'] = 'generic';
      const lowerHref = fullHref.toLowerCase();
      if (lowerHref.includes('/dp/') || lowerHref.includes('/p/') || lowerHref.includes('/product/') || lowerHref.includes('/item/')) {
        category = 'product';
      } else if (lowerHref.includes('/s?') || lowerHref.includes('/search')) {
        category = 'search';
      } else if (/^(?:next|prev|previous|\d+)$/i.test(text) || el.getAttribute('rel') === 'next') {
        category = 'pagination';
      } else {
        category = 'navigation';
      }

      links.push({
        text: normalizeText(text),
        href: fullHref,
        elementId: elementIdMap.get(el),
        category
      });

      if (links.length >= 20) break;
    }
  }
  return links;
}

/**
 * Extracts a PageRepresentation from the current DOM.
 */
export function extractPageRepresentationFromDom(): PageRepresentation {
  // querySelectorAll already returns document order, which makes the IDs
  // deterministic for a given representation without relying on page data.
  const rawElements = Array.from(document.querySelectorAll<Element>(PERCEPTION_SELECTOR));
  const seenElements = new Set<Element>();
  const elementsArray: Element[] = [];

  for (const element of rawElements) {
    if (!seenElements.has(element) && isRepresentationCandidate(element)) {
      seenElements.add(element);
      elementsArray.push(element);
    }
  }

  const elementIdMap = new Map<Element, string>();

  perceptionElementRegistry.clear();
  elementsArray.forEach((element, index) => {
    const id = `elem-${index + 1}`;
    elementIdMap.set(element, id);
    perceptionElementRegistry.set(id, element);
  });

  const pageElements: PageElement[] = elementsArray.map((element) => {
    const id = elementIdMap.get(element) as string;
    const tagName = element.tagName.toLowerCase();
    const role = getElementRole(element);
    const state = extractState(element);
    const visibleText = getVisibleText(element);
    const accessibleName = getAccessibleName(element);
    const placeholder = element.matches('input, textarea')
      ? normalizeText((element as HTMLInputElement | HTMLTextAreaElement).placeholder || '')
      : undefined;
    const inputType = element.matches('input')
      ? (element as HTMLInputElement).type.toLowerCase()
      : undefined;
    const rect = element.getBoundingClientRect();
    const bounds: ElementBounds = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    };

    const parentElement = element.parentElement;
    const parentId = parentElement ? elementIdMap.get(parentElement) : undefined;
    const childIds = Array.from(element.children)
      .map((child) => elementIdMap.get(child))
      .filter((childId): childId is string => childId !== undefined);

    const associatedLabels = getAssociatedLabels(element);
    const labelIds = associatedLabels
      .map((lbl) => elementIdMap.get(lbl))
      .filter((lblId): lblId is string => lblId !== undefined);

    const provenance: ElementProvenance = 'dom';
    const interactive = state.visible === true && !state.disabled && isInteractive(element, role);

    return {
      id,
      tagName,
      role,
      visibleText,
      accessibleName,
      placeholder: placeholder || undefined,
      inputType: inputType || undefined,
      bounds,
      state,
      interactive,
      attributes: extractAttributes(element),
      parentId,
      childIds: childIds.length > 0 ? childIds : undefined,
      labelIds: labelIds.length > 0 ? labelIds : undefined,
      provenance
    };
  });

  // Extract URL and document metadata
  const docUrl = typeof window !== 'undefined' ? window.location.href : '';
  const urlDetails = parseUrlDetails(docUrl);

  const canonicalEl = document.querySelector('link[rel="canonical"]');
  const rawCanonical = canonicalEl?.getAttribute('href') || undefined;
  const canonicalUrl = normalizeCanonicalUrl(rawCanonical, docUrl);

  const metaDescEl = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
  const description = metaDescEl ? normalizeText(metaDescEl.getAttribute('content') || '') : undefined;

  // OpenGraph metadata
  const openGraph: Record<string, string> = {};
  const ogTags = document.querySelectorAll('meta[property^="og:"]');
  for (const og of Array.from(ogTags)) {
    const prop = og.getAttribute('property');
    const content = og.getAttribute('content');
    if (prop && content) {
      openGraph[prop] = normalizeText(content);
    }
  }

  // Schema.org structured data
  const { structuredData, productData, schemaType } = extractStructuredData(document);

  // Search controls and relevant links
  const searchControls = extractSearchControls(elementsArray, elementIdMap);
  const relevantLinks = extractRelevantLinks(elementsArray, elementIdMap);

  // DOM type hints for classification
  const domHints: DomTypeHints = {
    hasSearchBox: searchControls.length > 0,
    hasSearchResultsGrid: Boolean(document.querySelector('[data-component-type="s-search-result"], .search-results, [role="feed"]')),
    hasProductPrice: Boolean(productData?.price || document.querySelector('.price, [data-price], [itemprop="price"]')),
    hasAddToCart: Boolean(document.querySelector('button[name*="submit.add-to-cart"], button[id*="add-to-cart"], [aria-label*="Add to cart" i]')),
    hasArticleBody: Boolean(document.querySelector('article, [itemprop="articleBody"]')),
    hasCodeBlocks: Boolean(document.querySelector('pre code, .highlight, .docs-content')),
    hasPrimaryForm: Boolean(document.querySelector('form:not([role="search"])')),
    schemaType
  };

  const pageType = inferPageTypeFromUrlAndDom(urlDetails, domHints);

  const metadata: PageMetadata = {
    title: normalizeText(document.title) || undefined,
    url: docUrl || undefined,
    canonicalUrl,
    hostname: urlDetails?.hostname,
    domain: urlDetails?.domain,
    description: description || undefined,
    pageType,
    searchControls: searchControls.length > 0 ? searchControls : undefined,
    relevantLinks: relevantLinks.length > 0 ? relevantLinks : undefined,
    productData,
    openGraph: Object.keys(openGraph).length > 0 ? openGraph : undefined,
    structuredData,
    completeness: 'complete'
  };

  const viewport: Viewport = {
    width: window.innerWidth,
    height: window.innerHeight
  };

  return {
    schemaVersion: PAGE_REPRESENTATION_SCHEMA_VERSION,
    metadata,
    viewport,
    elements: pageElements
  };
}

/**
 * Determines whether an element can be acted upon by the agent.
 */
function isInteractive(element: Element, role: ElementRole): boolean {
  if (isElementDisabled(element)) {
    return false;
  }

  const interactiveRoles: ElementRole[] = [
    'button',
    'link',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'menuitem',
    'treeitem'
  ];

  if (interactiveRoles.includes(role)) {
    return true;
  }

  // Native controls remain useful even when their role is generic, such as a
  // file input or image-submit input. Hidden inputs are intentionally excluded.
  if (element.matches('input:not([type="hidden"]), textarea, select, button, summary')) {
    return true;
  }

  if (element.hasAttribute('tabindex')) {
    const tabindex = Number.parseInt(element.getAttribute('tabindex') || '', 10);
    return Number.isFinite(tabindex) && tabindex >= 0;
  }

  return false;
}

/**
 * Resolves an element ID to its live DOM Element using the safe identity bridge.
 *
 * Target Identity Invariants:
 * 1. Direct DOM ID lookup if element has a native id matching elementId.
 * 2. Identity bridge lookup (verifies the exact Element perceived with that ID is still connected in doc).
 * 3. Fails closed (returns null) if identity cannot be verified or if the element was removed/replaced.
 *    Never falls back to blind positional candidate traversal across DOM mutations.
 */
export function resolveElementFromDom(
  elementId: string,
  doc: Document = document
): Element | null {
  if (!elementId || typeof elementId !== 'string') {
    return null;
  }

  // 1. Direct DOM ID attribute lookup (for elements with native id attributes)
  try {
    const byId = doc.getElementById(elementId);
    if (byId && byId.id === elementId && byId.isConnected) {
      return byId;
    }
  } catch {
    // Ignore in mock environments
  }

  // 2. Safe identity bridge lookup (from perception snapshot)
  const tracked = perceptionElementRegistry.get(elementId);
  if (tracked) {
    // Must belong to the requested document and still be connected in the live DOM
    if (tracked.ownerDocument === doc && tracked.isConnected) {
      return tracked;
    }
    // Tracked element was removed or replaced in DOM: FAIL CLOSED!
    return null;
  }

  // 3. Unknown or ungrounded element ID: FAIL CLOSED!
  return null;
}

export {
  getElementRole,
  isElementDisabled,
  isElementVisible,
  isInteractive,
  isInert
};
