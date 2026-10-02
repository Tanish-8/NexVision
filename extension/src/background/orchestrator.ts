/**
 * Unified Perception Orchestrator — Phase 2C / Phase 2D.
 *
 * Combines DOM perception, local screenshot capture, and visual perception
 * into a single structured result.
 *
 * Privacy invariants:
 * - Screenshot bytes are never persisted to disk or transmitted over the network.
 * - Form values, passwords, cookies, localStorage, and sessionStorage are not
 *   included in the orchestration result.
 * - The result contains only what the existing DOM and vision layers already
 *   produce; no new data collection is performed here.
 *
 * Architecture:
 * - All three providers are injected via interfaces, keeping each module
 *   independently testable.
 * - Error types are discriminated so callers can distinguish the failure origin.
 * - DomPerceptionProvider is async (Phase 2D): in the Chrome extension, DOM
 *   extraction must cross a process boundary via chrome.tabs.sendMessage from
 *   the service worker to the content script.
 */

import type { ElementProvenance, PageRepresentation, ScreenshotCaptureResult } from '../shared/types.js';
import {
  detectPrivacyFindings,
  isLikelyPersonName,
  CUSTOMER_ID_PATTERN,
  POSTAL_ADDRESS_PATTERN,
  SENSITIVE_PAGE_CONTEXT_PATTERN
} from '../privacy/index.js';

// ---------------------------------------------------------------------------
// Minimal provider interfaces
// ---------------------------------------------------------------------------

/**
 * Provider interface for DOM-based page perception.
 *
 * Phase 2D: async to accommodate Chrome IPC reality.
 * In the service worker context, DOM extraction requires an async
 * chrome.tabs.sendMessage round-trip to the content script.
 * In tests, return Promise.resolve(mockDom).
 */
export interface DomPerceptionProvider {
  (): Promise<PageRepresentation>;
}

/**
 * Minimal screenshot result the orchestrator cares about.
 * Structurally compatible with ScreenshotCaptureResult so that the
 * existing captureVisibleTab result can be passed directly.
 */
export interface ScreenshotReference {
  /** MIME format of the capture ('png' | 'jpeg'). */
  format: 'png' | 'jpeg';
  /** Epoch timestamp (ms) when the screenshot was captured. */
  timestamp: number;
  /**
   * Ephemeral in-memory data URL.
   * Present when vision processing needs image bytes; callers must NOT
   * persist or transmit this value.
   */
  dataUrl?: string;
  /** Optional physical pixel dimensions of the captured screenshot. */
  dimensions?: { width: number; height: number };
}

/**
 * Provider interface for requesting a screenshot.
 * Fulfilled in production by captureVisibleTab (wrapped to return ScreenshotReference).
 */
export interface ScreenshotProvider {
  (): Promise<ScreenshotReference>;
}

/**
 * Interaction capability hint for a visual observation.
 * Mirrors VisionInteractionHint from the vision package.
 */
export type VisualInteractionHint =
  | 'clickable'
  | 'scrollable'
  | 'input'
  | 'selectable'
  | 'static'
  | 'unknown';

/**
 * Explicitly typed, privacy-first metadata for visual observations.
 * Mirrors VisionObservationMetadata from the vision package.
 */
export interface VisualObservationMetadata {
  /** Indicates that the observation was generated synthetically for testing */
  synthetic?: boolean;
  /** Name of the perception adapter that produced the observation */
  adapterName?: string;
  /** Optional label used for mock/test identification */
  testLabel?: string;
}

/**
 * Visual observation shape the orchestrator receives.
 * Structurally compatible with VisionObservation from the vision package,
 * preserving provenance, interactionHint, and metadata.
 */
export interface VisualObservation {
  id: string;
  label: string;
  text?: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  confidence: number;
  /** Optional interaction capability hint matching VisionInteractionHint */
  interactionHint?: VisualInteractionHint;
  /** Perception source provenance matching VisionObservation */
  provenance?: ElementProvenance | 'vision';
  /** Explicit, privacy-safe perception metadata matching VisionObservationMetadata */
  metadata?: VisualObservationMetadata;
}

/**
 * Minimal visual perception adapter interface.
 * Structurally compatible with VisionPerception from the vision package;
 * no cross-project import is required because TypeScript uses structural typing.
 */
export interface VisualPerceptionAdapter {
  readonly name: string;
  perceive(input: {
    dimensions: { width: number; height: number };
    data?: ArrayBuffer | Uint8Array | string;
    format?: string;
  }): Promise<
    | { success: true; observations: VisualObservation[] }
    | { success: false; error: { code: string; message: string } }
  >;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Identifies which component caused a perception failure. */
export type PerceptionFailureOrigin =
  | 'dom'
  | 'screenshot'
  | 'vision';

/**
 * Structured error for a failed unified perception attempt.
 */
export interface UnifiedPerceptionError {
  /** Which component failed. */
  origin: PerceptionFailureOrigin;
  /** Human-readable description of the failure. */
  message: string;
  /** Original error code from the failing component, if available. */
  code?: string;
}

/**
 * Metadata accompanying a successful unified perception result.
 */
export interface UnifiedPerceptionMetadata {
  /** Epoch timestamp (ms) when orchestration completed. */
  orchestratedAt: number;
  /** Name of the visual perception adapter used. */
  visionAdapterName: string;
  /** Whether the visual perception result included synthetic/mock observations. */
  synthetic?: boolean;
}

/**
 * Successful unified perception result.
 */
export interface UnifiedPerceptionSuccess {
  success: true;
  /** DOM representation of the page — unchanged from Phase 1C output. */
  domRepresentation: PageRepresentation;
  /** Minimal screenshot reference — no persistent bytes are retained here. */
  screenshotRef: ScreenshotReference;
  /** Visual observations produced by the injected VisionPerception adapter. */
  visualObservations: VisualObservation[];
  metadata: UnifiedPerceptionMetadata;
}

/**
 * Failed unified perception result.
 */
export interface UnifiedPerceptionFailure {
  success: false;
  error: UnifiedPerceptionError;
}

/**
 * Discriminated union result for unified perception.
 */
export type UnifiedPerceptionResult =
  | UnifiedPerceptionSuccess
  | UnifiedPerceptionFailure;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UnifiedPerceptionOptions {
  /**
   * Image format to request from the screenshot provider.
   * Defaults to 'png'.
   */
  screenshotFormat?: 'png' | 'jpeg';
}

// ---------------------------------------------------------------------------
// Visual Privacy Gate (Phase 2.6 Fail-Closed Protection)
// ---------------------------------------------------------------------------

/**
 * Result of evaluating visual privacy safety for screenshot submission.
 */
export interface VisualPrivacyGateResult {
  allowed: boolean;
  blockedReason?: string;
  sensitiveCategories?: string[];
}

/**
 * Evaluates whether submitting visual screenshot data to a vision model adapter
 * risks exposing unredacted sensitive PII.
 *
 * Implements Phase 2.6 fail-closed screenshot privacy protection:
 * Because DOM-to-screenshot pixel coordinates cannot be guaranteed to perfectly
 * match rendered screenshot pixels in a background service worker (due to devicePixelRatio,
 * zoom, subpixel layout, canvas rendering, or dynamic layout shifts), unmasked screenshots
 * containing sensitive credentials or financial identifiers are blocked from vision-model submission.
 */
export function evaluateVisualPrivacyGate(page: PageRepresentation): VisualPrivacyGateResult {
  const sensitiveCategories = new Set<string>();

  // 1. Password input elements (inputType="password" or attributes.type="password")
  const hasPasswordInput = page.elements.some(
    el => el.inputType === 'password' || el.attributes?.['type'] === 'password'
  );
  if (hasPasswordInput) {
    sensitiveCategories.add('password');
  }

  // 2. Sensitive privacy findings detected in DOM text or attributes
  // Evaluates all categories supported by detector: password, card, email, phone, name, address, auth_token
  const findings = detectPrivacyFindings(page);
  for (const finding of findings) {
    sensitiveCategories.add(finding.category);
  }

  // 3. Customer identifiers, standalone names, and postal addresses in DOM text/attributes
  for (const el of page.elements) {
    const textSignals = [
      el.visibleText,
      el.accessibleName,
      el.placeholder,
      el.attributes?.['aria-label'],
      el.attributes?.['title'],
      el.attributes?.['alt'],
      el.attributes?.['aria-description']
    ];

    for (const text of textSignals) {
      if (!text) continue;

      if (CUSTOMER_ID_PATTERN.test(text)) {
        sensitiveCategories.add('customer_id');
      }

      if (isLikelyPersonName(text)) {
        sensitiveCategories.add('name');
      }

      if (POSTAL_ADDRESS_PATTERN.test(text)) {
        sensitiveCategories.add('address');
      }
    }
  }

  // 4. Conservative page-context rules:
  // Account, profile, billing, payment, checkout, customer-management pages require DOM-only perception
  const url = page.metadata?.url ?? '';
  const title = page.metadata?.title ?? '';
  if (SENSITIVE_PAGE_CONTEXT_PATTERN.test(url) || SENSITIVE_PAGE_CONTEXT_PATTERN.test(title)) {
    sensitiveCategories.add('sensitive_page_context');
  }

  if (sensitiveCategories.size > 0) {
    const categoryList = Array.from(sensitiveCategories).sort().join(', ');
    return {
      allowed: false,
      blockedReason: `Visual perception blocked: page contains sensitive data (${categoryList}) that cannot be reliably masked in screenshots.`,
      sensitiveCategories: Array.from(sensitiveCategories)
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Perform unified page perception by coordinating DOM, screenshot, and vision.
 *
 * @param domProvider   Provides the current PageRepresentation.
 * @param screenshotProvider  Provides an ephemeral screenshot reference.
 * @param visionAdapter  Runs visual perception on the screenshot.
 * @param options       Optional capture configuration.
 * @returns             A discriminated result distinguishing success and
 *                      per-component failures.
 */
export async function perceivePage(
  domProvider: DomPerceptionProvider,
  screenshotProvider: ScreenshotProvider,
  visionAdapter: VisualPerceptionAdapter,
  options?: UnifiedPerceptionOptions
): Promise<UnifiedPerceptionResult> {

  // 1. DOM perception — async IPC in production (Phase 2D); async rejection caught here.
  let domRepresentation: PageRepresentation;
  try {
    domRepresentation = await domProvider();
  } catch (error) {
    return {
      success: false,
      error: {
        origin: 'dom',
        message: error instanceof Error ? error.message : 'DOM perception failed'
      }
    };
  }

  // 2. Visual Privacy Gate Evaluation BEFORE Screenshot Capture (Phase 2.8 Fail-Closed Protection)
  const gate = evaluateVisualPrivacyGate(domRepresentation);

  if (visionAdapter.name !== 'NullVisionAdapter') {
    if (!gate.allowed) {
      // Visual perception blocked fail-closed BEFORE capturing any screenshot.
      // Zero screenshot bytes are captured, zero image encoding occurs, and no visual model submission is made.
      return {
        success: false,
        error: {
          origin: 'vision',
          code: 'VISUAL_PII_EXPOSURE_BLOCKED',
          message: gate.blockedReason ?? 'Visual perception blocked due to sensitive PII on page'
        }
      };
    }
  }

  // 3. For NullVisionAdapter when the page is sensitive:
  // Safely return DOM-only perception without taking an unnecessary screenshot of sensitive page data.
  if (visionAdapter.name === 'NullVisionAdapter' && !gate.allowed) {
    return {
      success: true,
      domRepresentation,
      screenshotRef: {
        format: options?.screenshotFormat ?? 'png',
        timestamp: Date.now()
      },
      visualObservations: [],
      metadata: {
        orchestratedAt: Date.now(),
        visionAdapterName: visionAdapter.name
      }
    };
  }

  // 4. Screenshot capture — async, provider may throw. ONLY called when privacy gate has approved.
  let screenshotRef: ScreenshotReference;
  try {
    screenshotRef = await screenshotProvider();
  } catch (error) {
    return {
      success: false,
      error: {
        origin: 'screenshot',
        message: error instanceof Error ? error.message : 'Screenshot capture failed'
      }
    };
  }

  // 5. Build VisionImageInput from the approved screenshot reference.
  //    Physical screenshot dimensions are preferred when known; falls back to CSS viewport dimensions.
  const visionInput = {
    dimensions: screenshotRef.dimensions ?? {
      width: domRepresentation.viewport.width,
      height: domRepresentation.viewport.height
    },
    data: screenshotRef.dataUrl,
    format: screenshotRef.format === 'jpeg' ? 'image/jpeg' : 'image/png'
  };

  // 6. Visual perception — async, discriminated result.
  let visionResult: Awaited<ReturnType<VisualPerceptionAdapter['perceive']>>;
  try {
    visionResult = await visionAdapter.perceive(visionInput);
  } catch (error) {
    return {
      success: false,
      error: {
        origin: 'vision',
        message: error instanceof Error ? error.message : 'Vision perception failed'
      }
    };
  }

  if (!visionResult.success) {
    return {
      success: false,
      error: {
        origin: 'vision',
        message: visionResult.error.message,
        code: visionResult.error.code
      }
    };
  }

  // 5. Assemble the unified result.
  //    screenshotRef.dataUrl is intentionally NOT forwarded in the result metadata
  //    so callers don't accidentally persist image bytes through the metadata path.
  const safeScreenshotRef: ScreenshotReference = {
    format: screenshotRef.format,
    timestamp: screenshotRef.timestamp,
    ...(screenshotRef.dimensions ? { dimensions: screenshotRef.dimensions } : {})
    // dataUrl omitted from the result — it was only needed for the vision step.
  };

  return {
    success: true,
    domRepresentation,
    screenshotRef: safeScreenshotRef,
    visualObservations: visionResult.observations,
    metadata: {
      orchestratedAt: Date.now(),
      visionAdapterName: visionAdapter.name
    }
  };
}
