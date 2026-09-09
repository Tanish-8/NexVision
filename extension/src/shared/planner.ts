/**
 * Phase 3A — Planner Architecture & Contract.
 *
 * Pure, defensive boundary that consumes structured, privacy-sanitized perception,
 * grounding results, and action target pools, and produces validated IntendedAction
 * requests ready for downstream execution (Phase 3B).
 *
 * Invariants:
 * - No Chrome APIs (chrome.*).
 * - No direct DOM access, DOM mutation, or event dispatching.
 * - No raw screenshot access or image pixel inspection.
 * - No network requests (fetch, WebSocket, HTTP).
 * - No LLM inference inside this module.
 * - No PII detection or redaction (trusts Phase 4 sanitized PageRepresentation).
 * - No synthetic ActionTargets, coordinates, or element IDs.
 * - Exactly one atomic IntendedAction per planning cycle.
 * - System clock is NEVER accessed (no Date.now, new Date(), performance.now()).
 * - No Math.random, counters, or global state.
 * - availableTargets is strictly authoritative for target membership.
 */

import type { ElementRole, PageElement, PageRepresentation } from './types.js';
import type {
  ActionIntentFailure,
  ActionTarget,
  ActionType,
  IntendedAction
} from './actions.js';
import {
  createIntendedAction,
  validateIntendedAction
} from './actions.js';
import type { GroundingResult } from './grounding.js';

// ---------------------------------------------------------------------------
// 1. Goal Contract
// ---------------------------------------------------------------------------

export type PlannerGoalIntent =
  | 'click'
  | 'type'
  | 'focus'
  | 'search'
  | 'navigate'
  | 'form_fill'
  | 'custom';

export interface PlannerGoal {
  readonly id: string;
  readonly description: string;
  readonly intent?: PlannerGoalIntent;
  readonly parameters?: Record<string, string>;
  readonly targetHint?: string;
}

// ---------------------------------------------------------------------------
// 2. Context & History
// ---------------------------------------------------------------------------

export interface PlannerHistoryStep {
  readonly stepIndex: number;
  readonly action: IntendedAction;
  readonly perceivedOutcome?: 'success' | 'no_change' | 'error';
}

export interface PlannerCompletionState {
  readonly satisfied: boolean;
  readonly summary?: string;
}

export interface PlannerContext {
  readonly page: PageRepresentation;
  readonly availableTargets: readonly ActionTarget[];
  readonly groundingResults?: readonly GroundingResult[];
  readonly capturedAt: number;
  readonly currentTime: number;
  readonly stepIndex: number;
  readonly completion?: PlannerCompletionState;
}

export interface PlannerOptions {
  readonly minConfidence?: number;
  readonly maxPerceptionAgeMs?: number;
  readonly strictRoleMatching?: boolean;
}

export interface PlannerInput {
  readonly goal: PlannerGoal;
  readonly context: PlannerContext;
  readonly history?: readonly PlannerHistoryStep[];
  readonly options?: PlannerOptions;
}

// ---------------------------------------------------------------------------
// 3. Constants & Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_PERCEPTION_AGE_MS = 10000;
export const DEFAULT_MIN_CONFIDENCE = 0.0;
export const DEFAULT_STRICT_ROLE_MATCHING = false;

// ---------------------------------------------------------------------------
// 4. Failure & Decision Contracts
// ---------------------------------------------------------------------------

export type PlannerFailureReason =
  | 'INVALID_INPUT'
  | 'STALE_PERCEPTION'
  | 'NO_FEASIBLE_TARGET'
  | 'LOW_CONFIDENCE'
  | 'UNKNOWN_TARGET_ELEMENT'
  | 'INCOMPATIBLE_ACTION_FOR_ROLE'
  | 'INVALID_ACTION_INTENT'
  | 'UNSUPPORTED_GOAL'
  | 'MODEL_ERROR';

export interface PlannerActionDecision {
  readonly status: 'ACTION';
  readonly planId: string;
  readonly action: IntendedAction;
  readonly targetElementId: string;
  readonly rationale: string;
  readonly estimatedProgress?: number;
}

export interface PlannerCompleteDecision {
  readonly status: 'COMPLETED';
  readonly planId: string;
  readonly summary: string;
}

export interface PlannerFailureDecision {
  readonly status: 'FAILED';
  readonly planId: string;
  readonly reason: PlannerFailureReason;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly targetFailure?: ActionIntentFailure;
}

export type PlannerResult =
  | PlannerActionDecision
  | PlannerCompleteDecision
  | PlannerFailureDecision;

// ---------------------------------------------------------------------------
// 5. Advisory Driver Contract
// ---------------------------------------------------------------------------

export interface AdvisoryStepProposal {
  readonly targetElementId: string;
  readonly actionType: ActionType;
  readonly payload?: {
    readonly text?: string;
    readonly clearFirst?: boolean;
    readonly pressEnter?: boolean;
  };
  readonly rationale: string;
  readonly estimatedProgress?: number;
}

export type AdvisoryProposalResult =
  | {
      readonly status: 'ACTION';
      readonly proposal: AdvisoryStepProposal;
    }
  | {
      readonly status: 'COMPLETED';
      readonly summary: string;
    }
  | {
      readonly status: 'FAILED';
      readonly reason: string;
    };

export interface PlannerDriver {
  readonly name: string;
  proposeStep(
    input: PlannerInput
  ): Promise<AdvisoryProposalResult> | AdvisoryProposalResult;
}

// ---------------------------------------------------------------------------
// 6. Internal Validation Helpers
// ---------------------------------------------------------------------------

const VALID_GOAL_INTENTS: ReadonlySet<string> = new Set([
  'click',
  'type',
  'focus',
  'search',
  'navigate',
  'form_fill',
  'custom'
]);

const VALID_ACTION_TYPES: ReadonlySet<string> = new Set([
  'click',
  'type',
  'focus'
]);

const STRICT_CLICK_ROLES: ReadonlySet<ElementRole> = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'switch',
  'tab',
  'treeitem',
  'textbox',
  'searchbox'
]);

const STRICT_FOCUS_ROLES: ReadonlySet<ElementRole> = new Set([
  'textbox',
  'searchbox',
  'button',
  'link',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem'
]);

const STRICT_TYPE_ROLES: ReadonlySet<ElementRole> = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton'
]);

const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'about',
  'click',
  'type',
  'focus',
  'please',
  'page',
  'button',
  'input',
  'field',
  'here'
]);

/**
 * Validates all PlannerInput invariants.
 * Returns null if valid, or a descriptive error message string if invalid.
 */
export function validatePlannerInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return 'PlannerInput must be a non-null object';
  }

  const inp = input as Record<string, unknown>;

  // 1. Goal validation
  if (typeof inp['goal'] !== 'object' || inp['goal'] === null) {
    return 'PlannerInput.goal must be a non-null object';
  }
  const goal = inp['goal'] as Record<string, unknown>;

  if (typeof goal['id'] !== 'string' || goal['id'].length === 0) {
    return 'goal.id must be a non-empty string';
  }

  if (typeof goal['description'] !== 'string' || goal['description'].length === 0) {
    return 'goal.description must be a non-empty string';
  }

  if (goal['intent'] !== undefined) {
    if (typeof goal['intent'] !== 'string' || !VALID_GOAL_INTENTS.has(goal['intent'])) {
      return `goal.intent must belong to valid vocabulary, got '${String(goal['intent'])}'`;
    }
  }

  if (goal['parameters'] !== undefined) {
    if (typeof goal['parameters'] !== 'object' || goal['parameters'] === null || Array.isArray(goal['parameters'])) {
      return 'goal.parameters must be a key-value record when supplied';
    }
    const params = goal['parameters'] as Record<string, unknown>;
    for (const [k, v] of Object.entries(params)) {
      if (typeof v !== 'string') {
        return `goal.parameters['${k}'] must be a string, got ${typeof v}`;
      }
    }
  }

  if (goal['targetHint'] !== undefined) {
    if (typeof goal['targetHint'] !== 'string' || goal['targetHint'].length === 0) {
      return 'goal.targetHint must be a non-empty string when supplied';
    }
  }

  // 2. Context validation
  if (typeof inp['context'] !== 'object' || inp['context'] === null) {
    return 'PlannerInput.context must be a non-null object';
  }
  const ctx = inp['context'] as Record<string, unknown>;

  if (typeof ctx['page'] !== 'object' || ctx['page'] === null) {
    return 'context.page must be a non-null PageRepresentation object';
  }
  const page = ctx['page'] as Record<string, unknown>;
  if (!Array.isArray(page['elements'])) {
    return 'context.page.elements must be an array';
  }

  if (!Array.isArray(ctx['availableTargets'])) {
    return 'context.availableTargets must be an array';
  }
  for (let i = 0; i < ctx['availableTargets'].length; i++) {
    const t = ctx['availableTargets'][i];
    if (typeof t !== 'object' || t === null) {
      return `context.availableTargets[${i}] must be a non-null ActionTarget object`;
    }
    const targetObj = t as Record<string, unknown>;
    if (typeof targetObj['elementId'] !== 'string' || targetObj['elementId'].length === 0) {
      return `context.availableTargets[${i}].elementId must be a non-empty string`;
    }
    if (
      typeof targetObj['confidence'] !== 'number' ||
      !Number.isFinite(targetObj['confidence']) ||
      (targetObj['confidence'] as number) < 0 ||
      (targetObj['confidence'] as number) > 1
    ) {
      return `context.availableTargets[${i}].confidence must be a finite number in [0, 1], got ${String(targetObj['confidence'])}`;
    }
    if (typeof targetObj['point'] !== 'object' || targetObj['point'] === null) {
      return `context.availableTargets[${i}].point must be an object`;
    }
    const pt = targetObj['point'] as Record<string, unknown>;
    if (typeof pt['x'] !== 'number' || !Number.isFinite(pt['x'])) {
      return `context.availableTargets[${i}].point.x must be a finite number, got ${String(pt['x'])}`;
    }
    if (typeof pt['y'] !== 'number' || !Number.isFinite(pt['y'])) {
      return `context.availableTargets[${i}].point.y must be a finite number, got ${String(pt['y'])}`;
    }
    if (typeof targetObj['viewportBounds'] !== 'object' || targetObj['viewportBounds'] === null) {
      return `context.availableTargets[${i}].viewportBounds must be an object`;
    }
    const vb = targetObj['viewportBounds'] as Record<string, unknown>;
    if (typeof vb['x'] !== 'number' || !Number.isFinite(vb['x'])) {
      return `context.availableTargets[${i}].viewportBounds.x must be a finite number, got ${String(vb['x'])}`;
    }
    if (typeof vb['y'] !== 'number' || !Number.isFinite(vb['y'])) {
      return `context.availableTargets[${i}].viewportBounds.y must be a finite number, got ${String(vb['y'])}`;
    }
    if (
      typeof vb['width'] !== 'number' ||
      !Number.isFinite(vb['width']) ||
      (vb['width'] as number) <= 0
    ) {
      return `context.availableTargets[${i}].viewportBounds.width must be a finite number > 0, got ${String(vb['width'])}`;
    }
    if (
      typeof vb['height'] !== 'number' ||
      !Number.isFinite(vb['height']) ||
      (vb['height'] as number) <= 0
    ) {
      return `context.availableTargets[${i}].viewportBounds.height must be a finite number > 0, got ${String(vb['height'])}`;
    }
  }

  if (ctx['groundingResults'] !== undefined && !Array.isArray(ctx['groundingResults'])) {
    return 'context.groundingResults must be an array when supplied';
  }

  if (typeof ctx['capturedAt'] !== 'number' || !Number.isFinite(ctx['capturedAt']) || ctx['capturedAt'] < 0) {
    return `context.capturedAt must be a non-negative finite number, got ${String(ctx['capturedAt'])}`;
  }

  if (typeof ctx['currentTime'] !== 'number' || !Number.isFinite(ctx['currentTime'])) {
    return `context.currentTime must be a finite number, got ${String(ctx['currentTime'])}`;
  }

  if ((ctx['currentTime'] as number) < (ctx['capturedAt'] as number)) {
    return `context.currentTime (${String(ctx['currentTime'])}) cannot be before context.capturedAt (${String(ctx['capturedAt'])})`;
  }

  if (
    typeof ctx['stepIndex'] !== 'number' ||
    !Number.isInteger(ctx['stepIndex']) ||
    (ctx['stepIndex'] as number) < 0
  ) {
    return `context.stepIndex must be a non-negative integer, got ${String(ctx['stepIndex'])}`;
  }

  if (ctx['completion'] !== undefined) {
    if (typeof ctx['completion'] !== 'object' || ctx['completion'] === null) {
      return 'context.completion must be an object when supplied';
    }
    const comp = ctx['completion'] as Record<string, unknown>;
    if (typeof comp['satisfied'] !== 'boolean') {
      return 'context.completion.satisfied must be a boolean';
    }
    if (comp['summary'] !== undefined && typeof comp['summary'] !== 'string') {
      return 'context.completion.summary must be a string when supplied';
    }
  }

  // 3. History validation
  if (inp['history'] !== undefined) {
    if (!Array.isArray(inp['history'])) {
      return 'PlannerInput.history must be an array when supplied';
    }
    const VALID_OUTCOMES: ReadonlySet<string> = new Set(['success', 'no_change', 'error']);
    for (let i = 0; i < inp['history'].length; i++) {
      const h = inp['history'][i];
      if (typeof h !== 'object' || h === null) {
        return `history[${i}] must be a non-null object`;
      }
      const histObj = h as Record<string, unknown>;
      if (
        typeof histObj['stepIndex'] !== 'number' ||
        !Number.isInteger(histObj['stepIndex']) ||
        (histObj['stepIndex'] as number) < 0
      ) {
        return `history[${i}].stepIndex must be a non-negative integer, got ${String(histObj['stepIndex'])}`;
      }
      if (typeof histObj['action'] !== 'object' || histObj['action'] === null) {
        return `history[${i}].action must be a non-null object`;
      }
      const act = histObj['action'] as Record<string, unknown>;
      if (typeof act['id'] !== 'string' || act['id'].length === 0) {
        return `history[${i}].action.id must be a non-empty string`;
      }
      if (typeof act['type'] !== 'string' || !VALID_ACTION_TYPES.has(act['type'])) {
        return `history[${i}].action.type must be a valid action type ('click', 'type', 'focus'), got '${String(act['type'])}'`;
      }
      if (histObj['perceivedOutcome'] !== undefined) {
        if (typeof histObj['perceivedOutcome'] !== 'string' || !VALID_OUTCOMES.has(histObj['perceivedOutcome'])) {
          return `history[${i}].perceivedOutcome must be 'success', 'no_change', or 'error' when supplied, got '${String(histObj['perceivedOutcome'])}'`;
        }
      }
    }
  }

  // 4. Options validation
  if (inp['options'] !== undefined) {
    if (typeof inp['options'] !== 'object' || inp['options'] === null) {
      return 'PlannerInput.options must be an object when supplied';
    }
    const opt = inp['options'] as Record<string, unknown>;
    if (opt['minConfidence'] !== undefined) {
      if (
        typeof opt['minConfidence'] !== 'number' ||
        !Number.isFinite(opt['minConfidence']) ||
        (opt['minConfidence'] as number) < 0 ||
        (opt['minConfidence'] as number) > 1
      ) {
        return `options.minConfidence must be a finite number in [0, 1], got ${String(opt['minConfidence'])}`;
      }
    }
    if (opt['maxPerceptionAgeMs'] !== undefined) {
      if (
        typeof opt['maxPerceptionAgeMs'] !== 'number' ||
        !Number.isFinite(opt['maxPerceptionAgeMs']) ||
        (opt['maxPerceptionAgeMs'] as number) < 0
      ) {
        return `options.maxPerceptionAgeMs must be a non-negative finite number, got ${String(opt['maxPerceptionAgeMs'])}`;
      }
    }
    if (opt['strictRoleMatching'] !== undefined && typeof opt['strictRoleMatching'] !== 'boolean') {
      return `options.strictRoleMatching must be a boolean, got ${typeof opt['strictRoleMatching']}`;
    }
  }

  return null;
}

/**
 * Computes a deterministic plan ID from stable goal and context parameters.
 */
function derivePlanId(input: PlannerInput | unknown): string {
  if (typeof input === 'object' && input !== null) {
    const inp = input as Record<string, unknown>;
    const goal = (typeof inp['goal'] === 'object' && inp['goal'] !== null)
      ? (inp['goal'] as Record<string, unknown>)
      : null;
    const ctx = (typeof inp['context'] === 'object' && inp['context'] !== null)
      ? (inp['context'] as Record<string, unknown>)
      : null;

    const goalId = typeof goal?.['id'] === 'string' && goal['id'].length > 0
      ? goal['id']
      : 'unknown';
    const stepIdx = typeof ctx?.['stepIndex'] === 'number' && Number.isInteger(ctx['stepIndex']) && ctx['stepIndex'] >= 0
      ? ctx['stepIndex']
      : 0;

    return `plan_${goalId}_step_${stepIdx}`;
  }
  return 'plan_unknown_step_0';
}

/**
 * Validates role/action compatibility and element interactivity.
 */
export function validateActionRoleCompatibility(
  pageElement: PageElement | undefined,
  target: ActionTarget,
  actionType: ActionType,
  strictRoleMatching: boolean
): { compatible: boolean; message?: string } {
  // 1. Target presence in current perception: availableTargets must correspond to current page representation
  if (pageElement === undefined) {
    return {
      compatible: false,
      message: `Target element '${target.elementId}' has no corresponding PageElement in context.page.elements`
    };
  }

  // 2. Interactivity check: disabled or non-interactive elements are never actionable
  if (pageElement.interactive === false) {
    return {
      compatible: false,
      message: `Target element '${target.elementId}' is marked non-interactive (interactive: false)`
    };
  }
  if (pageElement.state?.disabled === true) {
    return {
      compatible: false,
      message: `Target element '${target.elementId}' is disabled`
    };
  }

  const role: ElementRole = (pageElement.role ?? target.role ?? 'unknown') as ElementRole;

  // 2. Strict mode validation
  if (strictRoleMatching) {
    if (role === 'unknown') {
      return {
        compatible: false,
        message: `Role 'unknown' is rejected in strictRoleMatching mode for element '${target.elementId}'`
      };
    }

    if (actionType === 'click') {
      if (!STRICT_CLICK_ROLES.has(role)) {
        return {
          compatible: false,
          message: `Role '${role}' is not click-compatible in strict mode for element '${target.elementId}'`
        };
      }
      return { compatible: true };
    }

    if (actionType === 'focus') {
      if (!STRICT_FOCUS_ROLES.has(role)) {
        return {
          compatible: false,
          message: `Role '${role}' is not focus-compatible in strict mode for element '${target.elementId}'`
        };
      }
      return { compatible: true };
    }

    // type action
    if (!STRICT_TYPE_ROLES.has(role)) {
      return {
        compatible: false,
        message: `Role '${role}' is not type-compatible in strict mode for element '${target.elementId}'`
      };
    }
    return { compatible: true };
  }

  // 3. Non-strict mode validation
  const hasInteractiveTrue = pageElement?.interactive === true;

  if (actionType === 'click') {
    if (STRICT_CLICK_ROLES.has(role) || hasInteractiveTrue) {
      return { compatible: true };
    }
    return {
      compatible: false,
      message: `Element '${target.elementId}' with role '${role}' is not interactive for click action`
    };
  }

  if (actionType === 'focus') {
    if (STRICT_FOCUS_ROLES.has(role) || hasInteractiveTrue) {
      return { compatible: true };
    }
    return {
      compatible: false,
      message: `Element '${target.elementId}' with role '${role}' is not focusable`
    };
  }

  // actionType === 'type' in non-strict mode
  if (STRICT_TYPE_ROLES.has(role)) {
    return { compatible: true };
  }

  const tag = pageElement?.tagName?.toLowerCase();
  const isInputTag = tag === 'input' || tag === 'textarea';
  const isContentEditable = pageElement?.attributes?.['contenteditable'] === 'true';

  if (hasInteractiveTrue && (isInputTag || isContentEditable)) {
    return { compatible: true };
  }

  return {
    compatible: false,
    message: `Element '${target.elementId}' with role '${role}' does not accept text input`
  };
}

// ---------------------------------------------------------------------------
// 7. Deterministic Lexicographic Rule Planner
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  readonly target: ActionTarget;
  readonly pageElement?: PageElement;
  readonly hintMatch: number;
  readonly tokenMatches: number;
  readonly rolePriority: number;
}

/**
 * Tokenizes text into lowercase alphanumeric keywords, filtering stop words.
 */
function extractTokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Pure, synchronous reference implementation of PlannerDriver.
 * Ranks candidates using strict lexicographic criteria without floating-point weights.
 */
export class DeterministicRulePlanner implements PlannerDriver {
  readonly name = 'DeterministicRulePlanner';

  proposeStep(input: PlannerInput): AdvisoryProposalResult {
    const { goal, context, options } = input;
    const minConfidence = options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const strict = options?.strictRoleMatching ?? DEFAULT_STRICT_ROLE_MATCHING;

    // Reject unsupported high-level goal intents that cannot be mapped to browser actions
    if (goal.intent === 'navigate') {
      return {
        status: 'FAILED',
        reason: 'UNSUPPORTED_GOAL'
      };
    }

    if (context.availableTargets.length === 0) {
      return {
        status: 'FAILED',
        reason: 'NO_FEASIBLE_TARGET'
      };
    }

    const descriptionTokens = extractTokens(goal.description);
    const hint = goal.targetHint?.toLowerCase().trim();

    // Determine target action type from goal intent
    let expectedActionType: ActionType = 'click';
    if (goal.intent === 'type') {
      expectedActionType = 'type';
    } else if (goal.intent === 'focus') {
      expectedActionType = 'focus';
    } else if (goal.intent === 'search') {
      expectedActionType = 'type';
    }

    const scored: ScoredCandidate[] = [];

    for (const target of context.availableTargets) {
      const pageElement = context.page.elements.find((e) => e.id === target.elementId);

      // Skip disabled or non-interactive elements
      if (pageElement !== undefined) {
        if (pageElement.interactive === false || pageElement.state?.disabled === true) {
          continue;
        }
      }

      // Check role/action compatibility
      const comp = validateActionRoleCompatibility(pageElement, target, expectedActionType, strict);
      // If incompatible with expected action, check if it is click-compatible as fallback
      let viableActionType = expectedActionType;
      if (!comp.compatible) {
        if (expectedActionType === 'type' && goal.intent === 'search') {
          // For search, if element is not type-compatible (e.g. search button), check click
          const clickComp = validateActionRoleCompatibility(pageElement, target, 'click', strict);
          if (clickComp.compatible) {
            viableActionType = 'click';
          } else {
            continue;
          }
        } else {
          continue;
        }
      }

      // Criterion 1: Explicit targetHint match
      let hintMatch = 0;
      if (hint !== undefined && hint.length > 0) {
        const idMatch = target.elementId.toLowerCase() === hint || target.elementId.toLowerCase().includes(hint);
        const nameMatch = pageElement?.accessibleName?.toLowerCase().includes(hint) ?? false;
        const textMatch = pageElement?.visibleText?.toLowerCase().includes(hint) ?? false;
        if (idMatch || nameMatch || textMatch) {
          hintMatch = 1;
        }
      }

      // Criterion 2: Description token match count
      let tokenMatches = 0;
      if (descriptionTokens.length > 0) {
        const accName = pageElement?.accessibleName?.toLowerCase() ?? '';
        const visText = pageElement?.visibleText?.toLowerCase() ?? '';
        const elemId = target.elementId.toLowerCase();
        for (const token of descriptionTokens) {
          if (accName.includes(token) || visText.includes(token) || elemId.includes(token)) {
            tokenMatches++;
          }
        }
      }

      // Criterion 3: Semantic role priority
      let rolePriority = 0;
      const role = (pageElement?.role ?? target.role ?? 'unknown') as ElementRole;
      if (viableActionType === 'type' && STRICT_TYPE_ROLES.has(role)) {
        rolePriority = 1;
      } else if (viableActionType === 'click' && STRICT_CLICK_ROLES.has(role)) {
        rolePriority = 1;
      } else if (viableActionType === 'focus' && STRICT_FOCUS_ROLES.has(role)) {
        rolePriority = 1;
      }

      // Candidate must possess at least one positive relevance indicator
      const hasRelevance = hintMatch > 0 || tokenMatches > 0 || rolePriority > 0;
      if (!hasRelevance) {
        continue;
      }

      scored.push({
        target,
        pageElement,
        hintMatch,
        tokenMatches,
        rolePriority
      });
    }

    if (scored.length === 0) {
      return {
        status: 'FAILED',
        reason: 'NO_FEASIBLE_TARGET'
      };
    }

    // Sort strictly lexicographically
    scored.sort((a, b) => {
      // 1. Explicit targetHint match
      if (b.hintMatch !== a.hintMatch) {
        return b.hintMatch - a.hintMatch;
      }
      // 2. Goal-description token matches
      if (b.tokenMatches !== a.tokenMatches) {
        return b.tokenMatches - a.tokenMatches;
      }
      // 3. Semantic role priority
      if (b.rolePriority !== a.rolePriority) {
        return b.rolePriority - a.rolePriority;
      }
      // 4. Higher grounding confidence
      if (b.target.confidence !== a.target.confidence) {
        return b.target.confidence - a.target.confidence;
      }
      // 5. Lexical elementId tie-break
      return a.target.elementId.localeCompare(b.target.elementId);
    });

    const winner = scored[0]!;

    // Check confidence threshold
    if (winner.target.confidence < minConfidence) {
      return {
        status: 'FAILED',
        reason: 'LOW_CONFIDENCE'
      };
    }

    // Determine final action type & payload
    const role = (winner.pageElement?.role ?? winner.target.role ?? 'unknown') as ElementRole;
    let finalActionType: ActionType = 'click';
    if (expectedActionType === 'type' && (STRICT_TYPE_ROLES.has(role) || winner.pageElement?.tagName?.toLowerCase() === 'input')) {
      finalActionType = 'type';
    } else if (expectedActionType === 'focus') {
      finalActionType = 'focus';
    }

    let payload: { text?: string; clearFirst?: boolean; pressEnter?: boolean } | undefined;
    if (finalActionType === 'type') {
      const textToType =
        goal.parameters?.['text'] ??
        goal.parameters?.['query'] ??
        goal.parameters?.['value'] ??
        '';
      payload = {
        text: textToType,
        clearFirst: true,
        pressEnter: goal.intent === 'search'
      };
    }

    return {
      status: 'ACTION',
      proposal: {
        targetElementId: winner.target.elementId,
        actionType: finalActionType,
        payload,
        rationale: `Selected '${winner.target.elementId}' via rule planner (hint=${winner.hintMatch}, tokens=${winner.tokenMatches}, rolePriority=${winner.rolePriority})`
      }
    };
  }
}

// ---------------------------------------------------------------------------
// 8. Main Planning Orchestration Function
// ---------------------------------------------------------------------------

/**
 * Plans the next atomic browser action step.
 *
 * Evaluation pipeline:
 * 1. Validate PlannerInput invariants (pre-driver).
 * 2. Validate freshness (pre-driver).
 * 3. Evaluate caller completion gating (pre-driver).
 * 4. Invoke advisory driver (asynchronous or synchronous).
 * 5. Validate advisory proposal/result structure (post-driver).
 * 6. Validate targetElementId membership in context.availableTargets (post-driver).
 * 7. Validate ElementRole / ActionType compatibility and interactivity (post-driver).
 * 8. Construct IntendedAction via createIntendedAction() (Phase 2F-3).
 * 9. Validate IntendedAction via validateIntendedAction() (Phase 2F-3).
 * 10. Return PlannerResult with deterministic planId.
 *
 * Referentially transparent when given identical inputs and identical driver proposals.
 */
export async function planNextStep(
  input: PlannerInput,
  driver?: PlannerDriver
): Promise<PlannerResult> {
  // STAGE 1 — PRE-DRIVER VALIDATION

  // 1. Validate input invariants
  const inputError = validatePlannerInput(input);
  if (inputError !== null) {
    const planId = derivePlanId(input);
    return {
      status: 'FAILED',
      planId,
      reason: 'INVALID_INPUT',
      message: inputError
    };
  }

  // Snapshot validated planning state before driver invocation to protect against driver mutation
  const validatedGoalId = input.goal.id;
  const validatedStepIndex = input.context.stepIndex;
  const validatedCapturedAt = input.context.capturedAt;
  const validatedCurrentTime = input.context.currentTime;
  const validatedAvailableTargets = input.context.availableTargets.map((t) => ({
    ...t,
    point: { ...t.point },
    viewportBounds: { ...t.viewportBounds }
  }));
  const validatedPageElements = input.context.page.elements.map((e) => ({
    ...e,
    bounds: e.bounds ? { ...e.bounds } : undefined,
    state: e.state ? { ...e.state } : undefined,
    attributes: e.attributes ? { ...e.attributes } : undefined
  }));
  const validatedOptions = input.options ? { ...input.options } : undefined;

  const planId = `plan_${validatedGoalId}_step_${validatedStepIndex}`;

  // 2. Validate freshness
  const maxAge = validatedOptions?.maxPerceptionAgeMs ?? DEFAULT_MAX_PERCEPTION_AGE_MS;
  const age = validatedCurrentTime - validatedCapturedAt;
  if (age > maxAge) {
    return {
      status: 'FAILED',
      planId,
      reason: 'STALE_PERCEPTION',
      message: `Perception data is stale: age ${age}ms exceeds maximum ${maxAge}ms`
    };
  }

  // 3. Caller completion gating
  if (input.context.completion?.satisfied === true) {
    return {
      status: 'COMPLETED',
      planId,
      summary: input.context.completion.summary ?? 'Goal marked as satisfied by caller'
    };
  }

  // STAGE 2 — ADVISORY DRIVER INVOCATION

  const activeDriver = driver ?? new DeterministicRulePlanner();
  let proposalResult: AdvisoryProposalResult;

  // Clone input to pass to advisory driver, isolating caller-owned input from driver mutation
  const driverInput: PlannerInput = typeof structuredClone === 'function'
    ? structuredClone(input)
    : {
        goal: {
          ...input.goal,
          parameters: input.goal.parameters ? { ...input.goal.parameters } : undefined
        },
        context: {
          ...input.context,
          availableTargets: validatedAvailableTargets.map((t) => ({
            ...t,
            point: { ...t.point },
            viewportBounds: { ...t.viewportBounds }
          })),
          page: {
            ...input.context.page,
            elements: validatedPageElements
          },
          completion: input.context.completion ? { ...input.context.completion } : undefined
        },
        options: validatedOptions ? { ...validatedOptions } : undefined,
        history: input.history ? [...input.history] : undefined
      };

  try {
    proposalResult = await activeDriver.proposeStep(driverInput);
  } catch (error) {
    return {
      status: 'FAILED',
      planId,
      reason: 'MODEL_ERROR',
      message: error instanceof Error ? error.message : `Driver threw unexpected error: ${String(error)}`
    };
  }

  if (typeof proposalResult !== 'object' || proposalResult === null) {
    return {
      status: 'FAILED',
      planId,
      reason: 'MODEL_ERROR',
      message: 'Driver returned malformed or null result'
    };
  }

  // Handle driver completion
  if (proposalResult.status === 'COMPLETED') {
    return {
      status: 'COMPLETED',
      planId,
      summary: proposalResult.summary
    };
  }

  // Handle driver failure
  if (proposalResult.status === 'FAILED') {
    // Map known domain failures if explicitly emitted by driver
    if (proposalResult.reason === 'NO_FEASIBLE_TARGET') {
      return {
        status: 'FAILED',
        planId,
        reason: 'NO_FEASIBLE_TARGET',
        message: 'No feasible target found matching goal criteria'
      };
    }
    if (proposalResult.reason === 'LOW_CONFIDENCE') {
      return {
        status: 'FAILED',
        planId,
        reason: 'LOW_CONFIDENCE',
        message: 'Winning target confidence is below the required threshold'
      };
    }
    if (proposalResult.reason === 'UNSUPPORTED_GOAL') {
      return {
        status: 'FAILED',
        planId,
        reason: 'UNSUPPORTED_GOAL',
        message: `Goal '${validatedGoalId}' requests an unsupported intent or parameter`
      };
    }
    return {
      status: 'FAILED',
      planId,
      reason: 'MODEL_ERROR',
      message: proposalResult.reason
    };
  }

  if (proposalResult.status !== 'ACTION') {
    return {
      status: 'FAILED',
      planId,
      reason: 'MODEL_ERROR',
      message: `Driver returned unrecognized status '${String((proposalResult as Record<string, unknown>).status)}'`
    };
  }

  // STAGE 3 — POST-DRIVER PROPOSAL VALIDATION

  // 7. Validate proposal structure
  const proposal = proposalResult.proposal;
  if (typeof proposal !== 'object' || proposal === null) {
    return {
      status: 'FAILED',
      planId,
      reason: 'MODEL_ERROR',
      message: 'Driver returned malformed proposal object'
    };
  }

  if (typeof proposal.targetElementId !== 'string' || proposal.targetElementId.length === 0) {
    return {
      status: 'FAILED',
      planId,
      reason: 'MODEL_ERROR',
      message: 'Driver proposal missing valid targetElementId'
    };
  }

  if (typeof proposal.actionType !== 'string' || !VALID_ACTION_TYPES.has(proposal.actionType)) {
    return {
      status: 'FAILED',
      planId,
      reason: 'MODEL_ERROR',
      message: `Driver proposal specifies invalid actionType '${String(proposal.actionType)}'`
    };
  }

  // 8 & 9. Validate targetElementId membership in context.availableTargets
  const matchedTarget = validatedAvailableTargets.find(
    (t) => t.elementId === proposal.targetElementId
  );
  if (!matchedTarget) {
    return {
      status: 'FAILED',
      planId,
      reason: 'UNKNOWN_TARGET_ELEMENT',
      message: `Driver proposed elementId '${proposal.targetElementId}' which does not exist in availableTargets`
    };
  }

  // Check confidence threshold post-driver
  const minConfidence = validatedOptions?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (matchedTarget.confidence < minConfidence) {
    return {
      status: 'FAILED',
      planId,
      reason: 'LOW_CONFIDENCE',
      message: `Target element '${matchedTarget.elementId}' confidence ${matchedTarget.confidence} is below minimum ${minConfidence}`
    };
  }

  // 10 & 11. Validate role/action compatibility & interactivity
  const pageElement = validatedPageElements.find(
    (e) => e.id === matchedTarget.elementId
  );
  const strict = validatedOptions?.strictRoleMatching ?? DEFAULT_STRICT_ROLE_MATCHING;
  const compatibility = validateActionRoleCompatibility(
    pageElement,
    matchedTarget,
    proposal.actionType,
    strict
  );
  if (!compatibility.compatible) {
    return {
      status: 'FAILED',
      planId,
      reason: 'INCOMPATIBLE_ACTION_FOR_ROLE',
      message: compatibility.message ?? `Action '${proposal.actionType}' is incompatible with target '${matchedTarget.elementId}'`
    };
  }

  // 12. Create IntendedAction via Phase 2F-3 createIntendedAction()
  const deterministicActionId = `intent_${matchedTarget.observationId}_${proposal.actionType}`;
  const creationResult = createIntendedAction({
    id: deterministicActionId,
    type: proposal.actionType,
    target: matchedTarget,
    payload: proposal.payload,
    timestamp: validatedCurrentTime
  });

  if (!creationResult.success) {
    return {
      status: 'FAILED',
      planId,
      reason: 'INVALID_ACTION_INTENT',
      message: `Failed to construct intended action: ${creationResult.message}`,
      targetFailure: creationResult
    };
  }

  // 13. Validate IntendedAction via Phase 2F-3 validateIntendedAction()
  const validationResult = validateIntendedAction(creationResult.action);
  if (!validationResult.success) {
    return {
      status: 'FAILED',
      planId,
      reason: 'INVALID_ACTION_INTENT',
      message: `Action intent validation failed: ${validationResult.message}`,
      targetFailure: validationResult
    };
  }

  // 14. Return successful atomic PlannerActionDecision
  return {
    status: 'ACTION',
    planId,
    action: validationResult.action,
    targetElementId: matchedTarget.elementId,
    rationale: proposal.rationale ?? `Action '${proposal.actionType}' planned for target '${matchedTarget.elementId}'`,
    ...(proposal.estimatedProgress !== undefined ? { estimatedProgress: proposal.estimatedProgress } : {})
  };
}
