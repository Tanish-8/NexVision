/**
 * Entry point for NexVision Vision Perception Interface & Adapters (Phase 2B).
 */

export type {
  VisionBoundingBox,
  VisionInteractionHint,
  VisionObservationMetadata,
  VisionObservation,
  VisionImageDimensions,
  VisionImageInput,
  VisionPerceptionErrorCode,
  VisionPerceptionErrorDetails,
  VisionPerceptionError,
  VisionPerceptionSuccessMetadata,
  VisionPerceptionSuccessResult,
  VisionPerceptionFailureResult,
  VisionPerceptionResult,
  VisionPerception
} from './types.js';

export {
  isValidConfidence,
  validateConfidence,
  isValidBoundingBox,
  validateBoundingBox,
  isValidImageDimensions,
  isSupportedImageData,
  validateImageInput,
  validateObservation
} from './validation.js';

export {
  NullVisionPerception,
  MockVisionPerception,
  type MockVisionPerceptionOptions
} from './mockAdapter.js';

export {
  LocalVisionAdapter,
  validateLocalVisionModelConfig,
  type LocalVisionModelConfig,
  type LocalDetectionOutput,
  type LocalInferenceSuccess,
  type LocalInferenceFailure,
  type LocalInferenceResult,
  type LocalVisionInference,
  type LocalVisionInferenceFn,
  type LocalVisionAdapterOptions
} from './localVisionAdapter.js';
