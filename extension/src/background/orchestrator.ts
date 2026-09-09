/**
 * Unified Perception Orchestrator — Phase 2C.
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
 */

import type { ElementProvenance, PageRepresentation, ScreenshotCaptureResult } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Minimal provider interfaces
// ---------------------------------------------------------------------------

/**
 * Provider interface for DOM-based page perception.
 * Fulfilled in production by extractPageRepresentationFromDom().
 */
export interface DomPerceptionProvider {
  (): PageRepresentation;
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

  // 1. DOM perception — synchronous, throws on failure.
  let domRepresentation: PageRepresentation;
  try {
    domRepresentation = domProvider();
  } catch (error) {
    return {
      success: false,
      error: {
        origin: 'dom',
        message: error instanceof Error ? error.message : 'DOM perception failed'
      }
    };
  }

  // 2. Screenshot capture — async, provider may throw.
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

  // 3. Build VisionImageInput from the screenshot reference.
  //    Viewport dimensions come from the DOM representation.
  const visionInput = {
    dimensions: {
      width: domRepresentation.viewport.width,
      height: domRepresentation.viewport.height
    },
    data: screenshotRef.dataUrl,
    format: screenshotRef.format === 'jpeg' ? 'image/jpeg' : 'image/png'
  };

  // 4. Visual perception — async, discriminated result.
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
    timestamp: screenshotRef.timestamp
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
