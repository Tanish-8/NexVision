/**
 * Phase 2F-3 — Action Target & Intended Action Contract.
 *
 * Pure deterministic bridge between Phase 2F-2 GroundingResult and the
 * future Phase 3 planner/executor.
 *
 * Invariants:
 * - No Chrome APIs, no DOM APIs, no DOM mutation.
 * - No model inference, no network, no persistence.
 * - No randomness, no Date.now(), no timers, no counters.
 * - Same inputs always produce same outputs (referential transparency).
 * - Input objects are never mutated.
 * - Returned values are newly constructed plain objects.
 * - All types are JSON-serializable.
 */

import type { CssViewportRect } from './coordinates.js';
import type {
  GroundingResult,
  GroundingUnmatchedReason
} from './grounding.js';

// ---------------------------------------------------------------------------
// 1. Action Vocabulary
// ---------------------------------------------------------------------------

/** Minimum safe action vocabulary for Phase 2F-3. */
export type ActionType = 'click' | 'type' | 'focus';

// ---------------------------------------------------------------------------
// 2. Action Target Contract
// ---------------------------------------------------------------------------

/**
 * Coordinate point in CSS viewport pixels.
 * Origin (0,0) is the top-left of the viewport.
 */
export interface TargetPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Resolved, validated target for a browser action.
 * Carries DOM element identity, spatial coordinates, and grounding provenance.
 * Guaranteed to have strictly positive dimensions (width > 0 and height > 0).
 */
export interface ActionTarget {
  /** Target DOM element ID from perception/grounding. */
  readonly elementId: string;
  /** Primary interaction point in CSS viewport pixels (e.g. center of bounding box). */
  readonly point: TargetPoint;
  /** Normalized bounding box in CSS viewport coordinates (strictly positive dimensions). */
  readonly viewportBounds: CssViewportRect;
  /** Grounding confidence score in [0, 1]. */
  readonly confidence: number;
  /** Observation ID that originated this target (for end-to-end traceability). */
  readonly observationId: string;
  /** Optional semantic role if known (e.g. 'button', 'textbox'). */
  readonly role?: string;
}

// ---------------------------------------------------------------------------
// 3. Action Payloads
// ---------------------------------------------------------------------------

/** Payload for 'type' actions. */
export interface TypeActionPayload {
  /** Text string to type into the target element. Empty string is valid. */
  readonly text: string;
  /** Whether to clear existing content before typing. Default: false. */
  readonly clearFirst?: boolean;
  /** Whether to press Enter after typing. Default: false. */
  readonly pressEnter?: boolean;
}

// ---------------------------------------------------------------------------
// 4. Intended Action (Discriminated Union)
// ---------------------------------------------------------------------------

interface BaseIntendedAction {
  /** Unique action identifier, deterministically derived or explicitly supplied. */
  readonly id: string;
  /** Action type discriminator. */
  readonly type: ActionType;
  /** Grounded target for this action. */
  readonly target: ActionTarget;
  /**
   * Optional epoch timestamp (ms) when explicitly supplied by the caller.
   * Never generated at runtime via Date.now() to maintain referential transparency.
   */
  readonly timestamp?: number;
}

export interface ClickAction extends BaseIntendedAction {
  readonly type: 'click';
}

export interface TypeAction extends BaseIntendedAction {
  readonly type: 'type';
  readonly payload: TypeActionPayload;
}

export interface FocusAction extends BaseIntendedAction {
  readonly type: 'focus';
}

/** Complete intended action discriminated union. */
export type IntendedAction = ClickAction | TypeAction | FocusAction;

// ---------------------------------------------------------------------------
// 5. Resolution / Result Types
// ---------------------------------------------------------------------------

/** Reasons why an ActionTarget could not be resolved from grounding. */
export type ActionTargetFailureReason =
  | 'UNMATCHED_GROUNDING'
  | 'LOW_CONFIDENCE'
  | 'INVALID_BOUNDS'
  | 'INVALID_ELEMENT_ID'
  | 'INVALID_POINT_OFFSET';

export interface ActionTargetSuccess {
  readonly success: true;
  readonly target: ActionTarget;
}

export interface ActionTargetFailure {
  readonly success: false;
  readonly reason: ActionTargetFailureReason;
  readonly message: string;
  readonly groundingReason?: GroundingUnmatchedReason;
  readonly confidence?: number;
}

export type ActionTargetResolution = ActionTargetSuccess | ActionTargetFailure;

/** Reasons why an IntendedAction could not be created or validated. */
export type ActionIntentFailureReason =
  | 'INVALID_TARGET'
  | 'UNSUPPORTED_ACTION_TYPE'
  | 'MISSING_PAYLOAD'
  | 'INVALID_PAYLOAD'
  | 'INVALID_ACTION_ID';

export interface ActionIntentSuccess {
  readonly success: true;
  readonly action: IntendedAction;
}

export interface ActionIntentFailure {
  readonly success: false;
  readonly reason: ActionIntentFailureReason;
  readonly message: string;
  readonly targetFailure?: ActionTargetFailure;
}

export type ActionIntentResolution = ActionIntentSuccess | ActionIntentFailure;

// ---------------------------------------------------------------------------
// 6. Options & Request Interfaces
// ---------------------------------------------------------------------------

export interface ActionTargetOptions {
  /** Minimum grounding confidence required [0, 1]. Default: 0.0 (accepts any valid match). */
  readonly minConfidence?: number;
  /**
   * Relative offset within the bounding box [0, 1] for target point calculation.
   * Default: { xPercent: 0.5, yPercent: 0.5 } (center).
   */
  readonly pointOffset?: {
    readonly xPercent: number;
    readonly yPercent: number;
  };
  /** Optional semantic role override/supplement. */
  readonly role?: string;
}

export interface CreateActionRequest {
  /** Optional custom action ID. If omitted, deterministically generated from stable inputs. */
  readonly id?: string;
  /** Action type to perform. */
  readonly type: ActionType;
  /** Action target or raw GroundingResult. */
  readonly target: ActionTarget | GroundingResult;
  /** Payload for actions requiring data (e.g. 'type'). */
  readonly payload?: {
    readonly text?: string;
    readonly clearFirst?: boolean;
    readonly pressEnter?: boolean;
  };
  /** Target resolution options (applicable if target is a GroundingResult). */
  readonly targetOptions?: ActionTargetOptions;
  /**
   * Optional explicit caller-supplied epoch timestamp (ms).
   * If omitted, timestamp remains undefined on the resulting action.
   * Never defaults to Date.now().
   */
  readonly timestamp?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Clamps a number to the inclusive range [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Validates bounds suitability for an ActionTarget.
 * Returns null if valid, or an error message string if invalid.
 * Requires: all fields finite, width > 0, height > 0.
 */
function validateBoundsForTarget(bounds: unknown): string | null {
  if (typeof bounds !== 'object' || bounds === null) {
    return 'bounds must be a non-null object';
  }
  const b = bounds as Record<string, unknown>;

  if (typeof b['x'] !== 'number' || !Number.isFinite(b['x'] as number)) {
    return `bounds.x must be a finite number, got ${String(b['x'])}`;
  }
  if (typeof b['y'] !== 'number' || !Number.isFinite(b['y'] as number)) {
    return `bounds.y must be a finite number, got ${String(b['y'])}`;
  }
  if (typeof b['width'] !== 'number' || !Number.isFinite(b['width'] as number)) {
    return `bounds.width must be a finite number, got ${String(b['width'])}`;
  }
  if (typeof b['height'] !== 'number' || !Number.isFinite(b['height'] as number)) {
    return `bounds.height must be a finite number, got ${String(b['height'])}`;
  }

  const w = b['width'] as number;
  const h = b['height'] as number;

  if (w <= 0) {
    return `bounds.width must be > 0, got ${w}`;
  }
  if (h <= 0) {
    return `bounds.height must be > 0, got ${h}`;
  }

  return null;
}

/**
 * Validates the payload shape for a 'type' action.
 * Returns validated fields on success or an error descriptor on failure.
 */
type TypePayloadValid = {
  error: null;
  text: string;
  clearFirst: boolean | undefined;
  pressEnter: boolean | undefined;
};
type TypePayloadInvalid = {
  error: string;
  reason: ActionIntentFailureReason;
};

function validateTypePayload(payload: unknown): TypePayloadValid | TypePayloadInvalid {
  if (payload === undefined || payload === null) {
    return {
      error: "payload.text is required for 'type' actions",
      reason: 'MISSING_PAYLOAD'
    };
  }

  if (typeof payload !== 'object') {
    return {
      error: "payload must be an object for 'type' actions",
      reason: 'INVALID_PAYLOAD'
    };
  }

  const pl = payload as Record<string, unknown>;

  if (pl['text'] === undefined || pl['text'] === null) {
    return {
      error: "payload.text is required for 'type' actions",
      reason: 'MISSING_PAYLOAD'
    };
  }

  if (typeof pl['text'] !== 'string') {
    return {
      error: `payload.text must be a string, got ${typeof pl['text']}`,
      reason: 'INVALID_PAYLOAD'
    };
  }

  if (pl['clearFirst'] !== undefined && typeof pl['clearFirst'] !== 'boolean') {
    return {
      error: `payload.clearFirst must be a boolean when supplied, got ${typeof pl['clearFirst']}`,
      reason: 'INVALID_PAYLOAD'
    };
  }

  if (pl['pressEnter'] !== undefined && typeof pl['pressEnter'] !== 'boolean') {
    return {
      error: `payload.pressEnter must be a boolean when supplied, got ${typeof pl['pressEnter']}`,
      reason: 'INVALID_PAYLOAD'
    };
  }

  return {
    error: null,
    text: pl['text'] as string,
    clearFirst: pl['clearFirst'] as boolean | undefined,
    pressEnter: pl['pressEnter'] as boolean | undefined
  };
}

/**
 * Determines whether an unknown runtime value has the structural shape of a GroundingResult.
 * A GroundingResult is always discriminated by boolean property `matched`.
 */
function isPlausibleGroundingResult(value: unknown): value is GroundingResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (typeof r['matched'] !== 'boolean') {
    return false;
  }
  if (r['matched'] === false) {
    return typeof r['reason'] === 'string' || typeof r['message'] === 'string';
  }
  return 'normalizedCssBox' in r || 'elementId' in r;
}

/**
 * Determines whether an unknown runtime value is an ActionTarget candidate.
 * An ActionTarget never has `matched`, and carries spatial descriptors (viewportBounds and/or point).
 */
function isActionTargetCandidate(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if ('matched' in r) {
    return false;
  }
  return 'viewportBounds' in r || 'point' in r;
}

type ActionTargetValidationResult =
  | {
      readonly valid: true;
      readonly target: ActionTarget;
    }
  | {
      readonly valid: false;
      readonly message: string;
      readonly targetFailure?: ActionTargetFailure;
    };

/**
 * Validates all ActionTarget invariants on an untrusted or pre-resolved target.
 *
 * Invariants:
 * - elementId: non-empty string
 * - observationId: non-empty string
 * - confidence: finite number
 * - point: object with finite x and finite y
 * - viewportBounds: object with finite x, y, width, height and width > 0, height > 0
 * - optional role: string if supplied
 *
 * Does not mutate the input target. Returns a newly constructed ActionTarget on success.
 */
function validateActionTarget(target: unknown): ActionTargetValidationResult {
  if (typeof target !== 'object' || target === null) {
    return {
      valid: false,
      message: 'target must be a non-null object'
    };
  }

  const t = target as Record<string, unknown>;

  // 1. elementId: non-empty string
  if (typeof t['elementId'] !== 'string' || t['elementId'].length === 0) {
    const msg = typeof t['elementId'] !== 'string'
      ? `target.elementId must be a string, got ${typeof t['elementId']}`
      : 'target.elementId must be a non-empty string';
    return {
      valid: false,
      message: msg,
      targetFailure: {
        success: false,
        reason: 'INVALID_ELEMENT_ID',
        message: msg
      }
    };
  }

  // 2. observationId: non-empty string
  if (typeof t['observationId'] !== 'string' || t['observationId'].length === 0) {
    const msg = typeof t['observationId'] !== 'string'
      ? `target.observationId must be a string, got ${typeof t['observationId']}`
      : 'target.observationId must be a non-empty string';
    return {
      valid: false,
      message: msg
    };
  }

  // 3. confidence: finite number
  if (typeof t['confidence'] !== 'number' || !Number.isFinite(t['confidence'])) {
    return {
      valid: false,
      message: `target.confidence must be a finite number, got ${String(t['confidence'])}`
    };
  }

  // 4. point: object with finite x and finite y
  if (typeof t['point'] !== 'object' || t['point'] === null) {
    return {
      valid: false,
      message: 'target.point must be a non-null object'
    };
  }
  const pnt = t['point'] as Record<string, unknown>;
  if (typeof pnt['x'] !== 'number' || !Number.isFinite(pnt['x'])) {
    return {
      valid: false,
      message: `target.point.x must be a finite number, got ${String(pnt['x'])}`
    };
  }
  if (typeof pnt['y'] !== 'number' || !Number.isFinite(pnt['y'])) {
    return {
      valid: false,
      message: `target.point.y must be a finite number, got ${String(pnt['y'])}`
    };
  }

  // 5. viewportBounds: finite coordinates and width > 0, height > 0
  const boundsError = validateBoundsForTarget(t['viewportBounds']);
  if (boundsError !== null) {
    return {
      valid: false,
      message: `target.viewportBounds: ${boundsError}`,
      targetFailure: {
        success: false,
        reason: 'INVALID_BOUNDS',
        message: boundsError
      }
    };
  }
  const vb = t['viewportBounds'] as Record<string, unknown>;

  // 6. optional role: must be string if supplied
  if (t['role'] !== undefined && typeof t['role'] !== 'string') {
    return {
      valid: false,
      message: `target.role must be a string when supplied, got ${typeof t['role']}`
    };
  }

  // Construct clean ActionTarget (do not mutate or retain untrusted object)
  const cleanTarget: ActionTarget = {
    elementId: t['elementId'] as string,
    point: {
      x: pnt['x'] as number,
      y: pnt['y'] as number
    },
    viewportBounds: {
      x: vb['x'] as number,
      y: vb['y'] as number,
      width: vb['width'] as number,
      height: vb['height'] as number
    },
    confidence: t['confidence'] as number,
    observationId: t['observationId'] as string,
    ...(typeof t['role'] === 'string' ? { role: t['role'] as string } : {})
  };

  return {
    valid: true,
    target: cleanTarget
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculates the interaction point within a validated, positive-area bounding box.
 *
 * @param bounds  A strictly positive-area CSS viewport rectangle.
 * @param offset  Relative offset [0, 1] within the box. Defaults to center (0.5, 0.5).
 * @returns       Target point in CSS viewport pixels.
 * @throws        TypeError if offset coordinates are non-finite numbers.
 */
export function computeTargetPoint(
  bounds: CssViewportRect,
  offset?: { xPercent: number; yPercent: number }
): TargetPoint {
  if (offset !== undefined) {
    if (
      typeof offset.xPercent !== 'number' ||
      !Number.isFinite(offset.xPercent) ||
      typeof offset.yPercent !== 'number' ||
      !Number.isFinite(offset.yPercent)
    ) {
      throw new TypeError(
        `offset.xPercent and offset.yPercent must be finite numbers, got xPercent=${String(offset.xPercent)}, yPercent=${String(offset.yPercent)}`
      );
    }
  }
  const xPercent = offset !== undefined ? clamp(offset.xPercent, 0, 1) : 0.5;
  const yPercent = offset !== undefined ? clamp(offset.yPercent, 0, 1) : 0.5;
  return {
    x: bounds.x + bounds.width * xPercent,
    y: bounds.y + bounds.height * yPercent
  };
}

/**
 * Resolves a GroundingResult into a validated ActionTarget.
 *
 * Returns ActionTargetFailure for every expected domain error without throwing.
 *
 * @param groundingResult  The grounding result from Phase 2F-2.
 * @param options          Optional resolution configuration.
 */
export function resolveActionTarget(
  groundingResult: GroundingResult,
  options?: ActionTargetOptions
): ActionTargetResolution {
  // 1. Unmatched grounding
  if (groundingResult.matched === false) {
    return {
      success: false,
      reason: 'UNMATCHED_GROUNDING',
      message: groundingResult.message,
      groundingReason: groundingResult.reason
    };
  }

  // From here on, groundingResult is GroundingSuccessResult
  const { observationId, elementId, normalizedCssBox, groundingConfidence } = groundingResult;

  // 2. Confidence threshold
  const minConfidence = options?.minConfidence ?? 0;
  if (groundingConfidence < minConfidence) {
    return {
      success: false,
      reason: 'LOW_CONFIDENCE',
      message: `Grounding confidence ${groundingConfidence.toFixed(4)} is below minimum ${minConfidence}`,
      confidence: groundingConfidence
    };
  }

  // 3. Element ID validation
  if (typeof elementId !== 'string' || elementId.length === 0) {
    return {
      success: false,
      reason: 'INVALID_ELEMENT_ID',
      message: 'elementId must be a non-empty string'
    };
  }

  // 4. Bounds validation: finite and strictly positive dimensions
  const boundsError = validateBoundsForTarget(normalizedCssBox);
  if (boundsError !== null) {
    return {
      success: false,
      reason: 'INVALID_BOUNDS',
      message: boundsError
    };
  }

  // 5. Point offset validation: must be finite if supplied
  if (options?.pointOffset !== undefined) {
    const po = options.pointOffset;
    if (
      typeof po !== 'object' ||
      po === null ||
      typeof po.xPercent !== 'number' ||
      !Number.isFinite(po.xPercent) ||
      typeof po.yPercent !== 'number' ||
      !Number.isFinite(po.yPercent)
    ) {
      return {
        success: false,
        reason: 'INVALID_POINT_OFFSET',
        message: `pointOffset.xPercent and pointOffset.yPercent must be finite numbers, got xPercent=${String(po?.xPercent)}, yPercent=${String(po?.yPercent)}`
      };
    }
  }

  // 6. Compute interaction point
  const point = computeTargetPoint(normalizedCssBox, options?.pointOffset);

  // 7. Build and return ActionTarget (newly constructed)
  const target: ActionTarget = {
    elementId,
    point,
    viewportBounds: {
      x: normalizedCssBox.x,
      y: normalizedCssBox.y,
      width: normalizedCssBox.width,
      height: normalizedCssBox.height
    },
    confidence: groundingConfidence,
    observationId,
    ...(typeof options?.role === 'string' ? { role: options.role } : {})
  };

  return { success: true, target };
}

/**
 * Creates a validated, deterministic IntendedAction from a request.
 *
 * The `target` field may be either an already-resolved ActionTarget or a raw
 * GroundingResult (which is resolved internally via resolveActionTarget).
 *
 * Returns ActionIntentFailure for every expected domain error without throwing.
 *
 * Determinism guarantees:
 * - No Date.now(), Math.random(), or external state.
 * - Generated ID: `intent_${target.observationId}_${request.type}` (stable fields only).
 * - Explicit request.id is preserved verbatim.
 * - Explicit request.timestamp is preserved; omitted timestamp stays undefined.
 *
 * @param request  Action creation request.
 */
export function createIntendedAction(
  request: CreateActionRequest
): ActionIntentResolution {
  // 1. Validate ID if explicitly supplied
  if (request.id !== undefined) {
    if (typeof request.id !== 'string' || request.id.length === 0) {
      return {
        success: false,
        reason: 'INVALID_ACTION_ID',
        message: 'request.id must be a non-empty string when supplied'
      };
    }
  }

  // 2. Validate action type (runtime guard for JS callers passing unsupported types)
  const VALID_TYPES: readonly string[] = ['click', 'type', 'focus'];
  if (!VALID_TYPES.includes(request.type as string)) {
    return {
      success: false,
      reason: 'UNSUPPORTED_ACTION_TYPE',
      message: `Action type '${String(request.type)}' is not supported. Supported types: ${VALID_TYPES.join(', ')}`
    };
  }

  // 3. Resolve target
  let resolvedTarget: ActionTarget;

  if (typeof request.target !== 'object' || request.target === null) {
    return {
      success: false,
      reason: 'INVALID_TARGET',
      message: 'request.target must be a non-null object'
    };
  }

  if (isPlausibleGroundingResult(request.target)) {
    const resolution = resolveActionTarget(request.target, request.targetOptions);
    if (!resolution.success) {
      return {
        success: false,
        reason: 'INVALID_TARGET',
        message: `Target could not be resolved: ${resolution.message}`,
        targetFailure: resolution
      };
    }
    resolvedTarget = resolution.target;
  } else if (isActionTargetCandidate(request.target)) {
    const validation = validateActionTarget(request.target);
    if (!validation.valid) {
      return {
        success: false,
        reason: 'INVALID_TARGET',
        message: `Invalid pre-resolved ActionTarget: ${validation.message}`,
        ...(validation.targetFailure !== undefined ? { targetFailure: validation.targetFailure } : {})
      };
    }
    resolvedTarget = validation.target;
  } else {
    return {
      success: false,
      reason: 'INVALID_TARGET',
      message: 'request.target is neither a valid ActionTarget nor a recognizable GroundingResult'
    };
  }

  // 4. Compute deterministic ID from stable inputs only — no clock, no random
  const actionId = request.id !== undefined
    ? request.id
    : `intent_${resolvedTarget.observationId}_${request.type}`;

  // 5. Base fields — timestamp preserved if caller supplied; never defaulted to Date.now()
  const timestampField: { timestamp?: number } =
    request.timestamp !== undefined ? { timestamp: request.timestamp } : {};

  // 6. Build type-specific action
  if (request.type === 'type') {
    const payloadValidation = validateTypePayload(request.payload);
    if (payloadValidation.error !== null) {
      return {
        success: false,
        reason: payloadValidation.reason,
        message: payloadValidation.error
      };
    }

    const pl = payloadValidation as TypePayloadValid;
    const payloadOut: TypeActionPayload = {
      text: pl.text,
      ...(pl.clearFirst !== undefined ? { clearFirst: pl.clearFirst } : {}),
      ...(pl.pressEnter !== undefined ? { pressEnter: pl.pressEnter } : {})
    };

    const action: TypeAction = {
      id: actionId,
      type: 'type',
      target: resolvedTarget,
      payload: payloadOut,
      ...timestampField
    };
    return { success: true, action };
  }

  if (request.type === 'click') {
    // Extraneous payload permitted but ignored (per approved contract, R8)
    const action: ClickAction = {
      id: actionId,
      type: 'click',
      target: resolvedTarget,
      ...timestampField
    };
    return { success: true, action };
  }

  // focus
  const action: FocusAction = {
    id: actionId,
    type: 'focus',
    target: resolvedTarget,
    ...timestampField
  };
  return { success: true, action };
}

/**
 * Validates an untrusted or JSON-deserialized object against the IntendedAction contract.
 *
 * Does not mutate the input. Validates plain JSON-compatible shapes.
 *
 * @param action  Untrusted value to validate.
 */
export function validateIntendedAction(action: unknown): ActionIntentResolution {
  if (typeof action !== 'object' || action === null) {
    return {
      success: false,
      reason: 'INVALID_TARGET',
      message: 'action must be a non-null object'
    };
  }

  const a = action as Record<string, unknown>;

  // Validate id
  if (typeof a['id'] !== 'string' || (a['id'] as string).length === 0) {
    return {
      success: false,
      reason: 'INVALID_ACTION_ID',
      message: 'action.id must be a non-empty string'
    };
  }

  // Validate type discriminator
  const VALID_TYPES: readonly string[] = ['click', 'type', 'focus'];
  if (typeof a['type'] !== 'string' || !VALID_TYPES.includes(a['type'] as string)) {
    return {
      success: false,
      reason: 'UNSUPPORTED_ACTION_TYPE',
      message: `action.type must be one of: ${VALID_TYPES.join(', ')}`
    };
  }
  const actionType = a['type'] as ActionType;

  // Validate target object using shared validation helper
  const targetValidation = validateActionTarget(a['target']);
  if (!targetValidation.valid) {
    return {
      success: false,
      reason: 'INVALID_TARGET',
      message: `action.${targetValidation.message}`
    };
  }
  const target = targetValidation.target;

  // Validate optional timestamp
  if (a['timestamp'] !== undefined) {
    if (typeof a['timestamp'] !== 'number' || !Number.isFinite(a['timestamp'] as number)) {
      return {
        success: false,
        reason: 'INVALID_TARGET',
        message: 'action.timestamp must be a finite number when supplied'
      };
    }
  }

  // Validate type-specific payload
  if (actionType === 'type') {
    const payloadValidation = validateTypePayload(a['payload']);
    if (payloadValidation.error !== null) {
      return {
        success: false,
        reason: payloadValidation.reason,
        message: payloadValidation.error
      };
    }
  }

  const timestampField: { timestamp?: number } =
    a['timestamp'] !== undefined ? { timestamp: a['timestamp'] as number } : {};

  if (actionType === 'type') {
    const pl = (a['payload'] as Record<string, unknown>);
    const payloadOut: TypeActionPayload = {
      text: pl['text'] as string,
      ...(pl['clearFirst'] !== undefined ? { clearFirst: pl['clearFirst'] as boolean } : {}),
      ...(pl['pressEnter'] !== undefined ? { pressEnter: pl['pressEnter'] as boolean } : {})
    };
    const typedAction: TypeAction = {
      id: a['id'] as string,
      type: 'type',
      target,
      payload: payloadOut,
      ...timestampField
    };
    return { success: true, action: typedAction };
  }

  if (actionType === 'click') {
    const clickAction: ClickAction = {
      id: a['id'] as string,
      type: 'click',
      target,
      ...timestampField
    };
    return { success: true, action: clickAction };
  }

  const focusAction: FocusAction = {
    id: a['id'] as string,
    type: 'focus',
    target,
    ...timestampField
  };
  return { success: true, action: focusAction };
}
