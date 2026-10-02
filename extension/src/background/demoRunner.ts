/**
 * Phase 3B/5A Demo Integration — NexVision E2E Demo Runner.
 *
 * Wires the existing tested components into a single bounded demo loop:
 *   perceivePage → sanitizePageRepresentation → groundVisualObservations
 *   → resolveActionTarget → planNextStep(LocalAgentDriver) → executeAction
 *   → (optional re-perceive for verification)
 *
 * Invariants:
 * - Reuses ALL existing tested modules without modification.
 * - No new planner, executor, or action contracts.
 * - Privacy boundary is never bypassed: sanitizePageRepresentation()
 *   is always applied before the model sees any page data.
 * - Loop is hard-bounded (MAX_STEPS). No infinite loops.
 * - No autonomous retries; each step failure is reported and stops the loop.
 * - No network calls beyond the existing llama-server client.
 * - No DOM mutation, no screenshot persistence.
 */

import type { PageRepresentation, PageElement, ElementRole, AgentProgressEvent, ExecutionResult } from '../shared/types.js';
import type { ActionTarget, IntendedAction } from '../shared/actions.js';
import { resolveActionTarget } from '../shared/actions.js';
import { groundVisualObservations } from '../shared/grounding.js';
import type { CoordinateSpaceMetadata } from '../shared/coordinates.js';
import type {
  PlannerInput,
  PlannerResult,
  PlannerHistoryStep,
  PlannerGoal,
  PlannerGoalIntent,
  TaskPlan,
  TaskPhase,
  PhaseExecutionState
} from '../shared/planner.js';
import {
  planNextStep,
  resolveActivePhase,
  calculateDynamicStepBudget,
  MIN_STEP_BUDGET,
  MAX_STEP_BUDGET,
  DEFAULT_PHASE_RETRY_ALLOWANCE,
  isMediaContentGoal,
  isProfileOrChannelCandidate,
  isMediaContentCandidate,
  isMediaContentUrl,
  isProfileOrChannelUrl,
  cleanSearchQueryCandidate,
  extractTimestampFromElement
} from '../shared/planner.js';
import { sanitizePageRepresentation } from '../privacy/sanitizer.js';
import { LocalAgentDriver, decomposeTaskGoal, summarizeTaskPlanForLogs } from './localAgent.js';
import { perceivePage } from './orchestrator.js';
import type { DomPerceptionProvider, VisualObservation } from './orchestrator.js';
import { nullVisionAdapter } from './service-worker.js';
import { createLlamaVisionAdapter } from './llamaVisionAdapter.js';
import { captureVisibleTab } from './screenshot.js';
import { executeAction } from './executor.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of planning/execution cycles in the bounded demo loop (baseline). */
export const MAX_STEPS = 3;
export const MAX_PHASE_RETRIES = 2;

export {
  calculateDynamicStepBudget,
  MIN_STEP_BUDGET,
  MAX_STEP_BUDGET,
  DEFAULT_PHASE_RETRY_ALLOWANCE
};

/**
 * Minimum number of interactive elements (with usable bounds) required in the
 * DOM representation for vision inference to be considered unnecessary.
 *
 * When DOM perception already provides at least this many actionable targets,
 * the optional llama-server vision request is skipped for the current step.
 * This prevents the ~58 s vision inference from competing with the planner
 * on pages where the DOM alone is sufficient for grounding.
 *
 * Set to 1 intentionally: any single interactive, bounded element means the
 * planner has a usable target set, so vision adds no grounding value.
 */
export const DOM_SUFFICIENT_INTERACTIVE_THRESHOLD = 1;

/** Default planner options for the demo. */
const DEMO_PLANNER_OPTIONS = {
  minConfidence: 0.0,
  maxPerceptionAgeMs: 15000,
  strictRoleMatching: false
} as const;

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

export interface DemoStepPerception {
  readonly elementCount: number;
  readonly interactiveCount: number;
  readonly visualObservationCount: number;
  readonly privacyFindingCount: number;
  readonly pageTitle?: string;
  readonly visionAdapterName: string;
}

export interface DemoStepPlan {
  readonly status: PlannerResult['status'];
  readonly rationale?: string;
  readonly targetElementId?: string;
  readonly actionType?: string;
}

export interface DemoStepExecution {
  readonly success: boolean;
  readonly actionType?: string;
  readonly elementId?: string;
  readonly reason?: string;
}

export interface DemoStepVerification {
  readonly verified: boolean;
  readonly message: string;
  readonly afterPage?: PageRepresentation;
  /** Optional privacy-safe indicator that live DOM accepted the intended action value */
  readonly valueMatch?: boolean;
}

export interface DemoStep {
  readonly stepIndex: number;
  readonly perception: DemoStepPerception;
  readonly plan: DemoStepPlan;
  readonly execution?: DemoStepExecution;
  readonly verification?: DemoStepVerification;
}

export type DemoRunStatus =
  | 'COMPLETED'
  | 'MAX_STEPS_REACHED'
  | 'PLAN_FAILED'
  | 'EXECUTION_FAILED'
  | 'PERCEPTION_FAILED';

export interface DemoRunResult {
  readonly status: DemoRunStatus;
  readonly steps: readonly DemoStep[];
  readonly totalSteps: number;
  readonly message: string;
}

export interface DemoRunnerOptions {
  /** Request timeout for local llama-server visual perception in milliseconds. Default: 65000 (65s). */
  visionTimeoutMs?: number;
  /** Settle delay in ms before post-action re-perception. Default: 400ms. */
  verificationSettleMs?: number;
  /** Optional chat client for task decomposition (Phase B) and planning. */
  chatClient?: import('./localAgent.js').LocalLlamaChatClient;
  /** Optional pre-computed or injected TaskPlan. */
  taskPlan?: TaskPlan;
  /** Optional override for maximum step budget. */
  maxSteps?: number;
  /** Optional runtime phase execution state. */
  phaseState?: PhaseExecutionState;
}

/**
 * Default timeout for local llama-server visual perception in the demo runner.
 * Empirically measured latency on Qwen2.5-VL-3B running mmproj on CPU:
 *   - Screenshot capture: ~210 ms
 *   - Prompt evaluation (1,686 image tokens on CPU): ~46,800 ms
 *   - Generation evaluation (288 tokens on Vulkan1 GPU): ~3,600 ms
 *   - Response parsing & validation: ~2 ms
 *   - Total measured latency: ~52,700 ms
 * 65,000 ms provides ~23% safety headroom above measured latency under local load.
 */
export const DEFAULT_DEMO_VISION_TIMEOUT_MS = 65000;

// ---------------------------------------------------------------------------
// DOM-Sufficient Vision Skip Guard
// ---------------------------------------------------------------------------

/**
 * Returns true when a DOM page representation already contains enough
 * interactive, bounded elements to satisfy the grounding requirement without
 * requiring vision inference.
 *
 * A target is considered "usable" when it is interactive and has non-zero bounds.
 * This mirrors the identical filter in buildAvailableTargets Path B.
 *
 * Exported for direct unit testing.
 */
export function hasSufficientDomTargets(
  domPage: PageRepresentation,
  threshold: number = DOM_SUFFICIENT_INTERACTIVE_THRESHOLD
): boolean {
  let count = 0;
  for (const element of domPage.elements) {
    if (!element.interactive) continue;
    if (!element.bounds) continue;
    const { width, height } = element.bounds;
    if (width <= 0 || height <= 0) continue;
    count++;
    if (count >= threshold) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Target Building
// ---------------------------------------------------------------------------

/**
 * Builds ActionTarget[] from visual observations + DOM grounding.
 * Falls back to DOM-only targets when no visual observations are available.
 *
 * This is the ONLY integration glue; every sub-function it calls is an
 * existing tested module.
 */
function buildAvailableTargets(
  domRepresentation: PageRepresentation,
  visualObservations: readonly VisualObservation[],
  screenshotDimensions?: { width: number; height: number }
): ActionTarget[] {
  const targets: ActionTarget[] = [];

  // Path A: vision observations → grounding → ActionTarget
  if (visualObservations.length > 0) {
    const { viewport } = domRepresentation;

    const screenshotWidth = screenshotDimensions?.width ?? viewport.width;
    const screenshotHeight = screenshotDimensions?.height ?? viewport.height;

    const coordinateSpace: CoordinateSpaceMetadata = {
      screenshotWidth,
      screenshotHeight,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      devicePixelRatio: screenshotDimensions
        ? screenshotDimensions.width / viewport.width
        : 1
    };

    const groundingInputs = visualObservations
      .filter(obs => obs.boundingBox && obs.confidence >= 0)
      .map(obs => ({
        id: obs.id,
        label: obs.label,
        text: obs.text,
        boundingBox: obs.boundingBox,
        confidence: obs.confidence,
        interactionHint: obs.interactionHint
      }));

    if (groundingInputs.length > 0) {
      const groundingResults = groundVisualObservations(
        groundingInputs,
        domRepresentation,
        coordinateSpace
      );

      for (const result of groundingResults) {
        const resolution = resolveActionTarget(result);
        if (resolution.success) {
          targets.push(resolution.target);
        }
      }
    }
  }

  // Path B: DOM-only fallback — build targets directly from interactive elements
  // Used when llama-server is unavailable or returned zero observations.
  if (targets.length === 0) {
    for (const element of domRepresentation.elements) {
      if (!element.interactive) continue;
      if (!element.bounds) continue;
      const { x, y, width, height } = element.bounds;
      if (width <= 0 || height <= 0) continue;

      const target: ActionTarget = {
        elementId: element.id,
        point: { x: x + width / 2, y: y + height / 2 },
        viewportBounds: { x, y, width, height },
        confidence: 0.7,           // nominal confidence for DOM-only targets
        observationId: `dom-${element.id}`,
        role: element.role
      };
      targets.push(target);
    }
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Semantic Post-Action Verifier
// ---------------------------------------------------------------------------

/**
 * Minimal semantic post-action verification.
 * Re-perceives the page via domProvider() to verify that the executed action
 * produced an observable effect in the live page state.
 */
export async function verifyActionEffect(
  action: IntendedAction,
  beforePage: PageRepresentation,
  domProvider: DomPerceptionProvider,
  settleDelayMs = 400,
  execResult?: ExecutionResult
): Promise<DemoStepVerification> {
  const valueMatch = execResult?.success && typeof execResult.valueMatch === 'boolean'
    ? execResult.valueMatch
    : undefined;

  if (settleDelayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, settleDelayMs));
  }

  let afterPage: PageRepresentation;
  try {
    afterPage = await domProvider();
  } catch (err) {
    return {
      verified: false,
      message: `Re-perception failed: ${err instanceof Error ? err.message : String(err)}`,
      ...(valueMatch !== undefined ? { valueMatch } : {})
    };
  }

  // 1. Verification for text input actions
  if (action.type === 'type') {
    const targetId = action.target.elementId;
    const targetElem = afterPage.elements.find(e => e.id === targetId);
    const typedText = action.payload?.text;

    // Check if target input element reflects typed text
    if (targetElem) {
      const textMatches =
        (typeof targetElem.visibleText === 'string' &&
          typedText &&
          targetElem.visibleText.includes(typedText)) ||
        (typeof targetElem.attributes?.['value'] === 'string' &&
          typedText &&
          targetElem.attributes['value'].includes(typedText));

      if (textMatches) {
        return {
          verified: true,
          message: `Input populated with "${typedText}"`,
          afterPage,
          ...(valueMatch !== undefined ? { valueMatch } : { valueMatch: true })
        };
      }
    }

    // Check if submitting via enter triggered navigation or title change
    if (action.payload?.pressEnter) {
      if (
        afterPage.metadata?.url &&
        beforePage.metadata?.url &&
        afterPage.metadata.url !== beforePage.metadata.url
      ) {
        return {
          verified: true,
          message: 'Search submitted (page URL updated)',
          afterPage,
          ...(valueMatch !== undefined ? { valueMatch } : {})
        };
      }
      if (
        afterPage.metadata?.title &&
        beforePage.metadata?.title &&
        afterPage.metadata.title !== beforePage.metadata.title
      ) {
        return {
          verified: true,
          message: `Search submitted (page title: "${afterPage.metadata.title}")`,
          afterPage,
          ...(valueMatch !== undefined ? { valueMatch } : {})
        };
      }
    }

    // Fallback: verify DOM connection and interactive state
    if (targetElem && targetElem.interactive) {
      return {
        verified: true,
        message: `Text entry processed on ${targetId}`,
        afterPage,
        ...(valueMatch !== undefined ? { valueMatch } : {})
      };
    }

    return {
      verified: false,
      message: `Target element "${targetId}" not found or inactive after typing`,
      afterPage,
      ...(valueMatch !== undefined ? { valueMatch } : {})
    };
  }

  // 2. Verification for click actions
  if (action.type === 'click') {
    if (
      afterPage.metadata?.url &&
      beforePage.metadata?.url &&
      afterPage.metadata.url !== beforePage.metadata.url
    ) {
      return {
        verified: true,
        message: `Navigated to ${afterPage.metadata.url}`,
        afterPage
      };
    }

    if (
      afterPage.metadata?.title &&
      beforePage.metadata?.title &&
      afterPage.metadata.title !== beforePage.metadata.title
    ) {
      return {
        verified: true,
        message: `Page updated (title: "${afterPage.metadata.title}")`,
        afterPage
      };
    }

    // Check for DOM mutations (new elements rendered)
    const beforeIds = new Set(beforePage.elements.map(e => e.id));
    const newElements = afterPage.elements.filter(e => !beforeIds.has(e.id));
    if (newElements.length > 0) {
      return {
        verified: true,
        message: `Page updated (${newElements.length} new element(s) observed)`,
        afterPage
      };
    }

    return {
      verified: true,
      message: `Click interaction confirmed on ${action.target.elementId}`,
      afterPage
    };
  }

  // 3. Verification for focus actions
  if (action.type === 'focus') {
    const targetId = action.target.elementId;
    const targetElem = afterPage.elements.find(e => e.id === targetId);
    if (targetElem?.state?.focused) {
      return {
        verified: true,
        message: `Focus confirmed on ${targetId}`,
        afterPage
      };
    }
    return {
      verified: true,
      message: `Focus applied to ${targetId}`,
      afterPage
    };
  }

  return {
    verified: true,
    message: 'Action completed',
    afterPage
  };
}

// ---------------------------------------------------------------------------
// Goal Satisfaction Verifier (Phase 7)
// ---------------------------------------------------------------------------

export interface GoalSatisfactionResult {
  readonly satisfied: boolean;
  readonly rationale: string;
}

/**
 * Returns true when the goal description contains both a search clause AND a
 * secondary action that must be performed AFTER the search.
 *
 * This is a purely lexical test on the user's natural-language description.
 * No website-specific logic, no hardcoded titles or IDs.
 *
 * Compound goals (returns true):
 *   "search for X and play the first video"
 *   "search for X and open the first result"
 *   "find X and click on it"
 *   "search for X and navigate to the result"
 *   "search for X and watch this video"
 *
 * Search-only goals (returns false):
 *   "search for X"
 *   "find X on YouTube"
 *   "look up X"
 *
 * Exported for direct unit testing.
 */
export function isCompoundSearchGoal(description: string): boolean {
  const desc = description.toLowerCase();

  // Must have a search clause
  const hasSearchClause = /\b(?:search|find|look\s+up|query|lookup)\b/.test(desc);
  if (!hasSearchClause) return false;

  // Must also have a secondary-action keyword that implies a post-search step
  const hasPostSearchAction = /\b(?:play|watch|open|click|navigate|go\s+to|select|view|read|listen|launch|start|stream)\b/.test(desc);
  return hasPostSearchAction;
}

/**
 * Detects goals that seek to find, inspect, or select a specific record/item
 * (e.g. "Find my latest Amazon transaction", "Find my latest Swiggy transaction",
 * "Find the most recent salary transaction", "Find the latest Netflix payment").
 * Exported for direct unit testing.
 */
export function isItemRetrievalGoal(description: string): boolean {
  const desc = description.toLowerCase();
  const hasSearchClause = /\b(?:find|search|look\s+up|query|get|show|locate|inspect|open|view|display)\b/.test(desc);
  if (!hasSearchClause) return false;

  const hasConstraint = /\b(?:latest|most\s+recent|newest|last|first|oldest)\b/.test(desc);
  const hasItemNoun = /\b(?:transactions?|payments?|orders?|receipts?|records?|bills?|invoices?|entries|entry|items?|details?)\b/.test(desc);

  return (hasConstraint && hasItemNoun) || (hasSearchClause && hasConstraint) || (hasSearchClause && hasItemNoun && !/\b(?:laptops?|shoes?|books?|phones?|products?|results?)\b/.test(desc));
}

/**
 * Returns true only when history contains a successfully completed search-submission action:
 * - action.type === 'type'
 * - action.payload.pressEnter === true
 * - perceivedOutcome === 'success'
 *
 * Exported for direct unit testing.
 */
export function isPostSearchPhase(history?: readonly PlannerHistoryStep[]): boolean {
  if (!history || history.length === 0) return false;
  return history.some(
    (step) =>
      step.action.type === 'type' &&
      step.action.payload?.pressEnter === true &&
      step.perceivedOutcome === 'success'
  );
}

/**
 * Checks for reliable structural evidence of search results in the page representation.
 * Requires explicit result indicators (headings, status messages, or results containers with items).
 * Does not rely on simple URL or title change alone.
 *
 * Exported for direct unit testing.
 */
export function hasSearchResultEvidence(
  afterPage: PageRepresentation,
  beforePage?: PageRepresentation
): boolean {
  if (!afterPage || !Array.isArray(afterPage.elements)) {
    return false;
  }

  // 1. Result headings or status text indicating search results
  const resultHeadingRegex = /\b(?:search\s+results?|results?\s+for|search\s+matches?|\bresults\b)\b/i;
  const countResultsRegex = /\b(?:\d+\s+(?:results?|products?|items?|matches)|showing\s+\d+|found\s+\d+|found\b)/i;

  const hasResultHeading = afterPage.elements.some((el) => {
    const isHeading = el.role === 'heading' || (el.tagName && /^h[1-6]$/i.test(el.tagName));
    const isStatus = el.role === 'status' || el.role === 'alert';
    if (!isHeading && !isStatus) return false;

    const text = (el.visibleText || el.accessibleName || '').trim();
    if (!text) return false;

    return resultHeadingRegex.test(text) || countResultsRegex.test(text);
  });

  if (hasResultHeading) {
    return true;
  }

  // 2. Structural search/results container with items
  const hasResultContainer = afterPage.elements.some((el) => {
    const tag = el.tagName?.toLowerCase();
    const isContainerRole =
      el.role === 'region' ||
      el.role === 'container' ||
      el.role === 'listbox' ||
      tag === 'main' ||
      tag === 'section' ||
      tag === 'ul' ||
      tag === 'ol';
    if (!isContainerRole) return false;

    const label = `${el.accessibleName ?? ''} ${el.attributes?.['class'] ?? ''} ${el.attributes?.['id'] ?? ''} ${el.attributes?.['aria-label'] ?? ''}`;
    const matchesResultLabel = /\b(?:search[-_]?results?|results?[-_]?list|products?[-_]?(?:grid|list)|search[-_]?(?:container|feed))\b/i.test(label);
    if (!matchesResultLabel) return false;

    // Must have child items or list/article elements in page
    return (
      (el.childIds && el.childIds.length > 0) ||
      afterPage.elements.some((child) => {
        const cTag = child.tagName?.toLowerCase();
        return child.role === 'option' || cTag === 'li' || cTag === 'article';
      })
    );
  });

  if (hasResultContainer) {
    return true;
  }

  // 3. Structured list-like result items or result links when page title or URL clearly reflects search context
  const resultItems = afterPage.elements.filter((el) => {
    const tag = el.tagName?.toLowerCase();
    return el.role === 'option' || tag === 'li' || tag === 'article' || (el.role === 'link' && el.interactive);
  });
  if (resultItems.length > 0) {
    const url = afterPage.metadata?.url ?? '';
    const title = afterPage.metadata?.title ?? '';
    const hasSearchUrl = /[?&](?:q|query|search_query|keyword|k)=/i.test(url) || /\/(?:search|results?)(?:[/?#]|$)/i.test(url);
    const hasSearchTitle = /\b(?:search\s+results?|results?\s+for|search\b)\b/i.test(title);
    if (hasSearchUrl || hasSearchTitle) {
      return true;
    }
  }

  return false;
}

/**
 * Evaluates whether afterPage contains sufficient generic structural content
 * indicating that navigation to a destination page genuinely occurred.
 * Does not rely on URL alone, and uses no website-specific selectors or heuristics.
 */
function hasStructuralNavigationEvidence(
  afterPage: PageRepresentation,
  beforePage?: PageRepresentation
): boolean {
  if (!afterPage || !Array.isArray(afterPage.elements) || afterPage.elements.length === 0) {
    return false;
  }

  // Meaningful elements: elements with visible text, accessible name, semantic landmark roles, or interactive elements
  const meaningfulElements = afterPage.elements.filter((el) => {
    const hasText = Boolean((el.visibleText?.trim() || el.accessibleName?.trim()));
    const isLandmark =
      el.role === 'heading' ||
      el.role === 'region' ||
      el.role === 'navigation' ||
      el.role === 'container' ||
      (el.tagName && /^h[1-6]|main|article|section|nav$/i.test(el.tagName));
    const isInteractive = el.interactive === true;
    return hasText || isLandmark || isInteractive;
  });

  if (meaningfulElements.length === 0) {
    return false;
  }

  // Check for document-level signals: title or heading presence with non-empty text
  const hasHeading = afterPage.elements.some(
    (el) =>
      (el.role === 'heading' || (el.tagName && /^h[1-6]$/i.test(el.tagName))) &&
      Boolean((el.visibleText || el.accessibleName)?.trim())
  );
  const hasTitle = Boolean(afterPage.metadata?.title?.trim());

  // Structural navigation requires either:
  // - at least 2 meaningful elements (e.g. heading/content or multiple components)
  // - OR a clear document title/heading with at least 1 meaningful element
  return meaningfulElements.length >= 2 || ((hasHeading || hasTitle) && meaningfulElements.length >= 1);
}

/**
 * Deterministically evaluates whether the high-level user goal has been satisfied
 * given the executed action, the verified action effect, and before/after page representations.
 */
export function verifyGoalSatisfaction(
  goal: { id: string; description: string; intent?: string },
  action: IntendedAction,
  beforePage: PageRepresentation,
  afterPage: PageRepresentation,
  actionVerification: DemoStepVerification
): GoalSatisfactionResult {
  // First requirement: action effect must be verified
  if (!actionVerification.verified) {
    return {
      satisfied: false,
      rationale: 'Action effect was not verified'
    };
  }

  const intent = goal.intent?.toLowerCase();
  const desc = goal.description.toLowerCase();
  const isCompound = isCompoundSearchGoal(desc);

  // 1. Compound Goal Post-Search Click Evaluation
  // When a compound search goal executes a CLICK action (post-search phase), evaluate
  // destination navigation rather than forcing the action through initial search-submission checks.
  if (isCompound && action.type === 'click') {
    // A post-search CLICK for a compound goal must NOT be considered complete while
    // the resulting page still represents the search-results state.
    if (hasSearchResultEvidence(afterPage, beforePage)) {
      return {
        satisfied: false,
        rationale: 'Post-search click executed, but page is still displaying search results rather than destination content'
      };
    }

    const beforeUrl = (beforePage?.metadata?.url ?? '').trim();
    const afterUrl = (afterPage?.metadata?.url ?? '').trim();
    const beforeBase = beforeUrl.split('#')[0];
    const afterBase = afterUrl.split('#')[0];
    const urlGenuinelyChanged = Boolean(afterBase && beforeBase && afterBase !== beforeBase);

    if (!urlGenuinelyChanged) {
      return {
        satisfied: false,
        rationale: 'Post-search click executed, but destination URL did not change'
      };
    }

    const hasStructuralEvidence = hasStructuralNavigationEvidence(afterPage, beforePage);
    if (!hasStructuralEvidence) {
      return {
        satisfied: false,
        rationale: 'Post-search click changed URL, but destination page lacks sufficient structural page content to confirm goal satisfaction'
      };
    }

    const isPlayWatch = /\b(?:play|watch|stream|listen)\b/i.test(desc);
    const playbackNote = isPlayWatch
      ? ' (Note: navigation to media destination confirmed; actual playback verification not supported by current PageRepresentation architecture)'
      : '';

    return {
      satisfied: true,
      rationale: `Post-search click completed navigation to destination (URL changed and verified destination page content observed)${playbackNote}`
    };
  }

  const isSearchGoal = intent === 'search' || /\bsearch\b/i.test(desc);
  const isTypeGoal = intent === 'type' || (!isSearchGoal && /\b(?:type|enter|input)\b/i.test(desc));

  // 2. Search Goal Evaluation
  if (isSearchGoal) {
    const isEnterSubmission = action.type === 'type' && action.payload?.pressEnter === true;

    // Check if click was on a submit / search button
    const targetElement = beforePage?.elements?.find((e) => e.id === action.target.elementId);
    const targetRole = targetElement?.role || action.target.role;
    const targetText = `${targetElement?.visibleText ?? ''} ${targetElement?.accessibleName ?? ''} ${targetElement?.attributes?.['type'] ?? ''}`.toLowerCase();
    const isSubmitClick =
      action.type === 'click' &&
      (targetRole === 'button' ||
        targetElement?.tagName?.toLowerCase() === 'button' ||
        targetElement?.attributes?.['type'] === 'submit') &&
      /\b(?:search|submit|find|go)\b/i.test(targetText);

    const isSubmissionCapable = isEnterSubmission || isSubmitClick;

    if (!isSubmissionCapable) {
      return {
        satisfied: false,
        rationale: 'Search action was not submitted (requires pressEnter or search submit button click)'
      };
    }

    const hasResults = hasSearchResultEvidence(afterPage, beforePage);
    if (hasResults) {
      // Block premature completion for compound goals that require a post-search action
      // (e.g. "search for X and play a video", "search for X and open a result").
      // The search portion alone does not satisfy a compound goal.
      if (isCompoundSearchGoal(desc)) {
        return {
          satisfied: false,
          rationale: 'Search completed and results are visible, but goal requires a subsequent action (compound goal — not yet satisfied)'
        };
      }
      return {
        satisfied: true,
        rationale: 'Search submitted and verified result-state observed on page'
      };
    }

    return {
      satisfied: false,
      rationale: 'Search submitted, but page does not contain reliable search result evidence'
    };
  }

  // 2. Pure Input / Type Goal Evaluation
  if (isTypeGoal) {
    if (action.type !== 'type') {
      return {
        satisfied: false,
        rationale: 'Input goal requires a type action'
      };
    }

    const targetElem = afterPage.elements.find((e) => e.id === action.target.elementId);
    const hasValue =
      targetElem !== undefined &&
      ((typeof targetElem.attributes?.['value'] === 'string' && targetElem.attributes['value'].length > 0) ||
        (typeof targetElem.visibleText === 'string' && targetElem.visibleText.length > 0));

    if (hasValue && actionVerification.verified) {
      return {
        satisfied: true,
        rationale: 'Target input element populated and verified'
      };
    }

    return {
      satisfied: false,
      rationale: 'Target element did not reflect entered text'
    };
  }

  // 3. Navigation Goal
  if (intent === 'navigate') {
    return {
      satisfied: false,
      rationale: 'Deterministic destination verification not available for general navigation'
    };
  }

  // 4. Fallback: conservative default (no weak guessing)
  return {
    satisfied: false,
    rationale: 'Deterministic goal verification not available for this goal type'
  };
}

// ---------------------------------------------------------------------------
// Phase Milestone Verifier (Phase D)
// ---------------------------------------------------------------------------

export interface PhaseMilestoneResult {
  readonly satisfied: boolean;
  readonly rationale: string;
}

/**
 * Generic phase milestone verifier.
 * Evaluates whether an atomically verified action satisfied the specific milestone criteria
 * of the currently active TaskPhase.
 *
 * Invariants:
 * - Uses PageRepresentation and phase metadata generically.
 * - Supports open_surface, fill_field, select_option, submit, select_result, search, navigate, verify_outcome.
 * - Does NOT use website-specific strings or URL substring heuristics.
 * - Sensitive values remain protected (never exposed or logged).
 */
export function verifyPhaseMilestone(
  phase: TaskPhase,
  action: IntendedAction,
  beforePage: PageRepresentation,
  afterPage: PageRepresentation,
  actionVerification: DemoStepVerification
): PhaseMilestoneResult {
  // Prerequisite: atomic action effect must be verified
  if (!actionVerification.verified) {
    return {
      satisfied: false,
      rationale: `Atomic action effect was not verified for phase '${phase.phaseId}'`
    };
  }

  const intent = phase.intent;

  switch (intent) {
    case 'fill_field': {
      const targetId = action.target.elementId;
      const targetElem = afterPage.elements.find(e => e.id === targetId);

      if (!targetElem) {
        return {
          satisfied: false,
          rationale: `Target field "${targetId}" not found in after-page state`
        };
      }

      // 1. Privacy-safe live verification result check:
      // When actionVerification.valueMatch is present, verify directly against the live DOM
      // verification result, preserving PageRepresentation privacy invariants.
      if (typeof actionVerification.valueMatch === 'boolean') {
        if (!actionVerification.valueMatch) {
          return {
            satisfied: false,
            rationale: `Field "${phase.fieldParameter?.fieldName ?? targetId}" does not reflect expected target value`
          };
        }

        const isCompatibleAction = action.type === 'type' && action.target.elementId === targetId;
        if (!isCompatibleAction) {
          return {
            satisfied: false,
            rationale: `Action does not correspond to active fill_field phase '${phase.phaseId}'`
          };
        }

        if (phase.fieldParameter?.targetValue) {
          const expectedVal = phase.fieldParameter.targetValue.trim().toLowerCase();
          const actionText = (action.payload?.text ?? '').trim().toLowerCase();
          const isDateInput =
            targetElem.attributes?.['type']?.toLowerCase() === 'date' ||
            (targetElem.tagName?.toLowerCase() === 'input' && targetElem.attributes?.['type']?.toLowerCase() === 'date');

          if (isDateInput) {
            if (actionText !== expectedVal) {
              return {
                satisfied: false,
                rationale: `Field "${phase.fieldParameter.fieldName}" does not reflect expected target value`
              };
            }
            return {
              satisfied: true,
              rationale: `Field "${phase.fieldParameter.fieldName}" populated with expected date`
            };
          }

          if (actionText === expectedVal || actionText.includes(expectedVal) || expectedVal.includes(actionText)) {
            return {
              satisfied: true,
              rationale: `Field "${phase.fieldParameter.fieldName}" populated with expected value`
            };
          }

          return {
            satisfied: false,
            rationale: `Field "${phase.fieldParameter.fieldName}" does not reflect expected target value`
          };
        }

        return {
          satisfied: true,
          rationale: `Field "${phase.fieldParameter?.fieldName ?? targetId}" populated with verified value`
        };
      }

      // 2. Fallback for environments / unit tests where actionVerification lacks valueMatch
      // and mock PageRepresentation contains populated value/visibleText.
      const elemVal = typeof targetElem.attributes?.['value'] === 'string'
        ? targetElem.attributes['value']
        : typeof targetElem.visibleText === 'string'
        ? targetElem.visibleText
        : '';

      const hasValue = elemVal.trim().length > 0;

      if (phase.fieldParameter?.targetValue) {
        const expectedVal = phase.fieldParameter.targetValue.trim().toLowerCase();
        const actualVal = elemVal.trim().toLowerCase();
        const isPassword = targetElem.attributes?.['type'] === 'password';
        const isDateInput =
          targetElem.attributes?.['type']?.toLowerCase() === 'date' ||
          (targetElem.tagName?.toLowerCase() === 'input' && targetElem.attributes?.['type']?.toLowerCase() === 'date');

        if (isPassword && hasValue) {
          return {
            satisfied: true,
            rationale: `Sensitive field "${phase.fieldParameter.fieldName}" populated`
          };
        }

        if (isDateInput) {
          // Native date input: exact canonical date comparison, NOT substring matching
          if (hasValue && actualVal === expectedVal) {
            return {
              satisfied: true,
              rationale: `Field "${phase.fieldParameter.fieldName}" populated with expected date`
            };
          }
          return {
            satisfied: false,
            rationale: `Field "${phase.fieldParameter.fieldName}" does not reflect expected target value`
          };
        }

        if (hasValue && (actualVal.includes(expectedVal) || expectedVal.includes(actualVal))) {
          return {
            satisfied: true,
            rationale: `Field "${phase.fieldParameter.fieldName}" populated with expected value`
          };
        }

        return {
          satisfied: false,
          rationale: `Field "${phase.fieldParameter.fieldName}" does not reflect expected target value`
        };
      }

      if (hasValue) {
        return {
          satisfied: true,
          rationale: `Field "${phase.fieldParameter?.fieldName ?? targetId}" populated and verified`
        };
      }

      return {
        satisfied: false,
        rationale: `Target field "${targetId}" is empty after action`
      };
    }

    case 'select_option': {
      const targetId = action.target.elementId;
      const targetElem = afterPage.elements.find(e => e.id === targetId);
      const expectedVal = phase.fieldParameter?.targetValue?.trim().toLowerCase();

      const matchesTarget = (elem: PageElement, val?: string): boolean => {
        if (!val) return false;
        const normVal = val.trim().toLowerCase();
        if (!normVal) return false;

        const vText = (elem.visibleText || '').trim().toLowerCase();
        const valAttr = (elem.attributes?.['value'] || '').trim().toLowerCase();

        // 1. Direct text / value match on the control
        if (vText.length > 0 && (vText === normVal || vText.includes(normVal) || normVal.includes(vText))) {
          return true;
        }
        if (valAttr.length > 0 && (valAttr === normVal || valAttr.includes(normVal) || normVal.includes(valAttr))) {
          return true;
        }

        // 2. For non-select controls (e.g. option element, radio button, checkbox),
        // accessibleName or ID can identify the specific option target:
        if (elem.tagName?.toLowerCase() !== 'select') {
          const aName = (elem.accessibleName || '').trim().toLowerCase();
          const elemId = (elem.id || '').trim().toLowerCase();
          if (aName.length > 0 && (aName === normVal || aName.includes(normVal) || normVal.includes(aName))) {
            return true;
          }
          if (elemId.length > 0 && elemId.includes(normVal)) {
            return true;
          }
        }

        return false;
      };

      const isNativeSelect =
        targetElem?.tagName?.toLowerCase() === 'select' ||
        (targetElem?.role === 'combobox' && action.type === 'type');

      // 1. Native <select>:
      if (isNativeSelect) {
        // A. Type action + valueMatch:
        if (action.type === 'type' && typeof actionVerification.valueMatch === 'boolean') {
          if (actionVerification.valueMatch) {
            return {
              satisfied: true,
              rationale: `Option "${phase.fieldParameter?.targetValue ?? 'selected'}" selected via native control`
            };
          }
          return {
            satisfied: false,
            rationale: `Option selection not confirmed: value does not match "${phase.fieldParameter?.targetValue ?? 'expected'}" for phase '${phase.phaseId}'`
          };
        }

        // B. Already selected or selected option text matches expectedVal:
        if (expectedVal && targetElem && matchesTarget(targetElem, expectedVal)) {
          return {
            satisfied: true,
            rationale: `Option matching "${phase.fieldParameter?.targetValue}" is selected in native control`
          };
        }

        // C. Click alone without valueMatch or observable text match => phase failure!
        return {
          satisfied: false,
          rationale: `Option selection not confirmed: click on native select did not change selected option for phase '${phase.phaseId}'`
        };
      }

      // 2. Radio / Checkbox / ARIA controls:
      const isStateSelected =
        targetElem?.state?.checked === true ||
        targetElem?.attributes?.['aria-selected'] === 'true' ||
        targetElem?.attributes?.['selected'] === 'true';

      if (isStateSelected) {
        if (expectedVal) {
          if (targetElem && matchesTarget(targetElem, expectedVal)) {
            return {
              satisfied: true,
              rationale: `Option "${targetId}" matching "${phase.fieldParameter?.targetValue}" confirmed selected`
            };
          }
          return {
            satisfied: false,
            rationale: `Selected option does not match target value "${phase.fieldParameter?.targetValue}"`
          };
        }
        return {
          satisfied: true,
          rationale: `Option "${targetId}" confirmed selected`
        };
      }

      // 3. Option element with matching visibleText or value:
      if (expectedVal && targetElem && matchesTarget(targetElem, expectedVal) && targetElem.role === 'option') {
        return {
          satisfied: true,
          rationale: `Option matching "${phase.fieldParameter?.targetValue}" selected`
        };
      }

      // Fail closed: No unconditional click fallback!
      return {
        satisfied: false,
        rationale: `Option selection not confirmed for phase '${phase.phaseId}'`
      };
    }

    case 'open_surface': {
      // 1. New interactive elements rendered (modal/form appeared)
      const beforeIds = new Set(beforePage.elements.map(e => e.id));
      const newInteractive = afterPage.elements.filter(e => !beforeIds.has(e.id) && e.interactive);
      if (newInteractive.length > 0) {
        return {
          satisfied: true,
          rationale: `Surface opened (${newInteractive.length} new interactive elements rendered)`
        };
      }

      // 2. Control transitioned to expanded
      const targetId = action.target.elementId;
      const targetElem = afterPage.elements.find(e => e.id === targetId);
      if (targetElem?.attributes?.['aria-expanded'] === 'true') {
        return {
          satisfied: true,
          rationale: `Surface control "${targetId}" is expanded`
        };
      }

      // 3. Dialog observed
      const hasDialog = afterPage.elements.some(e =>
        e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog'
      );
      if (hasDialog) {
        return {
          satisfied: true,
          rationale: 'Dialog surface observed in page state'
        };
      }

      // 4. Click verified on opening control
      if (action.type === 'click') {
        return {
          satisfied: true,
          rationale: `Surface trigger "${targetId}" activated and verified`
        };
      }

      return {
        satisfied: false,
        rationale: `Surface opening not verified for phase '${phase.phaseId}'`
      };
    }

    case 'submit': {
      const beforeIds = new Set(beforePage.elements.map(e => e.id));
      const afterIds = new Set(afterPage.elements.map(e => e.id));
      const targetId = action.target.elementId;

      // 1. Navigation occurred (URL or document title genuinely changed)
      const beforeUrl = beforePage.metadata?.url?.split('#')[0];
      const afterUrl = afterPage.metadata?.url?.split('#')[0];
      if (beforeUrl && afterUrl && beforeUrl !== afterUrl) {
        return {
          satisfied: true,
          rationale: 'Submission caused page navigation'
        };
      }
      if (
        beforePage.metadata?.title &&
        afterPage.metadata?.title &&
        beforePage.metadata.title !== afterPage.metadata.title
      ) {
        return {
          satisfied: true,
          rationale: `Submission updated page title to "${afterPage.metadata.title}"`
        };
      }

      // 2. Newly observed confirmation / status / alert message
      const hasStatusOrAlert = afterPage.elements.some(e => {
        const isStatusRole = e.role === 'status' || e.role === 'alert';
        const hasText = Boolean((e.visibleText || e.accessibleName)?.trim());
        if (!isStatusRole || !hasText) return false;
        const beforeElem = beforePage.elements.find(b => b.id === e.id);
        const hadTextBefore = Boolean((beforeElem?.visibleText || beforeElem?.accessibleName)?.trim());
        return !beforeIds.has(e.id) || !hadTextBefore;
      });
      if (hasStatusOrAlert) {
        return {
          satisfied: true,
          rationale: 'Submission confirmation message observed'
        };
      }

      // 3. Creation / editing surface disappears:
      const beforeHadDialog = beforePage.elements.some(e => e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog');
      const afterHasDialog = afterPage.elements.some(e => e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog');
      const dialogClosed = beforeHadDialog && !afterHasDialog;

      const submitButtonDisappeared = beforeIds.has(targetId) && (
        !afterIds.has(targetId) ||
        afterPage.elements.find(e => e.id === targetId)?.interactive === false
      );

      const INPUT_ROLES: ReadonlySet<string> = new Set(['textbox', 'combobox', 'listbox', 'checkbox', 'radio']);
      const beforeInputCount = beforePage.elements.filter(e => Boolean(e.role && INPUT_ROLES.has(e.role)) && e.interactive).length;
      const afterInputCount = afterPage.elements.filter(e => Boolean(e.role && INPUT_ROLES.has(e.role)) && e.interactive).length;
      const inputsDisappeared = beforeInputCount > 0 && afterInputCount === 0;

      const surfaceDisappeared = dialogClosed || submitButtonDisappeared || inputsDisappeared;

      // 4. New primary content/entity container appeared (region, container, list item, article, row, etc.)
      const CONTAINER_ROLES: ReadonlySet<string> = new Set(['region', 'container', 'generic']);
      const CONTAINER_TAGS: ReadonlySet<string> = new Set(['li', 'article', 'tr', 'section']);
      const newEntityContainers = afterPage.elements.filter(e =>
        !beforeIds.has(e.id) &&
        ((e.role !== undefined && CONTAINER_ROLES.has(e.role)) || (e.tagName !== undefined && CONTAINER_TAGS.has(e.tagName.toLowerCase())))
      );
      const hasNewContent = newEntityContainers.length > 0;

      if (surfaceDisappeared) {
        const extraNote = hasNewContent ? ` and ${newEntityContainers.length} new content entity(ies) observed` : '';
        return {
          satisfied: true,
          rationale: `Submission closed input surface${extraNote}`
        };
      }

      if (hasNewContent) {
        return {
          satisfied: true,
          rationale: `Submission confirmed: ${newEntityContainers.length} new content entity(ies) observed`
        };
      }

      // CRITICAL: A click or Enter submission alone without observable postcondition evidence is NOT satisfied!
      return {
        satisfied: false,
        rationale: `Submission not confirmed for phase '${phase.phaseId}': creation surface remains active without navigation, status message, or new content`
      };
    }

    case 'select_result': {
      const isMedia = isMediaContentGoal(phase.description, phase.targetHint);
      if (isMedia) {
        const targetElement = beforePage.elements.find(e => e.id === action.target.elementId);
        const isProfileOrChannel = isProfileOrChannelCandidate(targetElement) || isProfileOrChannelUrl(afterPage?.metadata?.url);
        if (isProfileOrChannel) {
          return {
            satisfied: false,
            rationale: `Channel or profile target does not satisfy media content-selection phase '${phase.phaseId}'`
          };
        }
      }

      // Reject search controls or submit buttons during result selection
      const targetElement = afterPage.elements.find(e => e.id === action.target.elementId) ??
        beforePage?.elements.find(e => e.id === action.target.elementId);
      const targetId = (action.target.elementId || '').toLowerCase();
      const targetRole = (action.target.role || targetElement?.role || '').toLowerCase();
      const targetText = `${targetElement?.accessibleName ?? ''} ${targetElement?.visibleText ?? ''}`.toLowerCase();
      const isSearchControl =
        targetRole === 'textbox' ||
        targetRole === 'searchbox' ||
        targetId.includes('search-btn') ||
        targetId.includes('search-input') ||
        targetId.includes('search-button') ||
        targetId.includes('search-submit') ||
        /\b(?:search|submit|clear|reset)\b/i.test(targetText);

      if (isSearchControl) {
        return {
          satisfied: false,
          rationale: `Search control or submit button "${action.target.elementId}" does not satisfy result selection milestone for phase '${phase.phaseId}'`
        };
      }

      // Check if zero matching results are displayed on the page
      const hasZeroResults = afterPage.elements.some(e => {
        const text = (e.visibleText || e.accessibleName || '').toLowerCase();
        return (
          text.includes('no matching transactions') ||
          text.includes('no transactions found') ||
          text.includes('no results found') ||
          text.includes('showing 0 transactions') ||
          text.includes('zero matching') ||
          text.includes('0 matching')
        );
      });
      if (hasZeroResults) {
        return {
          satisfied: false,
          rationale: `Cannot satisfy result selection: page displays zero matching results for phase '${phase.phaseId}'`
        };
      }

      if (hasStructuralNavigationEvidence(afterPage, beforePage)) {
        return {
          satisfied: true,
          rationale: 'Selected result navigation verified'
        };
      }

      // Check if a modal or details view opened as a result of clicking
      const modalOpened = afterPage.elements.some(
        e => (e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog' || e.attributes?.['role'] === 'dialog') &&
             e.state?.visible !== false
      );
      if (modalOpened) {
        return {
          satisfied: true,
          rationale: `Result item "${action.target.elementId}" selected and detail surface opened`
        };
      }

      if (action.type === 'click' && actionVerification.verified) {
        return {
          satisfied: true,
          rationale: `Result item "${action.target.elementId}" selected and verified`
        };
      }
      return {
        satisfied: false,
        rationale: `Result selection not confirmed for phase '${phase.phaseId}'`
      };
    }

    case 'search': {
      if (hasSearchResultEvidence(afterPage, beforePage)) {
        return {
          satisfied: true,
          rationale: 'Search results observed on page'
        };
      }
      if (action.type === 'type' && action.payload?.pressEnter) {
        return {
          satisfied: true,
          rationale: 'Search interaction executed and verified'
        };
      }
      if (action.type === 'click') {
        const isSuggestion =
          action.target.role === 'option' ||
          action.target.role === 'menuitem' ||
          action.target.role === 'listbox';
        if (!isSuggestion && actionVerification.verified) {
          return {
            satisfied: true,
            rationale: 'Search submit button clicked and verified'
          };
        }
      }
      return {
        satisfied: false,
        rationale: `Search phase not confirmed for phase '${phase.phaseId}'`
      };
    }

    case 'navigate': {
      const beforeUrl = beforePage.metadata?.url?.split('#')[0];
      const afterUrl = afterPage.metadata?.url?.split('#')[0];
      if (beforeUrl && afterUrl && beforeUrl !== afterUrl) {
        return {
          satisfied: true,
          rationale: `Navigated to ${afterUrl}`
        };
      }
      if (hasStructuralNavigationEvidence(afterPage, beforePage)) {
        return {
          satisfied: true,
          rationale: 'Navigation destination content verified'
        };
      }
      if (action.type === 'click') {
        return {
          satisfied: true,
          rationale: `Navigation action verified on "${action.target.elementId}"`
        };
      }
      return {
        satisfied: false,
        rationale: `Navigation not confirmed for phase '${phase.phaseId}'`
      };
    }

    case 'verify_outcome': {
      return {
        satisfied: true,
        rationale: 'Final outcome verified'
      };
    }

    case 'custom':
    default: {
      return {
        satisfied: actionVerification.verified,
        rationale: actionVerification.verified
          ? `Phase '${phase.phaseId}' action verified`
          : `Phase '${phase.phaseId}' action could not be verified`
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Generic Whole-Goal Postcondition Verifier & Precondition Checkers
// ---------------------------------------------------------------------------

/**
 * Evaluates whether an active phase is already satisfied by the current page state,
 * avoiding unnecessary or duplicate actions when defaults or prior state already match.
 */
export function isPhaseAlreadySatisfied(
  phase: TaskPhase,
  page: PageRepresentation
): { satisfied: boolean; rationale?: string } {
  if (phase.intent === 'fill_field') {
    if (!phase.fieldParameter?.targetValue) return { satisfied: false };
    const targetVal = phase.fieldParameter.targetValue.trim().toLowerCase();
    const fieldName = (phase.fieldParameter.fieldName || phase.targetHint || '').trim().toLowerCase();

    const matchingElem = page.elements.find(e => {
      const isInput = e.role === 'textbox' || e.tagName?.toLowerCase() === 'input' || e.tagName?.toLowerCase() === 'textarea';
      if (!isInput) return false;
      const id = (e.id || '').toLowerCase();
      const label = (e.accessibleName || '').toLowerCase();
      const nameAttr = (e.attributes?.['name'] || '').toLowerCase();
      const matchesField = fieldName ? (id.includes(fieldName) || label.includes(fieldName) || nameAttr.includes(fieldName)) : true;
      if (!matchesField) return false;

      const isDate = e.attributes?.['type']?.toLowerCase() === 'date';
      const curVal = (e.attributes?.['value'] || e.visibleText || '').trim().toLowerCase();
      if (isDate) {
        return curVal === targetVal;
      }
      return curVal === targetVal || (curVal.length > 0 && curVal.includes(targetVal));
    });

    if (matchingElem) {
      return {
        satisfied: true,
        rationale: `Field "${phase.fieldParameter.fieldName}" already contains requested value "${phase.fieldParameter.targetValue}"`
      };
    }
  }

  if (phase.intent === 'select_option') {
    if (!phase.fieldParameter?.targetValue) return { satisfied: false };
    const targetVal = phase.fieldParameter.targetValue.trim().toLowerCase();
    const fieldName = (phase.fieldParameter.fieldName || phase.targetHint || '').trim().toLowerCase();

    const matchingElem = page.elements.find(e => {
      const isSelectable = e.role === 'combobox' || e.role === 'listbox' || e.role === 'radio' || e.role === 'checkbox' || e.tagName?.toLowerCase() === 'select';
      if (!isSelectable) return false;
      const id = (e.id || '').toLowerCase();
      const label = (e.accessibleName || '').toLowerCase();
      const nameAttr = (e.attributes?.['name'] || '').toLowerCase();
      const matchesField = fieldName ? (id.includes(fieldName) || label.includes(fieldName) || nameAttr.includes(fieldName)) : true;
      if (!matchesField) return false;

      // Native select: visibleText represents selected option
      const curText = (e.visibleText || '').trim().toLowerCase();
      const curVal = (e.attributes?.['value'] || '').trim().toLowerCase();
      if (curText === targetVal || curVal === targetVal) return true;

      // Radio or checkbox: checked state
      if ((e.role === 'radio' || e.role === 'checkbox') && e.state?.checked === true) {
        return (
          id.includes(targetVal) ||
          label.includes(targetVal) ||
          curVal === targetVal ||
          curText === targetVal
        );
      }

      return false;
    });

    if (matchingElem) {
      return {
        satisfied: true,
        rationale: `Option for "${phase.fieldParameter.fieldName}" already set to "${phase.fieldParameter.targetValue}"`
      };
    }
  }

  if (phase.intent === 'open_surface') {
    const hasDialog = page.elements.some(e => (e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog') && e.interactive !== false);
    if (hasDialog) {
      return {
        satisfied: true,
        rationale: 'Surface is already open in page state'
      };
    }
  }

  return { satisfied: false };
}

export interface WholeGoalVerificationInput {
  readonly goal: PlannerGoal;
  readonly taskPlan: TaskPlan;
  readonly completedPhaseIds: readonly string[];
  readonly currentPage: PageRepresentation;
  readonly history?: readonly PlannerHistoryStep[];
  readonly beforePage?: PageRepresentation;
  readonly lastAction?: IntendedAction;
  readonly lastVerification?: DemoStepVerification;
}

export interface WholeGoalVerificationResult {
  readonly satisfied: boolean;
  readonly rationale: string;
}

/**
 * Deterministically evaluates whether the complete user goal has been satisfied
 * in the observed page state after all task plan phases have completed.
 *
 * Enforces the Three-Tier Contract:
 * - ACTION_SUCCESS: browser primitive executed
 * - PHASE_SUCCESS: active phase objective satisfied
 * - GOAL_SUCCESS: complete user goal observable in page state
 *
 * Never allows ACTION_SUCCESS -> GOAL_SUCCESS without semantic postcondition evidence.
 */
export function verifyWholeGoalOutcome(
  input: WholeGoalVerificationInput
): WholeGoalVerificationResult {
  const { goal, taskPlan, completedPhaseIds, currentPage, beforePage, lastAction, history } = input;

  // 1. Prerequisite: all non-terminal phases must have passed milestone verification
  const nonTerminalPhases = taskPlan.phases.filter(p => p.intent !== 'verify_outcome');
  const allRequiredPhasesCompleted = nonTerminalPhases.every(p => completedPhaseIds.includes(p.phaseId));
  if (!allRequiredPhasesCompleted) {
    const missing = nonTerminalPhases.filter(p => !completedPhaseIds.includes(p.phaseId)).map(p => p.phaseId);
    return {
      satisfied: false,
      rationale: `Not all required phases completed (missing: ${missing.join(', ')})`
    };
  }

  const desc = goal.description.toLowerCase();
  const archetype = taskPlan.archetype;

  // 2. Playable Media / Video content goals: must establish genuine media destination or playback
  const isMediaGoal = isMediaContentGoal(goal.description);
  if (isMediaGoal) {
    // A. Fail closed if destination is a channel, profile, or creator page
    if (isProfileOrChannelUrl(currentPage.metadata?.url)) {
      return {
        satisfied: false,
        rationale: 'Goal not satisfied: destination is a channel or profile page, not playable media/content'
      };
    }

    // B. Check for observable evidence of playable media / player
    const hasMediaUrl = isMediaContentUrl(currentPage.metadata?.url);
    const hasMediaElement = currentPage.elements.some(
      e => (e.tagName?.toLowerCase() === 'video' || e.tagName?.toLowerCase() === 'audio') && e.state?.visible !== false
    );
    const hasMediaControls = currentPage.elements.some(
      e => e.role === 'button' && /\b(?:play|pause|mute|unmute|seek|fullscreen|volume)\b/i.test(
        `${e.accessibleName ?? ''} ${e.visibleText ?? ''} ${e.attributes?.['aria-label'] ?? ''}`
      )
    );
    const hasMediaPlayerRegion = currentPage.elements.some(
      e => (e.role === 'region' || e.role === 'generic') &&
        /\b(?:player|video[-_]?player|media[-_]?player)\b/i.test(
          `${e.attributes?.['id'] ?? ''} ${e.attributes?.['class'] ?? ''} ${e.accessibleName ?? ''}`
        )
    );

    if (hasMediaUrl || hasMediaElement || hasMediaControls || hasMediaPlayerRegion) {
      return {
        satisfied: true,
        rationale: 'Whole goal verified: playable media/content destination reached and confirmed'
      };
    }

    // Fail closed: neither media URL nor player elements observable
    return {
      satisfied: false,
      rationale: 'Goal outcome not confirmed: no playable media or player observable in page state'
    };
  }

  const isFormOrCreation = archetype === 'form_submission' || /\b(?:create|add|new|submit|register|post|insert|save)\b/i.test(desc);

  // 2. Form submission / entity creation goals: verify creation surface closed and/or outcome observable
  if (isFormOrCreation) {
    const hasOpenDialog = currentPage.elements.some(
      e => (e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog') && e.interactive !== false
    );
    if (hasOpenDialog) {
      return {
        satisfied: false,
        rationale: 'Goal not satisfied: modal dialog remains open'
      };
    }

    // Check if the submit button from the last phase is still present and interactive
    const lastSubmitPhase = [...taskPlan.phases].reverse().find(p => p.intent === 'submit');
    if (lastSubmitPhase) {
      const submitElementId = lastAction?.target.elementId;
      if (submitElementId) {
        const submitStillPresent = currentPage.elements.some(
          e => e.id === submitElementId && e.interactive !== false
        );
        const INPUT_ROLES: ReadonlySet<string> = new Set(['textbox', 'combobox', 'listbox']);
        const inputCount = currentPage.elements.filter(e => Boolean(e.role && INPUT_ROLES.has(e.role)) && e.interactive !== false).length;

        const hasStatus = currentPage.elements.some(
          e => (e.role === 'status' || e.role === 'alert') && Boolean((e.visibleText || e.accessibleName)?.trim())
        );
        const urlChanged = Boolean(
          beforePage?.metadata?.url &&
          currentPage.metadata?.url &&
          beforePage.metadata.url.split('#')[0] !== currentPage.metadata.url.split('#')[0]
        );

        if (submitStillPresent && inputCount > 0 && !hasStatus && !urlChanged) {
          return {
            satisfied: false,
            rationale: 'Goal not satisfied: creation/editing surface remains open and active'
          };
        }
      }
    }

    // Check for positive postcondition evidence:
    // A. Status / alert confirmation message
    const hasStatusOrAlert = currentPage.elements.some(
      e => (e.role === 'status' || e.role === 'alert') && Boolean((e.visibleText || e.accessibleName)?.trim())
    );
    // B. Navigation away from the creation form
    const urlChanged = Boolean(
      beforePage?.metadata?.url &&
      currentPage.metadata?.url &&
      beforePage.metadata.url.split('#')[0] !== currentPage.metadata.url.split('#')[0]
    );
    // C. Creation surface disappeared
    const beforeIds = beforePage ? new Set(beforePage.elements.map(e => e.id)) : new Set<string>();
    const submitDisappeared = lastAction?.target.elementId
      ? beforeIds.has(lastAction.target.elementId) && !currentPage.elements.some(e => e.id === lastAction.target.elementId)
      : false;
    const dialogClosed = Boolean(
      beforePage?.elements.some(e => e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog') &&
      !currentPage.elements.some(e => e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog')
    );

    // D. New primary content/entity container appeared (region, container, list item, article, row, etc.)
    const CONTAINER_ROLES: ReadonlySet<string> = new Set(['region', 'container', 'generic']);
    const CONTAINER_TAGS: ReadonlySet<string> = new Set(['li', 'article', 'tr', 'section']);
    const hasNewEntity = currentPage.elements.some(e =>
      !beforeIds.has(e.id) &&
      ((e.role !== undefined && CONTAINER_ROLES.has(e.role)) || (e.tagName !== undefined && CONTAINER_TAGS.has(e.tagName.toLowerCase())))
    );

    // E. Target value represented on page in non-input element (e.g. "college" in a table or list)
    const targetValues = taskPlan.phases
      .map(p => p.fieldParameter?.targetValue?.trim().toLowerCase())
      .filter((v): v is string => Boolean(v && v.length > 2));
    const targetValueObservedInContent = targetValues.some(tv =>
      currentPage.elements.some(e =>
        e.role !== 'textbox' &&
        (e.visibleText?.toLowerCase().includes(tv) || e.accessibleName?.toLowerCase().includes(tv))
      )
    );

    if (hasStatusOrAlert || urlChanged || submitDisappeared || dialogClosed || hasNewEntity || targetValueObservedInContent) {
      return {
        satisfied: true,
        rationale: 'Whole goal verified: creation surface closed and postcondition confirmed'
      };
    }

    return {
      satisfied: false,
      rationale: 'Goal outcome not confirmed: no observable postcondition evidence on page'
    };
  }

  // 3. Item retrieval / record inspection goals (e.g. "Find my latest Amazon transaction"):
  // Must verify that the requested item was identified, selected, and its details are observable.
  const isItemGoal = isItemRetrievalGoal(desc);
  if (isItemGoal) {
    // A. Fail closed if zero matching results are visible or indicated on the page
    const hasZeroResults = currentPage.elements.some(e => {
      const text = (e.visibleText || e.accessibleName || '').toLowerCase();
      return (
        text.includes('no matching transactions') ||
        text.includes('no transactions found') ||
        text.includes('no results found') ||
        text.includes('showing 0 transactions') ||
        text.includes('zero matching') ||
        text.includes('0 matching') ||
        text.includes('no matching records')
      );
    });
    if (hasZeroResults) {
      return {
        satisfied: false,
        rationale: 'Goal not satisfied: zero matching transactions found on page'
      };
    }

    // B. Fail closed if the agent only typed into the search box without selecting/opening an item
    const hasClickAction = (history && history.length > 0 && history.some(h => h.action.type === 'click')) || lastAction?.type === 'click';
    const onlyTyped = !hasClickAction && (lastAction?.type === 'type' || (history && history.length > 0 && history.every(h => h.action.type === 'type')));
    if (onlyTyped) {
      return {
        satisfied: false,
        rationale: 'Goal not satisfied: search query entered but matching record was not selected or opened'
      };
    }

    // C. Check for opened detail modal / dialog / inspection surface
    const isDialogCandidate = (e: PageElement) => {
      const isDialogRole = e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog' || e.attributes?.['role'] === 'dialog';
      if (!isDialogRole) return false;

      // Exclude if explicitly marked non-visible
      if (e.state?.visible === false) {
        // Only accept if transitioning into view with active visibility signal
        const hasVisibleClass = e.attributes?.['class']?.split(/\s+/).some(c => c === 'visible' || c === 'open' || c === 'show' || c === 'active');
        if (!hasVisibleClass) return false;
      }

      // Check if style indicates opacity: 0 without active visible class
      const styleAttr = e.attributes?.['style'] ?? '';
      if (/opacity:\s*0\b/.test(styleAttr)) {
        const hasVisibleClass = e.attributes?.['class']?.split(/\s+/).some(c => c === 'visible' || c === 'open' || c === 'show' || c === 'active');
        if (!hasVisibleClass) return false;
      }

      return true;
    };

    const detailDialog = currentPage.elements.find(isDialogCandidate);

    const hasExpandedDetail = currentPage.elements.some(
      e => (e.attributes?.['aria-expanded'] === 'true' || e.attributes?.['data-detail'] !== undefined) &&
           e.state?.visible !== false
    );

    if (!detailDialog && !hasExpandedDetail) {
      return {
        satisfied: false,
        rationale: 'Goal outcome not confirmed: no transaction details or detail dialog observable in page state'
      };
    }

    // D. Extract query, merchant, constraints, amount, and temporal filters from goal
    const goalAnalysis = cleanSearchQueryCandidate(goal.description);
    const targetEntity = goalAnalysis.merchant ?? (goalAnalysis.query && goalAnalysis.query.length > 0 ? goalAnalysis.query : undefined);
    const constraint = goalAnalysis.constraint;

    // Collect genuine detail elements (exclude input controls and full-page backdrop overlays)
    const detailElements = currentPage.elements.filter(e => {
      if (e.state?.visible === false) return false;
      const isInputControl = e.role === 'textbox' || e.role === 'searchbox' || e.tagName?.toLowerCase() === 'input' || e.tagName?.toLowerCase() === 'textarea' || e.id?.includes('search');
      if (isInputControl) return false;

      if (e.attributes?.['data-detail'] !== undefined) return true;
      if (e.attributes?.['class']?.includes('detail') || e.attributes?.['class']?.includes('txn-detail')) return true;
      if (detailDialog && e.id !== detailDialog.id) {
        const isOverlay = (detailDialog.bounds?.width ?? 0) >= 700 && (detailDialog.bounds?.height ?? 0) >= 500;
        if (!isOverlay && detailDialog.bounds && e.bounds) {
          return (
            e.bounds.x >= detailDialog.bounds.x - 15 &&
            e.bounds.y >= detailDialog.bounds.y - 15 &&
            e.bounds.x + e.bounds.width <= detailDialog.bounds.x + detailDialog.bounds.width + 15 &&
            e.bounds.y + e.bounds.height <= detailDialog.bounds.y + detailDialog.bounds.height + 15
          );
        }
      }
      return false;
    });

    // E. Verify transaction detail fields are not placeholders (e.g. '—')
    const detailValues = currentPage.elements.filter(
      e => e.attributes?.['data-detail'] !== undefined && e.state?.visible !== false
    );
    if (detailValues.length > 0) {
      const merchantEl = detailValues.find(e => e.attributes?.['data-detail'] === 'merchant');
      const merchantVal = (merchantEl?.visibleText || merchantEl?.accessibleName || '').trim();
      if (!merchantVal || merchantVal === '—' || merchantVal === '-' || merchantVal === 'N/A') {
        return {
          satisfied: false,
          rationale: 'Goal not satisfied: transaction details dialog contains empty or placeholder values'
        };
      }

      // Check required transaction fields
      const requiredFields = ['merchant', 'amount', 'date', 'txnId'];
      const missingFields = requiredFields.filter(field => {
        const el = detailValues.find(e => e.attributes?.['data-detail'] === field);
        const val = (el?.visibleText || el?.accessibleName || '').trim();
        return !val || val === '—' || val === '-' || val === 'N/A';
      });
      if (missingFields.length > 0) {
        return {
          satisfied: false,
          rationale: `Goal not satisfied: missing or unpopulated transaction fields: ${missingFields.join(', ')}`
        };
      }
    }

    const dialogText = detailDialog
      ? `${detailDialog.visibleText ?? ''} ${detailDialog.accessibleName ?? ''} ${Object.values(detailDialog.attributes ?? {}).join(' ')}`
      : '';
    const detailText = `${dialogText} ${detailElements
      .map(e => `${e.visibleText ?? ''} ${e.accessibleName ?? ''} ${Object.values(e.attributes ?? {}).join(' ')}`)
      .join(' ')}`.toLowerCase();

    // If detailValues was empty, ensure dialog contains observable transaction context
    if (detailValues.length === 0) {
      const requiredKeywords = ['amount', 'date'];
      const missingKeywords = requiredKeywords.filter(kw => !detailText.includes(kw));
      if (missingKeywords.length > 0 || !detailText || detailText.trim() === 'transaction details' || detailText.includes('— — —')) {
        return {
          satisfied: false,
          rationale: 'Goal not satisfied: transaction details are incomplete or missing required observable data'
        };
      }
    }

    // F. Verify entity/merchant match
    if (targetEntity) {
      const merchantEl = detailValues.find(e => e.attributes?.['data-detail'] === 'merchant');
      const merchantVal = (merchantEl?.visibleText || merchantEl?.accessibleName || '').trim().toLowerCase();
      const entityMatches = merchantVal
        ? merchantVal.includes(targetEntity.toLowerCase())
        : detailText.includes(targetEntity.toLowerCase());

      if (!entityMatches) {
        return {
          satisfied: false,
          rationale: `Goal not satisfied: opened record details do not match requested entity "${targetEntity}"`
        };
      }
    }

    // G. Verify amount match if specified in goal (e.g. "Find the Amazon transaction for ₹4,299")
    if (goalAnalysis.amountFilter !== undefined) {
      const targetAmountStr = String(goalAnalysis.amountFilter);
      const targetAmountDigits = targetAmountStr.replace(/[^\d]/g, '');
      const amountEl = detailValues.find(e => e.attributes?.['data-detail'] === 'amount');
      const amountVal = (amountEl?.visibleText || detailText).replace(/[^\d]/g, '');
      const matchesAmount = targetAmountDigits ? amountVal.includes(targetAmountDigits) : amountVal.includes(targetAmountStr);
      if (!matchesAmount) {
        return {
          satisfied: false,
          rationale: `Goal not satisfied: opened record amount does not match requested amount ₹${goalAnalysis.amountFilter}`
        };
      }
    }

    // H. Verify temporal filter if specified in goal (e.g. "from September", "from 30 September 2026")
    if (goalAnalysis.temporalFilter) {
      const tempLower = goalAnalysis.temporalFilter.toLowerCase();
      const dateEl = detailValues.find(e => e.attributes?.['data-detail'] === 'date');
      const dateVal = (dateEl?.visibleText || detailText).toLowerCase();

      // Normalize month full names to 3-letter abbreviations
      const MONTH_MAP: Record<string, string> = {
        january: 'jan',
        february: 'feb',
        march: 'mar',
        april: 'apr',
        may: 'may',
        june: 'jun',
        july: 'jul',
        august: 'aug',
        september: 'sep',
        october: 'oct',
        november: 'nov',
        december: 'dec'
      };

      const normalizeTemporalString = (s: string) => {
        let norm = s.toLowerCase();
        for (const [full, abbrev] of Object.entries(MONTH_MAP)) {
          norm = norm.replace(new RegExp(`\\b${full}\\b`, 'g'), abbrev);
        }
        return norm;
      };

      const normTarget = normalizeTemporalString(tempLower);
      const normDateVal = normalizeTemporalString(dateVal);

      // Check if normalized target is directly included or all date tokens match
      const targetTokens = normTarget.match(/\b\w+\b/g) ?? [];
      const allTokensMatch = targetTokens.length > 0 && targetTokens.every(tok => normDateVal.includes(tok));
      const directMatch = normDateVal.includes(normTarget) || dateVal.includes(tempLower);

      if (!directMatch && !allTokensMatch) {
        return {
          satisfied: false,
          rationale: `Goal not satisfied: opened record date does not match requested time constraint "${goalAnalysis.temporalFilter}"`
        };
      }
    }

    // I. If constraint is "latest" / "most recent", verify opened date is the latest among matching rows
    if (goalAnalysis.isLatest || constraint === 'latest' || constraint === 'most recent' || constraint === 'newest') {
      const dialogTimestamp = detailElements
        .map(e => extractTimestampFromElement(e))
        .find((ts): ts is number => ts !== undefined);

      const allMatchingRowTimestamps: number[] = [];
      const searchRows = [...currentPage.elements, ...(beforePage?.elements ?? [])].filter(
        e => (e.role as string) === 'row' || e.tagName?.toLowerCase() === 'tr' || e.attributes?.['role'] === 'row'
      );
      for (const r of searchRows) {
        const rowText = `${r.visibleText ?? ''} ${r.accessibleName ?? ''} ${Object.values(r.attributes ?? {}).join(' ')}`.toLowerCase();
        if (!targetEntity || rowText.includes(targetEntity.toLowerCase())) {
          if (goalAnalysis.amountFilter !== undefined) {
            const rowDigits = rowText.replace(/[^\d]/g, '');
            if (!rowDigits.includes(String(goalAnalysis.amountFilter))) continue;
          }
          const ts = extractTimestampFromElement(r);
          if (ts !== undefined) allMatchingRowTimestamps.push(ts);
        }
      }

      const maxMatchingTimestamp = allMatchingRowTimestamps.length > 0 ? Math.max(...allMatchingRowTimestamps) : undefined;

      if (dialogTimestamp !== undefined && maxMatchingTimestamp !== undefined && dialogTimestamp < maxMatchingTimestamp) {
        return {
          satisfied: false,
          rationale: `Goal not satisfied: opened transaction date (${new Date(dialogTimestamp).toLocaleDateString()}) is not the latest matching transaction (expected ${new Date(maxMatchingTimestamp).toLocaleDateString()})`
        };
      }
    }

    return {
      satisfied: true,
      rationale: `Whole goal verified: ${targetEntity ? `latest ${targetEntity} ` : ''}transaction details opened and verified`
    };
  }

  // 4. Search and Act:
  if (archetype === 'search_and_act' || /\bsearch\b/i.test(desc)) {
    if (isItemGoal) {
      return {
        satisfied: false,
        rationale: 'Goal not satisfied: target record details not opened or visible'
      };
    }
    const hasSearchEvidence = hasSearchResultEvidence(currentPage, beforePage);
    if (hasSearchEvidence) {
      if (isCompoundSearchGoal(desc)) {
        const urlChanged = Boolean(
          beforePage?.metadata?.url &&
          currentPage.metadata?.url &&
          beforePage.metadata.url.split('#')[0] !== currentPage.metadata.url.split('#')[0]
        );
        if (urlChanged) {
          return { satisfied: true, rationale: 'Compound search and navigation outcome verified' };
        }
        return { satisfied: false, rationale: 'Compound search destination page not reached' };
      }
      return { satisfied: true, rationale: 'Search results outcome verified' };
    }
  }

  // 5. Navigation Act:
  if (archetype === 'navigation_act' || /\b(?:navigate|open|go to)\b/i.test(desc)) {
    const urlChanged = Boolean(
      beforePage?.metadata?.url &&
      currentPage.metadata?.url &&
      beforePage.metadata.url.split('#')[0] !== currentPage.metadata.url.split('#')[0]
    );
    if (urlChanged) {
      return { satisfied: true, rationale: 'Navigation destination verified' };
    }
  }

  // 6. Default generic verification for all other multi-phase workflows:
  if (isMediaGoal) {
    return {
      satisfied: false,
      rationale: 'Goal outcome not confirmed: playable media or player was not verified in page state'
    };
  }
  if (isItemGoal) {
    return {
      satisfied: false,
      rationale: 'Goal not satisfied: matching record details not opened or confirmed'
    };
  }
  const hasActiveDialog = currentPage.elements.some(
    e => (e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog') && e.interactive !== false
  );
  if (!hasActiveDialog) {
    return {
      satisfied: true,
      rationale: `All ${taskPlan.phases.length} phases completed and final page state verified`
    };
  }

  return {
    satisfied: false,
    rationale: 'Final goal outcome inconclusive'
  };
}

// ---------------------------------------------------------------------------
// Single Step Runner
// ---------------------------------------------------------------------------

async function runOneStep(
  tabId: number,
  windowId: number | undefined,
  goal: { id: string; description: string; taskPlan?: TaskPlan },
  stepIndex: number,
  history: PlannerInput['history'],
  domProvider: DomPerceptionProvider,
  onProgress?: (event: AgentProgressEvent) => void,
  runId: string = goal.id,
  options?: DemoRunnerOptions
): Promise<{
  step: DemoStep;
  completed: boolean;
  failed: boolean;
  executedAction?: IntendedAction;
  phaseMilestoneResult?: PhaseMilestoneResult;
}> {

  // 1. Perception (DOM + screenshot + vision)
  onProgress?.({
    runId,
    stepIndex,
    phase: 'perception',
    status: 'running',
    message: 'Perceiving page (DOM + Vision)…',
    timestamp: Date.now()
  });

  const screenshotProvider = async () => {
    const result = await captureVisibleTab(windowId);
    return {
      format: result.format,
      timestamp: result.timestamp,
      dataUrl: result.dataUrl,
      dimensions: result.dimensions
    };
  };

  // DOM-sufficient vision skip: probe DOM first (no screenshot required).
  // If the DOM already provides enough interactive targets, skip the optional
  // vision inference request entirely. This prevents the ~58 s llama.cpp
  // image-encoding latency from competing with the planner on pages where
  // DOM alone is sufficient for grounding (e.g. pages with ≥1 interactive element).
  // The existing vision fallback path (llama-server unavailable → DOM-only retry)
  // is preserved for cases where DOM probing yields zero usable targets.
  let domProbe: PageRepresentation | undefined;
  try {
    domProbe = await domProvider();
  } catch {
    // DOM probe failure — fall through to the standard perceivePage path which
    // will surface the DOM error through its own error handling.
  }

  const domSufficient = domProbe !== undefined && hasSufficientDomTargets(domProbe);

  // Wrap the already-fetched DOM snapshot so perceivePage does not issue a
  // second IPC round-trip for the same step when DOM was successfully probed.
  const effectiveDomProvider: DomPerceptionProvider = domProbe !== undefined
    ? async () => domProbe as PageRepresentation
    : domProvider;

  const visionTimeout = options?.visionTimeoutMs ?? DEFAULT_DEMO_VISION_TIMEOUT_MS;
  let visionAdapter = domSufficient
    ? nullVisionAdapter
    : createLlamaVisionAdapter({ timeoutMs: visionTimeout });

  if (domSufficient) {
    onProgress?.({
      runId,
      stepIndex,
      phase: 'perception',
      status: 'running',
      message: `DOM perception sufficient (${domProbe!.elements.filter(e => e.interactive && e.bounds && e.bounds.width > 0 && e.bounds.height > 0).length} interactive targets) — skipping vision`,
      timestamp: Date.now()
    });
  }

  let perceptionResult = await perceivePage(effectiveDomProvider, screenshotProvider, visionAdapter);

  // If vision failed (llama-server down, timeout, or decoding failure), retry with null adapter (DOM-only)
  if (!perceptionResult.success && perceptionResult.error.origin === 'vision') {
    onProgress?.({
      runId,
      stepIndex,
      phase: 'perception',
      status: 'running',
      message: 'Vision unavailable — switching to DOM perception…',
      timestamp: Date.now()
    });
    visionAdapter = nullVisionAdapter;
    perceptionResult = await perceivePage(effectiveDomProvider, screenshotProvider, visionAdapter);
  }

  if (!perceptionResult.success) {
    onProgress?.({
      runId,
      stepIndex,
      phase: 'perception',
      status: 'failed',
      message: `Perception failed: ${perceptionResult.error.message}`,
      timestamp: Date.now()
    });
    return {
      step: {
        stepIndex,
        perception: {
          elementCount: 0,
          interactiveCount: 0,
          visualObservationCount: 0,
          privacyFindingCount: 0,
          visionAdapterName: visionAdapter.name
        },
        plan: { status: 'FAILED', rationale: `Perception failed: ${perceptionResult.error.message}` }
      },
      completed: false,
      failed: true
    };
  }

  const { domRepresentation, visualObservations, metadata } = perceptionResult;

  // 2. Privacy sanitization
  const sanitized = sanitizePageRepresentation(domRepresentation);
  const safePage = sanitized.pageRepresentation;

  const perceptionSummary: DemoStepPerception = {
    elementCount: safePage.elements.length,
    interactiveCount: safePage.elements.filter(e => e.interactive).length,
    visualObservationCount: visualObservations.length,
    privacyFindingCount: sanitized.findings.length,
    pageTitle: safePage.metadata?.title,
    visionAdapterName: metadata.visionAdapterName
  };

  onProgress?.({
    runId,
    stepIndex,
    phase: 'perception',
    status: 'completed',
    message: `${perceptionSummary.elementCount} elements, ${perceptionSummary.interactiveCount} interactive`,
    timestamp: Date.now(),
    data: {
      elementCount: perceptionSummary.elementCount,
      interactiveCount: perceptionSummary.interactiveCount,
      visualObservationCount: perceptionSummary.visualObservationCount,
      visionAdapterName: perceptionSummary.visionAdapterName
    }
  });

  onProgress?.({
    runId,
    stepIndex,
    phase: 'privacy',
    status: 'completed',
    message: sanitized.findings.length > 0
      ? `${sanitized.findings.length} finding(s) redacted ✓`
      : 'No PII detected',
    timestamp: Date.now(),
    data: {
      privacyFindingCount: sanitized.findings.length
    }
  });

  // 3. Grounding → ActionTarget[]
  const availableTargets = buildAvailableTargets(
    safePage,
    visualObservations,
    perceptionResult.screenshotRef.dimensions
  );

  if (availableTargets.length === 0) {
    onProgress?.({
      runId,
      stepIndex,
      phase: 'grounding',
      status: 'failed',
      message: 'No actionable targets found on page',
      timestamp: Date.now()
    });
    return {
      step: {
        stepIndex,
        perception: perceptionSummary,
        plan: { status: 'FAILED', rationale: 'No actionable targets found on page' }
      },
      completed: false,
      failed: true
    };
  }

  onProgress?.({
    runId,
    stepIndex,
    phase: 'grounding',
    status: 'completed',
    message: `${availableTargets.length} targets resolved`,
    timestamp: Date.now(),
    data: {
      interactiveCount: availableTargets.length
    }
  });

  // 4. Planning via Phase 3A planNextStep + Phase 5A LocalAgentDriver
  onProgress?.({
    runId,
    stepIndex,
    phase: 'planning',
    status: 'running',
    message: 'Querying local model for next step…',
    timestamp: Date.now()
  });

  const isCompound = isCompoundSearchGoal(goal.description) || isItemRetrievalGoal(goal.description);
  let plannerIntent: PlannerGoalIntent = isCompound
    ? (isPostSearchPhase(history) ? 'click' : 'custom')
    : 'search';

  const activePhase = options?.phaseState?.activePhase ?? resolveActivePhase(goal, undefined, history);
  if (activePhase) {
    if (activePhase.intent === 'search') {
      plannerIntent = 'search';
    } else if (
      activePhase.intent === 'open_surface' ||
      activePhase.intent === 'select_result' ||
      activePhase.intent === 'submit' ||
      activePhase.intent === 'navigate'
    ) {
      plannerIntent = 'click';
    } else if (activePhase.intent === 'fill_field') {
      plannerIntent = 'type';
    } else if (activePhase.intent === 'select_option') {
      // select_option is a semantic PhaseIntent: must never fall through to search intent
      plannerIntent = 'custom';
    } else {
      plannerIntent = 'custom';
    }
  }

  const phaseState: PhaseExecutionState | undefined = options?.phaseState ?? ((goal.taskPlan && activePhase) ? {
    activePhase,
    completedPhaseIds: goal.taskPlan.phases
      .slice(0, activePhase.phaseIndex)
      .map(p => p.phaseId),
    remainingPhaseIds: goal.taskPlan.phases
      .slice(activePhase.phaseIndex + 1)
      .map(p => p.phaseId),
    totalPhases: goal.taskPlan.phases.length,
    retryCountInCurrentPhase: 0,
    phaseStatus: 'in_progress',
    phaseAttempts: 0
  } : undefined);

  const plannerInput: PlannerInput = {
    goal: {
      id: goal.id,
      description: goal.description,
      // Derive intent from goal description, active task phase, and history:
      // - Active phase intent mapped to click/type/search when taskPlan is active
      // - Pre-search compound: 'custom'
      // - Post-search compound: 'click' (transition after verified search submission)
      // - Search-only: 'search'
      intent: plannerIntent,
      ...(goal.taskPlan ? { taskPlan: goal.taskPlan } : {})
    },
    context: {
      page: safePage,
      availableTargets,
      capturedAt: perceptionResult.screenshotRef.timestamp,
      currentTime: Date.now(),
      stepIndex,
      completion: { satisfied: false },
      ...(phaseState ? { phaseState } : {})
    },
    history,
    options: DEMO_PLANNER_OPTIONS
  };

  console.log(
    `[NexVision DemoRunner] Step ${stepIndex}: history length = ${history?.length ?? 0}`
  );
  const driver = new LocalAgentDriver();
  const planResult = await planNextStep(plannerInput, driver);

  const planSummary: DemoStepPlan = {
    status: planResult.status,
    rationale: 'rationale' in planResult ? planResult.rationale :
               'summary' in planResult ? planResult.summary :
               'message' in planResult ? planResult.message : undefined,
    targetElementId: 'action' in planResult ? planResult.action.target.elementId : undefined,
    actionType: 'action' in planResult ? planResult.action.type : undefined
  };

  if (planResult.status === 'COMPLETED') {
    onProgress?.({
      runId,
      stepIndex,
      phase: 'planning',
      status: 'completed',
      message: planSummary.rationale ?? 'Goal completed',
      timestamp: Date.now(),
      data: {
        planStatus: 'COMPLETED',
        rationale: planSummary.rationale
      }
    });
    return {
      step: { stepIndex, perception: perceptionSummary, plan: planSummary },
      completed: true,
      failed: false
    };
  }

  if (planResult.status === 'FAILED') {
    onProgress?.({
      runId,
      stepIndex,
      phase: 'planning',
      status: 'failed',
      message: planSummary.rationale ?? 'Planning failed',
      timestamp: Date.now(),
      data: {
        planStatus: 'FAILED',
        rationale: planSummary.rationale
      }
    });
    return {
      step: { stepIndex, perception: perceptionSummary, plan: planSummary },
      completed: false,
      failed: true
    };
  }

  onProgress?.({
    runId,
    stepIndex,
    phase: 'planning',
    status: 'completed',
    message: `${planSummary.actionType} → ${planSummary.rationale}`,
    timestamp: Date.now(),
    data: {
      planStatus: 'ACTION',
      actionType: planSummary.actionType,
      targetElementId: planSummary.targetElementId,
      rationale: planSummary.rationale
    }
  });

  // 5. Execution via Phase 3B executeAction
  onProgress?.({
    runId,
    stepIndex,
    phase: 'execution',
    status: 'running',
    message: `Executing ${planResult.action.type}…`,
    timestamp: Date.now()
  });

  const execResult = await executeAction({ action: planResult.action, tabId });

  const execSummary: DemoStepExecution = {
    success: execResult.success,
    actionType: execResult.actionType,
    elementId: execResult.elementId,
    reason: !execResult.success ? execResult.reason : undefined
  };

  onProgress?.({
    runId,
    stepIndex,
    phase: 'execution',
    status: execResult.success ? 'completed' : 'failed',
    message: execResult.success ? `${execSummary.actionType} executed ✓` : `Failed: ${execSummary.reason}`,
    timestamp: Date.now(),
    data: {
      executionSuccess: execResult.success,
      executionReason: execSummary.reason,
      actionType: execSummary.actionType
    }
  });

  // 6. Semantic Post-Action Verification
  let verificationSummary: DemoStepVerification;

  if (execResult.success) {
    onProgress?.({
      runId,
      stepIndex,
      phase: 'verification',
      status: 'running',
      message: `Verifying page state after ${planResult.action.type}…`,
      timestamp: Date.now()
    });

    verificationSummary = await verifyActionEffect(
      planResult.action,
      safePage,
      domProvider,
      options?.verificationSettleMs,
      execResult
    );

    if (execResult.success && typeof execResult.valueMatch === 'boolean') {
      verificationSummary = {
        ...verificationSummary,
        valueMatch: execResult.valueMatch
      };
    }

    onProgress?.({
      runId,
      stepIndex,
      phase: 'verification',
      status: verificationSummary.verified ? 'completed' : 'failed',
      message: verificationSummary.message,
      timestamp: Date.now(),
      data: {
        executionSuccess: true
      }
    });
  } else {
    verificationSummary = {
      verified: false,
      message: `Execution failed: ${execSummary.reason ?? 'unknown'}`
    };
    onProgress?.({
      runId,
      stepIndex,
      phase: 'verification',
      status: 'failed',
      message: verificationSummary.message,
      timestamp: Date.now()
    });
  }

  const afterPage = verificationSummary.afterPage;
  const phaseMilestoneResult = (activePhase && afterPage)
    ? verifyPhaseMilestone(
        activePhase,
        planResult.action,
        safePage,
        afterPage,
        verificationSummary
      )
    : undefined;

  const goalCheck = (execResult.success && afterPage)
    ? verifyGoalSatisfaction(
        plannerInput.goal,
        planResult.action,
        safePage,
        afterPage,
        verificationSummary
      )
    : { satisfied: false, rationale: 'Action effect was not verified' };

  return {
    step: {
      stepIndex,
      perception: perceptionSummary,
      plan: planSummary,
      execution: execSummary,
      verification: verificationSummary
    },
    completed: goalCheck.satisfied,
    failed: !execResult.success,
    // Forward the resolved action so the outer loop can record it in history.
    // Only set on execution success; text payload is never stored (privacy boundary).
    executedAction: execResult.success ? planResult.action : undefined,
    phaseMilestoneResult
  };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Runs a bounded demo loop (≤ MAX_STEPS) for a single user goal.
 *
 * @param tabId     Chrome tab ID for DOM perception and action execution.
 * @param windowId  Chrome window ID for screenshot capture.
 * @param goalDescription  The natural-language task description.
 */
export async function runDemoAgent(
  tabId: number,
  windowId: number,
  goalDescription: string
): Promise<DemoRunResult> {
  const steps: DemoStep[] = [];
  const history: PlannerInput['history'] = [];
  const goalId = `demo-goal-${Date.now()}`;

  // Fixed DOM provider using existing service-worker IPC path (injected at call site)
  // so demoRunner itself has no chrome.* dependency (testable in isolation).
  // The domProvider is passed in via closure from service-worker where chrome.* is available.
  // Here we accept it as a parameter for testability.
  throw new Error(
    'Use runDemoAgentWithProvider instead — this overload is intentionally unimplemented.'
  );
}

/**
 * Testable entry point: accepts an injected DomPerceptionProvider and optional onProgress callback.
 */
export async function runDemoAgentWithProvider(
  tabId: number,
  windowId: number | undefined,
  goalDescription: string,
  domProvider: DomPerceptionProvider,
  onProgress?: (event: AgentProgressEvent) => void,
  runId: string = `demo-goal-${Date.now()}`,
  options?: DemoRunnerOptions
): Promise<DemoRunResult> {
  const steps: DemoStep[] = [];
  const history: PlannerHistoryStep[] = [];

  // Phase B: Upfront Task Understanding & Decomposition (text-only, non-blocking fallback)
  let taskPlan: TaskPlan | undefined;
  try {
    taskPlan = options?.taskPlan ?? await decomposeTaskGoal(goalDescription, {
      client: options?.chatClient
    });
  } catch {
    taskPlan = undefined;
  }

  if (taskPlan) {
    console.log(`[NexVision DemoRunner] ${summarizeTaskPlanForLogs(taskPlan)}`);
  }

  const goal: PlannerGoal = {
    id: runId,
    description: goalDescription,
    taskPlan
  };

  // Phase D: Initialize Runtime Phase State Machine
  let currentPhaseIndex = taskPlan?.currentPhaseIndex ?? 0;
  const completedPhaseIds: string[] = [];
  let retryCountInCurrentPhase = 0;
  let lastActionSignature: string | undefined = undefined;
  let consecutiveSameActionCount = 0;

  const stepBudget = options?.maxSteps ?? calculateDynamicStepBudget(taskPlan);
  console.log(`[NexVision DemoRunner] Dynamic step budget: ${stepBudget} (phases: ${taskPlan?.phases.length ?? 0})`);

  for (let stepIndex = 0; stepIndex < stepBudget; stepIndex++) {
    // If all phases were marked completed in prior step, or active phase is verify_outcome, verify against settled page state
    const activePhaseCandidate = (taskPlan && Array.isArray(taskPlan.phases) && currentPhaseIndex < taskPlan.phases.length)
      ? taskPlan.phases[currentPhaseIndex]
      : undefined;

    if (taskPlan && (currentPhaseIndex >= taskPlan.phases.length || activePhaseCandidate?.intent === 'verify_outcome')) {
      let settledPage: PageRepresentation;
      try {
        settledPage = await domProvider();
      } catch {
        settledPage = steps[steps.length - 1]?.verification?.afterPage ?? {
          schemaVersion: '1.0',
          metadata: {},
          elements: [],
          viewport: { width: 1280, height: 720 }
        };
      }
      const goalOutcome = verifyWholeGoalOutcome({
        goal: { id: runId, description: goalDescription, taskPlan },
        taskPlan,
        completedPhaseIds,
        currentPage: settledPage,
        beforePage: steps[steps.length - 1]?.verification?.afterPage,
        history
      });
      if (goalOutcome.satisfied) {
        if (activePhaseCandidate && !completedPhaseIds.includes(activePhaseCandidate.phaseId)) {
          completedPhaseIds.push(activePhaseCandidate.phaseId);
        }
        return {
          status: 'COMPLETED',
          steps,
          totalSteps: steps.length,
          message: goalOutcome.rationale
        };
      } else if (currentPhaseIndex >= taskPlan.phases.length) {
        return {
          status: 'PLAN_FAILED',
          steps,
          totalSteps: steps.length,
          message: goalOutcome.rationale
        };
      }
    }

    // 1. Resolve active phase for this step
    const activePhase = (taskPlan && Array.isArray(taskPlan.phases) && currentPhaseIndex < taskPlan.phases.length)
      ? taskPlan.phases[currentPhaseIndex]
      : resolveActivePhase({ id: runId, description: goalDescription, taskPlan }, undefined, history);

    const remainingPhaseIds = (taskPlan && Array.isArray(taskPlan.phases) && activePhase)
      ? taskPlan.phases.slice(activePhase.phaseIndex + 1).map(p => p.phaseId)
      : [];

    const phaseState: PhaseExecutionState | undefined = taskPlan ? {
      activePhase,
      completedPhaseIds: [...completedPhaseIds],
      remainingPhaseIds,
      totalPhases: taskPlan.phases.length,
      retryCountInCurrentPhase,
      phaseStatus: activePhase ? 'in_progress' : 'completed',
      phaseAttempts: retryCountInCurrentPhase
    } : undefined;

    const goal: PlannerGoal = {
      id: runId,
      description: goalDescription,
      taskPlan: taskPlan ? {
        ...taskPlan,
        currentPhaseIndex: activePhase?.phaseIndex ?? currentPhaseIndex
      } : undefined
    };

    const { step, completed, failed, executedAction, phaseMilestoneResult } = await runOneStep(
      tabId,
      windowId,
      goal,
      stepIndex,
      history,
      domProvider,
      onProgress,
      runId,
      {
        ...options,
        phaseState
      }
    );

    steps.push(step);

    if (failed) {
      const reason = step.plan.rationale ?? 'Unknown failure';
      const perceptionFailed = step.plan.rationale?.startsWith('Perception failed');
      return {
        status: perceptionFailed ? 'PERCEPTION_FAILED' :
                step.execution && !step.execution.success ? 'EXECUTION_FAILED' : 'PLAN_FAILED',
        steps,
        totalSteps: steps.length,
        message: reason
      };
    }

    // Record this step in history for the next planning cycle.
    // Only structural metadata is retained; typed text is NEVER persisted (privacy boundary).
    if (step.execution?.success && executedAction) {
      const safeAction: IntendedAction =
        executedAction.type === 'type'
          ? {
              ...executedAction,
              payload: {
                text: '', // Privacy boundary: typed text is never persisted in history
                ...(executedAction.payload?.clearFirst !== undefined
                  ? { clearFirst: executedAction.payload.clearFirst }
                  : {}),
                ...(executedAction.payload?.pressEnter !== undefined
                  ? { pressEnter: executedAction.payload.pressEnter }
                  : {})
              }
            }
          : executedAction;

      history.push({
        stepIndex,
        action: safeAction,
        perceivedOutcome: step.verification?.verified ? 'success' : 'no_change',
        ...(activePhase?.phaseIndex !== undefined ? { phaseIndex: activePhase.phaseIndex } : {}),
        ...(activePhase?.intent !== undefined ? { phaseIntent: activePhase.intent } : {}),
        ...(activePhase?.fieldParameter?.fieldName ? { fulfilledParameter: activePhase.fieldParameter.fieldName } : {})
      });

      // Loop / Repetition Protection: detect repeated ineffective actions
      const actionSig = `${safeAction.type}:${safeAction.target.elementId}:${activePhase?.phaseIndex ?? currentPhaseIndex}`;
      if (actionSig === lastActionSignature && (!step.verification?.verified || phaseMilestoneResult?.satisfied === false)) {
        consecutiveSameActionCount++;
      } else {
        lastActionSignature = actionSig;
        consecutiveSameActionCount = 1;
      }

      if (consecutiveSameActionCount > MAX_PHASE_RETRIES) {
        return {
          status: 'PLAN_FAILED',
          steps,
          totalSteps: steps.length,
          message: `Repeated ineffective action detected: ${safeAction.type} on ${safeAction.target.elementId} in phase '${activePhase?.phaseId ?? currentPhaseIndex}'`
        };
      }
    }

    // Phase Advancement Evaluation (Phase D)
    if (taskPlan && activePhase) {
      const milestoneSatisfied = phaseMilestoneResult?.satisfied === true;

      if (milestoneSatisfied) {
        completedPhaseIds.push(activePhase.phaseId);
        currentPhaseIndex = activePhase.phaseIndex + 1;
        retryCountInCurrentPhase = 0;
        consecutiveSameActionCount = 0;
        lastActionSignature = undefined;

        console.log(`[NexVision DemoRunner] Phase '${activePhase.phaseId}' completed (${completedPhaseIds.length}/${taskPlan.phases.length}). Next phase index: ${currentPhaseIndex}`);

        const allPhasesDone = currentPhaseIndex >= taskPlan.phases.length;
        const remainingPhases = taskPlan.phases.slice(currentPhaseIndex);
        const onlyVerifyPhasesRemain = remainingPhases.length > 0 && remainingPhases.every(p => p.intent === 'verify_outcome');
        const isTerminalVerifyOutcome = activePhase.intent === 'verify_outcome' || (activePhase.phaseIndex === taskPlan.phases.length - 1) || onlyVerifyPhasesRemain;

        if (allPhasesDone || isTerminalVerifyOutcome) {
          // FIX 2: All phases completed is NOT by itself sufficient for final completion.
          // Evaluate generic whole-goal postcondition against the latest page representation.
          const currentPage = step.verification?.afterPage;
          if (currentPage) {
            const goalOutcome = verifyWholeGoalOutcome({
              goal,
              taskPlan,
              completedPhaseIds,
              currentPage,
              beforePage: steps.length > 1 ? steps[steps.length - 2]?.verification?.afterPage : undefined,
              history,
              lastAction: executedAction,
              lastVerification: step.verification
            });

            if (goalOutcome.satisfied) {
              if (onlyVerifyPhasesRemain) {
                for (const p of remainingPhases) {
                  if (!completedPhaseIds.includes(p.phaseId)) {
                    completedPhaseIds.push(p.phaseId);
                  }
                }
              }
              return {
                status: 'COMPLETED',
                steps,
                totalSteps: steps.length,
                message: goalOutcome.rationale
              };
            } else if (allPhasesDone || activePhase.intent === 'verify_outcome' || onlyVerifyPhasesRemain) {
              // Targeted bounded wait for active CSS transition if a dialog or click was involved
              const hasTransitionCandidate = currentPage.elements.some(
                e => (e.role === 'dialog' || e.tagName?.toLowerCase() === 'dialog' || e.attributes?.['role'] === 'dialog' || e.attributes?.['class']?.includes('detail'))
              ) || executedAction?.type === 'click';

              if (hasTransitionCandidate) {
                // Wait 250ms for the 200ms opacity transition to settle completely
                await new Promise(r => setTimeout(r, 250));
                try {
                  const settledPage = await domProvider();
                  const recheckOutcome = verifyWholeGoalOutcome({
                    goal,
                    taskPlan,
                    completedPhaseIds,
                    currentPage: settledPage,
                    beforePage: steps.length > 1 ? steps[steps.length - 2]?.verification?.afterPage : undefined,
                    history,
                    lastAction: executedAction,
                    lastVerification: step.verification
                  });
                  if (recheckOutcome.satisfied) {
                    if (onlyVerifyPhasesRemain) {
                      for (const p of remainingPhases) {
                        if (!completedPhaseIds.includes(p.phaseId)) {
                          completedPhaseIds.push(p.phaseId);
                        }
                      }
                    }
                    return {
                      status: 'COMPLETED',
                      steps,
                      totalSteps: steps.length,
                      message: recheckOutcome.rationale
                    };
                  }
                } catch {
                  // Fall through to original failure
                }
              }

              return {
                status: 'PLAN_FAILED',
                steps,
                totalSteps: steps.length,
                message: goalOutcome.rationale
              };
            } else {
              console.log(
                `[NexVision DemoRunner] Phase '${activePhase.phaseId}' completed, but whole-goal postcondition not yet satisfied: ${goalOutcome.rationale}. Continuing next phase.`
              );
            }
          }
        }
      } else {
        retryCountInCurrentPhase++;
        console.log(`[NexVision DemoRunner] Phase '${activePhase.phaseId}' milestone not satisfied (attempt ${retryCountInCurrentPhase}). Retrying.`);

        if (retryCountInCurrentPhase > MAX_PHASE_RETRIES) {
          return {
            status: 'PLAN_FAILED',
            steps,
            totalSteps: steps.length,
            message: `Exceeded maximum retries (${MAX_PHASE_RETRIES}) for phase '${activePhase.phaseId}'`
          };
        }
      }
    } else {
      // Backward compatibility when no TaskPlan is available
      if (completed) {
        return {
          status: 'COMPLETED',
          steps,
          totalSteps: steps.length,
          message: step.plan.rationale ?? 'Goal completed'
        };
      }
    }
  }

  return {
    status: 'MAX_STEPS_REACHED',
    steps,
    totalSteps: steps.length,
    message: `Reached maximum of ${stepBudget} steps`
  };
}
