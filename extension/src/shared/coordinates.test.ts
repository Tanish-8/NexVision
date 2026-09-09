/**
 * Tests for Phase 2F-1: Coordinate-Space Contract & Deterministic Normalization
 */

import { describe, it, expect } from 'vitest';
import {
  cssRectToScreenshotPixels,
  getCoordinateScale,
  isRectWithinBounds,
  screenshotPixelsToCssRect,
  validateCoordinateSpaceMetadata,
  validateRect
} from './coordinates.js';
import type {
  CoordinateSpaceMetadata,
  CssViewportRect,
  ScreenshotPixelRect
} from './coordinates.js';
import type { ElementBounds } from './types.js';

describe('Phase 2F-1: Coordinate-Space Contract & Normalization', () => {
  // 1. 1:1 mapping
  describe('1: 1:1 mapping', () => {
    const space1to1: CoordinateSpaceMetadata = {
      screenshotWidth: 1000,
      screenshotHeight: 800,
      viewportWidth: 1000,
      viewportHeight: 800,
      devicePixelRatio: 1.0
    };

    it('should leave screenshot rectangle unchanged when converted to CSS', () => {
      const screenshotRect: ScreenshotPixelRect = {
        x: 150,
        y: 250,
        width: 300,
        height: 200
      };

      const cssRect = screenshotPixelsToCssRect(screenshotRect, space1to1);

      expect(cssRect.x).toBe(150);
      expect(cssRect.y).toBe(250);
      expect(cssRect.width).toBe(300);
      expect(cssRect.height).toBe(200);
    });

    it('should leave CSS rectangle unchanged when converted to screenshot pixels', () => {
      const cssRect: CssViewportRect = {
        x: 150,
        y: 250,
        width: 300,
        height: 200
      };

      const screenshotRect = cssRectToScreenshotPixels(cssRect, space1to1);

      expect(screenshotRect.x).toBe(150);
      expect(screenshotRect.y).toBe(250);
      expect(screenshotRect.width).toBe(300);
      expect(screenshotRect.height).toBe(200);
    });
  });

  // 2. DPR-like scaling
  describe('2: DPR-like scaling', () => {
    const dpr2Space: CoordinateSpaceMetadata = {
      screenshotWidth: 2000,
      screenshotHeight: 1600,
      viewportWidth: 1000,
      viewportHeight: 800,
      devicePixelRatio: 2.0
    };

    it('should convert screenshot rectangle (200, 100, 400, 200) to approximately (100, 50, 200, 100)', () => {
      const screenshotRect: ScreenshotPixelRect = {
        x: 200,
        y: 100,
        width: 400,
        height: 200
      };

      const cssRect = screenshotPixelsToCssRect(screenshotRect, dpr2Space);

      expect(cssRect.x).toBeCloseTo(100, 6);
      expect(cssRect.y).toBeCloseTo(50, 6);
      expect(cssRect.width).toBeCloseTo(200, 6);
      expect(cssRect.height).toBeCloseTo(100, 6);
    });
  });

  // 3. The actual NexVision observed dimensions
  describe('3: Actual NexVision observed dimensions (1295x877 vs 1036x702)', () => {
    const nexVisionSpace: CoordinateSpaceMetadata = {
      screenshotWidth: 1295,
      screenshotHeight: 877,
      viewportWidth: 1036,
      viewportHeight: 702,
      devicePixelRatio: 1.25
    };

    it('should use measured scale rather than assuming DPR=1', () => {
      const scale = getCoordinateScale(nexVisionSpace);

      // scaleX = 1295 / 1036 = 1.25
      expect(scale.scaleX).toBe(1.25);
      // scaleY = 877 / 702 ≈ 1.2492877...
      expect(scale.scaleY).toBeCloseTo(877 / 702, 9);
      expect(scale.scaleY).not.toBe(1.0);
      expect(scale.scaleX).not.toBe(1.0);

      // A rectangle spanning the full screenshot should map exactly to the full CSS viewport
      const fullScreenshotRect: ScreenshotPixelRect = {
        x: 0,
        y: 0,
        width: 1295,
        height: 877
      };

      const cssRect = screenshotPixelsToCssRect(fullScreenshotRect, nexVisionSpace);

      expect(cssRect.x).toBe(0);
      expect(cssRect.y).toBe(0);
      expect(cssRect.width).toBeCloseTo(1036, 6);
      expect(cssRect.height).toBeCloseTo(702, 6);
    });

    it('should NOT use devicePixelRatio directly if DPR does not match measured scale', () => {
      // Craft metadata where DPR claims 1.5, but actual dimensions are 1295x877 -> 1036x702
      const auditSpace: CoordinateSpaceMetadata = {
        ...nexVisionSpace,
        devicePixelRatio: 1.5 // Intentionally different from measured scale
      };

      const rect: ScreenshotPixelRect = { x: 1295, y: 877, width: 0, height: 0 };
      const converted = screenshotPixelsToCssRect(rect, auditSpace);

      // Must scale by measured dimensions (1036, 702), NOT by DPR 1.5 (which would yield 1295/1.5 = 863.33)
      expect(converted.x).toBeCloseTo(1036, 6);
      expect(converted.y).toBeCloseTo(702, 6);
    });
  });

  // 4. Reverse conversion
  describe('4: Reverse conversion (CSS -> Screenshot -> CSS)', () => {
    const space: CoordinateSpaceMetadata = {
      screenshotWidth: 1295,
      screenshotHeight: 877,
      viewportWidth: 1036,
      viewportHeight: 702,
      devicePixelRatio: 1.25
    };

    it('should recover original CSS rectangle within small floating-point tolerance', () => {
      const originalCssRect: CssViewportRect = {
        x: 123.456,
        y: 78.901,
        width: 456.789,
        height: 234.567
      };

      const screenshotRect = cssRectToScreenshotPixels(originalCssRect, space);
      const recoveredCssRect = screenshotPixelsToCssRect(screenshotRect, space);

      expect(recoveredCssRect.x).toBeCloseTo(originalCssRect.x, 9);
      expect(recoveredCssRect.y).toBeCloseTo(originalCssRect.y, 9);
      expect(recoveredCssRect.width).toBeCloseTo(originalCssRect.width, 9);
      expect(recoveredCssRect.height).toBeCloseTo(originalCssRect.height, 9);
    });

    it('should recover original screenshot rectangle within small floating-point tolerance (Screenshot -> CSS -> Screenshot)', () => {
      const originalScreenshotRect: ScreenshotPixelRect = {
        x: 321.654,
        y: 198.765,
        width: 543.21,
        height: 312.45
      };

      const cssRect = screenshotPixelsToCssRect(originalScreenshotRect, space);
      const recoveredScreenshotRect = cssRectToScreenshotPixels(cssRect, space);

      expect(recoveredScreenshotRect.x).toBeCloseTo(originalScreenshotRect.x, 9);
      expect(recoveredScreenshotRect.y).toBeCloseTo(originalScreenshotRect.y, 9);
      expect(recoveredScreenshotRect.width).toBeCloseTo(originalScreenshotRect.width, 9);
      expect(recoveredScreenshotRect.height).toBeCloseTo(originalScreenshotRect.height, 9);
    });
  });

  // 5. Non-uniform scale
  describe('5: Non-uniform scale', () => {
    const nonUniformSpace: CoordinateSpaceMetadata = {
      screenshotWidth: 1500, // scaleX = 1500 / 1000 = 1.5
      screenshotHeight: 1600, // scaleY = 1600 / 800 = 2.0
      viewportWidth: 1000,
      viewportHeight: 800,
      devicePixelRatio: 1.75
    };

    it('should preserve independent scale factors per axis and not collapse them', () => {
      const scale = getCoordinateScale(nonUniformSpace);

      expect(scale.scaleX).toBe(1.5);
      expect(scale.scaleY).toBe(2.0);

      const screenshotRect: ScreenshotPixelRect = {
        x: 300,
        y: 400,
        width: 150,
        height: 200
      };

      const cssRect = screenshotPixelsToCssRect(screenshotRect, nonUniformSpace);

      // x / 1.5 = 200, y / 2.0 = 200
      expect(cssRect.x).toBeCloseTo(200, 6);
      expect(cssRect.y).toBeCloseTo(200, 6);
      // width / 1.5 = 100, height / 2.0 = 100
      expect(cssRect.width).toBeCloseTo(100, 6);
      expect(cssRect.height).toBeCloseTo(100, 6);
    });
  });

  // 6. Invalid metadata
  describe('6: Invalid metadata validation', () => {
    it('should reject non-object metadata', () => {
      expect(() => validateCoordinateSpaceMetadata(null)).toThrow(TypeError);
      expect(() => validateCoordinateSpaceMetadata(undefined)).toThrow(TypeError);
      expect(() => validateCoordinateSpaceMetadata('invalid')).toThrow(TypeError);
    });

    it('should reject zero dimensions', () => {
      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: 0,
          screenshotHeight: 800,
          viewportWidth: 1000,
          viewportHeight: 800,
          devicePixelRatio: 1
        })
      ).toThrow(RangeError);

      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: 1000,
          screenshotHeight: 0,
          viewportWidth: 1000,
          viewportHeight: 800,
          devicePixelRatio: 1
        })
      ).toThrow(RangeError);

      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: 1000,
          screenshotHeight: 800,
          viewportWidth: 0,
          viewportHeight: 800,
          devicePixelRatio: 1
        })
      ).toThrow(RangeError);

      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: 1000,
          screenshotHeight: 800,
          viewportWidth: 1000,
          viewportHeight: 0,
          devicePixelRatio: 1
        })
      ).toThrow(RangeError);
    });

    it('should reject negative dimensions', () => {
      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: -1000,
          screenshotHeight: 800,
          viewportWidth: 1000,
          viewportHeight: 800,
          devicePixelRatio: 1
        })
      ).toThrow(RangeError);
    });

    it('should reject NaN and Infinity dimensions', () => {
      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: NaN,
          screenshotHeight: 800,
          viewportWidth: 1000,
          viewportHeight: 800,
          devicePixelRatio: 1
        })
      ).toThrow(TypeError);

      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: 1000,
          screenshotHeight: Infinity,
          viewportWidth: 1000,
          viewportHeight: 800,
          devicePixelRatio: 1
        })
      ).toThrow(TypeError);
    });

    it('should reject zero or negative devicePixelRatio', () => {
      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: 1000,
          screenshotHeight: 800,
          viewportWidth: 1000,
          viewportHeight: 800,
          devicePixelRatio: 0
        })
      ).toThrow(RangeError);

      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: 1000,
          screenshotHeight: 800,
          viewportWidth: 1000,
          viewportHeight: 800,
          devicePixelRatio: -1.25
        })
      ).toThrow(RangeError);

      expect(() =>
        validateCoordinateSpaceMetadata({
          screenshotWidth: 1000,
          screenshotHeight: 800,
          viewportWidth: 1000,
          viewportHeight: 800,
          devicePixelRatio: NaN
        })
      ).toThrow(TypeError);
    });
  });

  // 7. Invalid rectangles
  describe('7: Invalid rectangles validation', () => {
    it('should reject non-object rectangles', () => {
      expect(() => validateRect(null)).toThrow(TypeError);
      expect(() => validateRect(undefined)).toThrow(TypeError);
      expect(() => validateRect(42)).toThrow(TypeError);
    });

    it('should reject negative width or height', () => {
      expect(() => validateRect({ x: 0, y: 0, width: -10, height: 100 })).toThrow(RangeError);
      expect(() => validateRect({ x: 0, y: 0, width: 100, height: -5 })).toThrow(RangeError);
    });

    it('should reject NaN coordinates and dimensions', () => {
      expect(() => validateRect({ x: NaN, y: 0, width: 100, height: 100 })).toThrow(TypeError);
      expect(() => validateRect({ x: 0, y: NaN, width: 100, height: 100 })).toThrow(TypeError);
      expect(() => validateRect({ x: 0, y: 0, width: NaN, height: 100 })).toThrow(TypeError);
      expect(() => validateRect({ x: 0, y: 0, width: 100, height: NaN })).toThrow(TypeError);
    });

    it('should reject infinite coordinates and dimensions', () => {
      expect(() => validateRect({ x: Infinity, y: 0, width: 100, height: 100 })).toThrow(TypeError);
      expect(() => validateRect({ x: 0, y: -Infinity, width: 100, height: 100 })).toThrow(TypeError);
      expect(() => validateRect({ x: 0, y: 0, width: Infinity, height: 100 })).toThrow(TypeError);
      expect(() => validateRect({ x: 0, y: 0, width: 100, height: Infinity })).toThrow(TypeError);
    });
  });

  // 8. Boundary coordinates
  describe('8: Boundary coordinates', () => {
    const space: CoordinateSpaceMetadata = {
      screenshotWidth: 1295,
      screenshotHeight: 877,
      viewportWidth: 1036,
      viewportHeight: 702,
      devicePixelRatio: 1.25
    };

    it('should correctly convert rectangles touching the exact right and bottom boundaries', () => {
      // Touching screenshot boundaries: right edge at 1295, bottom edge at 877
      const rectTouchingScreenshot: ScreenshotPixelRect = {
        x: 1000,
        y: 700,
        width: 295, // 1000 + 295 = 1295
        height: 177 // 700 + 177 = 877
      };

      const cssRect = screenshotPixelsToCssRect(rectTouchingScreenshot, space);

      expect(cssRect.x + cssRect.width).toBeCloseTo(1036, 6);
      expect(cssRect.y + cssRect.height).toBeCloseTo(702, 6);

      // Touching CSS viewport boundaries: right edge at 1036, bottom edge at 702
      const rectTouchingViewport: CssViewportRect = {
        x: 800,
        y: 500,
        width: 236, // 800 + 236 = 1036
        height: 202 // 500 + 202 = 702
      };

      const screenshotRect = cssRectToScreenshotPixels(rectTouchingViewport, space);

      expect(screenshotRect.x + screenshotRect.width).toBeCloseTo(1295, 6);
      expect(screenshotRect.y + screenshotRect.height).toBeCloseTo(877, 6);
    });
  });

  // 9. Out-of-bounds behavior
  describe('9: Out-of-bounds behavior (no silent clamping)', () => {
    const space: CoordinateSpaceMetadata = {
      screenshotWidth: 2000,
      screenshotHeight: 1600,
      viewportWidth: 1000,
      viewportHeight: 800,
      devicePixelRatio: 2.0
    };

    it('should NOT clamp negative coordinates in screenshotPixelsToCssRect by default', () => {
      const negativeScreenshotRect: ScreenshotPixelRect = {
        x: -200,
        y: -100,
        width: 400,
        height: 300
      };

      const cssRect = screenshotPixelsToCssRect(negativeScreenshotRect, space);

      expect(cssRect.x).toBe(-100);
      expect(cssRect.y).toBe(-50);
      expect(cssRect.width).toBe(200);
      expect(cssRect.height).toBe(150);
    });

    it('should NOT clamp coordinates overflowing dimensions by default', () => {
      const overflowScreenshotRect: ScreenshotPixelRect = {
        x: 2200,
        y: 1800,
        width: 200,
        height: 200
      };

      const cssRect = screenshotPixelsToCssRect(overflowScreenshotRect, space);

      expect(cssRect.x).toBe(1100);
      expect(cssRect.y).toBe(900);
      expect(cssRect.width).toBe(100);
      expect(cssRect.height).toBe(100);
    });

    it('should NOT clamp negative or overflowing CSS coordinates in cssRectToScreenshotPixels by default', () => {
      const outOfBoundsCssRect: CssViewportRect = {
        x: -50,
        y: 900,
        width: 200,
        height: 100
      };

      const screenshotRect = cssRectToScreenshotPixels(outOfBoundsCssRect, space);

      expect(screenshotRect.x).toBe(-100);
      expect(screenshotRect.y).toBe(1800);
      expect(screenshotRect.width).toBe(400);
      expect(screenshotRect.height).toBe(200);
    });

    it('should throw RangeError if strictBounds is enabled and rect extends outside screenshot', () => {
      const outOfBoundsRect: ScreenshotPixelRect = {
        x: -10,
        y: 50,
        width: 100,
        height: 100
      };

      expect(() =>
        screenshotPixelsToCssRect(outOfBoundsRect, space, { strictBounds: true })
      ).toThrow(RangeError);

      const overflowRect: ScreenshotPixelRect = {
        x: 1950,
        y: 100,
        width: 100, // 1950 + 100 = 2050 > 2000
        height: 100
      };

      expect(() =>
        screenshotPixelsToCssRect(overflowRect, space, { strictBounds: true })
      ).toThrow(RangeError);
    });

    it('should throw RangeError if strictBounds is enabled and rect extends outside viewport', () => {
      const outOfBoundsCssRect: CssViewportRect = {
        x: 950,
        y: 50,
        width: 100, // 950 + 100 = 1050 > 1000
        height: 100
      };

      expect(() =>
        cssRectToScreenshotPixels(outOfBoundsCssRect, space, { strictBounds: true })
      ).toThrow(RangeError);
    });
  });

  // 10. Determinism
  describe('10: Determinism', () => {
    const space: CoordinateSpaceMetadata = {
      screenshotWidth: 1295,
      screenshotHeight: 877,
      viewportWidth: 1036,
      viewportHeight: 702,
      devicePixelRatio: 1.25
    };

    it('should produce identical results on repeated calls with identical inputs', () => {
      const screenshotRect: ScreenshotPixelRect = {
        x: 234.56,
        y: 345.67,
        width: 456.78,
        height: 123.45
      };

      const result1 = screenshotPixelsToCssRect(screenshotRect, space);
      const result2 = screenshotPixelsToCssRect(screenshotRect, space);
      const result3 = screenshotPixelsToCssRect(screenshotRect, space);

      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);
      expect(result1.x).toBe(result2.x);
      expect(result1.y).toBe(result2.y);
      expect(result1.width).toBe(result2.width);
      expect(result1.height).toBe(result2.height);
    });
  });

  // 11. Helper: isRectWithinBounds
  describe('isRectWithinBounds helper', () => {
    it('should correctly identify rects inside and outside bounds', () => {
      const bounds = { width: 1000, height: 800 };

      expect(isRectWithinBounds({ x: 0, y: 0, width: 1000, height: 800 }, bounds)).toBe(true);
      expect(isRectWithinBounds({ x: 100, y: 100, width: 200, height: 200 }, bounds)).toBe(true);

      expect(isRectWithinBounds({ x: -1, y: 0, width: 100, height: 100 }, bounds)).toBe(false);
      expect(isRectWithinBounds({ x: 0, y: -1, width: 100, height: 100 }, bounds)).toBe(false);
      expect(isRectWithinBounds({ x: 901, y: 0, width: 100, height: 100 }, bounds)).toBe(false);
      expect(isRectWithinBounds({ x: 0, y: 701, width: 100, height: 100 }, bounds)).toBe(false);
    });
  });

  // 12. Structural compatibility with ElementBounds
  describe('Structural compatibility with ElementBounds', () => {
    it('should allow CssViewportRect to be assigned to ElementBounds without type mismatch', () => {
      const cssRect: CssViewportRect = {
        x: 10,
        y: 20,
        width: 100,
        height: 50
      };

      // Compile-time check: assignment to ElementBounds
      const bounds: ElementBounds = cssRect;
      expect(bounds.x).toBe(10);
      expect(bounds.y).toBe(20);
      expect(bounds.width).toBe(100);
      expect(bounds.height).toBe(50);
    });
  });
});
