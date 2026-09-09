/**
 * Phase 2F-3 — Action Target & Intended Action Contract: Test Suite.
 *
 * Covers all required test scenarios from the approved implementation plan.
 * No browser execution, no Chrome APIs, no DOM access.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveActionTarget,
  createIntendedAction,
  validateIntendedAction,
  computeTargetPoint
} from './actions.js';
import type {
  ActionTarget,
  ActionTargetOptions,
  CreateActionRequest,
  ClickAction,
  TypeAction,
  FocusAction
} from './actions.js';
import type { GroundingSuccessResult, GroundingUnmatchedResult, GroundingUnmatchedReason } from './grounding.js';
import type { CssViewportRect } from './coordinates.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const VALID_BOX: CssViewportRect = { x: 100, y: 200, width: 160, height: 40 };

const VALID_GROUNDING: GroundingSuccessResult = {
  matched: true,
  observationId: 'obs-1',
  elementId: 'elem-btn-1',
  normalizedCssBox: { ...VALID_BOX },
  groundingConfidence: 0.85,
  scoreBreakdown: {
    iou: 0.75,
    visualContainment: 0.90,
    elementContainment: 0.80,
    centerProximity: 0.95,
    isVisualCenterInsideDom: true,
    geometricScore: 0.82,
    semanticScore: 0.90,
    interactivityScore: 1.0,
    totalScore: 0.87
  }
};

function makeUnmatchedResult(
  reason: GroundingUnmatchedReason = 'NO_DOM_CANDIDATES',
  message = 'No DOM candidates found',
  observationId?: string
): GroundingUnmatchedResult {
  return {
    matched: false,
    reason,
    message,
    observationId
  };
}

function makeValidTarget(overrides?: Partial<ActionTarget>): ActionTarget {
  const result = resolveActionTarget(VALID_GROUNDING);
  if (!result.success) throw new Error('Expected success');
  return { ...result.target, ...overrides };
}

// ---------------------------------------------------------------------------
// computeTargetPoint helper
// ---------------------------------------------------------------------------

describe('computeTargetPoint', () => {
  it('computes center point by default', () => {
    const bounds = { x: 100, y: 200, width: 160, height: 40 };
    const pt = computeTargetPoint(bounds);
    expect(pt.x).toBe(180); // 100 + 160 * 0.5
    expect(pt.y).toBe(220); // 200 + 40 * 0.5
  });

  it('computes custom offset point', () => {
    const bounds = { x: 10, y: 20, width: 100, height: 80 };
    const pt = computeTargetPoint(bounds, { xPercent: 0.25, yPercent: 0.75 });
    expect(pt.x).toBe(35);  // 10 + 100 * 0.25
    expect(pt.y).toBe(80);  // 20 + 80 * 0.75
  });

  it('clamps offset values above 1 to 1', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const pt = computeTargetPoint(bounds, { xPercent: 2.0, yPercent: 5.0 });
    expect(pt.x).toBe(100);
    expect(pt.y).toBe(100);
  });

  it('clamps offset values below 0 to 0', () => {
    const bounds = { x: 50, y: 50, width: 100, height: 100 };
    const pt = computeTargetPoint(bounds, { xPercent: -1, yPercent: -3 });
    expect(pt.x).toBe(50);
    expect(pt.y).toBe(50);
  });

  it('preserves floating-point precision without rounding', () => {
    const bounds = { x: 0, y: 0, width: 3, height: 7 };
    const pt = computeTargetPoint(bounds, { xPercent: 1 / 3, yPercent: 2 / 7 });
    expect(pt.x).toBeCloseTo(1.0, 10);
    expect(pt.y).toBeCloseTo(2.0, 10);
  });
});

// ---------------------------------------------------------------------------
// resolveActionTarget — TARGET RESOLUTION scenarios
// ---------------------------------------------------------------------------

describe('resolveActionTarget', () => {
  // Scenario 1: Valid grounding → ActionTarget
  it('resolves valid grounding to ActionTarget', () => {
    const result = resolveActionTarget(VALID_GROUNDING);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const t = result.target;
    expect(t.elementId).toBe('elem-btn-1');
    expect(t.observationId).toBe('obs-1');
    expect(t.confidence).toBe(0.85);
    expect(t.viewportBounds).toEqual(VALID_BOX);
    // Default center point: 100 + 80 = 180, 200 + 20 = 220
    expect(t.point.x).toBe(180);
    expect(t.point.y).toBe(220);
  });

  // Scenario 2: Unmatched grounding → UNMATCHED_GROUNDING
  it('returns UNMATCHED_GROUNDING for NO_DOM_CANDIDATES', () => {
    const result = resolveActionTarget(makeUnmatchedResult('NO_DOM_CANDIDATES', 'No elements found'));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('UNMATCHED_GROUNDING');
    expect(result.groundingReason).toBe('NO_DOM_CANDIDATES');
  });

  it('returns UNMATCHED_GROUNDING for BELOW_SCORE_THRESHOLD', () => {
    const result = resolveActionTarget(makeUnmatchedResult('BELOW_SCORE_THRESHOLD', 'Score too low'));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('UNMATCHED_GROUNDING');
    expect(result.groundingReason).toBe('BELOW_SCORE_THRESHOLD');
  });

  it('propagates grounding message in UNMATCHED_GROUNDING', () => {
    const msg = 'Custom unmatched message';
    const result = resolveActionTarget(makeUnmatchedResult('OUT_OF_BOUNDS', msg));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toBe(msg);
  });

  // Scenario 3: minConfidence 0.85 rejects confidence 0.72
  it('rejects grounding below minConfidence threshold', () => {
    const lowConf: GroundingSuccessResult = { ...VALID_GROUNDING, groundingConfidence: 0.72 };
    const result = resolveActionTarget(lowConf, { minConfidence: 0.85 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('LOW_CONFIDENCE');
    expect(result.confidence).toBe(0.72);
  });

  // Scenario 4: minConfidence 0.50 accepts confidence 0.72
  it('accepts grounding above minConfidence threshold', () => {
    const lowConf: GroundingSuccessResult = { ...VALID_GROUNDING, groundingConfidence: 0.72 };
    const result = resolveActionTarget(lowConf, { minConfidence: 0.50 });
    expect(result.success).toBe(true);
  });

  it('accepts grounding at exactly the minConfidence boundary', () => {
    const conf: GroundingSuccessResult = { ...VALID_GROUNDING, groundingConfidence: 0.70 };
    const result = resolveActionTarget(conf, { minConfidence: 0.70 });
    expect(result.success).toBe(true);
  });

  // Scenario 5: Custom point offset 0.25 / 0.75
  it('uses custom pointOffset for target point calculation', () => {
    const result = resolveActionTarget(VALID_GROUNDING, {
      pointOffset: { xPercent: 0.25, yPercent: 0.75 }
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // x = 100 + 160 * 0.25 = 140
    // y = 200 + 40 * 0.75 = 230
    expect(result.target.point.x).toBe(140);
    expect(result.target.point.y).toBe(230);
  });

  // Scenario 6: width = 0 rejected
  it('rejects bounds with width = 0', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, normalizedCssBox: { x: 0, y: 0, width: 0, height: 50 } };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_BOUNDS');
  });

  // Scenario 7: height = 0 rejected
  it('rejects bounds with height = 0', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, normalizedCssBox: { x: 0, y: 0, width: 50, height: 0 } };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_BOUNDS');
  });

  // Scenario 8: negative width rejected
  it('rejects bounds with negative width', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, normalizedCssBox: { x: 0, y: 0, width: -10, height: 50 } };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_BOUNDS');
  });

  // Scenario 9: negative height rejected
  it('rejects bounds with negative height', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, normalizedCssBox: { x: 0, y: 0, width: 50, height: -5 } };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_BOUNDS');
  });

  // Scenario 10: NaN / Infinity bounds rejected
  it('rejects bounds with NaN width', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, normalizedCssBox: { x: 0, y: 0, width: NaN, height: 50 } };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_BOUNDS');
  });

  it('rejects bounds with Infinity height', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, normalizedCssBox: { x: 0, y: 0, width: 50, height: Infinity } };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_BOUNDS');
  });

  it('rejects bounds with NaN x coordinate', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, normalizedCssBox: { x: NaN, y: 0, width: 50, height: 50 } };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_BOUNDS');
  });

  it('rejects bounds with Infinity y coordinate', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, normalizedCssBox: { x: 0, y: -Infinity, width: 50, height: 50 } };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_BOUNDS');
  });

  // Scenario 11: empty element ID rejected
  it('rejects empty elementId', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, elementId: '' };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_ELEMENT_ID');
  });

  it('accepts role option and carries it to ActionTarget', () => {
    const result = resolveActionTarget(VALID_GROUNDING, { role: 'button' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.target.role).toBe('button');
  });

  it('does not include role when not provided', () => {
    const result = resolveActionTarget(VALID_GROUNDING);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect('role' in result.target).toBe(false);
  });

  it('does not mutate the input grounding result', () => {
    const original = { ...VALID_GROUNDING, normalizedCssBox: { ...VALID_BOX } };
    const originalBox = { ...original.normalizedCssBox };
    resolveActionTarget(original, { pointOffset: { xPercent: 0.1, yPercent: 0.9 } });
    expect(original.normalizedCssBox).toEqual(originalBox);
  });
});

// ---------------------------------------------------------------------------
// createIntendedAction — ACTION CREATION scenarios
// ---------------------------------------------------------------------------

describe('createIntendedAction', () => {
  // Scenario 12: Valid click
  it('creates a valid ClickAction', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action as ClickAction;
    expect(action.type).toBe('click');
    expect(action.target.elementId).toBe('elem-btn-1');
  });

  // Scenario 13: Valid type with payload
  it('creates a valid TypeAction with payload', () => {
    const req: CreateActionRequest = {
      type: 'type',
      target: VALID_GROUNDING,
      payload: { text: 'search query', clearFirst: true }
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action as TypeAction;
    expect(action.type).toBe('type');
    expect(action.payload.text).toBe('search query');
    expect(action.payload.clearFirst).toBe(true);
  });

  // Scenario 14: Missing type payload rejected
  it('rejects type action with missing payload', () => {
    const req: CreateActionRequest = {
      type: 'type',
      target: VALID_GROUNDING
      // no payload
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('MISSING_PAYLOAD');
  });

  // Scenario 15: Non-string type payload text rejected
  it('rejects type action with non-string text', () => {
    const req = {
      type: 'type' as const,
      target: VALID_GROUNDING,
      payload: { text: 42 }
    } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_PAYLOAD');
  });

  // Scenario 16: Empty type text accepted
  it('accepts type action with empty string text', () => {
    const req: CreateActionRequest = {
      type: 'type',
      target: VALID_GROUNDING,
      payload: { text: '' }
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action as TypeAction;
    expect(action.payload.text).toBe('');
  });

  // Scenario 17: Invalid clearFirst rejected
  it('rejects type action with non-boolean clearFirst', () => {
    const req = {
      type: 'type' as const,
      target: VALID_GROUNDING,
      payload: { text: 'hello', clearFirst: 'yes' }
    } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_PAYLOAD');
  });

  // Scenario 18: Invalid pressEnter rejected
  it('rejects type action with non-boolean pressEnter', () => {
    const req = {
      type: 'type' as const,
      target: VALID_GROUNDING,
      payload: { text: 'hello', pressEnter: 1 }
    } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_PAYLOAD');
  });

  // Scenario 19: Valid focus
  it('creates a valid FocusAction', () => {
    const req: CreateActionRequest = {
      type: 'focus',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action as FocusAction;
    expect(action.type).toBe('focus');
  });

  // Scenario 20: Direct GroundingResult → IntendedAction
  it('resolves GroundingResult directly to IntendedAction', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.target.observationId).toBe('obs-1');
  });

  // Scenario 21: Direct unmatched GroundingResult → INVALID_TARGET
  it('returns INVALID_TARGET when target is unmatched GroundingResult', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: makeUnmatchedResult('NO_DOM_CANDIDATES')
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.targetFailure).toBeDefined();
    expect(result.targetFailure?.reason).toBe('UNMATCHED_GROUNDING');
  });

  // Scenario 22: Unsupported runtime action type rejected
  it('rejects unsupported action type scroll', () => {
    const req = {
      type: 'scroll' as unknown as 'click',
      target: VALID_GROUNDING
    } as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('UNSUPPORTED_ACTION_TYPE');
  });

  it('rejects unsupported action type hover', () => {
    const req = {
      type: 'hover' as unknown as 'click',
      target: VALID_GROUNDING
    } as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('UNSUPPORTED_ACTION_TYPE');
  });

  it('rejects unsupported action type navigate', () => {
    const req = {
      type: 'navigate' as unknown as 'click',
      target: VALID_GROUNDING
    } as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('UNSUPPORTED_ACTION_TYPE');
  });

  // Scenario 23: Extraneous click/focus payload permitted and ignored
  it('permits and ignores extraneous payload on click', () => {
    const req = {
      type: 'click' as const,
      target: VALID_GROUNDING,
      payload: { text: 'should-be-ignored' } as { text: string }
    } as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action as ClickAction;
    expect(action.type).toBe('click');
    expect('payload' in action).toBe(false);
  });

  it('permits and ignores extraneous payload on focus', () => {
    const req = {
      type: 'focus' as const,
      target: VALID_GROUNDING,
      payload: { text: 'should-be-ignored' } as { text: string }
    } as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action as FocusAction;
    expect(action.type).toBe('focus');
    expect('payload' in action).toBe(false);
  });

  it('accepts ActionTarget directly (pre-resolved)', () => {
    const target = makeValidTarget();
    const req: CreateActionRequest = {
      type: 'click',
      target
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.target.elementId).toBe(target.elementId);
  });

  it('rejects pre-resolved ActionTarget with zero-area bounds', () => {
    const target = makeValidTarget({
      viewportBounds: { x: 0, y: 0, width: 0, height: 40 }
    });
    const req: CreateActionRequest = {
      type: 'click',
      target
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.targetFailure?.reason).toBe('INVALID_BOUNDS');
  });
});

// ---------------------------------------------------------------------------
// DETERMINISM / VALIDATION scenarios
// ---------------------------------------------------------------------------

describe('determinism invariants', () => {
  // Scenario 24: Same request twice → deep-equal result
  it('produces deep-equal results for identical requests', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING
    };
    const r1 = createIntendedAction(req);
    const r2 = createIntendedAction(req);
    expect(r1).toEqual(r2);
  });

  it('produces deep-equal results for type actions with identical requests', () => {
    const req: CreateActionRequest = {
      type: 'type',
      target: VALID_GROUNDING,
      payload: { text: 'hello', clearFirst: true }
    };
    const r1 = createIntendedAction(req);
    const r2 = createIntendedAction(req);
    expect(r1).toEqual(r2);
  });

  // Scenario 25: Generated ID exactly `intent_${observationId}_${type}`
  it('generates deterministic ID: intent_<observationId>_<type>', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.id).toBe('intent_obs-1_click');
  });

  it('generates correct ID for focus action', () => {
    const req: CreateActionRequest = {
      type: 'focus',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.id).toBe('intent_obs-1_focus');
  });

  it('generates correct ID for type action', () => {
    const req: CreateActionRequest = {
      type: 'type',
      target: VALID_GROUNDING,
      payload: { text: 'query' }
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.id).toBe('intent_obs-1_type');
  });

  // Scenario 26: Explicit ID preserved
  it('preserves explicit request.id verbatim', () => {
    const req: CreateActionRequest = {
      id: 'custom-action-id-xyz',
      type: 'click',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.id).toBe('custom-action-id-xyz');
  });

  it('rejects empty explicit ID', () => {
    const req: CreateActionRequest = {
      id: '',
      type: 'click',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_ACTION_ID');
  });

  // Scenario 27: Explicit timestamp preserved
  it('preserves explicit timestamp', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING,
      timestamp: 1725883200000
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.timestamp).toBe(1725883200000);
  });

  // Scenario 28: Missing timestamp remains undefined
  it('leaves timestamp undefined when not supplied', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.timestamp).toBeUndefined();
  });

  it('generated ID does not contain timestamp-like or random data', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // ID must be exactly intent_<observationId>_<type>, nothing else
    expect(result.action.id).toMatch(/^intent_[^_]+_(click|type|focus)$/);
  });
});

// ---------------------------------------------------------------------------
// validateIntendedAction scenarios
// ---------------------------------------------------------------------------

describe('validateIntendedAction', () => {
  function makePlainAction(overrides?: Record<string, unknown>) {
    return {
      id: 'action-id-1',
      type: 'click',
      target: {
        elementId: 'elem-1',
        observationId: 'obs-1',
        confidence: 0.9,
        point: { x: 180, y: 220 },
        viewportBounds: { x: 100, y: 200, width: 160, height: 40 }
      },
      ...overrides
    };
  }

  // Scenario 29: validateIntendedAction accepts valid action
  it('accepts a valid ClickAction object', () => {
    const result = validateIntendedAction(makePlainAction());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.type).toBe('click');
    expect(result.action.id).toBe('action-id-1');
  });

  it('accepts a valid TypeAction object', () => {
    const obj = makePlainAction({
      type: 'type',
      payload: { text: 'hello world' }
    });
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action as TypeAction;
    expect(action.type).toBe('type');
    expect(action.payload.text).toBe('hello world');
  });

  it('accepts a valid FocusAction object', () => {
    const result = validateIntendedAction(makePlainAction({ type: 'focus' }));
    expect(result.success).toBe(true);
  });

  // Scenario 30: rejects malformed action
  it('rejects null', () => {
    const result = validateIntendedAction(null);
    expect(result.success).toBe(false);
  });

  it('rejects non-object primitive', () => {
    const result = validateIntendedAction(42);
    expect(result.success).toBe(false);
  });

  it('rejects action with missing id', () => {
    const { id: _, ...obj } = makePlainAction();
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_ACTION_ID');
  });

  it('rejects action with empty id', () => {
    const result = validateIntendedAction(makePlainAction({ id: '' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_ACTION_ID');
  });

  // Scenario 31: rejects zero-area bounds
  it('rejects action with zero-width viewportBounds', () => {
    const obj = makePlainAction({
      target: {
        elementId: 'elem-1',
        observationId: 'obs-1',
        confidence: 0.9,
        point: { x: 100, y: 200 },
        viewportBounds: { x: 100, y: 200, width: 0, height: 40 }
      }
    });
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('rejects action with zero-height viewportBounds', () => {
    const obj = makePlainAction({
      target: {
        elementId: 'elem-1',
        observationId: 'obs-1',
        confidence: 0.9,
        point: { x: 100, y: 200 },
        viewportBounds: { x: 100, y: 200, width: 40, height: 0 }
      }
    });
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
  });

  // Scenario 32: rejects invalid discriminator
  it('rejects unsupported type discriminator', () => {
    const result = validateIntendedAction(makePlainAction({ type: 'drag' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('UNSUPPORTED_ACTION_TYPE');
  });

  it('rejects missing type field', () => {
    const { type: _, ...obj } = makePlainAction();
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('UNSUPPORTED_ACTION_TYPE');
  });

  // Scenario 33: rejects invalid type payload
  it('rejects type action missing payload', () => {
    const obj = makePlainAction({ type: 'type' }); // no payload
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('MISSING_PAYLOAD');
  });

  it('rejects type action with non-string text', () => {
    const obj = makePlainAction({
      type: 'type',
      payload: { text: 123 }
    });
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_PAYLOAD');
  });

  it('rejects missing target', () => {
    const obj = { id: 'x', type: 'click' };
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('rejects missing target.elementId', () => {
    const obj = makePlainAction({
      target: {
        observationId: 'obs-1',
        confidence: 0.9,
        point: { x: 100, y: 200 },
        viewportBounds: { x: 0, y: 0, width: 50, height: 50 }
      }
    });
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('reconstructs clean action without mutating input', () => {
    const obj = makePlainAction();
    const original = JSON.parse(JSON.stringify(obj));
    validateIntendedAction(obj);
    expect(obj).toEqual(original);
  });

  it('accepts timestamp when supplied', () => {
    const obj = makePlainAction({ timestamp: 1725883200000 });
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.timestamp).toBe(1725883200000);
  });

  it('rejects non-finite timestamp', () => {
    const obj = makePlainAction({ timestamp: NaN });
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
  });

  it('preserves role when present', () => {
    const obj = makePlainAction({
      target: {
        elementId: 'elem-1',
        observationId: 'obs-1',
        confidence: 0.9,
        point: { x: 180, y: 220 },
        viewportBounds: { x: 100, y: 200, width: 160, height: 40 },
        role: 'button'
      }
    });
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.target.role).toBe('button');
  });
});

// ---------------------------------------------------------------------------
// Scenario 34: JSON round-trip serialization
// ---------------------------------------------------------------------------

describe('JSON serialization', () => {
  it('round-trips a ClickAction through JSON', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING,
      timestamp: 1725883200000
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action;
    const roundTripped = JSON.parse(JSON.stringify(action));
    expect(roundTripped).toEqual(action);
  });

  it('round-trips a TypeAction through JSON', () => {
    const req: CreateActionRequest = {
      type: 'type',
      target: VALID_GROUNDING,
      payload: { text: 'hello', clearFirst: true, pressEnter: false },
      timestamp: 1000000
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action;
    const roundTripped = JSON.parse(JSON.stringify(action));
    expect(roundTripped).toEqual(action);
  });

  it('omits undefined timestamp in JSON serialization', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const serialized = JSON.stringify(result.action);
    const parsed = JSON.parse(serialized);
    // JSON.stringify omits undefined properties; parsed object should not have 'timestamp'
    expect('timestamp' in parsed).toBe(false);
    expect(result.action.timestamp).toBeUndefined();
  });

  it('round-trips a FocusAction through JSON', () => {
    const req: CreateActionRequest = {
      type: 'focus',
      target: VALID_GROUNDING,
      timestamp: 5000
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const roundTripped = JSON.parse(JSON.stringify(result.action));
    expect(roundTripped).toEqual(result.action);
  });
});

// ---------------------------------------------------------------------------
// Scenario 35: Inputs are not mutated
// ---------------------------------------------------------------------------

describe('immutability invariants', () => {
  it('does not mutate the GroundingResult passed to createIntendedAction', () => {
    const original = { ...VALID_GROUNDING, normalizedCssBox: { ...VALID_BOX } };
    const snapshot = JSON.parse(JSON.stringify(original));
    createIntendedAction({ type: 'click', target: original });
    expect(original).toEqual(snapshot);
  });

  it('does not mutate the ActionTarget passed to createIntendedAction', () => {
    const target = makeValidTarget();
    const snapshot = JSON.parse(JSON.stringify(target));
    createIntendedAction({ type: 'focus', target });
    expect(target).toEqual(snapshot);
  });

  it('does not mutate the GroundingResult passed to resolveActionTarget', () => {
    const original = { ...VALID_GROUNDING, normalizedCssBox: { ...VALID_BOX } };
    const snapshot = JSON.parse(JSON.stringify(original));
    resolveActionTarget(original, { pointOffset: { xPercent: 0.3, yPercent: 0.7 } });
    expect(original).toEqual(snapshot);
  });

  it('does not mutate the action object passed to validateIntendedAction', () => {
    const obj = {
      id: 'test-id',
      type: 'click',
      target: {
        elementId: 'e1',
        observationId: 'o1',
        confidence: 0.8,
        point: { x: 50, y: 60 },
        viewportBounds: { x: 10, y: 20, width: 100, height: 80 }
      }
    };
    const snapshot = JSON.parse(JSON.stringify(obj));
    validateIntendedAction(obj);
    expect(obj).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Additional edge-case coverage
// ---------------------------------------------------------------------------

describe('additional edge cases', () => {
  it('accepts confidence exactly 0 (no minConfidence set)', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, groundingConfidence: 0 };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(true);
  });

  it('accepts confidence exactly 1', () => {
    const g: GroundingSuccessResult = { ...VALID_GROUNDING, groundingConfidence: 1 };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.target.confidence).toBe(1);
  });

  it('accepts off-screen coordinates (no viewport clamping)', () => {
    // Partially off-screen bounds should not be rejected
    const g: GroundingSuccessResult = {
      ...VALID_GROUNDING,
      normalizedCssBox: { x: -50, y: -20, width: 200, height: 100 }
    };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.target.viewportBounds.x).toBe(-50);
  });

  it('preserves floating-point coordinates in ActionTarget', () => {
    const g: GroundingSuccessResult = {
      ...VALID_GROUNDING,
      normalizedCssBox: { x: 10.5, y: 20.3, width: 100.7, height: 40.9 }
    };
    const result = resolveActionTarget(g);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.target.viewportBounds.x).toBe(10.5);
    expect(result.target.viewportBounds.y).toBe(20.3);
    expect(result.target.viewportBounds.width).toBe(100.7);
    expect(result.target.viewportBounds.height).toBe(40.9);
    // Center point
    expect(result.target.point.x).toBeCloseTo(60.85); // 10.5 + 50.35
    expect(result.target.point.y).toBeCloseTo(40.75); // 20.3 + 20.45
  });

  it('TypeAction includes pressEnter when specified', () => {
    const req: CreateActionRequest = {
      type: 'type',
      target: VALID_GROUNDING,
      payload: { text: 'search', pressEnter: true }
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action as TypeAction;
    expect(action.payload.pressEnter).toBe(true);
  });

  it('TypeAction omits optional payload booleans when not supplied', () => {
    const req: CreateActionRequest = {
      type: 'type',
      target: VALID_GROUNDING,
      payload: { text: 'x' }
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const action = result.action as TypeAction;
    expect('clearFirst' in action.payload).toBe(false);
    expect('pressEnter' in action.payload).toBe(false);
  });

  it('targetOptions are applied when target is a GroundingResult', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING,
      targetOptions: {
        role: 'button',
        pointOffset: { xPercent: 0.1, yPercent: 0.1 }
      }
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.target.role).toBe('button');
    // point = 100 + 160 * 0.1 = 116, 200 + 40 * 0.1 = 204
    expect(result.action.target.point.x).toBeCloseTo(116);
    expect(result.action.target.point.y).toBeCloseTo(204);
  });

  it('confidence must be finite in validateIntendedAction', () => {
    const obj = {
      id: 'x',
      type: 'click',
      target: {
        elementId: 'e1',
        observationId: 'o1',
        confidence: NaN,
        point: { x: 50, y: 60 },
        viewportBounds: { x: 10, y: 20, width: 100, height: 80 }
      }
    };
    const result = validateIntendedAction(obj);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });
});

// ---------------------------------------------------------------------------
// Phase 2F-3 Regression Test Suite (Issues 1 - 4)
// ---------------------------------------------------------------------------

describe('Phase 2F-3 Regression: Full validation of pre-resolved ActionTarget (Issue 1)', () => {
  it('rejects an existing ActionTarget with empty elementId', () => {
    const target = makeValidTarget({ elementId: '' });
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.targetFailure?.reason).toBe('INVALID_ELEMENT_ID');
  });

  it('rejects an existing ActionTarget with empty observationId', () => {
    const target = makeValidTarget({ observationId: '' });
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.message).toContain('observationId');
  });

  it('rejects an existing ActionTarget with NaN point.x', () => {
    const target = makeValidTarget({ point: { x: NaN, y: 220 } });
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.message).toContain('point.x');
  });

  it('rejects an existing ActionTarget with Infinity point.y', () => {
    const target = makeValidTarget({ point: { x: 180, y: Infinity } });
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.message).toContain('point.y');
  });

  it('rejects an existing ActionTarget with -Infinity point.x', () => {
    const target = makeValidTarget({ point: { x: -Infinity, y: 220 } });
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('rejects an existing ActionTarget with NaN confidence', () => {
    const target = makeValidTarget({ confidence: NaN });
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.message).toContain('confidence');
  });

  it('rejects an existing ActionTarget with Infinity confidence', () => {
    const target = makeValidTarget({ confidence: Infinity });
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('rejects an existing ActionTarget with zero width', () => {
    const target = makeValidTarget({
      viewportBounds: { x: 10, y: 20, width: 0, height: 40 }
    });
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.targetFailure?.reason).toBe('INVALID_BOUNDS');
  });

  it('rejects an existing ActionTarget with zero height', () => {
    const target = makeValidTarget({
      viewportBounds: { x: 10, y: 20, width: 40, height: 0 }
    });
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.targetFailure?.reason).toBe('INVALID_BOUNDS');
  });

  it('rejects an existing ActionTarget with non-string role', () => {
    const target = { ...makeValidTarget(), role: 123 as unknown as string };
    const result = createIntendedAction({ type: 'click', target });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('valid pre-resolved ActionTarget constructs a fresh target instance', () => {
    const originalTarget = makeValidTarget({ role: 'link' });
    const result = createIntendedAction({ type: 'click', target: originalTarget });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.action.target).toEqual(originalTarget);
    // Newly constructed target: not referentially identical
    expect(result.action.target).not.toBe(originalTarget);
    expect(result.action.target.role).toBe('link');
  });
});

describe('Phase 2F-3 Regression: Defend against malformed runtime targets (Issue 2)', () => {
  it('returns INVALID_TARGET instead of throwing when target is null', () => {
    const req = { type: 'click', target: null } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.message).toContain('non-null object');
  });

  it('returns INVALID_TARGET instead of throwing when target is undefined', () => {
    const req = { type: 'click', target: undefined } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('returns INVALID_TARGET instead of throwing when target is primitive number', () => {
    const req = { type: 'click', target: 42 } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('returns INVALID_TARGET instead of throwing when target is primitive string', () => {
    const req = { type: 'click', target: 'element-selector' } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('returns INVALID_TARGET instead of throwing when target is primitive boolean', () => {
    const req = { type: 'click', target: true } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('returns INVALID_TARGET instead of throwing when target is an empty object', () => {
    const req = { type: 'click', target: {} } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('returns INVALID_TARGET instead of throwing when target is an unrelated object', () => {
    const req = {
      type: 'click',
      target: { randomField: 'foo', otherField: 123 }
    } as unknown as CreateActionRequest;
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
  });

  it('preserves valid GroundingResult behavior', () => {
    const result = createIntendedAction({ type: 'click', target: VALID_GROUNDING });
    expect(result.success).toBe(true);
  });

  it('preserves unmatched GroundingResult behavior', () => {
    const unmatched = makeUnmatchedResult('NO_DOM_CANDIDATES');
    const result = createIntendedAction({ type: 'click', target: unmatched });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.targetFailure?.reason).toBe('UNMATCHED_GROUNDING');
  });
});

describe('Phase 2F-3 Regression: Finite point-offset validation (Issue 3)', () => {
  const bounds: CssViewportRect = { x: 100, y: 200, width: 100, height: 100 };

  it('computeTargetPoint throws TypeError for NaN xPercent', () => {
    expect(() => computeTargetPoint(bounds, { xPercent: NaN, yPercent: 0.5 })).toThrow(TypeError);
  });

  it('computeTargetPoint throws TypeError for NaN yPercent', () => {
    expect(() => computeTargetPoint(bounds, { xPercent: 0.5, yPercent: NaN })).toThrow(TypeError);
  });

  it('computeTargetPoint throws TypeError for Infinity xPercent', () => {
    expect(() => computeTargetPoint(bounds, { xPercent: Infinity, yPercent: 0.5 })).toThrow(TypeError);
  });

  it('computeTargetPoint throws TypeError for Infinity yPercent', () => {
    expect(() => computeTargetPoint(bounds, { xPercent: 0.5, yPercent: Infinity })).toThrow(TypeError);
  });

  it('computeTargetPoint throws TypeError for -Infinity xPercent', () => {
    expect(() => computeTargetPoint(bounds, { xPercent: -Infinity, yPercent: 0.5 })).toThrow(TypeError);
  });

  it('computeTargetPoint throws TypeError for -Infinity yPercent', () => {
    expect(() => computeTargetPoint(bounds, { xPercent: 0.5, yPercent: -Infinity })).toThrow(TypeError);
  });

  it('resolveActionTarget returns INVALID_POINT_OFFSET for NaN xPercent without throwing', () => {
    const result = resolveActionTarget(VALID_GROUNDING, {
      pointOffset: { xPercent: NaN, yPercent: 0.5 }
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_POINT_OFFSET');
  });

  it('resolveActionTarget returns INVALID_POINT_OFFSET for Infinity yPercent without throwing', () => {
    const result = resolveActionTarget(VALID_GROUNDING, {
      pointOffset: { xPercent: 0.5, yPercent: Infinity }
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_POINT_OFFSET');
  });

  it('resolveActionTarget returns INVALID_POINT_OFFSET for -Infinity xPercent without throwing', () => {
    const result = resolveActionTarget(VALID_GROUNDING, {
      pointOffset: { xPercent: -Infinity, yPercent: 0.5 }
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_POINT_OFFSET');
  });

  it('createIntendedAction propagates INVALID_POINT_OFFSET typed failure for non-finite offset', () => {
    const req: CreateActionRequest = {
      type: 'click',
      target: VALID_GROUNDING,
      targetOptions: {
        pointOffset: { xPercent: NaN, yPercent: 0.5 }
      }
    };
    const result = createIntendedAction(req);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('INVALID_TARGET');
    expect(result.targetFailure?.reason).toBe('INVALID_POINT_OFFSET');
  });
});

describe('Phase 2F-3 Regression: Invariants & Serialization (Issues 1-4)', () => {
  it('does not mutate an invalid ActionTarget passed to createIntendedAction', () => {
    const malformed = {
      elementId: 'elem-1',
      observationId: 'obs-1',
      confidence: 0.9,
      point: { x: NaN, y: 50 },
      viewportBounds: { x: 10, y: 20, width: 100, height: 80 }
    };
    createIntendedAction({ type: 'click', target: malformed as unknown as ActionTarget });
    expect(Number.isNaN(malformed.point.x)).toBe(true);
    expect(malformed.point.y).toBe(50);
    expect(malformed.confidence).toBe(0.9);
    expect(malformed.elementId).toBe('elem-1');
    expect(malformed.observationId).toBe('obs-1');
    expect(malformed.viewportBounds).toEqual({ x: 10, y: 20, width: 100, height: 80 });
  });

  it('maintains determinism across repeated calls with pre-resolved ActionTarget', () => {
    const target = makeValidTarget();
    const req: CreateActionRequest = { type: 'click', target };
    const r1 = createIntendedAction(req);
    const r2 = createIntendedAction(req);
    expect(r1).toEqual(r2);
  });

  it('round-trips an action created with pre-resolved ActionTarget through JSON', () => {
    const target = makeValidTarget();
    const req: CreateActionRequest = { type: 'click', target, timestamp: 123456 };
    const result = createIntendedAction(req);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const roundTripped = JSON.parse(JSON.stringify(result.action));
    expect(roundTripped).toEqual(result.action);
  });
});
