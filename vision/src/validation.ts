/**
 * Validation utilities for vision perception inputs, confidence scores, bounding boxes, and metadata privacy.
 */

import type {
  VisionBoundingBox,
  VisionImageDimensions,
  VisionImageInput,
  VisionObservation,
  VisionObservationMetadata,
  VisionPerceptionErrorCode
} from './types.js';

/**
 * Checks whether a confidence score is valid (finite numeric value between 0 and 1 inclusive).
 */
export function isValidConfidence(confidence: unknown): confidence is number {
  return (
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
  );
}

/**
 * Validates a confidence score. Throws RangeError or TypeError if invalid.
 *
 * @param confidence Confidence score to validate
 * @returns The validated confidence score
 */
export function validateConfidence(confidence: unknown): number {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw new TypeError(
      `Invalid confidence score: expected a finite number, received ${typeof confidence === 'number' ? confidence : typeof confidence}`
    );
  }

  if (confidence < 0 || confidence > 1) {
    throw new RangeError(
      `Confidence score out of bounds [0, 1]: received ${confidence}`
    );
  }

  return confidence;
}

/**
 * Checks whether a bounding box has valid non-negative numeric dimensions and coordinates.
 */
export function isValidBoundingBox(box: unknown): box is VisionBoundingBox {
  if (!box || typeof box !== 'object') {
    return false;
  }

  const b = box as Partial<VisionBoundingBox>;
  return (
    typeof b.x === 'number' &&
    Number.isFinite(b.x) &&
    b.x >= 0 &&
    typeof b.y === 'number' &&
    Number.isFinite(b.y) &&
    b.y >= 0 &&
    typeof b.width === 'number' &&
    Number.isFinite(b.width) &&
    b.width >= 0 &&
    typeof b.height === 'number' &&
    Number.isFinite(b.height) &&
    b.height >= 0
  );
}

/**
 * Validates a bounding box structure. Throws Error if invalid.
 * Optionally verifies bounds against image dimensions if provided.
 */
export function validateBoundingBox(
  box: unknown,
  dimensions?: VisionImageDimensions
): VisionBoundingBox {
  if (!isValidBoundingBox(box)) {
    throw new Error(
      `Invalid bounding box coordinates: x, y, width, and height must be non-negative finite numbers`
    );
  }

  if (dimensions) {
    if (box.x > dimensions.width || box.y > dimensions.height) {
      throw new Error(
        `Bounding box origin (${box.x}, ${box.y}) exceeds image dimensions (${dimensions.width}x${dimensions.height})`
      );
    }
  }

  return box;
}

/**
 * Checks whether image dimensions are valid (width > 0, height > 0, finite numbers).
 */
export function isValidImageDimensions(
  dimensions: unknown
): dimensions is VisionImageDimensions {
  if (!dimensions || typeof dimensions !== 'object') {
    return false;
  }

  const d = dimensions as Partial<VisionImageDimensions>;
  return (
    typeof d.width === 'number' &&
    Number.isFinite(d.width) &&
    d.width > 0 &&
    typeof d.height === 'number' &&
    Number.isFinite(d.height) &&
    d.height > 0
  );
}

/**
 * Checks whether optional raw image data representation is supported (ArrayBuffer, Uint8Array, or string).
 */
export function isSupportedImageData(data: unknown): boolean {
  if (data === undefined || data === null) {
    return true;
  }

  if (typeof data === 'string') {
    return true;
  }

  if (data instanceof ArrayBuffer) {
    return true;
  }

  if (data instanceof Uint8Array) {
    return true;
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    return true;
  }

  return false;
}

export interface ImageInputValidationResult {
  valid: boolean;
  errorCode?: VisionPerceptionErrorCode;
  message?: string;
  invalidField?: string;
}

/**
 * Performs complete runtime validation on VisionImageInput.
 */
export function validateImageInput(input: unknown): ImageInputValidationResult {
  if (!input || typeof input !== 'object') {
    return {
      valid: false,
      errorCode: 'INVALID_IMAGE_INPUT',
      message: 'Image input must be an object',
      invalidField: 'input'
    };
  }

  const inp = input as Partial<VisionImageInput>;

  if (!inp.dimensions || !isValidImageDimensions(inp.dimensions)) {
    return {
      valid: false,
      errorCode: 'INVALID_IMAGE_INPUT',
      message: 'Invalid image input: width and height must be finite positive numbers',
      invalidField: 'dimensions'
    };
  }

  if (inp.data !== undefined && !isSupportedImageData(inp.data)) {
    return {
      valid: false,
      errorCode: 'UNSUPPORTED_IMAGE_REPRESENTATION',
      message:
        'Unsupported image data representation. Expected ArrayBuffer, Uint8Array, or string',
      invalidField: 'data'
    };
  }

  return { valid: true };
}

/**
 * Validates a VisionObservation shape and privacy metadata invariants.
 * Ensures confidence is [0, 1], bounding box is valid, and metadata contains ONLY explicit allowed fields.
 */
export function validateObservation(obs: unknown): VisionObservation {
  if (!obs || typeof obs !== 'object') {
    throw new TypeError('Observation must be an object');
  }

  const o = obs as Partial<VisionObservation>;

  if (typeof o.id !== 'string' || o.id.trim() === '') {
    throw new Error('Observation id must be a non-empty string');
  }

  if (typeof o.label !== 'string' || o.label.trim() === '') {
    throw new Error('Observation label must be a non-empty string');
  }

  validateBoundingBox(o.boundingBox);
  validateConfidence(o.confidence);

  if (o.provenance !== 'vision' && o.provenance !== 'both' && o.provenance !== 'dom') {
    throw new Error('Observation provenance must be a valid provenance type');
  }

  // Validate metadata structure strictly against VisionObservationMetadata schema
  if (o.metadata !== undefined && o.metadata !== null) {
    if (typeof o.metadata !== 'object') {
      throw new TypeError('Observation metadata must be an object');
    }

    const allowedKeys: (keyof VisionObservationMetadata)[] = [
      'synthetic',
      'adapterName',
      'testLabel'
    ];

    const metadataKeys = Object.keys(o.metadata);
    for (const key of metadataKeys) {
      if (!allowedKeys.includes(key as keyof VisionObservationMetadata)) {
        throw new Error(
          `Observation metadata contains disallowed key "${key}". Metadata is restricted to explicit fields only.`
        );
      }
    }

    const m = o.metadata as VisionObservationMetadata;
    if (m.synthetic !== undefined && typeof m.synthetic !== 'boolean') {
      throw new TypeError('metadata.synthetic must be a boolean');
    }
    if (m.adapterName !== undefined && typeof m.adapterName !== 'string') {
      throw new TypeError('metadata.adapterName must be a string');
    }
    if (m.testLabel !== undefined && typeof m.testLabel !== 'string') {
      throw new TypeError('metadata.testLabel must be a string');
    }
  }

  return o as VisionObservation;
}
