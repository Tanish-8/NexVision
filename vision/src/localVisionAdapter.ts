/**
 * Phase 2E-1 — Real Local Vision Adapter Foundation.
 *
 * Provides a model-agnostic, local visual perception adapter that implements
 * the VisionPerception interface using a dependency-injected local inference engine.
 *
 * Invariants:
 * - Completely local execution — strictly no network requests or cloud APIs.
 * - Privacy-first: Raw screenshot/image bytes are never exposed in observations or metadata.
 * - Strict validation of bounding boxes, confidence scores, and configuration.
 * - Fully decoupled from specific ML runtimes (ONNX, PyTorch, Transformers, llama.cpp, etc.).
 */

import type {
  VisionBoundingBox,
  VisionImageDimensions,
  VisionImageInput,
  VisionInteractionHint,
  VisionObservation,
  VisionPerception,
  VisionPerceptionResult
} from './types.js';
import {
  isValidBoundingBox,
  isValidConfidence,
  isValidImageDimensions,
  validateBoundingBox,
  validateImageInput,
  validateObservation
} from './validation.js';

/**
 * Configuration structure for a local vision perception adapter.
 * Contains only minimal, essential fields.
 */
export interface LocalVisionModelConfig {
  /** Identifier or name of the local model (e.g., 'qwen2.5-vl-ui', 'local-ui-grounder') */
  modelId: string;
  /**
   * Optional minimum confidence threshold in [0, 1].
   * Detections with confidence strictly below this threshold are filtered out.
   */
  confidenceThreshold?: number;
  /** Optional maximum allowed image dimensions for the model input */
  maxDimensions?: VisionImageDimensions;
}

/**
 * Validates a LocalVisionModelConfig structure.
 * Rejects non-finite, out-of-bounds, or NaN values without silent clamping.
 */
export function validateLocalVisionModelConfig(config: unknown): LocalVisionModelConfig {
  if (!config || typeof config !== 'object') {
    throw new TypeError('Local vision model config must be an object');
  }

  const c = config as Partial<LocalVisionModelConfig>;

  if (typeof c.modelId !== 'string' || c.modelId.trim() === '') {
    throw new Error('Local vision model config modelId must be a non-empty string');
  }

  if (c.confidenceThreshold !== undefined) {
    if (typeof c.confidenceThreshold !== 'number' || !Number.isFinite(c.confidenceThreshold)) {
      throw new TypeError(
        `Invalid confidenceThreshold in config: expected a finite number, received ${typeof c.confidenceThreshold === 'number' ? c.confidenceThreshold : typeof c.confidenceThreshold}`
      );
    }
    if (c.confidenceThreshold < 0 || c.confidenceThreshold > 1) {
      throw new RangeError(
        `Invalid confidenceThreshold in config: must be between 0 and 1 inclusive, received ${c.confidenceThreshold}`
      );
    }
  }

  if (c.maxDimensions !== undefined) {
    if (!isValidImageDimensions(c.maxDimensions)) {
      throw new Error(
        'Invalid maxDimensions in config: width and height must be finite positive numbers'
      );
    }
  }

  return {
    modelId: c.modelId.trim(),
    confidenceThreshold: c.confidenceThreshold,
    maxDimensions: c.maxDimensions ? { ...c.maxDimensions } : undefined
  };
}

/**
 * Raw detection output produced by a local inference engine.
 */
export interface LocalDetectionOutput {
  /** Optional unique detection ID; if omitted, the adapter generates a deterministic sequential ID */
  id?: string;
  /** Semantic UI category label (e.g., 'button', 'link', 'input', 'text', 'icon') */
  label: string;
  /** Optional detected visual text */
  text?: string;
  /** Bounding box relative to the input image, in image pixels */
  box: VisionBoundingBox;
  /** Numeric confidence score in [0, 1] */
  confidence: number;
  /** Optional interaction capability hint */
  interactionHint?: VisionInteractionHint;
  /** Optional test or identification label (never raw image data) */
  testLabel?: string;
}

/**
 * Successful local inference outcome.
 */
export interface LocalInferenceSuccess {
  success: true;
  detections: LocalDetectionOutput[];
  inferenceTimeMs?: number;
}

/**
 * Failed local inference outcome.
 */
export interface LocalInferenceFailure {
  success: false;
  error: {
    message: string;
    code?: string;
  };
}

/**
 * Discriminated result type for local inference calls.
 */
export type LocalInferenceResult = LocalInferenceSuccess | LocalInferenceFailure;

/**
 * Interface for dependency-injected local model inference.
 */
export interface LocalVisionInference {
  readonly modelId?: string;
  infer(input: VisionImageInput): Promise<LocalInferenceResult>;
}

/**
 * Function signature alternative for dependency-injected local inference.
 */
export type LocalVisionInferenceFn = (input: VisionImageInput) => Promise<LocalInferenceResult>;

/**
 * Construction options for LocalVisionAdapter.
 */
export interface LocalVisionAdapterOptions {
  /** Model configuration */
  config: LocalVisionModelConfig;
  /** Injected local inference engine (object with infer() method or async function) */
  inference: LocalVisionInference | LocalVisionInferenceFn;
  /** Optional adapter name override; defaults to 'LocalVisionAdapter' */
  adapterName?: string;
}

/**
 * Real local vision perception adapter implementing VisionPerception.
 * Coordinates input validation, local inference dispatch, detection bounds/confidence
 * validation, threshold filtering, and privacy-safe observation mapping.
 */
export class LocalVisionAdapter implements VisionPerception {
  readonly name: string;
  private readonly config: LocalVisionModelConfig;
  private readonly inference: LocalVisionInference;

  constructor(options: LocalVisionAdapterOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('LocalVisionAdapter options must be an object');
    }
    if (!options.inference) {
      throw new Error('LocalVisionAdapter requires an inference implementation or function');
    }

    this.config = validateLocalVisionModelConfig(options.config);

    if (typeof options.inference === 'function') {
      this.inference = { infer: options.inference };
    } else if (typeof options.inference.infer === 'function') {
      this.inference = options.inference;
    } else {
      throw new TypeError('LocalVisionAdapter inference must provide an infer() function');
    }

    this.name = options.adapterName || 'LocalVisionAdapter';
  }

  /**
   * Performs visual perception on the provided image input via local inference.
   */
  async perceive(input: VisionImageInput): Promise<VisionPerceptionResult> {
    // 1. Validate image input structure and dimensions
    const inputValidation = validateImageInput(input);
    if (!inputValidation.valid) {
      return {
        success: false,
        error: {
          code: inputValidation.errorCode || 'INVALID_IMAGE_INPUT',
          message: inputValidation.message || 'Invalid image input',
          details: inputValidation.invalidField
            ? { invalidField: inputValidation.invalidField }
            : undefined
        }
      };
    }

    // 2. Check configured maxDimensions if specified
    if (this.config.maxDimensions) {
      if (
        input.dimensions.width > this.config.maxDimensions.width ||
        input.dimensions.height > this.config.maxDimensions.height
      ) {
        return {
          success: false,
          error: {
            code: 'INVALID_IMAGE_INPUT',
            message: `Image dimensions (${input.dimensions.width}x${input.dimensions.height}) exceed configured maxDimensions (${this.config.maxDimensions.width}x${this.config.maxDimensions.height})`,
            details: { invalidField: 'dimensions' }
          }
        };
      }
    }

    // 3. Dispatch to local inference engine (caught safely)
    let inferenceResult: LocalInferenceResult;
    try {
      inferenceResult = await this.inference.infer(input);
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'PERCEPTION_FAILURE',
          message: error instanceof Error ? error.message : 'Local vision inference execution failed'
        }
      };
    }

    // 4. Handle inference failure result
    if (!inferenceResult.success) {
      return {
        success: false,
        error: {
          code: 'PERCEPTION_FAILURE',
          message: inferenceResult.error?.message || 'Local vision inference returned failure'
        }
      };
    }

    // 5. Validate detections array
    if (!Array.isArray(inferenceResult.detections)) {
      return {
        success: false,
        error: {
          code: 'PERCEPTION_FAILURE',
          message: 'Local vision inference returned invalid detections: expected an array'
        }
      };
    }

    // 6. Validate and transform detections into VisionObservations
    const observations: VisionObservation[] = [];

    for (let i = 0; i < inferenceResult.detections.length; i++) {
      const detection = inferenceResult.detections[i]!;

      // Validate bounding box coordinates and image boundary overflow
      if (!isValidBoundingBox(detection.box)) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: `Detection at index ${i} contains invalid bounding box coordinates`
          }
        };
      }

      try {
        validateBoundingBox(detection.box, input.dimensions);
      } catch (boxError) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: boxError instanceof Error ? boxError.message : `Detection at index ${i} bounding box exceeds image boundary`
          }
        };
      }

      // Validate confidence score
      if (!isValidConfidence(detection.confidence)) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: `Detection at index ${i} contains invalid confidence score: ${detection.confidence}`
          }
        };
      }

      // Filter by confidence threshold if configured
      if (
        this.config.confidenceThreshold !== undefined &&
        detection.confidence < this.config.confidenceThreshold
      ) {
        continue;
      }

      // Construct privacy-first VisionObservation
      const obsId =
        typeof detection.id === 'string' && detection.id.trim() !== ''
          ? detection.id.trim()
          : `${this.config.modelId}-obs-${observations.length + 1}`;

      const rawObservation: VisionObservation = {
        id: obsId,
        label: typeof detection.label === 'string' && detection.label.trim() !== ''
          ? detection.label.trim()
          : 'unknown',
        text: detection.text,
        boundingBox: { ...detection.box },
        confidence: detection.confidence,
        interactionHint: detection.interactionHint,
        provenance: 'vision',
        metadata: {
          adapterName: this.name,
          testLabel: detection.testLabel
        }
      };

      // Strict schema and privacy validation
      try {
        const validated = validateObservation(rawObservation);
        observations.push(validated);
      } catch (obsError) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: obsError instanceof Error ? obsError.message : `Detection at index ${i} produced invalid observation`
          }
        };
      }
    }

    return {
      success: true,
      observations,
      metadata: {
        adapterName: this.name,
        perceptionTimeMs: inferenceResult.inferenceTimeMs ?? 0
      }
    };
  }
}
