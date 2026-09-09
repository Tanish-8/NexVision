import { describe, it, expect, vi } from 'vitest';
import type {
  VisionBoundingBox,
  VisionImageInput,
  VisionObservation,
  VisionPerception
} from './index.js';
import {
  NullVisionPerception,
  MockVisionPerception,
  isValidConfidence,
  validateConfidence,
  isValidBoundingBox,
  validateBoundingBox,
  isValidImageDimensions,
  isSupportedImageData,
  validateImageInput,
  validateObservation
} from './index.js';

describe('Phase 2B — Vision Perception Interface & Adapters', () => {
  // 1. Valid VisionObservation
  it('1. should validate a correctly shaped VisionObservation', () => {
    const validObs: VisionObservation = {
      id: 'obs-101',
      label: 'button',
      text: 'Click Me',
      boundingBox: { x: 50, y: 100, width: 120, height: 40 },
      confidence: 0.92,
      interactionHint: 'clickable',
      provenance: 'vision',
      metadata: { synthetic: true, adapterName: 'TestAdapter', testLabel: 'test-button' }
    };

    const validated = validateObservation(validObs);
    expect(validated.id).toBe('obs-101');
    expect(validated.label).toBe('button');
    expect(validated.text).toBe('Click Me');
    expect(validated.confidence).toBe(0.92);
    expect(validated.provenance).toBe('vision');
    expect(validated.metadata?.synthetic).toBe(true);
  });

  // 2. Bounding-box representation
  it('2. should correctly represent bounding box x, y, width, height relative to top-left image origin', () => {
    const box: VisionBoundingBox = { x: 15, y: 25, width: 300, height: 150 };
    expect(isValidBoundingBox(box)).toBe(true);
    expect(validateBoundingBox(box)).toEqual(box);

    const negativeX = { x: -5, y: 10, width: 100, height: 100 };
    expect(isValidBoundingBox(negativeX)).toBe(false);

    const negativeHeight = { x: 10, y: 10, width: 100, height: -20 };
    expect(isValidBoundingBox(negativeHeight)).toBe(false);
  });

  // 3. Valid confidence values
  it('3. should accept valid confidence values between 0 and 1 inclusive', () => {
    expect(isValidConfidence(0)).toBe(true);
    expect(isValidConfidence(0.5)).toBe(true);
    expect(isValidConfidence(1.0)).toBe(true);
    expect(validateConfidence(0)).toBe(0);
    expect(validateConfidence(0.75)).toBe(0.75);
    expect(validateConfidence(1)).toBe(1);
  });

  // 4. Confidence < 0 rejected
  it('4. should reject confidence scores below 0', () => {
    expect(isValidConfidence(-0.01)).toBe(false);
    expect(isValidConfidence(-1)).toBe(false);
    expect(() => validateConfidence(-0.1)).toThrow(RangeError);
    expect(() => validateConfidence(-1)).toThrow('Confidence score out of bounds');
  });

  // 5. Confidence > 1 rejected
  it('5. should reject confidence scores above 1', () => {
    expect(isValidConfidence(1.01)).toBe(false);
    expect(isValidConfidence(2.0)).toBe(false);
    expect(() => validateConfidence(1.2)).toThrow(RangeError);
    expect(() => validateConfidence(5)).toThrow('Confidence score out of bounds');
  });

  // 6. Invalid / non-finite confidence rejected
  it('6. should reject invalid or non-finite confidence scores (NaN, Infinity, string)', () => {
    expect(isValidConfidence(NaN)).toBe(false);
    expect(isValidConfidence(Infinity)).toBe(false);
    expect(isValidConfidence(-Infinity)).toBe(false);
    expect(isValidConfidence('0.9')).toBe(false);

    expect(() => validateConfidence(NaN)).toThrow(TypeError);
    expect(() => validateConfidence(Infinity)).toThrow(TypeError);
    expect(() => validateConfidence('high')).toThrow(TypeError);
  });

  // 7. Valid image dimensions
  it('7. should validate correct positive finite image dimensions', () => {
    expect(isValidImageDimensions({ width: 1920, height: 1080 })).toBe(true);
    expect(isValidImageDimensions({ width: 1, height: 1 })).toBe(true);
  });

  // 8. Invalid image dimensions rejected
  it('8. should reject zero, negative, or non-finite image dimensions', async () => {
    expect(isValidImageDimensions({ width: 0, height: 100 })).toBe(false);
    expect(isValidImageDimensions({ width: 100, height: -50 })).toBe(false);
    expect(isValidImageDimensions({ width: NaN, height: 100 })).toBe(false);

    const adapter = new NullVisionPerception();
    const result = await adapter.perceive({ dimensions: { width: 0, height: 100 } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_IMAGE_INPUT');
      expect(result.error.message).toContain('Invalid image input');
    }
  });

  // 9. Unsupported image data representation rejected
  it('9. should reject unsupported image data representations with UNSUPPORTED_IMAGE_REPRESENTATION', async () => {
    expect(isSupportedImageData(new ArrayBuffer(8))).toBe(true);
    expect(isSupportedImageData(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(isSupportedImageData('data:image/png;base64,...')).toBe(true);
    expect(isSupportedImageData(12345)).toBe(false);
    expect(isSupportedImageData({ unsupported: 'object' })).toBe(false);

    const adapter = new NullVisionPerception();

    // Pass an invalid data type (number instead of ArrayBuffer/Uint8Array/string)
    const invalidDataInput = {
      dimensions: { width: 800, height: 600 },
      data: 12345 as unknown as string
    };

    const result = await adapter.perceive(invalidDataInput);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('UNSUPPORTED_IMAGE_REPRESENTATION');
      expect(result.error.message).toContain('Unsupported image data representation');
    }
  });

  // 10. Deterministic MockVisionPerception
  it('10. should execute MockVisionPerception deterministically', async () => {
    const mock = new MockVisionPerception();
    const input: VisionImageInput = { dimensions: { width: 1920, height: 1080 } };

    const result1 = await mock.perceive(input);
    const result2 = await mock.perceive(input);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    if (result1.success && result2.success) {
      expect(result1.observations).toEqual(result2.observations);
      expect(result1.metadata?.synthetic).toBe(true);
      expect(result1.metadata?.adapterName).toBe('MockVisionPerception');
    }
  });

  // 11. NullVisionPerception empty result
  it('11. should return an empty observation list for NullVisionPerception', async () => {
    const nullAdapter = new NullVisionPerception();
    const input: VisionImageInput = { dimensions: { width: 800, height: 600 } };

    const result = await nullAdapter.perceive(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.observations).toEqual([]);
      expect(result.metadata?.adapterName).toBe('NullVisionPerception');
    }
  });

  // 12. Typed failure result
  it('12. should return typed failure results for simulated error paths', async () => {
    const errorMock = new MockVisionPerception({
      simulatedError: 'UNAVAILABLE_IMPLEMENTATION',
      simulatedErrorMessage: 'No vision model registered'
    });

    const mockResult = await errorMock.perceive({ dimensions: { width: 100, height: 100 } });
    expect(mockResult.success).toBe(false);
    if (!mockResult.success) {
      expect(mockResult.error.code).toBe('UNAVAILABLE_IMPLEMENTATION');
      expect(mockResult.error.message).toBe('No vision model registered');
    }
  });

  // 13. Consumer can depend only on VisionPerception
  it('13. should allow consumers to depend solely on the VisionPerception interface', async () => {
    async function processPerception(
      provider: VisionPerception,
      input: VisionImageInput
    ): Promise<number> {
      const res = await provider.perceive(input);
      if (res.success) {
        return res.observations.length;
      }
      return -1;
    }

    const input: VisionImageInput = { dimensions: { width: 1024, height: 768 } };

    const countNull = await processPerception(new NullVisionPerception(), input);
    expect(countNull).toBe(0);

    const countMock = await processPerception(new MockVisionPerception(), input);
    expect(countMock).toBeGreaterThan(0);
  });

  // 14. No image bytes are included in observation output
  it('14. should guarantee that observations do not contain raw image bytes or screenshots', async () => {
    const mock = new MockVisionPerception();
    const res = await mock.perceive({ dimensions: { width: 100, height: 100 } });

    expect(res.success).toBe(true);
    if (res.success) {
      for (const obs of res.observations) {
        const record = obs as unknown as Record<string, unknown>;
        expect(record.data).toBeUndefined();
        expect(record.bytes).toBeUndefined();
        expect(record.screenshot).toBeUndefined();
      }
    }
  });

  // 15. No arbitrary screenshot/image data can be stored in observation metadata
  it('15. should enforce explicit typed metadata structure and reject arbitrary disallowed keys', () => {
    const invalidObsWithArbitraryKey = {
      id: 'bad-obs',
      label: 'image',
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      confidence: 0.9,
      provenance: 'vision' as const,
      metadata: {
        disallowedKey: 'arbitrary screenshot data'
      }
    };

    expect(() => validateObservation(invalidObsWithArbitraryKey)).toThrow(
      'contains disallowed key "disallowedKey"'
    );
  });

  // 16. No sensitive form/password values represented in observation metadata structure
  it('16. should prevent storing password or form PII keys in metadata structure', () => {
    const invalidObsWithPassword = {
      id: 'bad-obs-2',
      label: 'textbox',
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      confidence: 0.9,
      provenance: 'vision' as const,
      metadata: {
        passwordValue: 'secret123'
      }
    };

    expect(() => validateObservation(invalidObsWithPassword)).toThrow(
      'contains disallowed key "passwordValue"'
    );
  });

  // 17. Network isolation test
  it('17. should execute perception completely locally without making network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const mock = new MockVisionPerception();
    const result = await mock.perceive({ dimensions: { width: 640, height: 480 } });

    expect(result.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
