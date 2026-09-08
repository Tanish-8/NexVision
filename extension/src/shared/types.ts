/**
 * Shared types and messages for SIH26171 extension.
 * These define the contracts between popup, background, and content script.
 */

/**
 * Message types for extension communication
 */
export interface ExtensionMessage<T = any> {
  type: string;
  payload?: T;
  /** For request-response correlation */
  id?: string;
}

/**
 * Request from popup to background to inspect the current page
 */
export interface InspectPageRequest {
  /** Optional: specific elements to focus on */
  focus?: string[];
}

/**
 * Response from content script with basic page info
 */
export interface PageSnapshot {
  title: string;
  url: string;
  /** Count of heading elements as a simple perception metric */
  headingCount: number;
  /** Timestamp when snapshot was taken */
  timestamp: number;
}

/** Version of the shared page representation contract. */
export const PAGE_REPRESENTATION_SCHEMA_VERSION = '1.0' as const;
export type PageRepresentationSchemaVersion =
  typeof PAGE_REPRESENTATION_SCHEMA_VERSION;

/** Page-level metadata that may be available to a perception source. */
export interface PageMetadata {
  /** The document title, when available. */
  title?: string;
  /** The document URL, when available. */
  url?: string;
}

/** Viewport dimensions in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** A rectangle in viewport coordinates, measured in CSS pixels. */
export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Semantic roles understood by the shared representation. */
export type ElementRole =
  | 'button'
  | 'link'
  | 'textbox'
  | 'searchbox'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'listbox'
  | 'option'
  | 'heading'
  | 'image'
  | 'navigation'
  | 'form'
  | 'alert'
  | 'dialog'
  | 'menuitem'
  | 'progressbar'
  | 'region'
  | 'slider'
  | 'spinbutton'
  | 'status'
  | 'switch'
  | 'tab'
  | 'treeitem'
  | 'generic'
  | 'container'
  | 'unknown';

/** Interaction and presentation state known for an element. */
export interface ElementState {
  visible?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  expanded?: boolean;
}

/** Perception source used to identify or describe an element. */
export type ElementProvenance = 'dom' | 'vision' | 'both';

/**
 * A lightweight, privacy-sanitizable description of a page element.
 *
 * Only normalized, relevant attributes should be included. Raw HTML and
 * arbitrary page data do not belong in this representation.
 */
export interface PageElement {
  /** Stable within a page representation and suitable for later grounding. */
  id: string;
  /** Normalized HTML tag name when known (for example, `button`). */
  tagName?: string;
  role?: ElementRole;
  visibleText?: string;
  accessibleName?: string;
  placeholder?: string;
  inputType?: string;
  bounds?: ElementBounds;
  state?: ElementState;
  /** Whether the element can be acted on by the agent. */
  interactive?: boolean;
  /** Selected, normalized attributes relevant to perception or grounding. */
  attributes?: Record<string, string>;
  /** Relationships are represented by ids rather than nested elements. */
  parentId?: string;
  childIds?: string[];
  provenance?: ElementProvenance;
}

/**
 * Common page representation shared by DOM and visual perception sources.
 */
export interface PageRepresentation {
  schemaVersion: PageRepresentationSchemaVersion;
  metadata: PageMetadata;
  viewport: Viewport;
  elements: PageElement[];
}

/**
 * Generic response wrapper
 */
export interface ExtensionResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Message type discriminators
 */
export const MessageType = {
  INSPECT_PAGE_REQUEST: 'inspect-page-request',
  INSPECT_PAGE_RESPONSE: 'inspect-page-response',
  PAGE_SNAPSHOT: 'page-snapshot',
  EXTENSION_READY: 'extension-ready'
} as const;

export type MessageType = typeof MessageType[keyof typeof MessageType];