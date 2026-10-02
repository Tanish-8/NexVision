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
  validateTaskFieldParameter,
  validateTaskPhase,
  validateTaskPlan,
  validatePhaseExecutionState,
  validateSafeModelHistoryStep,
  VALID_PHASE_INTENTS,
  VALID_TASK_ARCHETYPES,
  DeterministicRulePlanner,
  DEFAULT_MAX_PERCEPTION_AGE_MS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_STRICT_ROLE_MATCHING,
  extractSearchQueryFromGoal,
  cleanSearchQueryCandidate,
  resolveActivePhase,
  isMediaContentGoal,
  isProfileOrChannelCandidate,
  isMediaContentCandidate,
  isProfileOrChannelUrl,
  isMediaContentUrl,
  validateAndNormalizeSearchQuery
} from './planner.js';
import type {
  PlannerGoal,
  PlannerContext,
  PlannerOptions,
  PlannerInput,
  PlannerDriver,
  AdvisoryProposalResult,
  AdvisoryStepProposal,
  TaskPlan,
  TaskPhase,
  PhaseIntent,
  TaskFieldParameter,
  PhaseExecutionState,
  SafeModelHistoryStep,
  PlannerHistoryStep
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
  history?: readonly PlannerHistoryStep[];
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
    ...(overrides?.options !== undefined ? { options: overrides.options } : {}),
    ...(overrides?.history !== undefined ? { history: overrides.history } : {})
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

// ---------------------------------------------------------------------------
// 9. Phase A — Hierarchical Task Plan & Phase Contracts
// ---------------------------------------------------------------------------

describe('Phase A — Hierarchical Task Plan & Phase Contracts', () => {
  describe('TaskFieldParameter representation', () => {
    it('validates a standard field parameter correctly', () => {
      const param: TaskFieldParameter = {
        fieldName: 'task name',
        targetValue: 'college',
        completed: false
      };
      expect(validateTaskFieldParameter(param)).toBeNull();
    });

    it('validates a vault reference field parameter', () => {
      const vaultParam: TaskFieldParameter = {
        fieldName: 'email',
        targetValue: 'profile.email',
        isVaultReference: true,
        completed: true
      };
      expect(validateTaskFieldParameter(vaultParam)).toBeNull();
    });

    it('validates a field parameter with rawTargetValue', () => {
      const paramWithRaw: TaskFieldParameter = {
        fieldName: 'dueDate',
        targetValue: '2026-09-29',
        rawTargetValue: "today's date",
        completed: false
      };
      expect(validateTaskFieldParameter(paramWithRaw)).toBeNull();
    });

    it('rejects invalid field parameters', () => {
      expect(validateTaskFieldParameter(null)).toContain('must be a non-null object');
      expect(validateTaskFieldParameter({})).toContain('fieldName must be a non-empty string');
      expect(validateTaskFieldParameter({ fieldName: 'name', targetValue: 123 })).toContain('targetValue must be a string');
      expect(validateTaskFieldParameter({ fieldName: 'name', targetValue: 'val', rawTargetValue: 123 })).toContain('rawTargetValue must be a string');
      expect(validateTaskFieldParameter({ fieldName: 'name', targetValue: 'val', isVaultReference: 'yes' })).toContain('isVaultReference must be a boolean');
      expect(validateTaskFieldParameter({ fieldName: 'name', targetValue: 'val', completed: 'no' })).toContain('completed must be a boolean');
    });
  });

  describe('TaskPhase representation', () => {
    it('validates an open_surface phase', () => {
      const phase: TaskPhase = {
        phaseId: 'phase-0',
        phaseIndex: 0,
        intent: 'open_surface',
        description: 'Open the task creation dialog',
        targetHint: 'Add Task, Create, +',
        allowedActions: ['click'],
        expectedOutcome: 'Task creation modal appears',
        requiredForCompletion: true
      };
      expect(validateTaskPhase(phase)).toBeNull();
    });

    it('validates a fill_field phase with fieldParameter', () => {
      const phase: TaskPhase = {
        phaseId: 'phase-1',
        phaseIndex: 1,
        intent: 'fill_field',
        description: 'Enter task name',
        fieldParameter: {
          fieldName: 'task name',
          targetValue: 'college'
        },
        allowedActions: ['type', 'focus']
      };
      expect(validateTaskPhase(phase)).toBeNull();
    });

    it('rejects invalid task phase properties', () => {
      expect(validateTaskPhase(null)).toContain('must be a non-null object');
      expect(validateTaskPhase({ phaseIndex: 0 })).toContain('phase.phaseId must be a non-empty string');
      expect(validateTaskPhase({ phaseId: 'p0', phaseIndex: -1 })).toContain('phase.phaseIndex must be a non-negative integer');
      expect(validateTaskPhase({ phaseId: 'p0', phaseIndex: 0, intent: 'invalid_intent' })).toContain('phase.intent must belong to valid PhaseIntent vocabulary');
      expect(validateTaskPhase({ phaseId: 'p0', phaseIndex: 0, intent: 'search', description: '' })).toContain('phase.description must be a non-empty string');
      expect(validateTaskPhase({ phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'valid', targetHint: '' })).toContain('phase.targetHint must be a non-empty string');
      expect(validateTaskPhase({ phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'valid', allowedActions: ['invalid' as any] })).toContain('allowedActions elements must be valid ActionTypes');
      expect(validateTaskPhase({ phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'valid', fieldParameter: { fieldName: '' } as any })).toContain('fieldName must be a non-empty string');
    });
  });

  describe('TaskPlan representation & serialization', () => {
    it('validates a full multi-phase TaskPlan', () => {
      const plan: TaskPlan = {
        planId: 'plan-task-create-1',
        archetype: 'form_submission',
        summary: 'Create and add a task with name college, status pending, due date today, priority medium',
        phases: [
          {
            phaseId: 'phase-open',
            phaseIndex: 0,
            intent: 'open_surface',
            description: 'Open new task creation form',
            targetHint: 'Add Task, New, +',
            allowedActions: ['click']
          },
          {
            phaseId: 'phase-name',
            phaseIndex: 1,
            intent: 'fill_field',
            description: 'Enter task name',
            fieldParameter: { fieldName: 'name', targetValue: 'college' },
            allowedActions: ['type']
          },
          {
            phaseId: 'phase-status',
            phaseIndex: 2,
            intent: 'select_option',
            description: 'Set status to pending',
            fieldParameter: { fieldName: 'status', targetValue: 'pending' },
            allowedActions: ['click', 'type']
          },
          {
            phaseId: 'phase-submit',
            phaseIndex: 3,
            intent: 'submit',
            description: 'Submit task form',
            targetHint: 'Save, Create, Submit',
            allowedActions: ['click']
          }
        ],
        currentPhaseIndex: 0,
        extractedParameters: {
          name: 'college',
          status: 'pending',
          dueDate: 'today',
          priority: 'medium'
        }
      };

      expect(validateTaskPlan(plan)).toBeNull();

      // JSON round-trip serialization preservation
      const json = JSON.stringify(plan);
      const parsed = JSON.parse(json);
      expect(parsed).toEqual(plan);
      expect(validateTaskPlan(parsed)).toBeNull();
    });

    it('rejects invalid TaskPlan objects', () => {
      expect(validateTaskPlan(null)).toContain('must be a non-null object');
      expect(validateTaskPlan({})).toContain('plan.planId must be a non-empty string');
      expect(validateTaskPlan({ planId: 'p1', archetype: 'invalid_arch' })).toContain('plan.archetype must belong to valid TaskArchetype vocabulary');
      expect(validateTaskPlan({ planId: 'p1', archetype: 'form_submission', summary: '' })).toContain('plan.summary must be a non-empty string');
      expect(validateTaskPlan({ planId: 'p1', archetype: 'form_submission', summary: 'ok', phases: [] })).toContain('plan.phases must contain at least one phase');
      expect(validateTaskPlan({
        planId: 'p1',
        archetype: 'form_submission',
        summary: 'ok',
        phases: [{ phaseId: 'ph0', phaseIndex: 0, intent: 'search', description: 'desc' }],
        currentPhaseIndex: 5
      })).toContain('plan.currentPhaseIndex must be an integer between 0 and phases.length (1)');
      expect(validateTaskPlan({
        planId: 'p1',
        archetype: 'form_submission',
        summary: 'ok',
        phases: [{ phaseId: 'ph0', phaseIndex: 0, intent: 'search', description: 'desc' }],
        currentPhaseIndex: 0,
        extractedParameters: { badKey: 123 as any }
      })).toContain("plan.extractedParameters['badKey'] must be a string");
    });
  });

  describe('PhaseExecutionState representation', () => {
    it('validates a valid PhaseExecutionState', () => {
      const state: PhaseExecutionState = {
        activePhase: {
          phaseId: 'ph-1',
          phaseIndex: 1,
          intent: 'fill_field',
          description: 'Enter name',
          allowedActions: ['type']
        },
        completedPhaseIds: ['ph-0'],
        remainingPhaseIds: ['ph-2', 'ph-3'],
        totalPhases: 4,
        retryCountInCurrentPhase: 0
      };
      expect(validatePhaseExecutionState(state)).toBeNull();
    });

    it('validates terminal PhaseExecutionState with undefined activePhase', () => {
      const terminalState: PhaseExecutionState = {
        activePhase: undefined,
        completedPhaseIds: ['ph-0', 'ph-1', 'ph-2', 'ph-3'],
        remainingPhaseIds: [],
        totalPhases: 4,
        retryCountInCurrentPhase: 0
      };
      expect(validatePhaseExecutionState(terminalState)).toBeNull();
    });

    it('rejects invalid PhaseExecutionState', () => {
      expect(validatePhaseExecutionState(null)).toContain('must be a non-null object');
      expect(validatePhaseExecutionState({ completedPhaseIds: 'not-array' })).toContain('completedPhaseIds must be an array');
      expect(validatePhaseExecutionState({ completedPhaseIds: [], remainingPhaseIds: 'not-array' })).toContain('remainingPhaseIds must be an array');
      expect(validatePhaseExecutionState({ completedPhaseIds: [], remainingPhaseIds: [], totalPhases: -1 })).toContain('totalPhases must be a non-negative integer');
      expect(validatePhaseExecutionState({ completedPhaseIds: [], remainingPhaseIds: [], totalPhases: 1, retryCountInCurrentPhase: -1 })).toContain('retryCountInCurrentPhase must be a non-negative integer');
    });
  });

  describe('SafeModelHistoryStep representation', () => {
    it('validates a privacy-safe history step carrying phase provenance', () => {
      const step: SafeModelHistoryStep = {
        stepIndex: 1,
        phaseIndex: 1,
        phaseIntent: 'fill_field',
        actionType: 'type',
        targetElementId: 'elem-task-name',
        targetRole: 'textbox',
        fulfilledParameter: 'task.name',
        perceivedOutcome: 'success'
      };
      expect(validateSafeModelHistoryStep(step)).toBeNull();

      // Confirms typed text is NOT part of SafeModelHistoryStep contract
      expect((step as any).text).toBeUndefined();
      expect((step as any).payload).toBeUndefined();
    });

    it('rejects malformed SafeModelHistoryStep', () => {
      expect(validateSafeModelHistoryStep(null)).toContain('must be a non-null object');
      expect(validateSafeModelHistoryStep({ stepIndex: -1 })).toContain('stepIndex must be a non-negative integer');
      expect(validateSafeModelHistoryStep({ stepIndex: 0, phaseIndex: -1 })).toContain('phaseIndex must be a non-negative integer');
      expect(validateSafeModelHistoryStep({ stepIndex: 0, phaseIntent: 'invalid_intent' })).toContain('phaseIntent must belong to valid PhaseIntent vocabulary');
      expect(validateSafeModelHistoryStep({ stepIndex: 0, actionType: 'invalid_action' as any })).toContain("actionType must be one of 'click', 'type', 'focus'");
      expect(validateSafeModelHistoryStep({ stepIndex: 0, actionType: 'click', targetElementId: '' })).toContain('targetElementId must be a non-empty string');
      expect(validateSafeModelHistoryStep({ stepIndex: 0, actionType: 'click', targetElementId: 'el1', perceivedOutcome: 'unknown' as any })).toContain("perceivedOutcome must be 'success', 'no_change', or 'error'");
    });
  });

  describe('PlannerInput Integration with Phase A Contracts', () => {
    it('accepts PlannerInput with valid taskPlan and phaseState', async () => {
      const validPlan: TaskPlan = {
        planId: 'plan-1',
        archetype: 'search_and_act',
        summary: 'Search for tutorial and open first video',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search query', allowedActions: ['click', 'type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'select_result', description: 'Select video', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 0
      };

      const validPhaseState: PhaseExecutionState = {
        activePhase: validPlan.phases[0],
        completedPhaseIds: [],
        remainingPhaseIds: ['p1'],
        totalPhases: 2,
        retryCountInCurrentPhase: 0
      };

      const input = createMockPlannerInput({
        goal: {
          taskPlan: validPlan
        },
        context: {
          phaseState: validPhaseState
        }
      });

      expect(validatePlannerInput(input)).toBeNull();
      const result = await planNextStep(input);
      expect(result.status).toBe('ACTION');
    });

    it('rejects proposal with INCOMPATIBLE_ACTION_FOR_PHASE when action violates activePhase.allowedActions', async () => {
      const validPlan: TaskPlan = {
        planId: 'plan-1',
        archetype: 'search_and_act',
        summary: 'Search for tutorial and open first video',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search query', allowedActions: ['type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'select_result', description: 'Select video', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 0
      };

      const validPhaseState: PhaseExecutionState = {
        activePhase: validPlan.phases[0], // allowedActions: ['type'] only
        completedPhaseIds: [],
        remainingPhaseIds: ['p1'],
        totalPhases: 2,
        retryCountInCurrentPhase: 0
      };

      // createMockPlannerInput defaults to button click
      const input = createMockPlannerInput({
        goal: {
          taskPlan: validPlan
        },
        context: {
          phaseState: validPhaseState
        }
      });

      const result = await planNextStep(input);
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') {
        expect(result.reason).toBe('INCOMPATIBLE_ACTION_FOR_PHASE');
      }
    });

    it('rejects PlannerInput with malformed taskPlan', () => {
      const input = createMockPlannerInput({
        goal: {
          taskPlan: { planId: '' } as any
        }
      });
      const err = validatePlannerInput(input);
      expect(err).toContain('goal.taskPlan');
    });

    it('rejects PlannerInput with malformed phaseState', () => {
      const input = createMockPlannerInput({
        context: {
          phaseState: { totalPhases: -1 } as any
        }
      });
      const err = validatePlannerInput(input);
      expect(err).toContain('context.phaseState');
    });

    it('validates history step with phaseIndex and phaseIntent', () => {
      const input = createMockPlannerInput();
      const inputWithPhaseHistory = {
        ...input,
        history: [
          {
            stepIndex: 0,
            action: {
              id: 'a0',
              type: 'click' as const,
              target: createMockActionTarget()
            },
            phaseIndex: 0,
            phaseIntent: 'open_surface' as const,
            fulfilledParameter: 'task.openModal',
            perceivedOutcome: 'success' as const
          }
        ]
      };
      expect(validatePlannerInput(inputWithPhaseHistory)).toBeNull();
    });

    it('rejects history step with invalid phaseIntent', () => {
      const input = createMockPlannerInput();
      const inputWithBadHistory = {
        ...input,
        history: [
          {
            stepIndex: 0,
            action: {
              id: 'a0',
              type: 'click' as const,
              target: createMockActionTarget()
            },
            phaseIntent: 'bogus_phase' as any
          }
        ]
      };
      const err = validatePlannerInput(inputWithBadHistory);
      expect(err).toContain('phaseIntent must belong to valid PhaseIntent vocabulary');
    });
  });

  // -------------------------------------------------------------------------
  // Phase E: Generic Browser Action Layer & Capability-Aware Selection
  // -------------------------------------------------------------------------
  describe('Phase E: Generic Browser Action Layer & Capability-Aware Selection', () => {
    const planner = new DeterministicRulePlanner();

    it('1. select_option + native <select> -> type', async () => {
      const selectElement = createMockPageElement({
        id: 'status-select',
        tagName: 'select',
        role: 'combobox',
        accessibleName: 'Status',
        visibleText: 'Select Status'
      });
      const selectTarget = createMockActionTarget({
        elementId: 'status-select',
        role: 'combobox'
      });
      const selectPhase: TaskPhase = {
        phaseId: 'p-status',
        phaseIndex: 0,
        intent: 'select_option',
        description: 'Select status as pending',
        targetHint: 'status',
        allowedActions: ['click', 'type'],
        fieldParameter: { fieldName: 'status', targetValue: 'pending' }
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'g-status',
          description: 'Set status to pending',
          intent: 'custom',
          taskPlan: {
            planId: 'tp-1',
            archetype: 'form_submission',
            summary: 'Form flow',
            phases: [selectPhase],
            currentPhaseIndex: 0
          }
        },
        context: {
          page: createMockPage([selectElement]),
          availableTargets: [selectTarget],
          phaseState: {
            activePhase: selectPhase,
            completedPhaseIds: [],
            remainingPhaseIds: [],
            totalPhases: 1,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const res = await planNextStep(input, planner);
      expect(res.status).toBe('ACTION');
      if (res.status === 'ACTION') {
        expect(res.action.type).toBe('type');
        expect(res.action.target.elementId).toBe('status-select');
        if (res.action.type === 'type') {
          expect(res.action.payload?.text).toBe('pending');
          expect(res.action.payload?.pressEnter).toBe(false);
        }
      }
    });

    it('2. select_option + radio -> click', async () => {
      const radioElement = createMockPageElement({
        id: 'priority-medium-radio',
        tagName: 'input',
        role: 'radio',
        accessibleName: 'Medium Priority',
        visibleText: 'Medium'
      });
      const radioTarget = createMockActionTarget({
        elementId: 'priority-medium-radio',
        role: 'radio'
      });
      const selectPhase: TaskPhase = {
        phaseId: 'p-priority',
        phaseIndex: 0,
        intent: 'select_option',
        description: 'Select priority as medium',
        targetHint: 'medium',
        allowedActions: ['click', 'type'],
        fieldParameter: { fieldName: 'priority', targetValue: 'medium' }
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'g-priority',
          description: 'Choose medium priority',
          intent: 'custom',
          taskPlan: {
            planId: 'tp-2',
            archetype: 'form_submission',
            summary: 'Form flow',
            phases: [selectPhase],
            currentPhaseIndex: 0
          }
        },
        context: {
          page: createMockPage([radioElement]),
          availableTargets: [radioTarget],
          phaseState: {
            activePhase: selectPhase,
            completedPhaseIds: [],
            remainingPhaseIds: [],
            totalPhases: 1,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const res = await planNextStep(input, planner);
      expect(res.status).toBe('ACTION');
      if (res.status === 'ACTION') {
        expect(res.action.type).toBe('click');
        expect(res.action.target.elementId).toBe('priority-medium-radio');
      }
    });

    it('3. select_option + checkbox -> click', async () => {
      const checkboxElement = createMockPageElement({
        id: 'agree-terms-checkbox',
        tagName: 'input',
        role: 'checkbox',
        accessibleName: 'I Agree',
        visibleText: 'Agree to terms'
      });
      const checkboxTarget = createMockActionTarget({
        elementId: 'agree-terms-checkbox',
        role: 'checkbox'
      });
      const selectPhase: TaskPhase = {
        phaseId: 'p-terms',
        phaseIndex: 0,
        intent: 'select_option',
        description: 'Check terms agreement',
        targetHint: 'terms',
        allowedActions: ['click', 'type']
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'g-terms',
          description: 'Agree to terms',
          intent: 'custom',
          taskPlan: {
            planId: 'tp-3',
            archetype: 'form_submission',
            summary: 'Form flow',
            phases: [selectPhase],
            currentPhaseIndex: 0
          }
        },
        context: {
          page: createMockPage([checkboxElement]),
          availableTargets: [checkboxTarget],
          phaseState: {
            activePhase: selectPhase,
            completedPhaseIds: [],
            remainingPhaseIds: [],
            totalPhases: 1,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const res = await planNextStep(input, planner);
      expect(res.status).toBe('ACTION');
      if (res.status === 'ACTION') {
        expect(res.action.type).toBe('click');
        expect(res.action.target.elementId).toBe('agree-terms-checkbox');
      }
    });

    it('4. select_option + ARIA combobox -> click', async () => {
      const comboboxElement = createMockPageElement({
        id: 'custom-dropdown-trigger',
        tagName: 'div',
        role: 'combobox',
        accessibleName: 'Category Selector',
        visibleText: 'Select category'
      });
      const comboboxTarget = createMockActionTarget({
        elementId: 'custom-dropdown-trigger',
        role: 'combobox'
      });
      const selectPhase: TaskPhase = {
        phaseId: 'p-category',
        phaseIndex: 0,
        intent: 'select_option',
        description: 'Open category combobox',
        targetHint: 'category',
        allowedActions: ['click', 'type'],
        fieldParameter: { fieldName: 'category', targetValue: 'electronics' }
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'g-category',
          description: 'Select category',
          intent: 'custom',
          taskPlan: {
            planId: 'tp-4',
            archetype: 'form_submission',
            summary: 'Form flow',
            phases: [selectPhase],
            currentPhaseIndex: 0
          }
        },
        context: {
          page: createMockPage([comboboxElement]),
          availableTargets: [comboboxTarget],
          phaseState: {
            activePhase: selectPhase,
            completedPhaseIds: [],
            remainingPhaseIds: [],
            totalPhases: 1,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const res = await planNextStep(input, planner);
      expect(res.status).toBe('ACTION');
      if (res.status === 'ACTION') {
        expect(res.action.type).toBe('click');
        expect(res.action.target.elementId).toBe('custom-dropdown-trigger');
      }
    });

    it('7. select_option never falls through to search intent (does not prioritize global searchbox)', async () => {
      const searchBox = createMockPageElement({
        id: 'global-search',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search everywhere',
        visibleText: ''
      });
      const selectElement = createMockPageElement({
        id: 'status-dropdown',
        tagName: 'select',
        role: 'combobox',
        accessibleName: 'Status',
        visibleText: 'Status'
      });
      const searchTarget = createMockActionTarget({
        elementId: 'global-search',
        role: 'searchbox'
      });
      const selectTarget = createMockActionTarget({
        elementId: 'status-dropdown',
        role: 'combobox'
      });

      const selectPhase: TaskPhase = {
        phaseId: 'p-select',
        phaseIndex: 1,
        intent: 'select_option',
        description: 'Select status',
        targetHint: 'status',
        allowedActions: ['click', 'type'],
        fieldParameter: { fieldName: 'status', targetValue: 'in_progress' }
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'g-taskflow',
          description: 'Create and add a task with name college and status in_progress',
          intent: 'custom',
          taskPlan: {
            planId: 'tp-tf',
            archetype: 'form_submission',
            summary: 'Create task',
            phases: [
              { phaseId: 'p-title', phaseIndex: 0, intent: 'fill_field', description: 'Enter title', allowedActions: ['type'] },
              selectPhase
            ],
            currentPhaseIndex: 1
          }
        },
        context: {
          page: createMockPage([searchBox, selectElement]),
          availableTargets: [searchTarget, selectTarget],
          phaseState: {
            activePhase: selectPhase,
            completedPhaseIds: ['p-title'],
            remainingPhaseIds: [],
            totalPhases: 2,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const res = await planNextStep(input, planner);
      expect(res.status).toBe('ACTION');
      if (res.status === 'ACTION') {
        // Must select the status select, NOT the search box
        expect(res.action.target.elementId).toBe('status-dropdown');
        expect(res.action.type).toBe('type');
        if (res.action.type === 'type') {
          expect(res.action.payload?.text).toBe('in_progress');
          expect(res.action.payload?.pressEnter).toBe(false);
        }
      }
    });

    it('7b. select_option with overarching goal.intent === "search" never falls through to searchbox', async () => {
      const searchBox = createMockPageElement({
        id: 'site-search',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search products',
        visibleText: ''
      });
      const selectElement = createMockPageElement({
        id: 'category-dropdown',
        tagName: 'select',
        role: 'combobox',
        accessibleName: 'Category',
        visibleText: 'Category'
      });
      const searchTarget = createMockActionTarget({
        elementId: 'site-search',
        role: 'searchbox'
      });
      const selectTarget = createMockActionTarget({
        elementId: 'category-dropdown',
        role: 'combobox'
      });

      const selectPhase: TaskPhase = {
        phaseId: 'p-category',
        phaseIndex: 1,
        intent: 'select_option',
        description: 'Select category electronics',
        targetHint: 'category',
        allowedActions: ['click', 'type'],
        fieldParameter: { fieldName: 'category', targetValue: 'electronics' }
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'g-search-category',
          description: 'Search products and select category electronics',
          intent: 'search', // Overarching goal intent is search
          taskPlan: {
            planId: 'tp-search-cat',
            archetype: 'search_and_act',
            summary: 'Search and category flow',
            phases: [
              { phaseId: 'p-search', phaseIndex: 0, intent: 'search', description: 'Search query', allowedActions: ['type'] },
              selectPhase
            ],
            currentPhaseIndex: 1
          }
        },
        context: {
          page: createMockPage([searchBox, selectElement]),
          availableTargets: [searchTarget, selectTarget],
          phaseState: {
            activePhase: selectPhase,
            completedPhaseIds: ['p-search'],
            remainingPhaseIds: [],
            totalPhases: 2,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const res = await planNextStep(input, planner);
      expect(res.status).toBe('ACTION');
      if (res.status === 'ACTION') {
        expect(res.action.target.elementId).toBe('category-dropdown');
        expect(res.action.type).toBe('type');
        if (res.action.type === 'type') {
          expect(res.action.payload?.text).toBe('electronics');
          expect(res.action.payload?.pressEnter).toBe(false);
        }
      }
    });

    it('7c. select_option with only searchbox present fails with NO_FEASIBLE_TARGET instead of falling through', async () => {
      const searchBox = createMockPageElement({
        id: 'global-search-only',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search',
        visibleText: ''
      });
      const searchTarget = createMockActionTarget({
        elementId: 'global-search-only',
        role: 'searchbox'
      });

      const selectPhase: TaskPhase = {
        phaseId: 'p-status',
        phaseIndex: 0,
        intent: 'select_option',
        description: 'Select status',
        targetHint: 'status',
        allowedActions: ['click', 'type'],
        fieldParameter: { fieldName: 'status', targetValue: 'pending' }
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'g-status-only',
          description: 'Select status',
          intent: 'search',
          taskPlan: {
            planId: 'tp-status',
            archetype: 'form_submission',
            summary: 'Status flow',
            phases: [selectPhase],
            currentPhaseIndex: 0
          }
        },
        context: {
          page: createMockPage([searchBox]),
          availableTargets: [searchTarget],
          phaseState: {
            activePhase: selectPhase,
            completedPhaseIds: [],
            remainingPhaseIds: [],
            totalPhases: 1,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const res = await planNextStep(input, planner);
      expect(res.status).toBe('FAILED');
      if (res.status === 'FAILED') {
        expect(res.reason).toBe('NO_FEASIBLE_TARGET');
      }
    });

    it('8. existing search behavior remains unchanged', async () => {
      const searchBox = createMockPageElement({
        id: 'search-input',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search',
        visibleText: ''
      });
      const searchTarget = createMockActionTarget({
        elementId: 'search-input',
        role: 'searchbox'
      });

      const input = createMockPlannerInput({
        goal: {
          id: 'g-search',
          description: 'Search for headphones',
          intent: 'search',
          parameters: { text: 'headphones' }
        },
        context: {
          page: createMockPage([searchBox]),
          availableTargets: [searchTarget]
        }
      });

      const res = await planNextStep(input, planner);
      expect(res.status).toBe('ACTION');
      if (res.status === 'ACTION') {
        expect(res.action.type).toBe('type');
        expect(res.action.target.elementId).toBe('search-input');
        if (res.action.type === 'type') {
          expect(res.action.payload?.text).toBe('headphones');
          expect(res.action.payload?.pressEnter).toBe(true);
        }
      }
    });

    it('9. existing fill_field behavior remains unchanged', async () => {
      const textInput = createMockPageElement({
        id: 'task-title',
        tagName: 'input',
        role: 'textbox',
        accessibleName: 'Task Title',
        visibleText: ''
      });
      const titleTarget = createMockActionTarget({
        elementId: 'task-title',
        role: 'textbox'
      });

      const fillPhase: TaskPhase = {
        phaseId: 'p-title',
        phaseIndex: 0,
        intent: 'fill_field',
        description: 'Enter task title',
        targetHint: 'title',
        allowedActions: ['type'],
        fieldParameter: { fieldName: 'title', targetValue: 'college' }
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'g-fill',
          description: 'Enter task title',
          intent: 'type',
          taskPlan: {
            planId: 'tp-fill',
            archetype: 'form_submission',
            summary: 'Form flow',
            phases: [fillPhase],
            currentPhaseIndex: 0
          }
        },
        context: {
          page: createMockPage([textInput]),
          availableTargets: [titleTarget],
          phaseState: {
            activePhase: fillPhase,
            completedPhaseIds: [],
            remainingPhaseIds: [],
            totalPhases: 1,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const res = await planNextStep(input, planner);
      expect(res.status).toBe('ACTION');
      if (res.status === 'ACTION') {
        expect(res.action.type).toBe('type');
        expect(res.action.target.elementId).toBe('task-title');
        if (res.action.type === 'type') {
          expect(res.action.payload?.text).toBe('college');
          expect(res.action.payload?.pressEnter).toBe(false);
        }
      }
    });

    it('10. privacy behavior remains unchanged (sensitive field parameters masked in history validation)', () => {
      const sensitivePhase: TaskPhase = {
        phaseId: 'p-pass',
        phaseIndex: 0,
        intent: 'fill_field',
        description: 'Enter confidential password',
        fieldParameter: { fieldName: 'password', targetValue: 'super_secret_999' },
        allowedActions: ['type']
      };

      const plan: TaskPlan = {
        planId: 'tp-priv',
        archetype: 'form_submission',
        summary: 'Enter sensitive information',
        phases: [sensitivePhase],
        currentPhaseIndex: 0
      };

      const planError = validateTaskPlan(plan);
      expect(planError).toBeNull();

      // SafeModelHistoryStep validation rejects non-string or unknown outcome
      const invalidOutcomeStep = {
        stepIndex: 0,
        actionType: 'type',
        targetElementId: 'pwd-input',
        perceivedOutcome: 'leaked_data'
      };
      const histErr = validateSafeModelHistoryStep(invalidOutcomeStep);
      expect(histErr).toContain("perceivedOutcome must be 'success', 'no_change', or 'error'");
    });
  });

  // -------------------------------------------------------------------------
  // Generic Search-Phase Interaction Policy & Autocomplete Handling (Section 7 A-G)
  // -------------------------------------------------------------------------
  describe('Generic Search-Phase Interaction Policy & Autocomplete Handling', () => {
    const planner = new DeterministicRulePlanner();

    it('extractSearchQueryFromGoal extracts query from compound and simple descriptions', () => {
      expect(extractSearchQueryFromGoal('Search for MrBeast', 'Search for MrBeast and play the first video')).toBe('MrBeast');
      expect(extractSearchQueryFromGoal(undefined, 'Search for MrBeast and play the first video')).toBe('MrBeast');
      expect(extractSearchQueryFromGoal(undefined, 'Search for laptops under ₹50,000')).toBe('laptops under ₹50,000');
      expect(extractSearchQueryFromGoal(undefined, 'Find wireless headphones and view details')).toBe('wireless headphones');
      expect(extractSearchQueryFromGoal('Search "retro sneakers"', undefined)).toBe('retro sneakers');
    });

    it('A. Search input + autocomplete option: expected action = type + pressEnter; suggestion is NOT selected', () => {
      const searchBox = createMockPageElement({
        id: 'search-input',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search',
        interactive: true
      });
      const suggestionOption = createMockPageElement({
        id: 'suggestion-mrbeast',
        tagName: 'div',
        role: 'option',
        accessibleName: 'MrBeast',
        visibleText: 'MrBeast',
        interactive: true
      });

      const targets: ActionTarget[] = [
        createMockActionTarget({ elementId: 'suggestion-mrbeast', role: 'option', confidence: 0.95 }),
        createMockActionTarget({ elementId: 'search-input', role: 'searchbox', confidence: 0.95 })
      ];

      const input = createMockPlannerInput({
        goal: {
          id: 'goal-search',
          description: 'Search for MrBeast and play the first video',
          intent: 'search'
        },
        context: {
          page: createMockPage([suggestionOption, searchBox]),
          availableTargets: targets
        }
      });

      const result = planner.proposeStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status === 'ACTION') {
        expect(result.proposal.targetElementId).toBe('search-input');
        expect(result.proposal.actionType).toBe('type');
        expect(result.proposal.payload).toEqual({
          text: 'MrBeast',
          clearFirst: true,
          pressEnter: true
        });
      }
    });

    it('B. Search input + multiple autocomplete suggestions: search input remains preferred', () => {
      const searchBox = createMockPageElement({
        id: 'search-input',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search',
        interactive: true
      });
      const suggestions = [
        createMockPageElement({ id: 'sugg-1', role: 'option', visibleText: 'MrBeast', interactive: true }),
        createMockPageElement({ id: 'sugg-2', role: 'option', visibleText: 'MrBeast video', interactive: true }),
        createMockPageElement({ id: 'sugg-3', role: 'option', visibleText: 'MrBeast first video', interactive: true }),
        createMockPageElement({ id: 'sugg-4', role: 'menuitem', visibleText: 'MrBeast gaming', interactive: true })
      ];

      const targets: ActionTarget[] = [
        ...suggestions.map(s => createMockActionTarget({ elementId: s.id, role: s.role, confidence: 1.0 })),
        createMockActionTarget({ elementId: 'search-input', role: 'searchbox', confidence: 0.9 })
      ];

      const input = createMockPlannerInput({
        goal: {
          id: 'goal-multi-sugg',
          description: 'Search for MrBeast and play the first video',
          intent: 'search'
        },
        context: {
          page: createMockPage([...suggestions, searchBox]),
          availableTargets: targets
        }
      });

      const result = planner.proposeStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status === 'ACTION') {
        expect(result.proposal.targetElementId).toBe('search-input');
        expect(result.proposal.actionType).toBe('type');
        expect(result.proposal.payload?.pressEnter).toBe(true);
      }
    });

    it('C. Search input with no autocomplete: existing behavior preserved', () => {
      const searchBox = createMockPageElement({
        id: 'search-input',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search query',
        interactive: true
      });

      const input = createMockPlannerInput({
        goal: {
          id: 'goal-clean-search',
          description: 'Search for mechanical keyboards',
          intent: 'search'
        },
        context: {
          page: createMockPage([searchBox]),
          availableTargets: [createMockActionTarget({ elementId: 'search-input', role: 'searchbox' })]
        }
      });

      const result = planner.proposeStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status === 'ACTION') {
        expect(result.proposal.targetElementId).toBe('search-input');
        expect(result.proposal.actionType).toBe('type');
        expect(result.proposal.payload).toEqual({
          text: 'mechanical keyboards',
          clearFirst: true,
          pressEnter: true
        });
      }
    });

    it('D. Search input + explicit search button: search input preferred; fallback button preserved if no input', () => {
      const searchBox = createMockPageElement({
        id: 'search-input',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search',
        interactive: true
      });
      const searchBtn = createMockPageElement({
        id: 'search-btn',
        tagName: 'button',
        role: 'button',
        accessibleName: 'Search',
        interactive: true
      });

      // Both present: search input preferred for typing query + enter
      const inputBoth = createMockPlannerInput({
        goal: {
          id: 'goal-both',
          description: 'Search for laptops under ₹50,000',
          intent: 'search'
        },
        context: {
          page: createMockPage([searchBtn, searchBox]),
          availableTargets: [
            createMockActionTarget({ elementId: 'search-btn', role: 'button' }),
            createMockActionTarget({ elementId: 'search-input', role: 'searchbox' })
          ]
        }
      });

      const resultBoth = planner.proposeStep(inputBoth);
      expect(resultBoth.status).toBe('ACTION');
      if (resultBoth.status === 'ACTION') {
        expect(resultBoth.proposal.targetElementId).toBe('search-input');
        expect(resultBoth.proposal.actionType).toBe('type');
        expect(resultBoth.proposal.payload?.pressEnter).toBe(true);
      }

      // Only button present: fallback click on search button preserved
      const inputBtnOnly = createMockPlannerInput({
        goal: {
          id: 'goal-btn-only',
          description: 'Search for laptops',
          intent: 'search'
        },
        context: {
          page: createMockPage([searchBtn]),
          availableTargets: [createMockActionTarget({ elementId: 'search-btn', role: 'button' })]
        }
      });

      const resultBtnOnly = planner.proposeStep(inputBtnOnly);
      expect(resultBtnOnly.status).toBe('ACTION');
      if (resultBtnOnly.status === 'ACTION') {
        expect(resultBtnOnly.proposal.targetElementId).toBe('search-btn');
        expect(resultBtnOnly.proposal.actionType).toBe('click');
      }
    });

    it('E. Search phase must not click suggestion merely because it has high lexical similarity', () => {
      // Suggestion has 100% exact lexical similarity to the user goal
      const highLexicalSuggestion = createMockPageElement({
        id: 'exact-match-suggestion',
        tagName: 'div',
        role: 'option',
        accessibleName: 'Search for MrBeast and play the first video',
        visibleText: 'Search for MrBeast and play the first video',
        interactive: true
      });
      const searchBox = createMockPageElement({
        id: 'search-box',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search',
        interactive: true
      });

      const input = createMockPlannerInput({
        goal: {
          id: 'goal-lexical',
          description: 'Search for MrBeast and play the first video',
          intent: 'search'
        },
        context: {
          page: createMockPage([highLexicalSuggestion, searchBox]),
          availableTargets: [
            createMockActionTarget({ elementId: 'exact-match-suggestion', role: 'option' }),
            createMockActionTarget({ elementId: 'search-box', role: 'searchbox' })
          ]
        }
      });

      const result = planner.proposeStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status === 'ACTION') {
        expect(result.proposal.targetElementId).toBe('search-box');
        expect(result.proposal.actionType).toBe('type');
      }
    });

    it('F. After search submission: compound goal transitions to select_result', () => {
      const searchPhase: TaskPhase = {
        phaseId: 'p0',
        phaseIndex: 0,
        intent: 'search',
        description: 'Search for MrBeast',
        allowedActions: ['type']
      };
      const selectResultPhase: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'select_result',
        description: 'Select the video result',
        allowedActions: ['click']
      };
      const plan: TaskPlan = {
        planId: 'plan-comp',
        archetype: 'search_and_act',
        summary: 'Search and play',
        phases: [searchPhase, selectResultPhase],
        currentPhaseIndex: 0
      };

      const historyAfterSearch = [
        {
          stepIndex: 0,
          action: {
            id: 'act-0',
            type: 'type' as const,
            target: createMockActionTarget({ elementId: 'search-input', role: 'searchbox' }),
            payload: { text: 'MrBeast', pressEnter: true }
          },
          perceivedOutcome: 'success' as const,
          phaseIndex: 0,
          phaseIntent: 'search' as const
        }
      ];

      const active = resolveActivePhase(
        { id: 'goal-comp', description: 'Search for MrBeast and play the first video', taskPlan: plan },
        undefined,
        historyAfterSearch
      );

      expect(active?.phaseIndex).toBe(1);
      expect(active?.intent).toBe('select_result');
    });

    it('G. select_result phase: actual result links remain selectable and preferred', () => {
      const searchBox = createMockPageElement({
        id: 'search-input',
        tagName: 'input',
        role: 'searchbox',
        accessibleName: 'Search',
        visibleText: 'MrBeast',
        interactive: true
      });
      const videoResultLink = createMockPageElement({
        id: 'video-card-1',
        tagName: 'a',
        role: 'link',
        accessibleName: 'MrBeast: $1,000,000 Video',
        visibleText: 'MrBeast: $1,000,000 Video',
        attributes: { href: '/watch?v=123' },
        interactive: true
      });

      const selectResultPhase: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'select_result',
        description: 'Select the video result',
        targetHint: 'MrBeast',
        allowedActions: ['click']
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'goal-select',
          description: 'Search for MrBeast and play the first video',
          intent: 'click',
          taskPlan: {
            planId: 'plan-select',
            archetype: 'search_and_act',
            summary: 'Search and play',
            phases: [
              { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search', allowedActions: ['type'] },
              selectResultPhase
            ],
            currentPhaseIndex: 1
          }
        },
        context: {
          page: createMockPage([searchBox, videoResultLink]),
          availableTargets: [
            createMockActionTarget({ elementId: 'search-input', role: 'searchbox' }),
            createMockActionTarget({ elementId: 'video-card-1', role: 'link' })
          ],
          phaseState: {
            activePhase: selectResultPhase,
            completedPhaseIds: ['p0'],
            remainingPhaseIds: [],
            totalPhases: 2,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const result = planner.proposeStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status === 'ACTION') {
        expect(result.proposal.targetElementId).toBe('video-card-1');
        expect(result.proposal.actionType).toBe('click');
      }
    });

    it('H. Content result candidate is strictly preferred over generic profile/channel link in select_result', () => {
      // Channel / profile card appears earlier in DOM, has more tokens matching "MrBeast"
      const channelCard = createMockPageElement({
        id: 'channel-card-elem-1',
        tagName: 'a',
        role: 'link',
        accessibleName: 'MrBeast @MrBeast • 519M subscribers • Official MrBeast Channel',
        visibleText: 'MrBeast @MrBeast • 519M subscribers',
        attributes: { href: '/@MrBeast' },
        interactive: true
      });

      // Video result appears later in DOM with media URL and timestamp
      const videoResult = createMockPageElement({
        id: 'video-card-elem-2',
        tagName: 'a',
        role: 'link',
        accessibleName: '$456,000 Squid Game In Real Life! by MrBeast 25 minutes 758M views',
        visibleText: '$456,000 Squid Game In Real Life!',
        attributes: { href: '/watch?v=0e3GPea1Tyg' },
        interactive: true
      });

      const selectResultPhase: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'select_result',
        description: 'Select the first video',
        targetHint: 'MrBeast',
        allowedActions: ['click']
      };

      const input = createMockPlannerInput({
        goal: {
          id: 'goal-play',
          description: 'Search for MrBeast and play the first video',
          intent: 'click',
          taskPlan: {
            planId: 'plan-play',
            archetype: 'search_and_act',
            summary: 'Search and play',
            phases: [
              { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search for MrBeast', allowedActions: ['type'] },
              selectResultPhase
            ],
            currentPhaseIndex: 1
          }
        },
        context: {
          // Channel card appears first in DOM order
          page: createMockPage([channelCard, videoResult]),
          availableTargets: [
            createMockActionTarget({ elementId: 'channel-card-elem-1', role: 'link' }),
            createMockActionTarget({ elementId: 'video-card-elem-2', role: 'link' })
          ],
          phaseState: {
            activePhase: selectResultPhase,
            completedPhaseIds: ['p0'],
            remainingPhaseIds: [],
            totalPhases: 2,
            retryCountInCurrentPhase: 0,
            phaseStatus: 'in_progress',
            phaseAttempts: 0
          }
        }
      });

      const result = planner.proposeStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status === 'ACTION') {
        // Video candidate MUST be selected, NOT the channel card
        expect(result.proposal.targetElementId).toBe('video-card-elem-2');
        expect(result.proposal.actionType).toBe('click');
      }
    });

    it('I. Generic content vs profile helpers correctly classify elements and URLs', () => {
      expect(isMediaContentGoal('Search for MrBeast and play the first video')).toBe(true);
      expect(isMediaContentGoal('Watch this video')).toBe(true);
      expect(isMediaContentGoal('Search for laptops under ₹50,000')).toBe(false);

      expect(isProfileOrChannelUrl('/@MrBeast')).toBe(true);
      expect(isProfileOrChannelUrl('/channel/UCX6OQ3DkcsbYNE6H8uQQuVA')).toBe(true);
      expect(isProfileOrChannelUrl('/user/someone')).toBe(true);
      expect(isProfileOrChannelUrl('/watch?v=123')).toBe(false);

      expect(isMediaContentUrl('/watch?v=123')).toBe(true);
      expect(isMediaContentUrl('/video/abc')).toBe(true);
      expect(isMediaContentUrl('/@MrBeast')).toBe(false);

      const channelElem = createMockPageElement({
        id: 'c1',
        role: 'link',
        accessibleName: '@Creator 100K subscribers',
        attributes: { href: '/@Creator' }
      });
      expect(isProfileOrChannelCandidate(channelElem)).toBe(true);
      expect(isMediaContentCandidate(channelElem)).toBe(false);

      const videoElem = createMockPageElement({
        id: 'v1',
        role: 'link',
        accessibleName: 'Awesome Clip 12:34 50K views',
        attributes: { href: '/watch?v=xyz' }
      });
      expect(isProfileOrChannelCandidate(videoElem)).toBe(false);
      expect(isMediaContentCandidate(videoElem)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // NexBank & Generic Item-Retrieval Search Tests (Regression Suite)
  // -------------------------------------------------------------------------
  describe('NexBank & Generic Item-Retrieval Search Tests (Regression Suite)', () => {
    it('1. Search query extraction: "Find my latest Amazon transaction." -> "Amazon"', () => {
      expect(extractSearchQueryFromGoal(undefined, 'Find my latest Amazon transaction.')).toBe('Amazon');
      expect(extractSearchQueryFromGoal('Search for the latest Amazon transaction.', 'Find my latest Amazon transaction.')).toBe('Amazon');
    });

    it('2. Search query extraction: "Find my latest Swiggy transaction." -> "Swiggy"', () => {
      expect(extractSearchQueryFromGoal(undefined, 'Find my latest Swiggy transaction.')).toBe('Swiggy');
      expect(extractSearchQueryFromGoal('Search for latest Swiggy transaction', undefined)).toBe('Swiggy');
    });

    it('3. "latest" is not included in search query for generic entity-retrieval goals', () => {
      const q1 = extractSearchQueryFromGoal(undefined, 'Find my latest Amazon transaction.');
      expect(q1).not.toContain('latest');
      expect(q1).toBe('Amazon');

      const q2 = extractSearchQueryFromGoal(undefined, 'Find my most recent salary transaction.');
      expect(q2).not.toContain('most recent');
      expect(q2).not.toContain('recent');
      expect(q2).toBe('salary');

      const q3 = extractSearchQueryFromGoal(undefined, 'Find the latest Netflix payment.');
      expect(q3).not.toContain('latest');
      expect(q3).not.toContain('payment');
      expect(q3).toBe('Netflix');
    });

    it('5. Latest matching transaction is selected based on parsed date recency', async () => {
      const rowOldest = createMockPageElement({
        id: 'txn-011',
        tagName: 'tr',
        role: 'generic',
        attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-02' },
        visibleText: 'Amazon Shopping −₹3,799 02 Sep 2026 Completed',
        interactive: true
      });
      const rowMiddle = createMockPageElement({
        id: 'txn-008',
        tagName: 'tr',
        role: 'generic',
        attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-25' },
        visibleText: 'Amazon Shopping −₹2,199 25 Sep 2026 Completed',
        interactive: true
      });
      const rowLatest = createMockPageElement({
        id: 'txn-001',
        tagName: 'tr',
        role: 'generic',
        attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' },
        visibleText: 'Amazon Shopping −₹4,299 30 Sep 2026 Completed',
        interactive: true
      });

      // Provide oldest first in availableTargets to ensure selection is NOT based on DOM position
      const targetOldest = createMockActionTarget({ elementId: 'txn-011', role: 'generic', confidence: 0.9 });
      const targetMiddle = createMockActionTarget({ elementId: 'txn-008', role: 'generic', confidence: 0.9 });
      const targetLatest = createMockActionTarget({ elementId: 'txn-001', role: 'generic', confidence: 0.9 });

      const input = createMockPlannerInput({
        goal: {
          id: 'g-amazon-latest',
          description: 'Find my latest Amazon transaction.',
          taskPlan: {
            planId: 'plan-1',
            archetype: 'search_and_act',
            summary: 'Find latest Amazon transaction',
            phases: [
              { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search Amazon', allowedActions: ['type'] },
              { phaseId: 'p1', phaseIndex: 1, intent: 'select_result', description: 'Select latest transaction', targetHint: 'Amazon', allowedActions: ['click'] }
            ],
            currentPhaseIndex: 1
          }
        },
        context: {
          page: createMockPage([rowOldest, rowMiddle, rowLatest]),
          availableTargets: [targetOldest, targetMiddle, targetLatest],
          phaseState: {
            activePhase: { phaseId: 'p1', phaseIndex: 1, intent: 'select_result', description: 'Select latest transaction', targetHint: 'Amazon', allowedActions: ['click'] },
            completedPhaseIds: ['p0'],
            remainingPhaseIds: [],
            totalPhases: 2,
            retryCountInCurrentPhase: 0
          }
        },
        history: [
          {
            stepIndex: 0,
            action: { id: 'act-type-amazon', type: 'type', target: createMockActionTarget({ elementId: 'search-input', role: 'searchbox', confidence: 0.9 }), payload: { text: 'Amazon', pressEnter: true } },
            perceivedOutcome: 'success',
            phaseIndex: 0
          }
        ]
      });

      const result = await planNextStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status === 'ACTION') {
        expect(result.targetElementId).toBe('txn-001'); // strictly 30 Sep 2026 row!
        expect(result.action.type).toBe('click');
      }
    });
  });

  describe('Intent Understanding & Entity Extraction Regression Suite (Repair Verification)', () => {
    it('Instruction A: "Find my latest Amazon transaction and show its details."', () => {
      const parsed = cleanSearchQueryCandidate('Find my latest Amazon transaction and show its details.');
      expect(parsed.merchant).toBe('Amazon');
      expect(parsed.query).toBe('Amazon');
      expect(parsed.constraint).toBe('latest');
      expect(parsed.isLatest).toBe(true);
      expect(parsed.entityNoun).toBe('transaction');
      expect(parsed.requestedAction).toBe('show its details');
      expect(extractSearchQueryFromGoal('Find my latest Amazon transaction and show its details.')).toBe('Amazon');
    });

    it('Instruction B: "Show me the most recent Swiggy payment."', () => {
      const parsed = cleanSearchQueryCandidate('Show me the most recent Swiggy payment.');
      expect(parsed.merchant).toBe('Swiggy');
      expect(parsed.query).toBe('Swiggy');
      expect(parsed.constraint).toBe('most recent');
      expect(parsed.isLatest).toBe(true);
      expect(parsed.entityNoun).toBe('payment');
      expect(extractSearchQueryFromGoal('Show me the most recent Swiggy payment.')).toBe('Swiggy');
    });

    it('Instruction C: "Open my Netflix transaction from September."', () => {
      const parsed = cleanSearchQueryCandidate('Open my Netflix transaction from September.');
      expect(parsed.merchant).toBe('Netflix');
      expect(parsed.query).toBe('Netflix');
      expect(parsed.temporalFilter?.toLowerCase()).toBe('september');
      expect(parsed.entityNoun).toBe('transaction');
      expect(extractSearchQueryFromGoal('Open my Netflix transaction from September.')).toBe('Netflix');
    });

    it('Instruction D: "Find the Amazon transaction for ₹4,299."', () => {
      const parsed = cleanSearchQueryCandidate('Find the Amazon transaction for ₹4,299.');
      expect(parsed.merchant).toBe('Amazon');
      expect(parsed.query).toBe('Amazon');
      expect(parsed.amountFilter).toBe('₹4,299');
      expect(parsed.entityNoun).toBe('transaction');
      expect(extractSearchQueryFromGoal('Find the Amazon transaction for ₹4,299.')).toBe('Amazon');
    });

    it('Instruction E: "Show the details of my latest transaction."', () => {
      const parsed = cleanSearchQueryCandidate('Show the details of my latest transaction.');
      expect(parsed.merchant).toBeUndefined();
      expect(parsed.constraint).toBe('latest');
      expect(parsed.isLatest).toBe(true);
      expect(parsed.entityNoun).toBe('transaction');
      // No merchant should be extracted
      expect(parsed.query).toBeUndefined();
    });

    it('Instruction F: "Find my most recent transaction from Amazon and tell me its amount."', () => {
      const parsed = cleanSearchQueryCandidate('Find my most recent transaction from Amazon and tell me its amount.');
      expect(parsed.merchant).toBe('Amazon');
      expect(parsed.query).toBe('Amazon');
      expect(parsed.constraint).toBe('most recent');
      expect(parsed.isLatest).toBe(true);
      expect(parsed.entityNoun).toBe('transaction');
      expect(parsed.requestedAction).toBe('tell me its amount');
      expect(extractSearchQueryFromGoal('Find my most recent transaction from Amazon and tell me its amount.')).toBe('Amazon');
    });

    it('Distinguishes action phrases and words from search entities', () => {
      const actionWords = ['find', 'latest', 'transaction', 'show', 'details', 'and', 'my', 'the'];
      const query = extractSearchQueryFromGoal('Find my latest Amazon transaction and show its details.');
      expect(query).toBe('Amazon');
      expect(query).toBeDefined();
      for (const word of actionWords) {
        expect(query!.toLowerCase()).not.toContain(word);
      }
    });

    it('Handles sequential tasks with different merchants without leaking prior state', () => {
      const merchants = ['Amazon', 'Swiggy', 'Netflix', 'Flipkart', 'Uber'];
      for (const merchant of merchants) {
        const goal = `Find my latest ${merchant} transaction and show its details.`;
        const extracted = extractSearchQueryFromGoal(goal);
        expect(extracted).toBe(merchant);
      }
    });

    describe('Phase 3 Regression: Search Query Validation & Normalization', () => {
      it('Full instruction incorrectly returned as search text is normalized to extracted merchant', () => {
        const goal = 'Find my latest Amazon transaction and show its details';
        const rawLLMQuery = 'amazon transaction and show its';
        const validated = validateAndNormalizeSearchQuery(rawLLMQuery, goal);
        expect(validated.valid).toBe(true);
        expect(validated.query).toBe('Amazon');
        expect(validated.merchant).toBe('Amazon');

        const fullInstructionQuery = 'Find my latest Amazon transaction and show its details';
        const validatedFull = validateAndNormalizeSearchQuery(fullInstructionQuery, goal);
        expect(validatedFull.valid).toBe(true);
        expect(validatedFull.query).toBe('Amazon');
      });

      it('Correct merchant extraction across diverse instructions', () => {
        const amazon = validateAndNormalizeSearchQuery('', 'Find my latest Amazon transaction and show its details');
        expect(amazon.valid).toBe(true);
        expect(amazon.query).toBe('Amazon');
        expect(amazon.merchant).toBe('Amazon');

        const swiggy = validateAndNormalizeSearchQuery('Find my latest Swiggy order', 'Find my latest Swiggy order');
        expect(swiggy.valid).toBe(true);
        expect(swiggy.query).toBe('Swiggy');
        expect(swiggy.merchant).toBe('Swiggy');

        const netflix = validateAndNormalizeSearchQuery('netflix payment', 'Find my Netflix payment');
        expect(netflix.valid).toBe(true);
        expect(netflix.query).toBe('Netflix');
        expect(netflix.merchant).toBe('Netflix');
      });

      it('Preserves legitimate multi-word search terms without reducing to single word', () => {
        const docQuery = validateAndNormalizeSearchQuery(
          'Search for installation guide',
          'Search for installation guide',
          undefined,
          [{ id: 'item-1', role: 'button', visibleText: 'Installation Guide' }]
        );
        expect(docQuery.valid).toBe(true);
        expect(docQuery.query).toBe('Installation Guide');
        expect(docQuery.query?.split(' ').length).toBe(2);

        const openDocsQuery = validateAndNormalizeSearchQuery('', 'Find the Installation Guide');
        expect(openDocsQuery.valid).toBe(true);
        expect(openDocsQuery.query).toBe('Installation Guide');

        const multiWordWithPage = validateAndNormalizeSearchQuery(
          'installation guide',
          'Search for installation guide',
          undefined,
          [{ id: 'item-1', role: 'button', visibleText: 'Installation Guide' }]
        );
        expect(multiWordWithPage.valid).toBe(true);
        expect(multiWordWithPage.query).toBe('Installation Guide');
      });

      it('Date-filtered merchant searches preserve search query and temporal filter constraint', () => {
        const result = validateAndNormalizeSearchQuery('', 'Find transactions from Amazon for September');
        expect(result.valid).toBe(true);
        expect(result.query).toBe('Amazon');
        expect(result.merchant).toBe('Amazon');
        expect(result.temporalFilter?.toLowerCase()).toBe('september');
      });

      it('Full-date and amount instructions correctly normalize merchant and extract constraints', () => {
        const amountRes = validateAndNormalizeSearchQuery('', 'Find my Amazon transaction for ₹4,299.');
        expect(amountRes.valid).toBe(true);
        expect(amountRes.query).toBe('Amazon');
        expect(amountRes.merchant).toBe('Amazon');
        expect(amountRes.amountFilter).toBe('₹4,299');

        const dateRes = validateAndNormalizeSearchQuery('', 'Show me the Amazon transaction from 30 September 2026.');
        expect(dateRes.valid).toBe(true);
        expect(dateRes.query).toBe('Amazon');
        expect(dateRes.merchant).toBe('Amazon');
        expect(dateRes.temporalFilter).toBe('30 September 2026');

        const convRes = validateAndNormalizeSearchQuery('', 'Can you show me the most recent purchase I made on Amazon?');
        expect(convRes.valid).toBe(true);
        expect(convRes.query).toBe('Amazon');
      });

      it('Ambiguous search instructions cannot be safely resolved and are rejected', () => {
        const ambiguous1 = validateAndNormalizeSearchQuery('transaction', 'Show the details of my latest transaction.');
        expect(ambiguous1.valid).toBe(false);
        expect(ambiguous1.isAmbiguous).toBe(true);
        expect(ambiguous1.reason).toContain('AMBIGUOUS_SEARCH_QUERY');

        const ambiguous2 = validateAndNormalizeSearchQuery('details', 'Show details of recent orders');
        expect(ambiguous2.valid).toBe(false);
        expect(ambiguous2.isAmbiguous).toBe(true);
      });

      it('Existing deterministic planner behaviour utilizes validated search query for search intent', async () => {
        const planner = new DeterministicRulePlanner();
        const input: PlannerInput = {
          goal: {
            id: 'g-det-search',
            description: 'Find my latest Amazon transaction and show its details',
            intent: 'search'
          },
          context: {
            stepIndex: 0,
            capturedAt: Date.now(),
            currentTime: Date.now(),
            page: {
              schemaVersion: '1.0',
              metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
              viewport: { width: 1280, height: 720 },
              elements: [
                { id: 'txn-search-input', role: 'searchbox', interactive: true, attributes: { role: 'searchbox', name: 'search' } }
              ]
            },
            availableTargets: [
              {
                elementId: 'txn-search-input',
                point: { x: 100, y: 100 },
                viewportBounds: { x: 50, y: 80, width: 200, height: 40 },
                confidence: 0.95,
                observationId: 'obs-1',
                role: 'searchbox'
              }
            ]
          }
        };

        const decision = await planner.proposeStep(input);
        expect(decision.status).toBe('ACTION');
        if (decision.status === 'ACTION') {
          expect(decision.proposal.actionType).toBe('type');
          expect(decision.proposal.payload?.text).toBe('Amazon');
          expect(decision.proposal.payload?.pressEnter).toBe(true);
        }
      });
    });
  });
});
