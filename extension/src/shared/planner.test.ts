/**
 * Phase 3A — Planner Architecture & Contract: Comprehensive Test Suite.
 *
 * Covers all required scenarios:
 * 1. Input Invariant Validation (goal, context, options, completion, history)
 * 2. Freshness & Stale Perception Validation
 * 3. Caller Completion Gating
 * 4. Advisory Driver Contract & Error Handling
 * 5. Deterministic Rule Planner & Lexicographic Ranking
 * 6. Target Defense & Authoritative availableTargets
 * 7. Action / Role Compatibility & Interactivity
 * 8. Determinism, Referential Transparency, and Serialization
 *
 * Strictly zero Chrome APIs, zero DOM access, zero network operations.
 */

import { describe, it, expect } from 'vitest';
import {
  planNextStep,
  validatePlannerInput,
  validateActionRoleCompatibility,
  DeterministicRulePlanner,
  DEFAULT_MAX_PERCEPTION_AGE_MS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_STRICT_ROLE_MATCHING
} from './planner.js';
import type {
  PlannerGoal,
  PlannerContext,
  PlannerOptions,
  PlannerInput,
  PlannerDriver,
  AdvisoryProposalResult,
  AdvisoryStepProposal
} from './planner.js';
import type { PageElement, PageRepresentation } from './types.js';
import type { ActionTarget } from './actions.js';
import type { GroundingResult } from './grounding.js';

// ---------------------------------------------------------------------------
// Test Fixture Factories
// ---------------------------------------------------------------------------

function createMockPageElement(overrides?: Partial<PageElement>): PageElement {
  return {
    id: 'btn-submit',
    tagName: 'button',
    role: 'button',
    visibleText: 'Submit Form',
    accessibleName: 'Submit Form',
    interactive: true,
    state: { visible: true, enabled: true, disabled: false },
    bounds: { x: 100, y: 200, width: 120, height: 40 },
    ...overrides
  };
}

function createMockActionTarget(overrides?: Partial<ActionTarget>): ActionTarget {
  return {
    elementId: 'btn-submit',
    point: { x: 160, y: 220 },
    viewportBounds: { x: 100, y: 200, width: 120, height: 40 },
    confidence: 0.95,
    observationId: 'obs-001',
    role: 'button',
    ...overrides
  };
}

function createMockPage(elements: PageElement[] = [createMockPageElement()]): PageRepresentation {
  return {
    schemaVersion: '1.0',
    metadata: { url: 'https://example.com/checkout', title: 'Checkout Page' },
    viewport: { width: 1280, height: 720 },
    elements
  };
}

function createMockPlannerInput(overrides?: {
  goal?: Partial<PlannerGoal>;
  context?: Partial<PlannerContext>;
  options?: Partial<PlannerOptions>;
}): PlannerInput {
  const defaultGoal: PlannerGoal = {
    id: 'goal-checkout-1',
    description: 'Click the submit form button',
    intent: 'click',
    targetHint: 'submit'
  };

  const defaultContext: PlannerContext = {
    page: createMockPage(),
    availableTargets: [createMockActionTarget()],
    capturedAt: 1000,
    currentTime: 2000,
    stepIndex: 0
  };

  return {
    goal: { ...defaultGoal, ...overrides?.goal },
    context: { ...defaultContext, ...overrides?.context },
    ...(overrides?.options !== undefined ? { options: overrides.options } : {})
  };
}

// ---------------------------------------------------------------------------
// 1. Input Invariant Validation
// ---------------------------------------------------------------------------

describe('PlannerInput Invariants Validation', () => {
  it('1. missing/empty goal.id is rejected with INVALID_INPUT', async () => {
    const input = createMockPlannerInput({ goal: { id: '' } });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('goal.id');
    }
  });

  it('2. missing/empty goal.description is rejected with INVALID_INPUT', async () => {
    const input = createMockPlannerInput({ goal: { description: '' } });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('goal.description');
    }
  });

  it('3. invalid goal.intent is rejected with INVALID_INPUT', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = createMockPlannerInput({ goal: { intent: 'invalid_intent' as any } });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('goal.intent');
    }
  });

  it('4. invalid goal.parameters (non-string values) is rejected with INVALID_INPUT', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = createMockPlannerInput({ goal: { parameters: { count: 42 as any } } });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('parameters');
    }
  });

  it('5. empty targetHint is rejected with INVALID_INPUT', async () => {
    const input = createMockPlannerInput({ goal: { targetHint: '' } });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('targetHint');
    }
  });

  it('6. missing or invalid context.page is rejected with INVALID_INPUT', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = createMockPlannerInput({ context: { page: null as any } });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('context.page');
    }
  });

  it('7. invalid context.availableTargets (non-array or malformed item) is rejected with INVALID_INPUT', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = createMockPlannerInput({ context: { availableTargets: [{ bad: true } as any] } });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('availableTargets');
    }
  });

  it('rejects target with non-finite point.x or point.y', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targetBadX = createMockActionTarget({ point: { x: Number.NaN, y: 100 } });
    const inputX = createMockPlannerInput({ context: { availableTargets: [targetBadX] } });
    const resultX = await planNextStep(inputX);
    expect(resultX.status).toBe('FAILED');
    if (resultX.status === 'FAILED') {
      expect(resultX.reason).toBe('INVALID_INPUT');
      expect(resultX.message).toContain('point.x');
    }

    const targetBadY = createMockActionTarget({ point: { x: 100, y: Number.POSITIVE_INFINITY } });
    const inputY = createMockPlannerInput({ context: { availableTargets: [targetBadY] } });
    const resultY = await planNextStep(inputY);
    expect(resultY.status).toBe('FAILED');
    if (resultY.status === 'FAILED') {
      expect(resultY.reason).toBe('INVALID_INPUT');
      expect(resultY.message).toContain('point.y');
    }
  });

  it('rejects target with non-finite viewportBounds coordinates (x, y)', async () => {
    const targetBadX = createMockActionTarget({
      viewportBounds: { x: Number.NaN, y: 50, width: 100, height: 40 }
    });
    const inputX = createMockPlannerInput({ context: { availableTargets: [targetBadX] } });
    const resultX = await planNextStep(inputX);
    expect(resultX.status).toBe('FAILED');
    if (resultX.status === 'FAILED') {
      expect(resultX.reason).toBe('INVALID_INPUT');
      expect(resultX.message).toContain('viewportBounds.x');
    }

    const targetBadY = createMockActionTarget({
      viewportBounds: { x: 50, y: Number.POSITIVE_INFINITY, width: 100, height: 40 }
    });
    const inputY = createMockPlannerInput({ context: { availableTargets: [targetBadY] } });
    const resultY = await planNextStep(inputY);
    expect(resultY.status).toBe('FAILED');
    if (resultY.status === 'FAILED') {
      expect(resultY.reason).toBe('INVALID_INPUT');
      expect(resultY.message).toContain('viewportBounds.y');
    }
  });

  it('rejects target with zero or negative viewportBounds width/height', async () => {
    const targetZeroW = createMockActionTarget({
      viewportBounds: { x: 0, y: 0, width: 0, height: 40 }
    });
    const inputZeroW = createMockPlannerInput({ context: { availableTargets: [targetZeroW] } });
    const resultZeroW = await planNextStep(inputZeroW);
    expect(resultZeroW.status).toBe('FAILED');
    if (resultZeroW.status === 'FAILED') {
      expect(resultZeroW.reason).toBe('INVALID_INPUT');
      expect(resultZeroW.message).toContain('viewportBounds.width');
    }

    const targetNegH = createMockActionTarget({
      viewportBounds: { x: 0, y: 0, width: 100, height: -5 }
    });
    const inputNegH = createMockPlannerInput({ context: { availableTargets: [targetNegH] } });
    const resultNegH = await planNextStep(inputNegH);
    expect(resultNegH.status).toBe('FAILED');
    if (resultNegH.status === 'FAILED') {
      expect(resultNegH.reason).toBe('INVALID_INPUT');
      expect(resultNegH.message).toContain('viewportBounds.height');
    }
  });

  it('rejects target with confidence outside [0, 1] or non-finite', async () => {
    const targetNegConf = createMockActionTarget({ confidence: -0.05 });
    const inputNeg = createMockPlannerInput({ context: { availableTargets: [targetNegConf] } });
    const resultNeg = await planNextStep(inputNeg);
    expect(resultNeg.status).toBe('FAILED');
    if (resultNeg.status === 'FAILED') {
      expect(resultNeg.reason).toBe('INVALID_INPUT');
      expect(resultNeg.message).toContain('confidence');
    }

    const targetOverConf = createMockActionTarget({ confidence: 1.05 });
    const inputOver = createMockPlannerInput({ context: { availableTargets: [targetOverConf] } });
    const resultOver = await planNextStep(inputOver);
    expect(resultOver.status).toBe('FAILED');
    if (resultOver.status === 'FAILED') {
      expect(resultOver.reason).toBe('INVALID_INPUT');
      expect(resultOver.message).toContain('confidence');
    }

    const targetNaNConf = createMockActionTarget({ confidence: Number.NaN });
    const inputNaN = createMockPlannerInput({ context: { availableTargets: [targetNaNConf] } });
    const resultNaN = await planNextStep(inputNaN);
    expect(resultNaN.status).toBe('FAILED');
    if (resultNaN.status === 'FAILED') {
      expect(resultNaN.reason).toBe('INVALID_INPUT');
      expect(resultNaN.message).toContain('confidence');
    }
  });

  it('rejects malformed history entries in PlannerInput', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputNullStep = { ...createMockPlannerInput(), history: [null as any] };
    expect(validatePlannerInput(inputNullStep)).toContain('history[0] must be a non-null object');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputNegIndex = { ...createMockPlannerInput(), history: [{ stepIndex: -1, action: {} } as any] };
    expect(validatePlannerInput(inputNegIndex)).toContain('stepIndex must be a non-negative integer');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputMissingAction = { ...createMockPlannerInput(), history: [{ stepIndex: 0, action: null as any }] };
    expect(validatePlannerInput(inputMissingAction)).toContain('action must be a non-null object');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputEmptyActionId = { ...createMockPlannerInput(), history: [{ stepIndex: 0, action: { id: '', type: 'click' } as any }] };
    expect(validatePlannerInput(inputEmptyActionId)).toContain('action.id must be a non-empty string');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputInvalidActionType = { ...createMockPlannerInput(), history: [{ stepIndex: 0, action: { id: 'act-1', type: 'hover' } as any }] };
    expect(validatePlannerInput(inputInvalidActionType)).toContain('action.type must be a valid action type');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputInvalidOutcome = { ...createMockPlannerInput(), history: [{ stepIndex: 0, action: { id: 'act-1', type: 'click' }, perceivedOutcome: 'exploded' as any }] };
    expect(validatePlannerInput(inputInvalidOutcome)).toContain('perceivedOutcome must be');
  });

  it('8. invalid context.capturedAt (negative or non-finite) is rejected with INVALID_INPUT', async () => {
    const inputNegative = createMockPlannerInput({ context: { capturedAt: -100 } });
    const resultNeg = await planNextStep(inputNegative);
    expect(resultNeg.status).toBe('FAILED');
    if (resultNeg.status === 'FAILED') {
      expect(resultNeg.reason).toBe('INVALID_INPUT');
    }

    const inputNaN = createMockPlannerInput({ context: { capturedAt: Number.NaN } });
    const resultNaN = await planNextStep(inputNaN);
    expect(resultNaN.status).toBe('FAILED');
    if (resultNaN.status === 'FAILED') {
      expect(resultNaN.reason).toBe('INVALID_INPUT');
    }
  });

  it('9. invalid context.currentTime (non-finite) is rejected with INVALID_INPUT', async () => {
    const inputInf = createMockPlannerInput({ context: { currentTime: Number.POSITIVE_INFINITY } });
    const resultInf = await planNextStep(inputInf);
    expect(resultInf.status).toBe('FAILED');
    if (resultInf.status === 'FAILED') {
      expect(resultInf.reason).toBe('INVALID_INPUT');
    }
  });

  it('10. currentTime < capturedAt is rejected with INVALID_INPUT', async () => {
    const inputTimeTravel = createMockPlannerInput({
      context: { capturedAt: 5000, currentTime: 4000 }
    });
    const result = await planNextStep(inputTimeTravel);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('cannot be before');
    }
  });

  it('11. invalid context.stepIndex (negative or float) is rejected with INVALID_INPUT', async () => {
    const inputFloat = createMockPlannerInput({ context: { stepIndex: 1.5 } });
    const resultFloat = await planNextStep(inputFloat);
    expect(resultFloat.status).toBe('FAILED');
    if (resultFloat.status === 'FAILED') {
      expect(resultFloat.reason).toBe('INVALID_INPUT');
    }

    const inputNeg = createMockPlannerInput({ context: { stepIndex: -1 } });
    const resultNeg = await planNextStep(inputNeg);
    expect(resultNeg.status).toBe('FAILED');
    if (resultNeg.status === 'FAILED') {
      expect(resultNeg.reason).toBe('INVALID_INPUT');
    }
  });

  it('12. invalid options.minConfidence (out of [0, 1]) is rejected with INVALID_INPUT', async () => {
    const inputLow = createMockPlannerInput({ options: { minConfidence: -0.1 } });
    const resultLow = await planNextStep(inputLow);
    expect(resultLow.status).toBe('FAILED');
    if (resultLow.status === 'FAILED') {
      expect(resultLow.reason).toBe('INVALID_INPUT');
    }

    const inputHigh = createMockPlannerInput({ options: { minConfidence: 1.5 } });
    const resultHigh = await planNextStep(inputHigh);
    expect(resultHigh.status).toBe('FAILED');
    if (resultHigh.status === 'FAILED') {
      expect(resultHigh.reason).toBe('INVALID_INPUT');
    }
  });

  it('13. invalid options.maxPerceptionAgeMs (negative or non-finite) is rejected with INVALID_INPUT', async () => {
    const input = createMockPlannerInput({ options: { maxPerceptionAgeMs: -50 } });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('maxPerceptionAgeMs');
    }
  });

  it('validates non-object input as INVALID_INPUT', () => {
    expect(validatePlannerInput(null)).toContain('must be a non-null object');
    expect(validatePlannerInput('string')).toContain('must be a non-null object');
  });
});

// ---------------------------------------------------------------------------
// 2. Freshness & Stale Perception
// ---------------------------------------------------------------------------

describe('Freshness & Perception Staleness', () => {
  it('14. valid below max age proceeds to planning', async () => {
    const input = createMockPlannerInput({
      context: { capturedAt: 1000, currentTime: 4000 },
      options: { maxPerceptionAgeMs: 5000 }
    });
    const result = await planNextStep(input);
    expect(result.status).toBe('ACTION');
  });

  it('15. stale above max age fails with STALE_PERCEPTION', async () => {
    const input = createMockPlannerInput({
      context: { capturedAt: 1000, currentTime: 7000 },
      options: { maxPerceptionAgeMs: 5000 }
    });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('STALE_PERCEPTION');
      expect(result.message).toContain('stale');
    }
  });

  it('16. exact boundary (currentTime - capturedAt === maxPerceptionAgeMs) is accepted', async () => {
    const input = createMockPlannerInput({
      context: { capturedAt: 1000, currentTime: 6000 },
      options: { maxPerceptionAgeMs: 5000 }
    });
    const result = await planNextStep(input);
    expect(result.status).toBe('ACTION');
  });

  it('uses default maxPerceptionAgeMs (10000ms) when omitted', async () => {
    const inputStaleDefault = createMockPlannerInput({
      context: { capturedAt: 1000, currentTime: 11001 }
    });
    const resultStale = await planNextStep(inputStaleDefault);
    expect(resultStale.status).toBe('FAILED');
    if (resultStale.status === 'FAILED') {
      expect(resultStale.reason).toBe('STALE_PERCEPTION');
    }

    const inputFreshDefault = createMockPlannerInput({
      context: { capturedAt: 1000, currentTime: 11000 }
    });
    const resultFresh = await planNextStep(inputFreshDefault);
    expect(resultFresh.status).toBe('ACTION');
  });
});

// ---------------------------------------------------------------------------
// 3. Caller Completion Gating
// ---------------------------------------------------------------------------

describe('Completion Gating', () => {
  it('17. completion.satisfied=true returns COMPLETED immediately without invoking driver', async () => {
    let driverInvoked = false;
    const mockDriver: PlannerDriver = {
      name: 'SpyDriver',
      proposeStep: () => {
        driverInvoked = true;
        return { status: 'FAILED', reason: 'Should not be called' };
      }
    };

    const input = createMockPlannerInput({
      context: {
        completion: { satisfied: true, summary: 'Already checked out successfully' }
      }
    });

    const result = await planNextStep(input, mockDriver);
    expect(driverInvoked).toBe(false);
    expect(result.status).toBe('COMPLETED');
    if (result.status === 'COMPLETED') {
      expect(result.summary).toBe('Already checked out successfully');
      expect(result.planId).toBe('plan_goal-checkout-1_step_0');
    }
  });

  it('18. completion.satisfied=false or undefined proceeds to driver', async () => {
    let driverInvoked = false;
    const mockDriver: PlannerDriver = {
      name: 'SpyDriver',
      proposeStep: () => {
        driverInvoked = true;
        return { status: 'COMPLETED', summary: 'Driver completed' };
      }
    };

    const input = createMockPlannerInput({
      context: { completion: { satisfied: false } }
    });

    const result = await planNextStep(input, mockDriver);
    expect(driverInvoked).toBe(true);
    expect(result.status).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------------------
// 4. Advisory Driver Contract & Error Handling
// ---------------------------------------------------------------------------

describe('Advisory Driver Contract', () => {
  it('19. driver FAILED maps to MODEL_ERROR (or specific domain failure)', async () => {
    const failingDriver: PlannerDriver = {
      name: 'FailingDriver',
      proposeStep: () => ({ status: 'FAILED', reason: 'Internal reasoning breakdown' })
    };

    const input = createMockPlannerInput();
    const result = await planNextStep(input, failingDriver);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toBe('Internal reasoning breakdown');
    }
  });

  it('20. driver COMPLETED returns COMPLETED with summary', async () => {
    const completingDriver: PlannerDriver = {
      name: 'CompletingDriver',
      proposeStep: () => ({ status: 'COMPLETED', summary: 'Goal achieved in step' })
    };

    const input = createMockPlannerInput();
    const result = await planNextStep(input, completingDriver);
    expect(result.status).toBe('COMPLETED');
    if (result.status === 'COMPLETED') {
      expect(result.summary).toBe('Goal achieved in step');
      expect(result.planId).toBe('plan_goal-checkout-1_step_0');
    }
  });

  it('21. asynchronous Promise-returning driver is supported', async () => {
    const asyncDriver: PlannerDriver = {
      name: 'AsyncDriver',
      proposeStep: async () => {
        // Asynchronous resolution
        await Promise.resolve();
        return {
          status: 'ACTION',
          proposal: {
            targetElementId: 'btn-submit',
            actionType: 'click',
            rationale: 'Async proposal'
          }
        };
      }
    };

    const input = createMockPlannerInput();
    const result = await planNextStep(input, asyncDriver);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.targetElementId).toBe('btn-submit');
      expect(result.rationale).toBe('Async proposal');
    }
  });

  it('22. PlannerInput immutability across driver invocation protects caller state', async () => {
    const mutatingDriver: PlannerDriver = {
      name: 'MaliciousDriver',
      proposeStep: (input) => {
        // Malicious driver attempts to corrupt input fields
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyInput = input as any;
        anyInput.goal.id = 'mutated-id';
        anyInput.goal.description = 'mutated-description';
        anyInput.context.stepIndex = 999;
        anyInput.context.availableTargets.length = 0;
        return {
          status: 'ACTION',
          proposal: {
            targetElementId: 'btn-submit',
            actionType: 'click',
            rationale: 'Mutating test'
          }
        };
      }
    };

    const target = createMockActionTarget();
    const input = createMockPlannerInput({
      context: { availableTargets: [target] }
    });
    const snapshotBefore = JSON.stringify(input);

    const result = await planNextStep(input, mutatingDriver);

    // Verify caller-owned input remains strictly uncorrupted
    expect(JSON.stringify(input)).toBe(snapshotBefore);
    expect(input.goal.id).toBe('goal-checkout-1');
    expect(input.context.stepIndex).toBe(0);
    expect(input.context.availableTargets).toHaveLength(1);

    // Verify planner produced deterministic planId based on original validated planning state
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.planId).toBe('plan_goal-checkout-1_step_0');
      expect(result.targetElementId).toBe('btn-submit');
    }
  });

  it('driver throwing exception is caught and returns MODEL_ERROR', async () => {
    const throwingDriver: PlannerDriver = {
      name: 'ThrowingDriver',
      proposeStep: () => {
        throw new Error('Crash in model provider');
      }
    };

    const input = createMockPlannerInput();
    const result = await planNextStep(input, throwingDriver);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('Crash in model provider');
    }
  });

  it('driver returning malformed proposal returns MODEL_ERROR', async () => {
    const malformedDriver: PlannerDriver = {
      name: 'MalformedDriver',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proposeStep: () => ({ status: 'ACTION', proposal: null as any })
    };

    const input = createMockPlannerInput();
    const result = await planNextStep(input, malformedDriver);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('malformed');
    }
  });

  it('driver proposing invalid actionType returns MODEL_ERROR', async () => {
    const invalidTypeDriver: PlannerDriver = {
      name: 'InvalidTypeDriver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'btn-submit',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          actionType: 'drag' as any,
          rationale: 'Invalid action type'
        }
      })
    };

    const input = createMockPlannerInput();
    const result = await planNextStep(input, invalidTypeDriver);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('invalid actionType');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Deterministic Rule Planner & Lexicographic Ranking
// ---------------------------------------------------------------------------

describe('Deterministic Rule Planner & Lexicographic Ranking', () => {
  it('23. targetHint matching accessibleName / id wins highest priority', async () => {
    const elemA = createMockPageElement({
      id: 'btn-cancel',
      role: 'button',
      accessibleName: 'Cancel Order',
      visibleText: 'Cancel'
    });
    const elemB = createMockPageElement({
      id: 'btn-confirm',
      role: 'button',
      accessibleName: 'Confirm Order',
      visibleText: 'Confirm'
    });

    const targetA = createMockActionTarget({ elementId: 'btn-cancel', confidence: 0.99 });
    const targetB = createMockActionTarget({ elementId: 'btn-confirm', confidence: 0.50 });

    const input = createMockPlannerInput({
      goal: {
        id: 'g-confirm',
        description: 'Please order',
        intent: 'click',
        targetHint: 'confirm' // Explicitly hints at elemB
      },
      context: {
        page: createMockPage([elemA, elemB]),
        availableTargets: [targetA, targetB]
      }
    });

    const result = await planNextStep(input);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.targetElementId).toBe('btn-confirm');
    }
  });

  it('24. semantic role priority prefers role matching goal.intent', async () => {
    const inputElem = createMockPageElement({
      id: 'input-search',
      role: 'textbox',
      tagName: 'input',
      accessibleName: 'Search Products',
      visibleText: ''
    });
    const buttonElem = createMockPageElement({
      id: 'btn-search',
      role: 'button',
      tagName: 'button',
      accessibleName: 'Search Products',
      visibleText: 'Search'
    });

    const targetInput = createMockActionTarget({ elementId: 'input-search', confidence: 0.8 });
    const targetButton = createMockActionTarget({ elementId: 'btn-search', confidence: 0.8 });

    // When goal intent is 'type', textbox should win over button
    const typeInput = createMockPlannerInput({
      goal: {
        id: 'g-type',
        description: 'Search products',
        intent: 'type',
        parameters: { text: 'laptop' }
      },
      context: {
        page: createMockPage([buttonElem, inputElem]),
        availableTargets: [targetButton, targetInput]
      }
    });

    const typeResult = await planNextStep(typeInput);
    expect(typeResult.status).toBe('ACTION');
    if (typeResult.status === 'ACTION') {
      expect(typeResult.targetElementId).toBe('input-search');
      expect(typeResult.action.type).toBe('type');
    }
  });

  it('25. description token matches candidate with higher count', async () => {
    const elemA = createMockPageElement({
      id: 'btn-checkout-guest',
      role: 'button',
      accessibleName: 'Checkout as Guest',
      visibleText: 'Guest Checkout'
    });
    const elemB = createMockPageElement({
      id: 'btn-checkout-express-vip',
      role: 'button',
      accessibleName: 'Express VIP Member Checkout Now',
      visibleText: 'Express VIP Checkout'
    });

    const targetA = createMockActionTarget({ elementId: 'btn-checkout-guest', confidence: 0.9 });
    const targetB = createMockActionTarget({ elementId: 'btn-checkout-express-vip', confidence: 0.9 });

    const input = createMockPlannerInput({
      goal: {
        id: 'g-express',
        description: 'Click express vip member checkout',
        intent: 'click'
      },
      context: {
        page: createMockPage([elemA, elemB]),
        availableTargets: [targetA, targetB]
      }
    });

    const result = await planNextStep(input);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.targetElementId).toBe('btn-checkout-express-vip');
    }
  });

  it('26. deterministic lexical elementId tie-break when scores are identical', async () => {
    const elemZ = createMockPageElement({
      id: 'z-elem',
      role: 'button',
      accessibleName: 'Action Item',
      visibleText: 'Action'
    });
    const elemA = createMockPageElement({
      id: 'a-elem',
      role: 'button',
      accessibleName: 'Action Item',
      visibleText: 'Action'
    });

    const targetZ = createMockActionTarget({ elementId: 'z-elem', confidence: 0.9 });
    const targetA = createMockActionTarget({ elementId: 'a-elem', confidence: 0.9 });

    // Both match token 'action' equally, same role priority, same confidence
    // 'a-elem'.localeCompare('z-elem') < 0, so 'a-elem' MUST win
    const input = createMockPlannerInput({
      goal: { id: 'g-tie', description: 'Action item', intent: 'click' },
      context: {
        page: createMockPage([elemZ, elemA]),
        availableTargets: [targetZ, targetA]
      }
    });

    const result = await planNextStep(input);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.targetElementId).toBe('a-elem');
    }
  });

  it('27. NO_FEASIBLE_TARGET when no candidates have relevance or availableTargets is empty', async () => {
    const inputEmpty = createMockPlannerInput({
      context: { availableTargets: [] }
    });
    const resultEmpty = await planNextStep(inputEmpty);
    expect(resultEmpty.status).toBe('FAILED');
    if (resultEmpty.status === 'FAILED') {
      expect(resultEmpty.reason).toBe('NO_FEASIBLE_TARGET');
    }

    const elemIrrelevant = createMockPageElement({
      id: 'elem-header',
      role: 'heading',
      accessibleName: 'Header Banner',
      visibleText: 'Header'
    });
    const targetIrrelevant = createMockActionTarget({
      elementId: 'elem-header',
      role: 'heading'
    });
    const inputIrrelevant = createMockPlannerInput({
      goal: { id: 'g-unrelated', description: 'Search shopping cart', intent: 'type' },
      context: {
        page: createMockPage([elemIrrelevant]),
        availableTargets: [targetIrrelevant]
      }
    });
    const resultIrrelevant = await planNextStep(inputIrrelevant);
    expect(resultIrrelevant.status).toBe('FAILED');
    if (resultIrrelevant.status === 'FAILED') {
      expect(resultIrrelevant.reason).toBe('NO_FEASIBLE_TARGET');
    }
  });

  it('28. LOW_CONFIDENCE when best candidate confidence is below minConfidence', async () => {
    const targetLowConf = createMockActionTarget({ confidence: 0.35 });
    const input = createMockPlannerInput({
      context: { availableTargets: [targetLowConf] },
      options: { minConfidence: 0.7 }
    });

    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('LOW_CONFIDENCE');
      expect(result.message).toContain('threshold');
    }
  });

  it('unsupported goal intent returns UNSUPPORTED_GOAL', async () => {
    const input = createMockPlannerInput({
      goal: { id: 'g-nav', description: 'Navigate to google.com', intent: 'navigate' }
    });
    const result = await planNextStep(input);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('UNSUPPORTED_GOAL');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Target Defense & Authoritative availableTargets
// ---------------------------------------------------------------------------

describe('Target Defense & Authority', () => {
  it('29. UNKNOWN_TARGET_ELEMENT when driver proposes nonexistent elementId', async () => {
    const rogueDriver: PlannerDriver = {
      name: 'RogueDriver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'nonexistent-element-999',
          actionType: 'click',
          rationale: 'Hallucinated target'
        }
      })
    };

    const input = createMockPlannerInput();
    const result = await planNextStep(input, rogueDriver);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('UNKNOWN_TARGET_ELEMENT');
      expect(result.message).toContain('nonexistent-element-999');
    }
  });

  it('30. groundingResults cannot bypass availableTargets', async () => {
    const grounding: GroundingResult = {
      matched: true,
      elementId: 'ghost-element',
      observationId: 'obs-ghost',
      normalizedCssBox: { x: 50, y: 50, width: 100, height: 30 },
      groundingConfidence: 0.99,
      scoreBreakdown: {
        iou: 0.9,
        visualContainment: 0.9,
        elementContainment: 0.9,
        centerProximity: 0.9,
        isVisualCenterInsideDom: true,
        geometricScore: 0.9,
        semanticScore: 1.0,
        interactivityScore: 1.0,
        totalScore: 0.95
      }
    };

    const driverProposingGhost: PlannerDriver = {
      name: 'GhostDriver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'ghost-element',
          actionType: 'click',
          rationale: 'Target from grounding'
        }
      })
    };

    const input = createMockPlannerInput({
      context: {
        availableTargets: [createMockActionTarget({ elementId: 'real-element' })],
        groundingResults: [grounding]
      }
    });

    const result = await planNextStep(input, driverProposingGhost);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('UNKNOWN_TARGET_ELEMENT');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Action / Role Compatibility & Interactivity
// ---------------------------------------------------------------------------

describe('Action & Role Compatibility', () => {
  it('31. type on button or image is rejected with INCOMPATIBLE_ACTION_FOR_ROLE', async () => {
    const btnElem = createMockPageElement({ id: 'btn-1', role: 'button' });
    const imgElem = createMockPageElement({ id: 'img-1', role: 'image', tagName: 'img' });
    const targetBtn = createMockActionTarget({ elementId: 'btn-1', role: 'button' });
    const targetImg = createMockActionTarget({ elementId: 'img-1', role: 'image' });

    const driverTypeOnButton: PlannerDriver = {
      name: 'Driver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'btn-1',
          actionType: 'type',
          payload: { text: 'hello' },
          rationale: 'Type on button'
        }
      })
    };

    const input = createMockPlannerInput({
      context: {
        page: createMockPage([btnElem, imgElem]),
        availableTargets: [targetBtn, targetImg]
      }
    });

    const resultBtn = await planNextStep(input, driverTypeOnButton);
    expect(resultBtn.status).toBe('FAILED');
    if (resultBtn.status === 'FAILED') {
      expect(resultBtn.reason).toBe('INCOMPATIBLE_ACTION_FOR_ROLE');
    }

    const driverTypeOnImage: PlannerDriver = {
      name: 'Driver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'img-1',
          actionType: 'type',
          payload: { text: 'hello' },
          rationale: 'Type on image'
        }
      })
    };

    const resultImg = await planNextStep(input, driverTypeOnImage);
    expect(resultImg.status).toBe('FAILED');
    if (resultImg.status === 'FAILED') {
      expect(resultImg.reason).toBe('INCOMPATIBLE_ACTION_FOR_ROLE');
    }
  });

  it('32. disabled element is rejected with INCOMPATIBLE_ACTION_FOR_ROLE', async () => {
    const disabledBtn = createMockPageElement({
      id: 'btn-disabled',
      role: 'button',
      state: { disabled: true, enabled: false }
    });
    const target = createMockActionTarget({ elementId: 'btn-disabled' });

    const driver: PlannerDriver = {
      name: 'Driver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'btn-disabled',
          actionType: 'click',
          rationale: 'Click disabled button'
        }
      })
    };

    const input = createMockPlannerInput({
      context: {
        page: createMockPage([disabledBtn]),
        availableTargets: [target]
      }
    });

    const result = await planNextStep(input, driver);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INCOMPATIBLE_ACTION_FOR_ROLE');
      expect(result.message).toContain('disabled');
    }
  });

  it('non-interactive element (interactive: false) is rejected with INCOMPATIBLE_ACTION_FOR_ROLE', async () => {
    const nonInteractiveBtn = createMockPageElement({
      id: 'btn-static',
      role: 'button',
      interactive: false
    });
    const target = createMockActionTarget({ elementId: 'btn-static' });

    const driver: PlannerDriver = {
      name: 'Driver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'btn-static',
          actionType: 'click',
          rationale: 'Click non-interactive button'
        }
      })
    };

    const input = createMockPlannerInput({
      context: {
        page: createMockPage([nonInteractiveBtn]),
        availableTargets: [target]
      }
    });

    const result = await planNextStep(input, driver);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INCOMPATIBLE_ACTION_FOR_ROLE');
      expect(result.message).toContain('interactive: false');
    }
  });

  it('ActionTarget without corresponding PageElement in context.page.elements is rejected with INCOMPATIBLE_ACTION_FOR_ROLE', async () => {
    const targetOrphan = createMockActionTarget({ elementId: 'elem-orphan', role: 'button' });
    const pageExistingElem = createMockPageElement({ id: 'elem-existing', role: 'button' });

    // 1. Direct unit test of validateActionRoleCompatibility
    const comp = validateActionRoleCompatibility(undefined, targetOrphan, 'click', false);
    expect(comp.compatible).toBe(false);
    expect(comp.message).toContain('has no corresponding PageElement in context.page.elements');

    // 2. Integration test in planNextStep
    const driverProposingOrphan: PlannerDriver = {
      name: 'Driver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'elem-orphan',
          actionType: 'click',
          rationale: 'Click target with no PageElement'
        }
      })
    };

    const input = createMockPlannerInput({
      context: {
        page: createMockPage([pageExistingElem]),
        availableTargets: [targetOrphan]
      }
    });

    const result = await planNextStep(input, driverProposingOrphan);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INCOMPATIBLE_ACTION_FOR_ROLE');
      expect(result.message).toContain('has no corresponding PageElement in context.page.elements');
    }
  });

  it('33. strict vs non-strict unknown role behavior', async () => {
    const unknownElem = createMockPageElement({
      id: 'elem-custom',
      role: 'unknown',
      interactive: true
    });
    const target = createMockActionTarget({ elementId: 'elem-custom', role: 'unknown' });

    const driver: PlannerDriver = {
      name: 'Driver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'elem-custom',
          actionType: 'click',
          rationale: 'Click unknown role'
        }
      })
    };

    // Strict mode rejects unknown role
    const inputStrict = createMockPlannerInput({
      context: {
        page: createMockPage([unknownElem]),
        availableTargets: [target]
      },
      options: { strictRoleMatching: true }
    });

    const resultStrict = await planNextStep(inputStrict, driver);
    expect(resultStrict.status).toBe('FAILED');
    if (resultStrict.status === 'FAILED') {
      expect(resultStrict.reason).toBe('INCOMPATIBLE_ACTION_FOR_ROLE');
    }

    // Non-strict mode allows click on interactive unknown element
    const inputNonStrict = createMockPlannerInput({
      context: {
        page: createMockPage([unknownElem]),
        availableTargets: [target]
      },
      options: { strictRoleMatching: false }
    });

    const resultNonStrict = await planNextStep(inputNonStrict, driver);
    expect(resultNonStrict.status).toBe('ACTION');
  });

  it('type on contenteditable element in non-strict mode succeeds', async () => {
    const editorElem = createMockPageElement({
      id: 'div-editor',
      role: 'generic',
      interactive: true,
      attributes: { contenteditable: 'true' }
    });
    const target = createMockActionTarget({ elementId: 'div-editor', role: 'generic' });

    const driver: PlannerDriver = {
      name: 'Driver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'div-editor',
          actionType: 'type',
          payload: { text: 'rich text content' },
          rationale: 'Type into contenteditable'
        }
      })
    };

    const input = createMockPlannerInput({
      context: {
        page: createMockPage([editorElem]),
        availableTargets: [target]
      },
      options: { strictRoleMatching: false }
    });

    const result = await planNextStep(input, driver);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.action.type).toBe('type');
      if (result.action.type === 'type') {
        expect(result.action.payload.text).toBe('rich text content');
      }
    }
  });

  it('34. valid click, type, and focus actions pass Phase 2F-3 validation', async () => {
    // 1. Click
    const clickElem = createMockPageElement({ id: 'btn-click', role: 'button' });
    const clickTarget = createMockActionTarget({ elementId: 'btn-click' });
    const clickDriver: PlannerDriver = {
      name: 'ClickDriver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: { targetElementId: 'btn-click', actionType: 'click', rationale: 'Click' }
      })
    };
    const clickResult = await planNextStep(
      createMockPlannerInput({
        context: { page: createMockPage([clickElem]), availableTargets: [clickTarget] }
      }),
      clickDriver
    );
    expect(clickResult.status).toBe('ACTION');
    if (clickResult.status === 'ACTION') {
      expect(clickResult.action.type).toBe('click');
      expect(clickResult.action.id).toBe(`intent_${clickTarget.observationId}_click`);
    }

    // 2. Type
    const typeElem = createMockPageElement({ id: 'input-text', role: 'textbox' });
    const typeTarget = createMockActionTarget({ elementId: 'input-text', role: 'textbox' });
    const typeDriver: PlannerDriver = {
      name: 'TypeDriver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'input-text',
          actionType: 'type',
          payload: { text: 'my search query', clearFirst: true, pressEnter: true },
          rationale: 'Type'
        }
      })
    };
    const typeResult = await planNextStep(
      createMockPlannerInput({
        context: { page: createMockPage([typeElem]), availableTargets: [typeTarget] }
      }),
      typeDriver
    );
    expect(typeResult.status).toBe('ACTION');
    if (typeResult.status === 'ACTION') {
      expect(typeResult.action.type).toBe('type');
      if (typeResult.action.type === 'type') {
        expect(typeResult.action.payload.text).toBe('my search query');
        expect(typeResult.action.payload.clearFirst).toBe(true);
        expect(typeResult.action.payload.pressEnter).toBe(true);
      }
    }

    // 3. Focus
    const focusElem = createMockPageElement({ id: 'input-focus', role: 'textbox' });
    const focusTarget = createMockActionTarget({ elementId: 'input-focus', role: 'textbox' });
    const focusDriver: PlannerDriver = {
      name: 'FocusDriver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: { targetElementId: 'input-focus', actionType: 'focus', rationale: 'Focus' }
      })
    };
    const focusResult = await planNextStep(
      createMockPlannerInput({
        context: { page: createMockPage([focusElem]), availableTargets: [focusTarget] }
      }),
      focusDriver
    );
    expect(focusResult.status).toBe('ACTION');
    if (focusResult.status === 'ACTION') {
      expect(focusResult.action.type).toBe('focus');
    }
  });

  it('INVALID_ACTION_INTENT propagated when type action missing text payload', async () => {
    const typeElem = createMockPageElement({ id: 'input-text', role: 'textbox' });
    const typeTarget = createMockActionTarget({ elementId: 'input-text', role: 'textbox' });
    const driverMissingText: PlannerDriver = {
      name: 'Driver',
      proposeStep: () => ({
        status: 'ACTION',
        proposal: {
          targetElementId: 'input-text',
          actionType: 'type',
          // payload missing text
          payload: {} as any,
          rationale: 'Type without text'
        }
      })
    };

    const input = createMockPlannerInput({
      context: { page: createMockPage([typeElem]), availableTargets: [typeTarget] }
    });
    const result = await planNextStep(input, driverMissingText);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INVALID_ACTION_INTENT');
      expect(result.targetFailure).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Determinism, Referential Transparency, and Serialization
// ---------------------------------------------------------------------------

describe('Determinism & Serialization', () => {
  it('35. exact deterministic planId is produced without randomness or timestamps', async () => {
    const input = createMockPlannerInput({
      goal: { id: 'search-flow-99' },
      context: { stepIndex: 7 }
    });
    const result = await planNextStep(input);
    expect(result.planId).toBe('plan_search-flow-99_step_7');
  });

  it('36. DeterministicRulePlanner produces deep-equal output for identical inputs', async () => {
    const inputA = createMockPlannerInput();
    const inputB = createMockPlannerInput();

    const resultA = await planNextStep(inputA);
    const resultB = await planNextStep(inputB);

    expect(resultA).toEqual(resultB);
  });

  it('37. zero system clock or Math.random reliance', async () => {
    // Run multiple consecutive iterations with the same input
    const input = createMockPlannerInput();
    const runs = await Promise.all([
      planNextStep(input),
      planNextStep(input),
      planNextStep(input)
    ]);

    expect(runs[0]).toEqual(runs[1]);
    expect(runs[1]).toEqual(runs[2]);
  });

  it('38. JSON round-trip serialization of PlannerResult', async () => {
    const input = createMockPlannerInput();
    const result = await planNextStep(input);

    const serialized = JSON.stringify(result);
    const deserialized = JSON.parse(serialized);

    expect(deserialized).toEqual(result);
  });
});
