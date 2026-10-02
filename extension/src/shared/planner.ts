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
// 1. Goal Contract & Hierarchical Task Plan (Phase A)
// ---------------------------------------------------------------------------

export type PlannerGoalIntent =
  | 'click'
  | 'type'
  | 'focus'
  | 'search'
  | 'navigate'
  | 'form_fill'
  | 'custom';

/** High-level archetype of an agent workflow */
export type TaskArchetype =
  | 'search_and_act'    // e.g. Search for X and play/view/open Y
  | 'form_submission'   // e.g. Create record, fill registration, contact form
  | 'navigation_act'    // e.g. Go to section and toggle setting
  | 'data_extraction'   // e.g. Locate and extract information
  | 'generic_workflow'; // General multi-phase sequence

export const VALID_TASK_ARCHETYPES: ReadonlySet<string> = new Set([
  'search_and_act',
  'form_submission',
  'navigation_act',
  'data_extraction',
  'generic_workflow'
]);

/** Semantic intent of an individual execution phase within a task plan */
export type PhaseIntent =
  | 'open_surface'      // Locate/activate button/link/tab to reveal modal, drawer, or page
  | 'search'            // Enter query and submit to retrieve search results
  | 'select_result'     // Choose navigation destination from search or list results
  | 'fill_field'        // Enter specific value into an identified input/textarea
  | 'select_option'     // Choose dropdown option, radio button, or checkbox
  | 'submit'            // Activate primary form/dialog submission button
  | 'navigate'          // Direct navigation or link traversal
  | 'verify_outcome'    // Inspect page state to confirm successful task completion
  | 'custom';           // Fallback for unclassified phases

export const VALID_PHASE_INTENTS: ReadonlySet<string> = new Set([
  'open_surface',
  'search',
  'select_result',
  'fill_field',
  'select_option',
  'submit',
  'navigate',
  'verify_outcome',
  'custom'
]);

/**
 * Represents a structured parameter to be entered into or selected in a field.
 * Strictly metadata-safe: never contains unredacted raw credentials or vault secrets.
 */
export interface TaskFieldParameter {
  /** Logical field name (e.g. 'task name', 'status', 'due date', 'search query') */
  readonly fieldName: string;
  /** Expected value or target option to select/type (e.g. 'college', 'pending', '2026-09-29') */
  readonly targetValue: string;
  /** Original unnormalized semantic value when targetValue was transformed (e.g. "today's date") */
  readonly rawTargetValue?: string;
  /** Whether this value represents an unresolved vault pointer (e.g. 'profile.email') */
  readonly isVaultReference?: boolean;
  /** Whether this field parameter has been completed */
  readonly completed?: boolean;
}

/**
 * An individual milestone/phase within a structured task plan.
 */
export interface TaskPhase {
  /** Unique identifier for this phase within the plan (e.g. 'phase-0', 'open-modal') */
  readonly phaseId: string;
  /** 0-indexed position within the sequential plan */
  readonly phaseIndex: number;
  /** Semantic intent category for this phase */
  readonly intent: PhaseIntent;
  /** Human-readable description of what this phase accomplishes */
  readonly description: string;
  /** Optional target hint for grounding (e.g. 'Add Task, Create, +') */
  readonly targetHint?: string;
  /** Associated field parameter when this phase fills or selects a field */
  readonly fieldParameter?: TaskFieldParameter;
  /** Allowed low-level action types in this phase (e.g. ['click'], ['type']) */
  readonly allowedActions?: readonly ActionType[];
  /** Expected outcome description used for semantic phase verification */
  readonly expectedOutcome?: string;
  /** Whether completing this phase is required for overall goal satisfaction */
  readonly requiredForCompletion?: boolean;
}

/**
 * High-level task plan decomposed from natural-language goal.
 */
export interface TaskPlan {
  /** Unique plan identifier */
  readonly planId: string;
  /** High-level workflow archetype */
  readonly archetype: TaskArchetype;
  /** Summary of the overall task objective */
  readonly summary: string;
  /** Ordered list of phases required to complete the task */
  readonly phases: readonly TaskPhase[];
  /** Index of the current active phase (0 to phases.length) */
  readonly currentPhaseIndex: number;
  /** Extracted key-value parameters from the user goal (sanitized) */
  readonly extractedParameters?: Record<string, string>;
}

export interface PlannerGoal {
  readonly id: string;
  readonly description: string;
  readonly intent?: PlannerGoalIntent;
  readonly parameters?: Record<string, string>;
  readonly targetHint?: string;
  /** Optional decomposed task plan (Hierarchical Hybrid Architecture - Phase A) */
  readonly taskPlan?: TaskPlan;
}

// ---------------------------------------------------------------------------
// 2. Context & History
// ---------------------------------------------------------------------------

/**
 * Dynamic state of the phase state machine during execution.
 */
export interface PhaseExecutionState {
  /** Currently active phase, if any (undefined when all phases completed) */
  readonly activePhase?: TaskPhase;
  /** Completed phase IDs in execution order */
  readonly completedPhaseIds: readonly string[];
  /** Remaining phase IDs yet to be executed */
  readonly remainingPhaseIds: readonly string[];
  /** Total number of phases in the plan */
  readonly totalPhases: number;
  /** Number of action attempts made within the current phase (for retry limits) */
  readonly retryCountInCurrentPhase: number;
  /** Current phase execution status (Phase D) */
  readonly phaseStatus?: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Whether the last action executed in this phase was atomically verified */
  readonly lastActionVerified?: boolean;
  /** Whether the current phase milestone has been verified */
  readonly milestoneVerified?: boolean;
  /** Cumulative action attempts in current phase */
  readonly phaseAttempts?: number;
}

/**
 * Safe, allowlisted history step for LLM consumption and planner state tracking.
 * Carries phase and parameter provenance without leaking typed text or sensitive values.
 */
export interface SafeModelHistoryStep {
  readonly stepIndex: number;
  readonly phaseIndex?: number;
  readonly phaseIntent?: PhaseIntent;
  readonly actionType: ActionType;
  readonly targetElementId: string;
  readonly targetRole?: string;
  /** Logical parameter reference fulfilled by this step (e.g. 'task.name', 'search.query') */
  readonly fulfilledParameter?: string;
  readonly perceivedOutcome?: 'success' | 'no_change' | 'error';
}

export interface PlannerHistoryStep {
  readonly stepIndex: number;
  readonly action: IntendedAction;
  readonly perceivedOutcome?: 'success' | 'no_change' | 'error';
  readonly phaseIndex?: number;
  readonly phaseIntent?: PhaseIntent;
  readonly fulfilledParameter?: string;
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
  readonly goalSatisfied?: boolean;
  /** Optional phase execution state (Hierarchical Hybrid Architecture - Phase A) */
  readonly phaseState?: PhaseExecutionState;
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
  | 'INCOMPATIBLE_ACTION_FOR_PHASE'
  | 'INVALID_ACTION_INTENT'
  | 'UNSUPPORTED_GOAL'
  | 'NO_MATCHING_RESULTS'
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
 * Validates a TaskFieldParameter object.
 * Returns null if valid, or a descriptive error message string if invalid.
 */
export function validateTaskFieldParameter(param: unknown): string | null {
  if (typeof param !== 'object' || param === null) {
    return 'TaskFieldParameter must be a non-null object';
  }
  const p = param as Record<string, unknown>;
  if (typeof p['fieldName'] !== 'string' || p['fieldName'].trim().length === 0) {
    return 'fieldParameter.fieldName must be a non-empty string';
  }
  if (typeof p['targetValue'] !== 'string') {
    return 'fieldParameter.targetValue must be a string';
  }
  if (p['rawTargetValue'] !== undefined && typeof p['rawTargetValue'] !== 'string') {
    return 'fieldParameter.rawTargetValue must be a string when supplied';
  }
  if (p['isVaultReference'] !== undefined && typeof p['isVaultReference'] !== 'boolean') {
    return 'fieldParameter.isVaultReference must be a boolean when supplied';
  }
  if (p['completed'] !== undefined && typeof p['completed'] !== 'boolean') {
    return 'fieldParameter.completed must be a boolean when supplied';
  }
  return null;
}

/**
 * Validates a TaskPhase object.
 * Returns null if valid, or a descriptive error message string if invalid.
 */
export function validateTaskPhase(phase: unknown): string | null {
  if (typeof phase !== 'object' || phase === null) {
    return 'TaskPhase must be a non-null object';
  }
  const ph = phase as Record<string, unknown>;
  if (typeof ph['phaseId'] !== 'string' || ph['phaseId'].trim().length === 0) {
    return 'phase.phaseId must be a non-empty string';
  }
  if (typeof ph['phaseIndex'] !== 'number' || !Number.isInteger(ph['phaseIndex']) || ph['phaseIndex'] < 0) {
    return `phase.phaseIndex must be a non-negative integer, got ${String(ph['phaseIndex'])}`;
  }
  if (typeof ph['intent'] !== 'string' || !VALID_PHASE_INTENTS.has(ph['intent'])) {
    return `phase.intent must belong to valid PhaseIntent vocabulary, got '${String(ph['intent'])}'`;
  }
  if (typeof ph['description'] !== 'string' || ph['description'].trim().length === 0) {
    return 'phase.description must be a non-empty string';
  }
  if (ph['targetHint'] !== undefined && (typeof ph['targetHint'] !== 'string' || ph['targetHint'].trim().length === 0)) {
    return 'phase.targetHint must be a non-empty string when supplied';
  }
  if (ph['fieldParameter'] !== undefined) {
    const err = validateTaskFieldParameter(ph['fieldParameter']);
    if (err) return err;
  }
  if (ph['allowedActions'] !== undefined) {
    if (!Array.isArray(ph['allowedActions'])) {
      return 'phase.allowedActions must be an array when supplied';
    }
    for (const a of ph['allowedActions']) {
      if (typeof a !== 'string' || !VALID_ACTION_TYPES.has(a)) {
        return `phase.allowedActions elements must be valid ActionTypes ('click', 'type', 'focus'), got '${String(a)}'`;
      }
    }
  }
  if (ph['expectedOutcome'] !== undefined && typeof ph['expectedOutcome'] !== 'string') {
    return 'phase.expectedOutcome must be a string when supplied';
  }
  if (ph['requiredForCompletion'] !== undefined && typeof ph['requiredForCompletion'] !== 'boolean') {
    return 'phase.requiredForCompletion must be a boolean when supplied';
  }
  return null;
}

/**
 * Validates a TaskPlan object.
 * Returns null if valid, or a descriptive error message string if invalid.
 */
export function validateTaskPlan(plan: unknown): string | null {
  if (typeof plan !== 'object' || plan === null) {
    return 'TaskPlan must be a non-null object';
  }
  const pl = plan as Record<string, unknown>;
  if (typeof pl['planId'] !== 'string' || pl['planId'].trim().length === 0) {
    return 'plan.planId must be a non-empty string';
  }
  if (typeof pl['archetype'] !== 'string' || !VALID_TASK_ARCHETYPES.has(pl['archetype'])) {
    return `plan.archetype must belong to valid TaskArchetype vocabulary, got '${String(pl['archetype'])}'`;
  }
  if (typeof pl['summary'] !== 'string' || pl['summary'].trim().length === 0) {
    return 'plan.summary must be a non-empty string';
  }
  if (!Array.isArray(pl['phases'])) {
    return 'plan.phases must be an array';
  }
  if (pl['phases'].length === 0) {
    return 'plan.phases must contain at least one phase';
  }
  for (let i = 0; i < pl['phases'].length; i++) {
    const err = validateTaskPhase(pl['phases'][i]);
    if (err) return `plan.phases[${i}]: ${err}`;
  }
  if (
    typeof pl['currentPhaseIndex'] !== 'number' ||
    !Number.isInteger(pl['currentPhaseIndex']) ||
    pl['currentPhaseIndex'] < 0 ||
    pl['currentPhaseIndex'] > pl['phases'].length
  ) {
    return `plan.currentPhaseIndex must be an integer between 0 and phases.length (${pl['phases'].length}), got ${String(pl['currentPhaseIndex'])}`;
  }
  if (pl['extractedParameters'] !== undefined) {
    if (typeof pl['extractedParameters'] !== 'object' || pl['extractedParameters'] === null || Array.isArray(pl['extractedParameters'])) {
      return 'plan.extractedParameters must be an object when supplied';
    }
    for (const [k, v] of Object.entries(pl['extractedParameters'] as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        return `plan.extractedParameters['${k}'] must be a string, got ${typeof v}`;
      }
    }
  }
  return null;
}

/**
 * Validates a PhaseExecutionState object.
 * Returns null if valid, or a descriptive error message string if invalid.
 */
export function validatePhaseExecutionState(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) {
    return 'PhaseExecutionState must be a non-null object';
  }
  const st = state as Record<string, unknown>;
  if (st['activePhase'] !== undefined) {
    const err = validateTaskPhase(st['activePhase']);
    if (err) return `phaseState.activePhase: ${err}`;
  }
  if (!Array.isArray(st['completedPhaseIds'])) {
    return 'phaseState.completedPhaseIds must be an array';
  }
  for (let i = 0; i < st['completedPhaseIds'].length; i++) {
    if (typeof st['completedPhaseIds'][i] !== 'string') {
      return `phaseState.completedPhaseIds[${i}] must be a string`;
    }
  }
  if (!Array.isArray(st['remainingPhaseIds'])) {
    return 'phaseState.remainingPhaseIds must be an array';
  }
  for (let i = 0; i < st['remainingPhaseIds'].length; i++) {
    if (typeof st['remainingPhaseIds'][i] !== 'string') {
      return `phaseState.remainingPhaseIds[${i}] must be a string`;
    }
  }
  if (typeof st['totalPhases'] !== 'number' || !Number.isInteger(st['totalPhases']) || st['totalPhases'] < 0) {
    return `phaseState.totalPhases must be a non-negative integer, got ${String(st['totalPhases'])}`;
  }
  if (typeof st['retryCountInCurrentPhase'] !== 'number' || !Number.isInteger(st['retryCountInCurrentPhase']) || st['retryCountInCurrentPhase'] < 0) {
    return `phaseState.retryCountInCurrentPhase must be a non-negative integer, got ${String(st['retryCountInCurrentPhase'])}`;
  }
  if (st['phaseStatus'] !== undefined) {
    const validStatuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
    if (typeof st['phaseStatus'] !== 'string' || !validStatuses.has(st['phaseStatus'])) {
      return `phaseState.phaseStatus must be one of 'pending', 'in_progress', 'completed', 'failed', got '${String(st['phaseStatus'])}'`;
    }
  }
  if (st['lastActionVerified'] !== undefined && typeof st['lastActionVerified'] !== 'boolean') {
    return 'phaseState.lastActionVerified must be a boolean';
  }
  if (st['milestoneVerified'] !== undefined && typeof st['milestoneVerified'] !== 'boolean') {
    return 'phaseState.milestoneVerified must be a boolean';
  }
  if (st['phaseAttempts'] !== undefined && (typeof st['phaseAttempts'] !== 'number' || !Number.isInteger(st['phaseAttempts']) || st['phaseAttempts'] < 0)) {
    return `phaseState.phaseAttempts must be a non-negative integer, got ${String(st['phaseAttempts'])}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dynamic Step Budget (Phase D)
// ---------------------------------------------------------------------------

export const MIN_STEP_BUDGET = 3;
export const MAX_STEP_BUDGET = 10;
export const DEFAULT_PHASE_RETRY_ALLOWANCE = 2;

/**
 * Calculates a bounded dynamic action budget derived from the task plan.
 * Clamps (numberOfPhases + retryAllowance) between minBudget and maxBudget.
 */
export function calculateDynamicStepBudget(
  taskPlan?: TaskPlan,
  minBudget: number = MIN_STEP_BUDGET,
  maxBudget: number = MAX_STEP_BUDGET,
  retryAllowance: number = DEFAULT_PHASE_RETRY_ALLOWANCE
): number {
  if (!taskPlan || !Array.isArray(taskPlan.phases) || taskPlan.phases.length === 0) {
    return minBudget;
  }
  const calculated = taskPlan.phases.length + retryAllowance;
  return Math.max(minBudget, Math.min(calculated, maxBudget));
}

/**
 * Validates a SafeModelHistoryStep object.
 * Returns null if valid, or a descriptive error message string if invalid.
 */
export function validateSafeModelHistoryStep(step: unknown): string | null {
  if (typeof step !== 'object' || step === null) {
    return 'SafeModelHistoryStep must be a non-null object';
  }
  const s = step as Record<string, unknown>;
  if (typeof s['stepIndex'] !== 'number' || !Number.isInteger(s['stepIndex']) || s['stepIndex'] < 0) {
    return `historyStep.stepIndex must be a non-negative integer, got ${String(s['stepIndex'])}`;
  }
  if (s['phaseIndex'] !== undefined && (typeof s['phaseIndex'] !== 'number' || !Number.isInteger(s['phaseIndex']) || s['phaseIndex'] < 0)) {
    return `historyStep.phaseIndex must be a non-negative integer when supplied, got ${String(s['phaseIndex'])}`;
  }
  if (s['phaseIntent'] !== undefined && (typeof s['phaseIntent'] !== 'string' || !VALID_PHASE_INTENTS.has(s['phaseIntent']))) {
    return `historyStep.phaseIntent must belong to valid PhaseIntent vocabulary, got '${String(s['phaseIntent'])}'`;
  }
  if (typeof s['actionType'] !== 'string' || !VALID_ACTION_TYPES.has(s['actionType'])) {
    return `historyStep.actionType must be one of 'click', 'type', 'focus', got '${String(s['actionType'])}'`;
  }
  if (typeof s['targetElementId'] !== 'string' || s['targetElementId'].trim().length === 0) {
    return 'historyStep.targetElementId must be a non-empty string';
  }
  if (s['targetRole'] !== undefined && typeof s['targetRole'] !== 'string') {
    return 'historyStep.targetRole must be a string when supplied';
  }
  if (s['fulfilledParameter'] !== undefined && typeof s['fulfilledParameter'] !== 'string') {
    return 'historyStep.fulfilledParameter must be a string when supplied';
  }
  if (s['perceivedOutcome'] !== undefined) {
    if (typeof s['perceivedOutcome'] !== 'string' || !['success', 'no_change', 'error'].includes(s['perceivedOutcome'])) {
      return `historyStep.perceivedOutcome must be 'success', 'no_change', or 'error', got '${String(s['perceivedOutcome'])}'`;
    }
  }
  return null;
}

/**
 * Resolves the currently active TaskPhase from PlannerGoal, PlannerContext, and optional history.
 * 1. Honors explicit context.phaseState.activePhase if present.
 * 2. Otherwise falls back to goal.taskPlan.phases[currentPhaseIndex].
 * 3. Advances index based on verified history steps if currentPhaseIndex is at initial 0.
 * 4. Returns undefined if no task plan exists.
 */
export function resolveActivePhase(
  goal?: PlannerGoal,
  context?: PlannerContext,
  history?: readonly PlannerHistoryStep[]
): TaskPhase | undefined {
  if (context?.phaseState?.activePhase) {
    return context.phaseState.activePhase;
  }
  const plan = goal?.taskPlan;
  if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) {
    return undefined;
  }
  let idx = plan.currentPhaseIndex ?? 0;
  if (history && history.length > 0 && idx === 0) {
    const successfulPhases = history
      .filter((h) => h.perceivedOutcome === 'success' && typeof h.phaseIndex === 'number')
      .map((h) => h.phaseIndex as number);
    if (successfulPhases.length > 0) {
      const maxPhase = Math.max(...successfulPhases);
      idx = Math.min(maxPhase + 1, plan.phases.length - 1);
    } else {
      // In compound search flows (search -> select_result), advance if a type action succeeded
      const hasSearchSuccess = history.some(
        (h) => h.action.type === 'type' && h.perceivedOutcome === 'success'
      );
      if (plan.phases[0].intent === 'search' && hasSearchSuccess) {
        idx = Math.min(1, plan.phases.length - 1);
      } else {
        const successCount = history.filter((h) => h.perceivedOutcome === 'success').length;
        idx = Math.min(successCount, plan.phases.length - 1);
      }
    }
  }
  if (idx >= 0 && idx < plan.phases.length) {
    return plan.phases[idx];
  }
  return undefined;
}

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

  if (goal['taskPlan'] !== undefined) {
    const planErr = validateTaskPlan(goal['taskPlan']);
    if (planErr) {
      return `goal.taskPlan: ${planErr}`;
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

  if (ctx['phaseState'] !== undefined) {
    const phaseErr = validatePhaseExecutionState(ctx['phaseState']);
    if (phaseErr) {
      return `context.phaseState: ${phaseErr}`;
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
      if (histObj['phaseIndex'] !== undefined) {
        if (
          typeof histObj['phaseIndex'] !== 'number' ||
          !Number.isInteger(histObj['phaseIndex']) ||
          (histObj['phaseIndex'] as number) < 0
        ) {
          return `history[${i}].phaseIndex must be a non-negative integer when supplied, got ${String(histObj['phaseIndex'])}`;
        }
      }
      if (histObj['phaseIntent'] !== undefined) {
        if (typeof histObj['phaseIntent'] !== 'string' || !VALID_PHASE_INTENTS.has(histObj['phaseIntent'])) {
          return `history[${i}].phaseIntent must belong to valid PhaseIntent vocabulary, got '${String(histObj['phaseIntent'])}'`;
        }
      }
      if (histObj['fulfilledParameter'] !== undefined) {
        if (typeof histObj['fulfilledParameter'] !== 'string') {
          return `history[${i}].fulfilledParameter must be a string when supplied`;
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
    if (!STRICT_TYPE_ROLES.has(role) && pageElement?.tagName?.toLowerCase() !== 'select') {
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
  if (STRICT_TYPE_ROLES.has(role) || pageElement?.tagName?.toLowerCase() === 'select') {
    return { compatible: true };
  }

  const tag = pageElement?.tagName?.toLowerCase();
  const isInputTag = tag === 'input' || tag === 'textarea' || tag === 'select';
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
  readonly timestamp?: number;
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
 * Extracts a search query string generically from phase description or goal description.
/**
 * Generic analysis of a search goal or phase description.
 * Distinguishes:
 * - Search query (entity to search for, e.g. "Amazon", "Swiggy", "salary", "Netflix", "laptops under ₹50,000")
 * - Selection constraint (e.g. "latest", "most recent", "newest", "first", "last")
 * - Target entity noun (e.g. "transaction", "payment", "order", "receipt")
 */
export interface SearchQueryAnalysis {
  readonly query?: string;
  readonly merchant?: string;
  readonly constraint?: string;
  readonly isLatest?: boolean;
  readonly entityNoun?: string;
  readonly amountFilter?: string;
  readonly temporalFilter?: string;
  readonly requestedAction?: string;
}

/**
 * Normalizes a goal description or search phase description into a clean entity search query.
 *
 * Distinguishes:
 * - Search query / merchant name (e.g. "Amazon", "Swiggy", "salary", "Netflix", "laptops under ₹50,000")
 * - Selection constraint (e.g. "latest", "most recent", "newest", "first", "last")
 * - Target entity noun (e.g. "transaction", "payment", "order", "receipt")
 * - Amount filter (e.g. "₹4,299")
 * - Temporal filter (e.g. "September")
 * - Requested output/action clause (e.g. "show its details", "tell me its amount")
 */
export function cleanSearchQueryCandidate(raw: string): SearchQueryAnalysis {
  if (!raw || typeof raw !== 'string') return {};
  let str = raw.trim();
  if (!str) return {};

  let requestedAction: string | undefined;
  let amountFilter: string | undefined;
  let temporalFilter: string | undefined;

  // 1. Strip trailing punctuation
  str = str.replace(/[.!?]+$/, '').trim();

  // 2. Extract and strip compound action clause at end:
  // e.g. 'and show its details', 'and tell me its amount', 'to view details', 'and play the first video'
  const actionClauseMatch = str.match(/\s+(?:and|then|to)\s+(?:show|tell(?:\s+me)?|display|view|inspect|open|play|watch|click|select|listen|launch|start|stream|find|get)\b.*$/i);
  if (actionClauseMatch && actionClauseMatch.index !== undefined) {
    requestedAction = actionClauseMatch[0].trim().replace(/^(?:and|then|to)\s+/i, '');
    str = str.slice(0, actionClauseMatch.index).trim();
  }

  // 3. Extract and strip amount filter clause:
  // e.g. 'for ₹4,299', 'of ₹4,299', 'for 4299'
  const amountMatch = str.match(/\s+(?:for|of|amounting\s+to|with\s+amount)\s+([₹$€£]?\s*[\d,]+(?:\.\d+)?)\b/i);
  if (amountMatch && amountMatch.index !== undefined) {
    amountFilter = amountMatch[1].trim();
    str = str.slice(0, amountMatch.index) + str.slice(amountMatch.index + amountMatch[0].length);
    str = str.trim();
  }

  // 4. Extract and strip temporal/date/month filter clause:
  // e.g. 'from 30 September 2026', 'on 30 September 2026', 'dated 30 Sep 2026', 'from September', 'in September'
  const fullDateMatch = str.match(/\s+(?:from|on|dated|at|for|in)?\s*\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:\s+\d{2,4})?)\b/i) ||
                        str.match(/\s+(?:from|on|dated|at|for|in)?\s*\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/i);
  if (fullDateMatch && fullDateMatch.index !== undefined) {
    temporalFilter = fullDateMatch[1].trim();
    str = str.slice(0, fullDateMatch.index) + str.slice(fullDateMatch.index + fullDateMatch[0].length);
    str = str.trim();
  } else {
    const monthMatch = str.match(/\s+(?:from|in|for|of)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{4})\b/i);
    if (monthMatch && monthMatch.index !== undefined) {
      temporalFilter = monthMatch[1].trim();
      str = str.slice(0, monthMatch.index) + str.slice(monthMatch.index + monthMatch[0].length);
      str = str.trim();
    }
  }

  // 4b. Conversational question clauses (e.g. "Can you show me the most recent purchase I made on Amazon")
  const conversationalPrefix = str.match(/^(?:can\s+you\s+)?(?:show\s+(?:me\s+)?|find\s+|get\s+(?:me\s+)?|open\s+)?(?:the\s+)?(?:most\s+recent|latest)?\s*(?:purchase|order|transaction|payment|item)\s+(?:i\s+made\s+)?(?:on|from|at)\s+/i);
  let isLatest = false;
  let constraint: string | undefined;
  if (conversationalPrefix) {
    isLatest = /most\s+recent|latest/i.test(conversationalPrefix[0]);
    if (isLatest) constraint = 'latest';
    str = str.slice(conversationalPrefix[0].length).trim();
  }

  // 5. Strip leading action verbs
  str = str.replace(/^(?:search\s+(?:for\s+)?|find\s+|look\s+up\s+|query\s+(?:for\s+)?|show\s+(?:me\s+)?|get\s+(?:me\s+)?|fetch\s+|locate\s+|filter\s+(?:by\s+)?|open\s+|view\s+|display\s+|check\s+|inspect\s+|tell\s+me\s+(?:about\s+)?)/i, '').trim();

  // 6. Strip quotes if wrapped
  str = str.replace(/^["']|["']$/g, '').trim();

  // 7. Strip wrapper phrases like 'the details of', 'details of', etc.
  str = str.replace(/^(?:the\s+details\s+of\s+|details\s+of\s+|information\s+about\s+|info\s+on\s+)/i, '').trim();

  // 8. Strip leading possessives/articles ('my', 'the', 'a', 'an', 'our')
  str = str.replace(/^(?:my|the|a|an|our)\s+/i, '').trim();

  // 9. Detect and strip selection / temporal constraints ('latest', 'most recent', 'newest', 'last', 'first', 'oldest', 'recent')
  if (!constraint) {
    const constraintMatch = str.match(/^(latest|most\s+recent|newest|last|first|oldest|recent)\s+/i);
    if (constraintMatch) {
      constraint = constraintMatch[1].trim().toLowerCase();
      str = str.slice(constraintMatch[0].length).trim();
    }
  }

  // Also check if constraint was embedded: e.g. 'transaction from Amazon' with constraint already stripped or not
  if (!constraint) {
    const embeddedConstraint = str.match(/\b(latest|most\s+recent|newest|last|first|oldest)\b/i);
    if (embeddedConstraint) {
      constraint = embeddedConstraint[1].trim().toLowerCase();
      str = str.replace(/\b(latest|most\s+recent|newest|last|first|oldest)\s*/i, '').trim();
    }
  }

  isLatest = isLatest || (constraint === 'latest' || constraint === 'most recent' || constraint === 'newest');

  // 10. Check for entity noun and merchant separation:
  // Case A: '<noun> from <Merchant>' (e.g. 'transaction from Amazon')
  let entityNoun: string | undefined;
  let merchant: string | undefined;
  const fromMerchantMatch = str.match(/^(?:.*?\s+)?(transactions?|payments?|orders?|receipts?|records?|bills?|invoices?|transfers?|entries|entry|items?|details?)\s+(?:from|at|with|by|on|for)\s+([A-Za-z0-9&]+)$/i);
  if (fromMerchantMatch) {
    entityNoun = fromMerchantMatch[1].trim().toLowerCase();
    merchant = fromMerchantMatch[2].trim();
    str = merchant;
  } else {
    // Case B: '<Merchant> <noun>' (e.g. 'Amazon transaction')
    const nounMatch = str.match(/^(.*?)\s+(transactions?|payments?|orders?|receipts?|records?|bills?|invoices?|transfers?|entries|entry|items?|details?)$/i);
    if (nounMatch) {
      entityNoun = nounMatch[2].trim().toLowerCase();
      const candidateMerchant = nounMatch[1].trim().replace(/^(?:my|the|a|an|our)\s+/i, '').trim();
      if (candidateMerchant.length > 0) {
        merchant = candidateMerchant;
        str = candidateMerchant;
      } else {
        str = '';
      }
    } else {
      // Case C: Just the noun alone (e.g. 'transaction' or 'details')
      const standaloneNoun = str.match(/^(transactions?|payments?|orders?|receipts?|records?|bills?|invoices?|transfers?|entries|entry|items?|details?)$/i);
      if (standaloneNoun) {
        entityNoun = standaloneNoun[1].trim().toLowerCase();
        str = '';
      }
    }
  }

  // Final cleanup of quotes and punctuation
  str = str.replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').trim();

  return {
    query: str.length > 0 ? str : undefined,
    merchant: merchant || (str.length > 0 && entityNoun ? str : undefined),
    constraint,
    isLatest,
    entityNoun,
    amountFilter,
    temporalFilter,
    requestedAction
  };
}

/**
 * Result of validating and normalizing a proposed search query against user intent.
 */
export interface SearchQueryValidationResult {
  readonly valid: boolean;
  readonly query?: string;
  readonly reason?: string;
  readonly merchant?: string;
  readonly temporalFilter?: string;
  readonly amountFilter?: string;
  readonly isAmbiguous?: boolean;
}

/**
 * Validates and deterministically normalizes a search query candidate.
 * Ensures LLM-generated search queries do not pass through full conversational instructions
 * or malformed action clauses. Preserves legitimate multi-word search terms and filters.
 */
export function validateAndNormalizeSearchQuery(
  proposedText?: string,
  goalDescription?: string,
  phaseDescription?: string,
  pageElements?: readonly PageElement[]
): SearchQueryValidationResult {
  const goalAnalysis = goalDescription ? cleanSearchQueryCandidate(goalDescription) : {};
  const phaseAnalysis = phaseDescription ? cleanSearchQueryCandidate(phaseDescription) : {};
  const proposedAnalysis = proposedText ? cleanSearchQueryCandidate(proposedText) : {};

  // 1. Check for unambiguous merchant from goal, phase, or proposal
  const unambiguousMerchant = goalAnalysis.merchant ?? phaseAnalysis.merchant ?? proposedAnalysis.merchant;
  const temporalFilter = goalAnalysis.temporalFilter ?? phaseAnalysis.temporalFilter ?? proposedAnalysis.temporalFilter;
  const amountFilter = goalAnalysis.amountFilter ?? phaseAnalysis.amountFilter ?? proposedAnalysis.amountFilter;

  // Detect whether proposedText contains conversational / task instruction fluff
  const hasFluff = Boolean(
    proposedText && (
      proposedAnalysis.requestedAction ||
      /^(?:find|search|show|get|open|view|tell me)\b/i.test(proposedText.trim()) ||
      /\b(?:and show|and tell|and display|and view|details\.?|transaction and)\b/i.test(proposedText.trim()) ||
      (unambiguousMerchant && proposedText.toLowerCase().includes('transaction'))
    )
  );

  // If unambiguous merchant is known:
  // If proposedText was empty, or has conversational fluff, or doesn't match merchant:
  // normalize to the validated merchant!
  if (unambiguousMerchant && unambiguousMerchant.trim().length > 0) {
    return {
      valid: true,
      query: unambiguousMerchant.trim(),
      merchant: unambiguousMerchant.trim(),
      temporalFilter,
      amountFilter
    };
  }

  // 2. If proposedText is already a clean, legitimate search term without conversational fluff:
  // (e.g. 'laptop', 'custom arbitrary user query', 'mechanical keyboards')
  if (proposedText && proposedText.trim().length > 0 && !hasFluff) {
    const cleanProposed = proposedText.trim();
    // Verify it is not an ambiguous container noun alone (e.g. "transaction", "details")
    const isBareNoun = /^(?:transactions?|payments?|orders?|receipts?|records?|bills?|invoices?|details?)$/i.test(cleanProposed);
    if (!isBareNoun) {
      let groundedQuery = cleanProposed;
      if (pageElements && pageElements.length > 0) {
        const match = pageElements.find(e =>
          e.visibleText?.trim().toLowerCase() === groundedQuery.toLowerCase() ||
          e.accessibleName?.trim().toLowerCase() === groundedQuery.toLowerCase()
        );
        if (match) {
          groundedQuery = match.accessibleName?.trim() || match.visibleText?.trim() || groundedQuery;
        }
      }
      return {
        valid: true,
        query: groundedQuery,
        temporalFilter,
        amountFilter
      };
    }
  }

  // 3. Check for target query from goal or phase (e.g. "Installation Guide", "laptops under ₹50,000")
  const targetQuery = goalAnalysis.query ?? phaseAnalysis.query;
  if (targetQuery && targetQuery.trim().length > 0) {
    let resolvedQuery = targetQuery.trim();
    // Ground casing against pageElements if an element matches case-insensitively
    if (pageElements && pageElements.length > 0) {
      const match = pageElements.find(e =>
        e.visibleText?.trim().toLowerCase() === resolvedQuery.toLowerCase() ||
        e.accessibleName?.trim().toLowerCase() === resolvedQuery.toLowerCase()
      );
      if (match) {
        resolvedQuery = match.accessibleName?.trim() || match.visibleText?.trim() || resolvedQuery;
      }
    }
    return {
      valid: true,
      query: resolvedQuery,
      temporalFilter,
      amountFilter
    };
  }

  // 4. Fall back to proposedAnalysis.query if it's not a bare noun
  if (proposedAnalysis.query && proposedAnalysis.query.trim().length > 0) {
    return {
      valid: true,
      query: proposedAnalysis.query.trim(),
      temporalFilter,
      amountFilter
    };
  }

  // 5. If neither goal nor proposal provides an unambiguous search entity (e.g. only container nouns like "transaction")
  return {
    valid: false,
    isAmbiguous: true,
    reason: 'AMBIGUOUS_SEARCH_QUERY: Cannot safely resolve search target from instruction'
  };
}

/**
 * Generic extraction of date/timestamp from a PageElement or visible content.
 * Checks attributes (data-date, datetime, data-timestamp, data-time) and standard text formats
 * (e.g. '30 Sep 2026', '30 September 2026', '2026-09-30', 'Sep 30, 2026').
 */
const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
};

export function extractTimestampFromElement(element?: PageElement): number | undefined {
  if (!element) return undefined;

  // 1. Check data attributes
  const attrs = element.attributes;
  if (attrs) {
    const dateAttr = attrs['data-date'] || attrs['datetime'] || attrs['data-timestamp'] || attrs['data-time'];
    if (dateAttr) {
      const isoMatch = dateAttr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoMatch) {
        return Date.UTC(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
      }
      const parsed = Date.parse(dateAttr);
      if (!Number.isNaN(parsed)) return parsed;
      const num = Number(dateAttr);
      if (!Number.isNaN(num) && num > 100000000) return num;
    }
  }

  // 2. Search visibleText and accessibleName for date expressions
  const textCandidates = [element.visibleText, element.accessibleName]
    .filter((t): t is string => Boolean(t && t.trim().length > 0));

  for (const text of textCandidates) {
    // Pattern A: Day Month Year (e.g. "30 Sep 2026", "02 September 2026")
    const dmy = text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i);
    if (dmy) {
      const monthIdx = MONTH_MAP[dmy[2].toLowerCase()];
      if (monthIdx !== undefined) {
        return Date.UTC(parseInt(dmy[3], 10), monthIdx, parseInt(dmy[1], 10));
      }
    }

    // Pattern B: Month Day, Year (e.g. "Sep 30, 2026", "September 30, 2026")
    const mdy = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i);
    if (mdy) {
      const monthIdx = MONTH_MAP[mdy[1].toLowerCase()];
      if (monthIdx !== undefined) {
        return Date.UTC(parseInt(mdy[3], 10), monthIdx, parseInt(mdy[2], 10));
      }
    }

    // Pattern C: ISO YYYY-MM-DD
    const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) {
      return Date.UTC(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    }
  }

  return undefined;
}

/**
 * Checks whether a goal, phase description, or target hint specifies a recency/latest selection constraint.
 */
export function isLatestSelectionConstraint(
  goalDescription?: string,
  phaseDescription?: string,
  targetHint?: string
): boolean {
  const combined = `${goalDescription ?? ''} ${phaseDescription ?? ''} ${targetHint ?? ''}`.toLowerCase();
  return /\b(?:latest|most\s+recent|newest|last)\b/i.test(combined);
}

/**
 * Extracts a normalized, semantic search query string from a phase description or goal description.
 * Distinct from selection constraints ("latest", "most recent") and container nouns ("transaction").
 */
export function extractSearchQueryFromGoal(
  phaseDescription?: string,
  goalDescription?: string
): string | undefined {
  const sources = [phaseDescription, goalDescription].filter((s): s is string => Boolean(s && s.trim().length > 0));

  for (const src of sources) {
    const cleaned = cleanSearchQueryCandidate(src);
    if (cleaned.merchant) {
      return cleaned.merchant;
    }
    if (cleaned.query) {
      return cleaned.query;
    }
  }

  return undefined;
}

/**
 * Generic detection of goals or phases expressing intent for playable media
 * (videos, streams, audio tracks, podcasts, etc.).
 * Lexical inspection only, domain-agnostic.
 */
export function isMediaContentGoal(description?: string, targetHint?: string): boolean {
  if (!description && !targetHint) return false;
  const text = `${description ?? ''} ${targetHint ?? ''}`.toLowerCase();
  const hasMediaAction = /\b(?:play|watch|stream|listen)\b/i.test(text);
  const hasMediaNoun = /\b(?:video|videos|clip|movie|episode|track|audio|song|podcast)\b/i.test(text);
  return hasMediaAction || hasMediaNoun;
}

/**
 * Generic profile / channel / author / creator candidate detection.
 * Identifies links or controls that navigate to an entity's profile, channel landing,
 * or author page rather than an individual piece of content.
 * Works across social, video, publishing, and code platforms.
 */
export function isProfileOrChannelCandidate(element?: PageElement): boolean {
  if (!element) return false;
  const href = (element.attributes?.['href'] || '').trim().toLowerCase();
  const name = (element.accessibleName || '').trim().toLowerCase();
  const text = (element.visibleText || '').trim().toLowerCase();

  // 1. Generic URL structure for channel/profile/author/user/handle
  if (href) {
    if (/(?:^|\/)(?:@[a-z0-9._-]+|channel\/|user\/|profile\/|author\/|u\/|c\/|account\/)/i.test(href)) {
      return true;
    }
  }

  // 2. Generic profile/channel accessibleName or visibleText indicators
  if (/^@[a-z0-9._-]+$/i.test(text) || /^@[a-z0-9._-]+$/i.test(name)) {
    return true;
  }
  const profileKeywordsRegex = /\b(?:subscribers?|followers?|view profile|visit profile|go to channel|visit channel|view channel|subscribe)\b/i;
  if (profileKeywordsRegex.test(name) || profileKeywordsRegex.test(text)) {
    return true;
  }

  return false;
}

/**
 * Generic playable media / video candidate detection.
 * Identifies links, media tags, or controls that represent playable or streamable media content.
 * Works across media, video, and audio platforms.
 */
export function isMediaContentCandidate(element?: PageElement): boolean {
  if (!element) return false;
  // If it represents a channel/profile surface, it is not a media content item
  if (isProfileOrChannelCandidate(element)) {
    return false;
  }

  const tagName = element.tagName?.toLowerCase();
  if (tagName === 'video' || tagName === 'audio') {
    return true;
  }

  const href = (element.attributes?.['href'] || '').trim().toLowerCase();
  const name = (element.accessibleName || '').trim().toLowerCase();
  const text = (element.visibleText || '').trim().toLowerCase();

  // 1. Generic media URL structures
  if (href) {
    if (/(?:[?&](?:v|video_id)=|\/(?:watch|video|videos|embed|play|player|stream|shorts|clip|episode|track)\b)/i.test(href)) {
      return true;
    }
  }

  // 2. Duration / timestamp metadata (strongly indicates media items across platforms)
  if (/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(name) || /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(text)) {
    return true;
  }
  if (/\b\d+\s*(?:seconds?|mins?|minutes?|hours?)\b/i.test(name) || /\b\d+\s*(?:seconds?|mins?|minutes?|hours?)\b/i.test(text)) {
    return true;
  }

  // 3. Media view/listen indicators or video aria-label
  if (/\b\d+[\d.,]*\s*(?:views|listens|plays)\b/i.test(name) || /\b\d+[\d.,]*\s*(?:views|listens|plays)\b/i.test(text)) {
    return true;
  }

  return false;
}

/**
 * Generic channel/profile URL detection for page metadata or link destinations.
 */
export function isProfileOrChannelUrl(url?: string): boolean {
  if (!url) return false;
  return /(?:^|\/)(?:@[a-z0-9._-]+|channel\/|user\/|profile\/|author\/|u\/|c\/|account\/)/i.test(url);
}

/**
 * Generic media URL detection for page metadata or link destinations.
 */
export function isMediaContentUrl(url?: string): boolean {
  if (!url) return false;
  if (isProfileOrChannelUrl(url)) return false;
  return /(?:[?&](?:v|video_id)=|\/(?:watch|video|videos|embed|play|player|stream|shorts|clip|episode|track)\b)/i.test(url);
}

/**
 * Pure, synchronous reference implementation of PlannerDriver.
 * Ranks candidates using strict lexicographic criteria without floating-point weights.
 */
export class DeterministicRulePlanner implements PlannerDriver {
  readonly name = 'DeterministicRulePlanner';

  proposeStep(input: PlannerInput): AdvisoryProposalResult {
    const { goal, context, options, history } = input;
    const minConfidence = options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const strict = options?.strictRoleMatching ?? DEFAULT_STRICT_ROLE_MATCHING;

    // Resolve active phase if present
    const activePhase = resolveActivePhase(goal, context, history);

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
    const hint = (activePhase?.targetHint || activePhase?.fieldParameter?.fieldName || goal.targetHint)?.toLowerCase().trim();

    // Determine target action type: active phase intent takes precedence over global goal intent
    let expectedActionType: ActionType = 'click';
    if (activePhase) {
      if (activePhase.intent === 'fill_field') {
        expectedActionType = 'type';
      } else if (activePhase.intent === 'search') {
        expectedActionType = 'type';
      } else if (activePhase.intent === 'select_option') {
        expectedActionType = 'click';
      } else if (
        activePhase.intent === 'open_surface' ||
        activePhase.intent === 'select_result' ||
        activePhase.intent === 'submit' ||
        activePhase.intent === 'navigate'
      ) {
        expectedActionType = 'click';
      }
    } else if (goal.intent === 'type' || goal.intent === 'search') {
      expectedActionType = 'type';
    } else if (goal.intent === 'focus') {
      expectedActionType = 'focus';
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

      const role = (pageElement?.role ?? target.role ?? 'unknown') as ElementRole;
      const isNativeSelect = pageElement?.tagName?.toLowerCase() === 'select';
      const isSuggestion =
        role === 'option' ||
        role === 'menuitem' ||
        role === 'listbox' ||
        pageElement?.attributes?.['role'] === 'option' ||
        pageElement?.attributes?.['role'] === 'menuitem' ||
        pageElement?.attributes?.['role'] === 'listbox';

      // When activePhase is select_option, target must be a compatible selectable control.
      // Text entry / searchbox controls are fundamentally incompatible with option selection.
      if (activePhase?.intent === 'select_option') {
        const isSearchOrGenericText =
          role === 'searchbox' ||
          (role === 'textbox' && !isNativeSelect) ||
          pageElement?.attributes?.['type'] === 'search';
        if (isSearchOrGenericText) {
          continue;
        }
      }

      // When activePhase is select_result, text entry, searchbox, and container/combobox controls are not search results.
      if (activePhase?.intent === 'select_result') {
        const isSearchOrInputOrContainer =
          role === 'searchbox' ||
          role === 'textbox' ||
          role === 'combobox' ||
          role === 'listbox' ||
          pageElement?.tagName?.toLowerCase() === 'input' ||
          pageElement?.attributes?.['type'] === 'search';
        if (isSearchOrInputOrContainer) {
          continue;
        }
      }

      const isSearchIntent = activePhase ? activePhase.intent === 'search' : goal.intent === 'search';

      // In search phase: autocomplete suggestions generated from the search input must NOT
      // be selected as the search submission target.
      if (isSearchIntent && isSuggestion) {
        continue;
      }

      // Determine candidate action type based on phase intent and grounded target capability
      let candidateActionType: ActionType;
      if (activePhase?.intent === 'select_option') {
        // Generic rule: native <select> -> type(targetValue), radio/checkbox/combobox/other -> click
        candidateActionType = isNativeSelect ? 'type' : 'click';
      } else if (activePhase?.intent === 'fill_field') {
        candidateActionType = 'type';
      } else {
        candidateActionType = expectedActionType;
      }

      // Check role/action compatibility
      const comp = validateActionRoleCompatibility(pageElement, target, candidateActionType, strict);
      // If incompatible with expected action, check if it is click-compatible as fallback
      let viableActionType = candidateActionType;
      if (!comp.compatible) {
        if (candidateActionType === 'type' && isSearchIntent) {
          // For search, if element is not type-compatible, allow click ONLY for explicit search buttons/controls
          const isButtonOrSubmit =
            role === 'button' ||
            pageElement?.tagName?.toLowerCase() === 'button' ||
            (pageElement?.tagName?.toLowerCase() === 'input' &&
              (pageElement?.inputType === 'submit' || pageElement?.inputType === 'button'));
          if (isButtonOrSubmit) {
            const clickComp = validateActionRoleCompatibility(pageElement, target, 'click', strict);
            if (clickComp.compatible) {
              viableActionType = 'click';
            } else {
              continue;
            }
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

      const goalAnalysis = cleanSearchQueryCandidate(goal.description);

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

      // Criterion 2b: Amount filter boost (e.g. "for ₹4,299")
      if (goalAnalysis.amountFilter) {
        const cleanAmount = goalAnalysis.amountFilter.replace(/[^\d]/g, '');
        if (cleanAmount.length > 0) {
          const rawAmount = pageElement?.attributes?.['data-amount'] || '';
          const elemAmount = rawAmount.replace(/[^\d]/g, '');
          const elemText = ((pageElement?.visibleText ?? '') + ' ' + (pageElement?.accessibleName ?? '')).replace(/[^\d]/g, '');
          if (elemAmount === cleanAmount || elemText.includes(cleanAmount)) {
            tokenMatches += 10;
          }
        }
      }

      // Criterion 2c: Temporal/month filter boost (e.g. "from September")
      if (goalAnalysis.temporalFilter) {
        const filterLower = goalAnalysis.temporalFilter.toLowerCase();
        const elemText = ((pageElement?.visibleText ?? '') + ' ' + (pageElement?.accessibleName ?? '') + ' ' + (pageElement?.attributes?.['data-date'] ?? '')).toLowerCase();
        if (elemText.includes(filterLower)) {
          tokenMatches += 10;
        }
      }

      // Criterion 3: Semantic role priority
      let rolePriority = 0;
      if (activePhase?.intent === 'select_option') {
        const SELECTABLE_ROLES: ReadonlySet<ElementRole> = new Set([
          'combobox',
          'listbox',
          'option',
          'radio',
          'checkbox'
        ]);
        if (SELECTABLE_ROLES.has(role) || isNativeSelect) {
          rolePriority = 1;
        }
      } else if (isSearchIntent) {
        const isSearchInput =
          viableActionType === 'type' &&
          (role === 'searchbox' || role === 'textbox' || role === 'combobox' ||
           pageElement?.tagName?.toLowerCase() === 'input');
        if (isSearchInput) {
          rolePriority = 2; // Search input is strongly preferred
        } else if (viableActionType === 'click' && role === 'button') {
          rolePriority = 1; // Explicit search submit control is valid fallback
        }
      } else if (activePhase?.intent === 'select_result') {
        const isMediaGoal = isMediaContentGoal(goal.description, activePhase.targetHint || activePhase.description);
        const isContent = isMediaGoal ? isMediaContentCandidate(pageElement) : false;
        const isProfileOrChannel = isMediaGoal ? isProfileOrChannelCandidate(pageElement) : false;

        if (isMediaGoal) {
          if (isContent) {
            rolePriority = 3; // Playable media / video content candidate is top priority
          } else if (isProfileOrChannel) {
            rolePriority = 0; // Profile/channel navigation penalized when media content is requested
          } else if (role === 'link') {
            rolePriority = 2; // Generic link fallback
          } else if (viableActionType === 'click') {
            rolePriority = 1; // Generic clickable fallback
          }
        } else {
          const isResultItem =
            role === 'link' ||
            pageElement?.tagName?.toLowerCase() === 'tr' ||
            pageElement?.tagName?.toLowerCase() === 'li' ||
            pageElement?.attributes?.['role'] === 'row' ||
            pageElement?.attributes?.['role'] === 'listitem';
          if (isResultItem) {
            rolePriority = 2; // Result links, rows, or list items are strongly preferred
          } else if (viableActionType === 'click') {
            const isSearchControl =
              target.elementId === 'search-btn' ||
              pageElement?.attributes?.['type'] === 'submit' ||
              pageElement?.visibleText?.trim().toLowerCase() === 'search' ||
              pageElement?.accessibleName?.trim().toLowerCase() === 'search' ||
              target.elementId.toLowerCase().includes('search');
            if (!isSearchControl) {
              rolePriority = 1; // Other clickable controls (e.g. result buttons)
            }
          }
        }
      } else if (viableActionType === 'type' && STRICT_TYPE_ROLES.has(role)) {
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

      const timestamp = extractTimestampFromElement(pageElement);

      scored.push({
        target,
        pageElement,
        hintMatch,
        tokenMatches,
        rolePriority,
        timestamp
      });
    }

    if (scored.length === 0) {
      return {
        status: 'FAILED',
        reason: 'NO_FEASIBLE_TARGET'
      };
    }

    const isSearchIntent = activePhase ? activePhase.intent === 'search' : goal.intent === 'search';
    const isLatest = isLatestSelectionConstraint(
      goal.description,
      activePhase?.description,
      activePhase?.targetHint
    );
    const goalAnalysis = cleanSearchQueryCandidate(goal.description);

    // Sort strictly lexicographically
    scored.sort((a, b) => {
      // In search or select_result phase: primary role (search input or result link = 2) takes strict precedence over fallback controls
      if ((isSearchIntent || activePhase?.intent === 'select_result') && b.rolePriority !== a.rolePriority) {
        return b.rolePriority - a.rolePriority;
      }
      // 1. Explicit targetHint match
      if (b.hintMatch !== a.hintMatch) {
        return b.hintMatch - a.hintMatch;
      }
      // 1b. Recency/latest timestamp comparison for select_result with latest constraint (prioritized over accidental token matches)
      if (activePhase?.intent === 'select_result' && isLatest && !goalAnalysis.amountFilter) {
        const timeA = a.timestamp ?? 0;
        const timeB = b.timestamp ?? 0;
        if (timeA !== timeB) {
          return timeB - timeA;
        }
      }
      // 2. Goal-description token matches / amount matches
      if (b.tokenMatches !== a.tokenMatches) {
        return b.tokenMatches - a.tokenMatches;
      }
      // 2b. Recency/latest timestamp comparison fallback
      if (activePhase?.intent === 'select_result' && isLatest) {
        const timeA = a.timestamp ?? 0;
        const timeB = b.timestamp ?? 0;
        if (timeA !== timeB) {
          return timeB - timeA;
        }
      }
      // 3. Semantic role priority (for other intents)
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
    if (activePhase?.intent === 'select_option') {
      const isNativeSelect = winner.pageElement?.tagName?.toLowerCase() === 'select';
      finalActionType = isNativeSelect ? 'type' : 'click';
    } else if (
      expectedActionType === 'type' &&
      (STRICT_TYPE_ROLES.has(role) ||
        winner.pageElement?.tagName?.toLowerCase() === 'input' ||
        winner.pageElement?.tagName?.toLowerCase() === 'textarea' ||
        winner.pageElement?.tagName?.toLowerCase() === 'select')
    ) {
      finalActionType = 'type';
    } else if (expectedActionType === 'focus') {
      finalActionType = 'focus';
    }

    let payload: { text?: string; clearFirst?: boolean; pressEnter?: boolean } | undefined;
    if (finalActionType === 'type') {
      let textToType =
        activePhase?.fieldParameter?.targetValue ??
        goal.parameters?.['text'] ??
        goal.parameters?.['query'] ??
        goal.parameters?.['value'];

      if (isSearchIntent) {
        const queryValidation = validateAndNormalizeSearchQuery(
          textToType ?? '',
          goal.description,
          activePhase?.description,
          context.page.elements
        );
        if (queryValidation.valid && queryValidation.query) {
          textToType = queryValidation.query;
        } else if (!textToType) {
          textToType = extractSearchQueryFromGoal(activePhase?.description, goal.description);
        }
      }

      payload = {
        text: textToType ?? '',
        clearFirst: true,
        pressEnter: isSearchIntent && activePhase?.intent !== 'select_option'
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
    if (proposalResult.reason === 'NO_MATCHING_RESULTS') {
      return {
        status: 'FAILED',
        planId,
        reason: 'NO_MATCHING_RESULTS',
        message: 'No matching transaction results are available for the current selection phase.'
      };
    }
    if (proposalResult.reason?.startsWith('INCOMPATIBLE_ACTION_FOR_PHASE') || proposalResult.reason === 'INCOMPATIBLE_ACTION_FOR_PHASE') {
      return {
        status: 'FAILED',
        planId,
        reason: 'INCOMPATIBLE_ACTION_FOR_PHASE',
        message: proposalResult.reason
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

  // 7b. Validate action against active phase allowedActions (Phase C: Action Allowlist Enforcement)
  const activePhase = resolveActivePhase(input.goal, input.context, input.history);
  if (activePhase?.allowedActions && activePhase.allowedActions.length > 0) {
    if (!activePhase.allowedActions.includes(proposal.actionType)) {
      return {
        status: 'FAILED',
        planId,
        reason: 'INCOMPATIBLE_ACTION_FOR_PHASE',
        message: `Proposed action '${proposal.actionType}' is not allowed in active phase '${activePhase.intent}' (allowed: ${activePhase.allowedActions.join(', ')})`
      };
    }
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
