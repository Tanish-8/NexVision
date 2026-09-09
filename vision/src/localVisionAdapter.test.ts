/**
 * Tests for Phase 2E-1 — LocalVisionAdapter Foundation.
 *
 * Requirements:
 * - Completely local execution — no network / cloud APIs.
 * - Injected local inference for deterministic testing.
 * - Validation of bounding boxes, confidence, and config without silent clamping.
 * - Privacy invariants: no raw screenshot/image bytes exposed.
 * - Full compatibility with VisionPerception interface.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  VisionBoundingBox,
  VisionImageInput,
  VisionPerception
} from './index.js';
import {
  LocalVisionAdapter,
  validateLocalVisionModelConfig,
  type LocalDetectionOutput,
  type LocalInferenceResult,
  type LocalVisionInference,
  type LocalVisionModelConfig
} from './index.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const MOCK_CONFIG: LocalVisionModelConfig = {
  modelId: 'test-local-vlm'
};

const VALID_INPUT: VisionImageInput = {
  dimensions: { width: 1280, height: 720 },
  data: 'data:image/png;base64,RAW_EPHEMERAL_IMAGE_BYTES',
  format: 'image/png'
};

const VALID_DETECTION: LocalDetectionOutput = {
  id: 'det-1',
  label: 'button',
  text: 'Sign In',
  box: { x: 100, y: 150, width: 200, height: 50 },
  confidence: 0.95,
  interactionHint: 'clickable',
  testLabel: 'sign-in-button'
};

/**
 * Creates a deterministic fake inference engine returning the given result.
 */
function createFakeInference(result: LocalInferenceResult): LocalVisionInference {
  return {
    modelId: 'test-local-vlm',
    infer: vi.fn().mockResolvedValue(result)
  };
}

describe('Phase 2E-1 — LocalVisionAdapter', () => {

  // -------------------------------------------------------------------------
  // Requirement 1 & A: Successful conversion of local inference to VisionObservation[]
  // -------------------------------------------------------------------------
  it('A. should convert valid local inference output into typed VisionObservation[]', async () => {
    const inference = createFakeInference({
      success: true,
      detections: [VALID_DETECTION],
      inferenceTimeMs: 42
    });

    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference
    });

    const result = await adapter.perceive(VALID_INPUT);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0]!;
    expect(obs.id).toBe('det-1');
    expect(obs.label).toBe('button');
    expect(obs.text).toBe('Sign In');
    expect(obs.boundingBox).toEqual({ x: 100, y: 150, width: 200, height: 50 });
    expect(obs.confidence).toBe(0.95);
    expect(obs.interactionHint).toBe('clickable');
    expect(obs.provenance).toBe('vision');
    expect(obs.metadata?.adapterName).toBe('LocalVisionAdapter');
    expect(obs.metadata?.testLabel).toBe('sign-in-button');

    expect(result.metadata?.adapterName).toBe('LocalVisionAdapter');
    expect(result.metadata?.perceptionTimeMs).toBe(42);
  });

  it('A2. should auto-generate deterministic sequential IDs when detection IDs are omitted', async () => {
    const detectionWithoutId: LocalDetectionOutput = {
      label: 'link',
      box: { x: 10, y: 20, width: 50, height: 20 },
      confidence: 0.88
    };

    const adapter = new LocalVisionAdapter({
      config: { modelId: 'ui-grounder' },
      inference: async () => ({
        success: true,
        detections: [detectionWithoutId]
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    expect(result.observations[0]!.id).toBe('ui-grounder-obs-1');
  });

  // -------------------------------------------------------------------------
  // Requirement 2 & B: Invalid bounding boxes are rejected
  // -------------------------------------------------------------------------
  it('B1. should reject detections with negative bounding box coordinates', async () => {
    const invalidDetection: LocalDetectionOutput = {
      label: 'button',
      box: { x: -10, y: 20, width: 100, height: 50 },
      confidence: 0.9
    };

    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: true,
        detections: [invalidDetection]
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.code).toBe('PERCEPTION_FAILURE');
    expect(result.error.message).toContain('bounding box');
  });

  it('B2. should reject detections whose bounding box exceeds input image dimensions', async () => {
    // x = 1200, width = 200 => right edge = 1400 > 1280
    const overflowingDetection: LocalDetectionOutput = {
      label: 'panel',
      box: { x: 1200, y: 100, width: 200, height: 50 },
      confidence: 0.85
    };

    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: true,
        detections: [overflowingDetection]
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.code).toBe('PERCEPTION_FAILURE');
    expect(result.error.message).toContain('exceeds image');
  });

  it('B3. should reject detections with non-finite bounding box coordinates', async () => {
    const nonFiniteDetection: LocalDetectionOutput = {
      label: 'badge',
      box: { x: 10, y: NaN, width: 50, height: 20 },
      confidence: 0.7
    };

    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: true,
        detections: [nonFiniteDetection]
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.code).toBe('PERCEPTION_FAILURE');
  });

  // -------------------------------------------------------------------------
  // Requirement 3 & C: Invalid confidence values are rejected
  // -------------------------------------------------------------------------
  it('C1. should reject detections with confidence < 0', async () => {
    const invalidConfidenceDetection: LocalDetectionOutput = {
      label: 'button',
      box: { x: 10, y: 10, width: 50, height: 20 },
      confidence: -0.05
    };

    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: true,
        detections: [invalidConfidenceDetection]
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.code).toBe('PERCEPTION_FAILURE');
    expect(result.error.message).toContain('confidence');
  });

  it('C2. should reject detections with confidence > 1', async () => {
    const invalidConfidenceDetection: LocalDetectionOutput = {
      label: 'button',
      box: { x: 10, y: 10, width: 50, height: 20 },
      confidence: 1.05
    };

    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: true,
        detections: [invalidConfidenceDetection]
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.code).toBe('PERCEPTION_FAILURE');
    expect(result.error.message).toContain('confidence');
  });

  it('C3. should reject detections with non-finite confidence (NaN or Infinity)', async () => {
    const nanConfidenceDetection: LocalDetectionOutput = {
      label: 'button',
      box: { x: 10, y: 10, width: 50, height: 20 },
      confidence: NaN
    };

    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: true,
        detections: [nanConfidenceDetection]
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.code).toBe('PERCEPTION_FAILURE');
  });

  // -------------------------------------------------------------------------
  // Requirement 4 & D: Empty observation result is valid
  // -------------------------------------------------------------------------
  it('D1. should successfully return an empty observation list when inference detects nothing', async () => {
    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: true,
        detections: []
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.observations).toEqual([]);
  });

  it('D2. should filter out observations below configured confidenceThreshold', async () => {
    const detections: LocalDetectionOutput[] = [
      {
        id: 'det-low',
        label: 'button',
        box: { x: 10, y: 10, width: 50, height: 20 },
        confidence: 0.4
      },
      {
        id: 'det-high',
        label: 'input',
        box: { x: 70, y: 10, width: 100, height: 30 },
        confidence: 0.85
      }
    ];

    const adapter = new LocalVisionAdapter({
      config: {
        modelId: 'test-threshold-model',
        confidenceThreshold: 0.7
      },
      inference: createFakeInference({
        success: true,
        detections
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.id).toBe('det-high');
    expect(result.observations[0]!.confidence).toBe(0.85);
  });

  it('D3. should return empty observations if all detections fall below confidenceThreshold', async () => {
    const detections: LocalDetectionOutput[] = [
      {
        label: 'icon',
        box: { x: 10, y: 10, width: 20, height: 20 },
        confidence: 0.5
      }
    ];

    const adapter = new LocalVisionAdapter({
      config: {
        modelId: 'test-threshold-model',
        confidenceThreshold: 0.8
      },
      inference: createFakeInference({
        success: true,
        detections
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.observations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Config refinement: validate confidenceThreshold without silent clamping
  // -------------------------------------------------------------------------
  describe('LocalVisionModelConfig validation', () => {
    it('should accept valid confidenceThreshold in [0, 1]', () => {
      expect(validateLocalVisionModelConfig({ modelId: 'm1', confidenceThreshold: 0 })).toEqual({
        modelId: 'm1',
        confidenceThreshold: 0,
        maxDimensions: undefined
      });
      expect(validateLocalVisionModelConfig({ modelId: 'm1', confidenceThreshold: 0.75 })).toEqual({
        modelId: 'm1',
        confidenceThreshold: 0.75,
        maxDimensions: undefined
      });
      expect(validateLocalVisionModelConfig({ modelId: 'm1', confidenceThreshold: 1 })).toEqual({
        modelId: 'm1',
        confidenceThreshold: 1,
        maxDimensions: undefined
      });
    });

    it('should reject confidenceThreshold < 0 with RangeError', () => {
      expect(() =>
        validateLocalVisionModelConfig({ modelId: 'm1', confidenceThreshold: -0.1 })
      ).toThrow(RangeError);
      expect(() =>
        new LocalVisionAdapter({
          config: { modelId: 'm1', confidenceThreshold: -0.5 },
          inference: async () => ({ success: true, detections: [] })
        })
      ).toThrow(RangeError);
    });

    it('should reject confidenceThreshold > 1 with RangeError', () => {
      expect(() =>
        validateLocalVisionModelConfig({ modelId: 'm1', confidenceThreshold: 1.05 })
      ).toThrow(RangeError);
    });

    it('should reject non-finite confidenceThreshold (NaN, Infinity, non-number) with TypeError', () => {
      expect(() =>
        validateLocalVisionModelConfig({ modelId: 'm1', confidenceThreshold: NaN })
      ).toThrow(TypeError);
      expect(() =>
        validateLocalVisionModelConfig({ modelId: 'm1', confidenceThreshold: Infinity })
      ).toThrow(TypeError);
      expect(() =>
        validateLocalVisionModelConfig({ modelId: 'm1', confidenceThreshold: '0.5' as any })
      ).toThrow(TypeError);
    });

    it('should reject empty or whitespace modelId', () => {
      expect(() => validateLocalVisionModelConfig({ modelId: '' })).toThrow('modelId');
      expect(() => validateLocalVisionModelConfig({ modelId: '   ' })).toThrow('modelId');
    });

    it('should reject invalid maxDimensions', () => {
      expect(() =>
        validateLocalVisionModelConfig({ modelId: 'm1', maxDimensions: { width: 0, height: 100 } })
      ).toThrow('maxDimensions');
      expect(() =>
        validateLocalVisionModelConfig({ modelId: 'm1', maxDimensions: { width: 100, height: -50 } })
      ).toThrow('maxDimensions');
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 5 & E: Local inference failure converted into typed failure contract
  // -------------------------------------------------------------------------
  it('E1. should convert local inference failure result into PERCEPTION_FAILURE error', async () => {
    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: false,
        error: {
          code: 'OUT_OF_MEMORY',
          message: 'Local GPU memory allocation failed'
        }
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.code).toBe('PERCEPTION_FAILURE');
    expect(result.error.message).toBe('Local GPU memory allocation failed');
  });

  it('E2. should catch thrown exceptions in local inference and map to PERCEPTION_FAILURE', async () => {
    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: async () => {
        throw new Error('Inference runtime crashed unexpectedly');
      }
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.code).toBe('PERCEPTION_FAILURE');
    expect(result.error.message).toContain('Inference runtime crashed unexpectedly');
  });

  // -------------------------------------------------------------------------
  // Requirement 6 & F: Adapter does not make network requests
  // -------------------------------------------------------------------------
  it('F. should execute completely locally without making network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: true,
        detections: [VALID_DETECTION]
      })
    });

    const result = await adapter.perceive(VALID_INPUT);
    expect(result.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Requirement 7 & G: Raw screenshot bytes are not exposed in observations
  // -------------------------------------------------------------------------
  it('G. should guarantee raw image bytes or screenshots are never exposed in observations or metadata', async () => {
    const SENSITIVE_RAW_DATA = 'data:image/png;base64,HIGHLY_SENSITIVE_SCREENSHOT_BYTES';

    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: createFakeInference({
        success: true,
        detections: [VALID_DETECTION]
      })
    });

    const result = await adapter.perceive({
      dimensions: { width: 1280, height: 720 },
      data: SENSITIVE_RAW_DATA
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    for (const obs of result.observations) {
      const record = obs as unknown as Record<string, unknown>;
      expect(record.data).toBeUndefined();
      expect(record.bytes).toBeUndefined();
      expect(record.screenshot).toBeUndefined();
      expect(record.image).toBeUndefined();

      if (obs.metadata) {
        const metaRecord = obs.metadata as unknown as Record<string, unknown>;
        expect(metaRecord.data).toBeUndefined();
        expect(metaRecord.screenshot).toBeUndefined();
      }
    }

    // Serialized output must not contain raw image bytes
    const serialized = JSON.stringify(result.observations);
    expect(serialized).not.toContain('HIGHLY_SENSITIVE_SCREENSHOT_BYTES');
  });

  // -------------------------------------------------------------------------
  // Requirement 8 & H: Compatibility with existing VisualPerception interface
  // -------------------------------------------------------------------------
  it('H. should remain fully compatible with the VisionPerception interface', async () => {
    // Structural type checking test
    const adapter: VisionPerception = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: async () => ({
        success: true,
        detections: [VALID_DETECTION]
      })
    });

    expect(adapter.name).toBe('LocalVisionAdapter');
    expect(typeof adapter.perceive).toBe('function');

    // Polymorphic consumption function
    async function runPerceptionPipeline(engine: VisionPerception, input: VisionImageInput) {
      return engine.perceive(input);
    }

    const res = await runPerceptionPipeline(adapter, VALID_INPUT);
    expect(res.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Input dimensions validation & maxDimensions constraints
  // -------------------------------------------------------------------------
  it('should reject invalid input dimensions with INVALID_IMAGE_INPUT', async () => {
    const adapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: async () => ({ success: true, detections: [] })
    });

    const res = await adapter.perceive({
      dimensions: { width: 0, height: 600 }
    });

    expect(res.success).toBe(false);
    if (res.success) throw new Error('Expected failure');
    expect(res.error.code).toBe('INVALID_IMAGE_INPUT');
  });

  it('should reject input dimensions exceeding configured maxDimensions', async () => {
    const adapter = new LocalVisionAdapter({
      config: {
        modelId: 'fixed-res-vlm',
        maxDimensions: { width: 800, height: 600 }
      },
      inference: async () => ({ success: true, detections: [] })
    });

    const res = await adapter.perceive({
      dimensions: { width: 1024, height: 768 }
    });

    expect(res.success).toBe(false);
    if (res.success) throw new Error('Expected failure');
    expect(res.error.code).toBe('INVALID_IMAGE_INPUT');
    expect(res.error.message).toContain('exceed configured maxDimensions');
  });

  // -------------------------------------------------------------------------
  // Support for both LocalVisionInference object and standalone function
  // -------------------------------------------------------------------------
  it('should support both LocalVisionInference object and function', async () => {
    // 1. Function
    const fnAdapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: async (_input) => ({
        success: true,
        detections: [VALID_DETECTION]
      })
    });
    const res1 = await fnAdapter.perceive(VALID_INPUT);
    expect(res1.success).toBe(true);

    // 2. Object with infer()
    const objAdapter = new LocalVisionAdapter({
      config: MOCK_CONFIG,
      inference: {
        modelId: 'object-model',
        infer: async (_input) => ({
          success: true,
          detections: [VALID_DETECTION]
        })
      }
    });
    const res2 = await objAdapter.perceive(VALID_INPUT);
    expect(res2.success).toBe(true);
  });
});
