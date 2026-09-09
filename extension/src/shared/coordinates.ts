/**
 * Coordinate-Space Contract & Deterministic Normalization — Phase 2F-1.
 *
 * Defines explicit types and deterministic conversions between:
 * 1. Screenshot pixel coordinates (physical image pixels)
 * 2. CSS viewport coordinates (DOM CSS pixels)
 *
 * Invariants:
 * - Conversion scales are measured independently per axis:
 *     scaleX = screenshotWidth / viewportWidth
 *     scaleY = screenshotHeight / viewportHeight
 * - devicePixelRatio is retained for auditing/metadata only; it is NEVER used
 *   directly as the conversion scale.
 * - Out-of-bounds coordinates are preserved without silent clamping unless
 *   strictBounds: true is explicitly requested.
 * - Full floating-point precision is maintained throughout transformations without
 *   premature rounding.
 */

/**
 * A rectangle in screenshot pixel coordinate space.
 * Origin (0,0) is the top-left corner of the captured screenshot image.
 */
export interface ScreenshotPixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A rectangle in CSS viewport coordinate space.
 * Origin (0,0) is the top-left corner of the browser viewport.
 * Structurally compatible with ElementBounds from types.ts.
 */
export interface CssViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Explicit metadata representing the relationship between physical screenshot
 * pixels and CSS viewport coordinates.
 */
export interface CoordinateSpaceMetadata {
  /** Width of the captured screenshot in physical pixels (> 0). */
  screenshotWidth: number;
  /** Height of the captured screenshot in physical pixels (> 0). */
  screenshotHeight: number;
  /** Width of the browser viewport in CSS pixels (> 0). */
  viewportWidth: number;
  /** Height of the browser viewport in CSS pixels (> 0). */
  viewportHeight: number;
  /** Device pixel ratio reported by the browser (> 0). For auditing/metadata only. */
  devicePixelRatio: number;
}

/**
 * Scale factors derived from measured screenshot and viewport dimensions.
 */
export interface CoordinateScale {
  scaleX: number;
  scaleY: number;
}

/**
 * Options for coordinate conversion operations.
 */
export interface CoordinateConversionOptions {
  /**
   * When true, validates that the source rectangle is entirely contained
   * within the source coordinate space dimensions (x >= 0, y >= 0,
   * x + width <= sourceWidth, y + height <= sourceHeight).
   *
   * When false or omitted (default), out-of-bounds and off-screen coordinates
   * are preserved and converted linearly without clamping or rejection.
   */
  strictBounds?: boolean;
}

/**
 * Validates coordinate space metadata.
 * Throws TypeError if fields are missing or not finite numbers.
 * Throws RangeError if dimensions or devicePixelRatio are <= 0.
 */
export function validateCoordinateSpaceMetadata(
  metadata: unknown
): CoordinateSpaceMetadata {
  if (!metadata || typeof metadata !== 'object') {
    throw new TypeError('Coordinate space metadata must be a non-null object');
  }

  const m = metadata as Partial<CoordinateSpaceMetadata>;

  const checkField = (field: keyof CoordinateSpaceMetadata, name: string): number => {
    const val = m[field];
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new TypeError(
        `Invalid ${name}: expected a finite number, received ${typeof val === 'number' ? val : typeof val}`
      );
    }
    if (val <= 0) {
      throw new RangeError(
        `Invalid ${name}: must be greater than zero, received ${val}`
      );
    }
    return val;
  };

  return {
    screenshotWidth: checkField('screenshotWidth', 'screenshotWidth'),
    screenshotHeight: checkField('screenshotHeight', 'screenshotHeight'),
    viewportWidth: checkField('viewportWidth', 'viewportWidth'),
    viewportHeight: checkField('viewportHeight', 'viewportHeight'),
    devicePixelRatio: checkField('devicePixelRatio', 'devicePixelRatio')
  };
}

/**
 * Validates a rectangle's coordinates and dimensions.
 * Throws TypeError if coordinates or dimensions are not finite numbers.
 * Throws RangeError if width < 0 or height < 0.
 */
export function validateRect(
  rect: unknown,
  label = 'Rectangle'
): { x: number; y: number; width: number; height: number } {
  if (!rect || typeof rect !== 'object') {
    throw new TypeError(`${label} must be a non-null object`);
  }

  const r = rect as Partial<ScreenshotPixelRect>;

  if (typeof r.x !== 'number' || !Number.isFinite(r.x)) {
    throw new TypeError(
      `Invalid ${label} x coordinate: expected a finite number, received ${typeof r.x === 'number' ? r.x : typeof r.x}`
    );
  }

  if (typeof r.y !== 'number' || !Number.isFinite(r.y)) {
    throw new TypeError(
      `Invalid ${label} y coordinate: expected a finite number, received ${typeof r.y === 'number' ? r.y : typeof r.y}`
    );
  }

  if (typeof r.width !== 'number' || !Number.isFinite(r.width)) {
    throw new TypeError(
      `Invalid ${label} width: expected a finite number, received ${typeof r.width === 'number' ? r.width : typeof r.width}`
    );
  }
  if (r.width < 0) {
    throw new RangeError(
      `Invalid ${label} width: must be non-negative, received ${r.width}`
    );
  }

  if (typeof r.height !== 'number' || !Number.isFinite(r.height)) {
    throw new TypeError(
      `Invalid ${label} height: expected a finite number, received ${typeof r.height === 'number' ? r.height : typeof r.height}`
    );
  }
  if (r.height < 0) {
    throw new RangeError(
      `Invalid ${label} height: must be non-negative, received ${r.height}`
    );
  }

  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height
  };
}

/**
 * Checks whether a rectangle is completely contained within the specified boundary dimensions.
 *
 * @param rect Rectangle to inspect
 * @param bounds Boundary dimensions (width and height)
 * @returns true if rect is within [0, bounds.width] and [0, bounds.height], false otherwise.
 */
export function isRectWithinBounds(
  rect: { x: number; y: number; width: number; height: number },
  bounds: { width: number; height: number }
): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= bounds.width &&
    rect.y + rect.height <= bounds.height
  );
}

/**
 * Derives the independent scale factors from measured dimensions.
 *
 * scaleX = screenshotWidth / viewportWidth
 * scaleY = screenshotHeight / viewportHeight
 *
 * @param metadata Validated or raw coordinate space metadata
 * @returns Calculated CoordinateScale
 */
export function getCoordinateScale(
  metadata: CoordinateSpaceMetadata
): CoordinateScale {
  const valid = validateCoordinateSpaceMetadata(metadata);
  return {
    scaleX: valid.screenshotWidth / valid.viewportWidth,
    scaleY: valid.screenshotHeight / valid.viewportHeight
  };
}

/**
 * Converts a rectangle from screenshot pixel coordinates to CSS viewport coordinates.
 *
 * Uses measured scale factors (scaleX = screenshotWidth / viewportWidth,
 * scaleY = screenshotHeight / viewportHeight).
 *
 * Out-of-bounds coordinates are NOT clamped silently; they are converted linearly
 * unless strictBounds: true is explicitly requested, in which case a RangeError is thrown.
 *
 * @param rect Rectangle in screenshot physical pixels
 * @param metadata Coordinate space metadata
 * @param options Optional conversion configuration
 * @returns Converted rectangle in CSS viewport coordinates
 */
export function screenshotPixelsToCssRect(
  rect: ScreenshotPixelRect,
  metadata: CoordinateSpaceMetadata,
  options?: CoordinateConversionOptions
): CssViewportRect {
  const validRect = validateRect(rect, 'ScreenshotPixelRect');
  const validMetadata = validateCoordinateSpaceMetadata(metadata);

  if (options?.strictBounds) {
    const fits = isRectWithinBounds(validRect, {
      width: validMetadata.screenshotWidth,
      height: validMetadata.screenshotHeight
    });
    if (!fits) {
      throw new RangeError(
        `Source rectangle (x=${validRect.x}, y=${validRect.y}, width=${validRect.width}, height=${validRect.height}) ` +
        `extends outside screenshot bounds (${validMetadata.screenshotWidth}x${validMetadata.screenshotHeight})`
      );
    }
  }

  const scaleX = validMetadata.screenshotWidth / validMetadata.viewportWidth;
  const scaleY = validMetadata.screenshotHeight / validMetadata.viewportHeight;

  return {
    x: validRect.x / scaleX,
    y: validRect.y / scaleY,
    width: validRect.width / scaleX,
    height: validRect.height / scaleY
  };
}

/**
 * Converts a rectangle from CSS viewport coordinates to screenshot pixel coordinates.
 *
 * Inverse of screenshotPixelsToCssRect.
 * Uses measured scale factors (scaleX = screenshotWidth / viewportWidth,
 * scaleY = screenshotHeight / viewportHeight).
 *
 * Out-of-bounds coordinates are NOT clamped silently; they are converted linearly
 * unless strictBounds: true is explicitly requested, in which case a RangeError is thrown.
 *
 * @param rect Rectangle in CSS viewport coordinates
 * @param metadata Coordinate space metadata
 * @param options Optional conversion configuration
 * @returns Converted rectangle in screenshot physical pixels
 */
export function cssRectToScreenshotPixels(
  rect: CssViewportRect,
  metadata: CoordinateSpaceMetadata,
  options?: CoordinateConversionOptions
): ScreenshotPixelRect {
  const validRect = validateRect(rect, 'CssViewportRect');
  const validMetadata = validateCoordinateSpaceMetadata(metadata);

  if (options?.strictBounds) {
    const fits = isRectWithinBounds(validRect, {
      width: validMetadata.viewportWidth,
      height: validMetadata.viewportHeight
    });
    if (!fits) {
      throw new RangeError(
        `Source rectangle (x=${validRect.x}, y=${validRect.y}, width=${validRect.width}, height=${validRect.height}) ` +
        `extends outside CSS viewport bounds (${validMetadata.viewportWidth}x${validMetadata.viewportHeight})`
      );
    }
  }

  const scaleX = validMetadata.screenshotWidth / validMetadata.viewportWidth;
  const scaleY = validMetadata.screenshotHeight / validMetadata.viewportHeight;

  return {
    x: validRect.x * scaleX,
    y: validRect.y * scaleY,
    width: validRect.width * scaleX,
    height: validRect.height * scaleY
  };
}
