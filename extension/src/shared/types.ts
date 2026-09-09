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
  labelIds?: string[];
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
 * Options for local visible tab screenshot capture.
 */
export interface ScreenshotCaptureOptions {
  /** Target image format. Defaults to 'png'. */
  format?: 'png' | 'jpeg';
  /** Compression quality (0-100), only applicable when format is 'jpeg'. */
  quality?: number;
}

/**
 * Minimal local viewport screenshot result.
 * Strictly local and ephemeral: contains only in-memory image data and essential capture metadata.
 * Contains no DOM HTML, form values, credentials, or arbitrary page data.
 */
export interface ScreenshotCaptureResult {
  /** In-memory data URL of the captured viewport ('data:image/png;base64,...'). */
  dataUrl: string;
  /** Image format of the captured screenshot. */
  format: 'png' | 'jpeg';
  /** Epoch timestamp (ms) when the screenshot was captured. */
  timestamp: number;
}

/**
 * Message type discriminators
 */
export const MessageType = {
  INSPECT_PAGE_REQUEST: 'inspect-page-request',
  INSPECT_PAGE_RESPONSE: 'inspect-page-response',
  PAGE_SNAPSHOT: 'page-snapshot',
  EXTENSION_READY: 'extension-ready',
  CAPTURE_SCREENSHOT_REQUEST: 'capture-screenshot-request'
} as const;

export type MessageType = typeof MessageType[keyof typeof MessageType];

/** Sensitive data categories classified by local privacy processing. */
export type PrivacyCategory =
  | 'email'
  | 'phone'
  | 'card'
  | 'password'
  | 'address'
  | 'name'
  | 'auth_token'
  | 'other';

/** Confidence of a privacy detection finding. */
export type PrivacyConfidence = 'high' | 'medium' | 'low';

/** Source signal contributing to a privacy finding. */
export type PrivacySignalSource =
  | 'input_type'
  | 'autocomplete'
  | 'attribute'
  | 'visible_text'
  | 'accessible_name'
  | 'placeholder'
  | 'url_query';

/**
 * A privacy finding describing detected sensitive information.
 * Strictly local and metadata-only: NEVER retains raw detected PII values.
 */
export interface PrivacyFinding {
  /** Target element ID (or 'page-metadata' / 'page-url' for page-level findings). */
  elementId?: string;
  /** Categorized sensitive data type. */
  category: PrivacyCategory;
  /** Evaluated confidence level. */
  confidence: PrivacyConfidence;
  /** Signal sources contributing to this finding. */
  sources: PrivacySignalSource[];
  /** Optional semantic reference for future executor resolution (e.g., 'profile.email'). */
  semanticReference?: string;
}

/** Metadata summarizing the privacy sanitization execution. */
export interface PrivacySanitizationMetadata {
  /** Epoch timestamp (ms) when sanitization was performed. */
  sanitizedAt: number;
  /** Total count of privacy findings detected. */
  totalFindings: number;
  /** Findings broken down by category. */
  categoryCounts: Record<PrivacyCategory, number>;
}

/**
 * Sanitized page representation produced by the local privacy boundary.
 * Contains the structural PageRepresentation with sensitive textual values
 * replaced by deterministic redaction tokens, alongside privacy findings.
 */
export interface SanitizedPageRepresentation {
  pageRepresentation: PageRepresentation;
  findings: PrivacyFinding[];
  metadata: PrivacySanitizationMetadata;
}
