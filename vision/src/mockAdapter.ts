/**
 * Deterministic Mock and Null implementations of VisionPerception for testing and adapter foundation.
 *
 * Requirements:
 * - Completely local
 * - Deterministic
 * - No network / no API calls
 * - No ML dependencies / model downloads
 * - No screenshot logging or persistence
 * - Synthetic/test data explicitly marked
 */

import type {
  VisionImageInput,
  VisionObservation,
  VisionPerception,
  VisionPerceptionErrorCode,
  VisionPerceptionResult
} from './types.js';
import {
  validateImageInput,
  validateObservation
} from './validation.js';

/**
 * Null implementation of VisionPerception.
 * Always returns an empty detection result (zero observations) upon valid input.
 */
export class NullVisionPerception implements VisionPerception {
  readonly name = 'NullVisionPerception';

  async perceive(input: VisionImageInput): Promise<VisionPerceptionResult> {
    const validation = validateImageInput(input);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          code: validation.errorCode || 'INVALID_IMAGE_INPUT',
          message: validation.message || 'Invalid image input',
          details: validation.invalidField
            ? { invalidField: validation.invalidField }
            : undefined
        }
      };
    }

    return {
      success: true,
      observations: [],
      metadata: {
        adapterName: this.name,
        perceptionTimeMs: 0
      }
    };
  }
}

export interface MockVisionPerceptionOptions {
  /** Custom synthetic observations for deterministic consumer testing */
  syntheticObservations?: VisionObservation[];
  /** Optional simulated error code to test failure paths */
  simulatedError?: VisionPerceptionErrorCode;
  /** Optional custom error message when simulating failure */
  simulatedErrorMessage?: string;
}

/**
 * Deterministic Mock implementation of VisionPerception.
 * Returns synthetic/test observations explicitly marked as synthetic.
 */
export class MockVisionPerception implements VisionPerception {
  readonly name = 'MockVisionPerception';
  private readonly syntheticObservations: VisionObservation[];
  private readonly simulatedError?: VisionPerceptionErrorCode;
  private readonly simulatedErrorMessage?: string;

  constructor(options: MockVisionPerceptionOptions = {}) {
    this.simulatedError = options.simulatedError;
    this.simulatedErrorMessage = options.simulatedErrorMessage;

    // Validate synthetic observations if provided
    if (options.syntheticObservations) {
      this.syntheticObservations = options.syntheticObservations.map((obs) =>
        validateObservation(obs)
      );
    } else {
      // Default deterministic synthetic observations for testing
      this.syntheticObservations = [
        {
          id: 'mock-obs-1',
          label: 'button',
          text: 'Submit [SYNTHETIC]',
          boundingBox: { x: 10, y: 20, width: 100, height: 40 },
          confidence: 0.95,
          interactionHint: 'clickable',
          provenance: 'vision',
          metadata: { synthetic: true, adapterName: this.name, testLabel: 'mock-submit-button' }
        },
        {
          id: 'mock-obs-2',
          label: 'image',
          boundingBox: { x: 120, y: 20, width: 200, height: 150 },
          confidence: 0.88,
          interactionHint: 'static',
          provenance: 'vision',
          metadata: { synthetic: true, adapterName: this.name, testLabel: 'mock-hero-image' }
        }
      ];
    }
  }

  async perceive(input: VisionImageInput): Promise<VisionPerceptionResult> {
    const validation = validateImageInput(input);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          code: validation.errorCode || 'INVALID_IMAGE_INPUT',
          message: validation.message || 'Invalid image input',
          details: validation.invalidField
            ? { invalidField: validation.invalidField }
            : undefined
        }
      };
    }

    if (this.simulatedError) {
      return {
        success: false,
        error: {
          code: this.simulatedError,
          message:
            this.simulatedErrorMessage ||
            `Simulated vision perception failure (${this.simulatedError})`
        }
      };
    }

    return {
      success: true,
      observations: this.syntheticObservations.map((obs) => ({
        ...obs,
        boundingBox: { ...obs.boundingBox },
        metadata: obs.metadata ? { ...obs.metadata } : undefined
      })),
      metadata: {
        adapterName: this.name,
        synthetic: true,
        perceptionTimeMs: 1
      }
    };
  }
}
