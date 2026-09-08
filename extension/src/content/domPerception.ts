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
  type Viewport
} from '../shared/types.js';

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
  'summary'
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
  'main, article, section, aside, header, footer',
  'p, blockquote, pre, figure, figcaption, li, dt, dd, table, caption, output',
  '[role]',
  '[tabindex]'
].join(', ');

/**
 * Normalizes text by collapsing whitespace and trimming.
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
    'input:not([type="hidden"]), textarea, select, button, summary, a[href]'
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

  if (explicitRole && PRESENTATION_ROLES.has(explicitRole)) {
    return isNativeInteractiveElement(element) || hasTabindex;
  }

  if (
    explicitRole === 'img'
    || (explicitRole && SUPPORTED_ARIA_ROLES.has(explicitRole as ElementRole))
  ) {
    return true;
  }

  return nativeCandidate || hasTabindex || meaningfulContent;
}

/**
 * Checks CSS visibility without requiring layout. This is used for text nodes
 * below a visible element; the root element still goes through the layout check
 * in isElementVisible().
 */
function hasVisibleCss(element: Element): boolean {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse';
}

/**
 * Determines if an element is visible. A non-zero layout rectangle is required
 * in production so that displayable but zero-sized elements are not actionable.
 */
function isElementVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
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
  return rect.width !== 0 && rect.height !== 0;
}

/**
 * Collects rendered text while excluding hidden descendants. Form controls
 * whose text is user-entered are intentionally excluded from this function.
 */
function getVisibleText(element: Element): string | undefined {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea') {
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
      // Exclude user-entered controls even when they are descendants of a
      // represented container such as a form.
      if (
        !isRoot
        && (node.tagName.toLowerCase() === 'input' || node.tagName.toLowerCase() === 'textarea')
      ) {
        return '';
      }
      if (!isRoot && !hasVisibleCss(node)) {
        return '';
      }
      return Array.from(node.childNodes)
        .map((child) => collectText(child))
        .join(' ');
    }

    return Array.from(node.childNodes || [])
      .map((child) => collectText(child))
      .join(' ');
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
 * Gets text from an element that can safely be used as an accessible name.
 */
function getNameText(element: Element): string | undefined {
  return getVisibleText(element);
}

/**
 * Extracts an accessible name using the useful, privacy-safe subset of the
 * accessible-name algorithm needed by this phase.
 */
function getAccessibleName(element: Element): string | undefined {
  const ariaLabel = normalizeText(element.getAttribute('aria-label') || '');
  if (ariaLabel) {
    return ariaLabel;
  }

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

  if (element.matches('input, textarea, select')) {
    const formControl = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const labels = formControl.labels;
    if (labels && labels.length > 0) {
      const labelName = normalizeText(
        Array.from(labels).map((label) => getNameText(label) || '').join(' ')
      );
      if (labelName) {
        return labelName;
      }
    }

    let parent = element.parentElement;
    while (parent) {
      if (parent.tagName.toLowerCase() === 'label') {
        const labelName = getNameText(parent);
        if (labelName) {
          return labelName;
        }
        break;
      }
      parent = parent.parentElement;
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
  ) {
    return getVisibleText(element);
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
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'aria-expanded',
    'aria-checked',
    'aria-selected',
    'aria-disabled',
    'disabled',
    'readonly'
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
 * Determines whether a native or ARIA element is disabled.
 */
function isElementDisabled(element: Element): boolean {
  if (
    element.hasAttribute('disabled')
    || element.getAttribute('aria-disabled')?.toLowerCase() === 'true'
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
 * Extracts a PageRepresentation from the current DOM.
 */
export function extractPageRepresentationFromDom(): PageRepresentation {
  // querySelectorAll already returns document order, which makes the IDs
  // deterministic for a given representation without relying on page data.
  const elementsArray = Array.from(document.querySelectorAll<Element>(PERCEPTION_SELECTOR))
    .filter(isRepresentationCandidate);
  const elementIdMap = new Map<Element, string>();

  elementsArray.forEach((element, index) => {
    elementIdMap.set(element, `elem-${index + 1}`);
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
      provenance
    };
  });

  const metadata: PageMetadata = {
    title: normalizeText(document.title) || undefined,
    url: window.location.href || undefined
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
