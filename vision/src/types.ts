/**
 * Vision Perception Abstraction Types for NexVision (Phase 2B Foundation).
 *
 * Provides model- and provider-independent interfaces and types for visual perception.
 * All visual coordinates are relative to the supplied input image.
 */

import type { ElementProvenance } from '../../extension/src/shared/types.js';

/**
 * Bounding box relative to the top-left corner of the input image, in image pixels.
 *
 * Coordinate convention:
 * - Origin (0,0): Top-left corner of the input image
 * - x: Horizontal distance from the left edge in pixels (x >= 0)
 * - y: Vertical distance from the top edge in pixels (y >= 0)
 * - width: Width of the bounding box in pixels (width >= 0)
 * - height: Height of the bounding box in pixels (height >= 0)
 *
 * Note: Coordinates are strictly relative to the supplied image/screenshot and
 * do NOT represent browser viewport coordinates.
 */
export interface VisionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Interaction capability hint for a visual observation.
 */
export type VisionInteractionHint =
  | 'clickable'
  | 'scrollable'
  | 'input'
  | 'selectable'
  | 'static'
  | 'unknown';

/**
 * Explicitly typed, privacy-first metadata for visual observations.
 *
 * Only metadata required by Phase 2B perception is permitted.
 * Arbitrary keys, image bytes, and PII are strictly excluded by design.
 */
export interface VisionObservationMetadata {
  /** Indicates that the observation was generated synthetically for testing */
  synthetic?: boolean;
  /** Name of the perception adapter that produced the observation */
  adapterName?: string;
  /** Optional label used for mock/test identification */
  testLabel?: string;
}

/**
 * Visual observation produced by vision perception sources.
 */
export interface VisionObservation {
  /** Stable unique observation identifier */
  id: string;
  /** Semantic or visual category label (e.g. 'button', 'text', 'icon', 'image') */
  label: string;
  /** Optional detected visual text */
  text?: string;
  /** Bounding box relative to top-left of supplied input image */
  boundingBox: VisionBoundingBox;
  /** Numeric confidence score constrained to [0, 1] */
  confidence: number;
  /** Optional interaction capability hint */
  interactionHint?: VisionInteractionHint;
  /** Provenance indicator indicating visual perception source */
  provenance: ElementProvenance | 'vision';
  /** Explicit, privacy-safe perception metadata */
  metadata?: VisionObservationMetadata;
}

/**
 * Image dimensions in pixels.
 */
export interface VisionImageDimensions {
  width: number;
  height: number;
}

/**
 * Input abstraction for image/screenshot passed to VisionPerception.
 */
export interface VisionImageInput {
  /** Dimensions of the image in pixels */
  dimensions: VisionImageDimensions;
  /** Optional raw image data representation (ArrayBuffer, Uint8Array, or string) */
  data?: ArrayBuffer | Uint8Array | string;
  /** Optional format identifier (e.g., 'image/png', 'image/jpeg') */
  format?: string;
}

/**
 * Discriminated error codes for vision perception failures.
 */
export type VisionPerceptionErrorCode =
  | 'INVALID_IMAGE_INPUT'
  | 'UNSUPPORTED_IMAGE_REPRESENTATION'
  | 'PERCEPTION_FAILURE'
  | 'UNAVAILABLE_IMPLEMENTATION';

/**
 * Explicitly typed error details for vision perception failures.
 */
export interface VisionPerceptionErrorDetails {
  /** Field name that caused validation failure, if applicable */
  invalidField?: string;
  /** Expected constraint or representation message */
  expected?: string;
}

/**
 * Structured error details for a failed vision perception attempt.
 */
export interface VisionPerceptionError {
  code: VisionPerceptionErrorCode;
  message: string;
  details?: VisionPerceptionErrorDetails;
}

/**
 * Metadata accompanying a successful vision perception result.
 */
export interface VisionPerceptionSuccessMetadata {
  perceptionTimeMs?: number;
  adapterName?: string;
  synthetic?: boolean;
}

/**
 * Successful vision perception result.
 */
export interface VisionPerceptionSuccessResult {
  success: true;
  observations: VisionObservation[];
  metadata?: VisionPerceptionSuccessMetadata;
}

/**
 * Failed vision perception result.
 */
export interface VisionPerceptionFailureResult {
  success: false;
  error: VisionPerceptionError;
}

/**
 * Result strategy for vision perception operations.
 */
export type VisionPerceptionResult =
  | VisionPerceptionSuccessResult
  | VisionPerceptionFailureResult;

/**
 * Model/provider-independent interface representing visual perception capabilities.
 *
 * Consumers depend solely on this interface without coupling to specific ML models
 * (e.g. OpenAI, Gemini, Claude, YOLO, Florence, Qwen) or cloud APIs.
 */
export interface VisionPerception {
  /** Identifier/name of the perception implementation or adapter */
  readonly name: string;

  /**
   * Performs visual perception on the provided image input.
   *
   * @param input Minimal image input containing dimensions and optional data
   * @returns Promise resolving to VisionPerceptionResult
   */
  perceive(input: VisionImageInput): Promise<VisionPerceptionResult>;
}
