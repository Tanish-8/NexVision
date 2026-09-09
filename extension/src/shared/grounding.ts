/**
 * Phase 2F-2 — Deterministic Vision → DOM Grounding.
 *
 * Pure deterministic function that maps visual observations (in screenshot pixel
 * coordinates) to existing DOM PageElements (in CSS viewport coordinates) using
 * Phase 2F-1 coordinate normalization.
 *
 * Invariants:
 * - No Chrome APIs, no DOM APIs, no DOM mutation.
 * - No model inference, no network, no persistence.
 * - No randomness; same inputs always produce same outputs.
 * - Input objects are never mutated.
 */

import type {
  ElementRole,
  PageRepresentation
} from './types.js';
import {
  screenshotPixelsToCssRect
} from './coordinates.js';
import type {
  CoordinateSpaceMetadata,
  CssViewportRect,
  ScreenshotPixelRect
} from './coordinates.js';

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

/**
 * Visual observation input contract for grounding.
 * Structurally compatible with VisionObservation and VisualObservation.
 */
export interface GroundingVisualObservation {
  id: string;
  label: string;
  text?: string;
  boundingBox: ScreenshotPixelRect;
  confidence: number;
  interactionHint?:
    | 'clickable'
    | 'scrollable'
    | 'input'
    | 'selectable'
    | 'static'
    | 'unknown';
}

/** Deterministic reasons for why a visual observation could not be grounded. */
export type GroundingUnmatchedReason =
  | 'NO_DOM_CANDIDATES'
  | 'OUT_OF_BOUNDS'
  | 'NO_OVERLAPPING_CANDIDATES'
  | 'BELOW_SCORE_THRESHOLD'
  | 'INVALID_OBSERVATION';

/**
 * Granular scoring breakdown for evaluation, debugging, and test assertions.
 */
export interface GroundingScoreBreakdown {
  /** Intersection-over-Union between visual box and DOM element [0, 1] */
  iou: number;
  /** Proportion of visual box area contained within the DOM element [0, 1] */
  visualContainment: number;
  /** Proportion of DOM element area contained within the visual box [0, 1] */
  elementContainment: number;
  /** Proximity of centers normalized by diagonal of bounding union [0, 1] */
  centerProximity: number;
  /** Whether the visual box center falls inside the DOM element bounds */
  isVisualCenterInsideDom: boolean;
  /** Combined geometric score [0, 1] using 0.45/0.20/0.15/0.20 weights */
  geometricScore: number;
  /** Semantic compatibility score [0, 1] */
  semanticScore: number;
  /** Interactivity alignment score [0, 1] */
  interactivityScore: number;
  /** Weighted total score [0, 1] */
  totalScore: number;
}

/** Scored candidate evaluation record. */
export interface GroundedCandidateMatch {
  elementId: string;
  score: number;
  breakdown: GroundingScoreBreakdown;
}

/** Successful grounding result. */
export interface GroundingSuccessResult {
  matched: true;
  observationId: string;
  elementId: string;
  /** Normalized visual box in CSS viewport coordinates (via Phase 2F-1) */
  normalizedCssBox: CssViewportRect;
  /** Grounding confidence in [0, 1] */
  groundingConfidence: number;
  /** Detailed scoring breakdown of the winning element */
  scoreBreakdown: GroundingScoreBreakdown;
  /** All evaluated candidates ranked deterministically */
  candidates?: GroundedCandidateMatch[];
}

/** Explicit unmatched grounding result. */
export interface GroundingUnmatchedResult {
  matched: false;
  observationId?: string;
  reason: GroundingUnmatchedReason;
  /** Normalized CSS box if normalization succeeded before the failure */
  normalizedCssBox?: CssViewportRect;
  message: string;
  /** Highest score achieved among evaluated candidates, if any */
  highestScore?: number;
  /** Details of closest evaluated candidate, if any */
  closestCandidate?: GroundedCandidateMatch;
}

/** Discriminated union result for grounding. */
export type GroundingResult = GroundingSuccessResult | GroundingUnmatchedResult;

/** Optional configuration for grounding. */
export interface GroundingOptions {
  /** Minimum composite score required for a match. Default: 0.40 */
  minScoreThreshold?: number;
  /**
   * Minimum IoU for coarse overlap filter. Default: 0.05.
   * Containment threshold is fixed at 0.20.
   */
  minOverlapThreshold?: number;
  /** Whether to allow matching disabled elements. Default: false */
  allowDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_SCORE_THRESHOLD = 0.40;
const DEFAULT_MIN_OVERLAP_THRESHOLD = 0.05;
const CONTAINMENT_THRESHOLD = 0.20;
const TIE_EPSILON = 1e-6;

// ---------------------------------------------------------------------------
// Strong semantic label set (case-insensitive comparison targets)
// ---------------------------------------------------------------------------

const STRONG_SEMANTIC_LABELS = new Set([
  'button', 'link', 'textbox', 'input', 'checkbox', 'radio',
  'select', 'combobox', 'heading', 'image', 'icon'
]);

// ---------------------------------------------------------------------------
// Geometric helpers
// ---------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Returns the area of a rectangle. Returns 0 for degenerate rectangles. */
function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/** Computes the intersection rectangle of two rects, or null if they do not overlap. */
function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) {
    return null;
  }
  return { x, y, width: right - x, height: bottom - y };
}

/** Computes the bounding union rectangle of two rects. */
function boundingUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** Computes the Euclidean diagonal of a rect (used for normalizing center distance). */
function diagonal(r: Rect): number {
  return Math.sqrt(r.width * r.width + r.height * r.height);
}

/** Returns the center of a rect. */
function center(r: Rect): { cx: number; cy: number } {
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}

/** Returns true if a point is strictly inside or on the boundary of a rect. */
function isPointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height;
}

/**
 * Computes the full geometric breakdown for a visual box vs. a DOM element box.
 * Handles degenerate/zero-area cases safely without NaN or Infinity.
 */
function computeGeometry(
  visual: Rect,
  dom: Rect
): Pick<GroundingScoreBreakdown,
  | 'iou'
  | 'visualContainment'
  | 'elementContainment'
  | 'centerProximity'
  | 'isVisualCenterInsideDom'
  | 'geometricScore'
> {
  const inter = intersection(visual, dom);
  const interArea = inter ? area(inter) : 0;

  const visualArea = area(visual);
  const domArea = area(dom);
  const unionArea = visualArea + domArea - interArea;

  const iou = unionArea > 0 ? interArea / unionArea : 0;
  const visualContainment = visualArea > 0 ? interArea / visualArea : 0;
  const elementContainment = domArea > 0 ? interArea / domArea : 0;

  const unionRect = boundingUnion(visual, dom);
  const unionDiag = diagonal(unionRect);
  const vCenter = center(visual);
  const dCenter = center(dom);
  const dist = Math.sqrt(
    (vCenter.cx - dCenter.cx) ** 2 + (vCenter.cy - dCenter.cy) ** 2
  );
  const centerProximity = unionDiag > 0 ? Math.max(0, 1 - dist / unionDiag) : 1;

  const isVisualCenterInsideDom = isPointInRect(vCenter.cx, vCenter.cy, dom);

  const geometricScore = Math.min(
    1,
    Math.max(
      0,
      0.45 * iou +
      0.20 * visualContainment +
      0.15 * elementContainment +
      0.20 * centerProximity
    )
  );

  return {
    iou,
    visualContainment,
    elementContainment,
    centerProximity,
    isVisualCenterInsideDom,
    geometricScore
  };
}

// ---------------------------------------------------------------------------
// Semantic scoring
// ---------------------------------------------------------------------------

/** Normalizes a label string for comparison: lowercase, trimmed. */
function normalizeLabel(s: string): string {
  return s.toLowerCase().trim();
}

/** Strong semantic label semantic score. Returns null if label is not strong. */
function strongLabelSemanticScore(
  normalizedLabel: string,
  role: ElementRole
): number | null {
  switch (normalizedLabel) {
    case 'button':
      if (role === 'button' || role === 'menuitem' || role === 'tab') return 1.00;
      if (role === 'link') return 0.60;
      if (role === 'heading' || role === 'image' || role === 'textbox' || role === 'searchbox') return 0.10;
      return 0.10;

    case 'link':
      if (role === 'link') return 1.00;
      if (role === 'button') return 0.60;
      return 0.10;

    case 'textbox':
    case 'input':
      if (role === 'textbox' || role === 'searchbox') return 1.00;
      if (role === 'slider' || role === 'spinbutton') return 0.70;
      return 0.00;

    case 'checkbox':
      if (role === 'checkbox' || role === 'switch') return 1.00;
      return 0.10;

    case 'radio':
      if (role === 'radio') return 1.00;
      return 0.10;

    case 'select':
    case 'combobox':
      if (role === 'combobox' || role === 'listbox' || role === 'option') return 1.00;
      return 0.10;

    case 'heading':
      if (role === 'heading') return 1.00;
      return 0.10;

    case 'image':
    case 'icon':
      if (role === 'image') return 1.00;
      return 0.10;

    default:
      return null; // Not a strong label
  }
}

/** Generic interaction hint semantic score. */
function genericHintSemanticScore(
  hint: string,
  role: ElementRole,
  isInteractive: boolean
): number {
  switch (hint) {
    case 'clickable':
      if (role === 'button' || role === 'link') return 0.75;
      if (
        role === 'checkbox' || role === 'radio' || role === 'switch' ||
        role === 'tab' || role === 'menuitem'
      ) return 0.50;
      if (isInteractive) return 0.50;
      return 0.25;

    case 'input':
      if (role === 'textbox' || role === 'searchbox') return 0.75;
      return 0.25;

    case 'selectable':
      if (role === 'combobox' || role === 'listbox' || role === 'option') return 0.75;
      return 0.25;

    case 'static':
      if (
        role === 'heading' || role === 'image' || role === 'status' ||
        role === 'progressbar' || role === 'generic' || role === 'container'
      ) return 0.70;
      if (isInteractive) return 0.30;
      return 0.50;

    default:
      return 0.50;
  }
}

/**
 * Computes the semantic score for an observation label/hint against a DOM element role.
 */
function computeSemanticScore(
  observation: GroundingVisualObservation,
  role: ElementRole,
  isInteractive: boolean
): number {
  const rawLabel = observation.label ?? '';
  const normalizedLabel = normalizeLabel(rawLabel);

  // Try strong semantic label first
  if (STRONG_SEMANTIC_LABELS.has(normalizedLabel)) {
    const score = strongLabelSemanticScore(normalizedLabel, role);
    if (score !== null) return score;
  }

  // Fall through to generic hint or label treated as generic
  const hint = observation.interactionHint;
  if (hint && hint !== 'unknown' && hint !== 'scrollable') {
    return genericHintSemanticScore(hint, role, isInteractive);
  }

  // Unknown/absent or scrollable-only — neutral
  return 0.50;
}

// ---------------------------------------------------------------------------
// Interactivity scoring
// ---------------------------------------------------------------------------

/** Whether this observation cue indicates an interactive control. */
function isInteractiveCue(observation: GroundingVisualObservation): boolean {
  const label = normalizeLabel(observation.label ?? '');
  if (
    label === 'button' || label === 'link' || label === 'textbox' ||
    label === 'input' || label === 'checkbox' || label === 'radio' ||
    label === 'select' || label === 'combobox'
  ) {
    return true;
  }
  const hint = observation.interactionHint;
  return hint === 'clickable' || hint === 'input' || hint === 'selectable';
}

/** Whether this observation cue indicates static non-interactive content. */
function isStaticCue(observation: GroundingVisualObservation): boolean {
  const label = normalizeLabel(observation.label ?? '');
  if (label === 'heading' || label === 'image' || label === 'icon') return true;
  return observation.interactionHint === 'static';
}

function computeInteractivityScore(
  observation: GroundingVisualObservation,
  elementInteractive: boolean
): number {
  if (isInteractiveCue(observation)) {
    return elementInteractive ? 1.0 : 0.3;
  }
  if (isStaticCue(observation)) {
    return elementInteractive ? 0.5 : 1.0;
  }
  // Neutral
  return elementInteractive ? 0.8 : 0.5;
}

// ---------------------------------------------------------------------------
// Full score computation
// ---------------------------------------------------------------------------

function computeFullScore(
  observation: GroundingVisualObservation,
  normalizedCssBox: CssViewportRect,
  elementId: string,
  elementBounds: { x: number; y: number; width: number; height: number },
  elementRole: ElementRole,
  elementInteractive: boolean
): GroundingScoreBreakdown {
  const geo = computeGeometry(normalizedCssBox, elementBounds);
  const semanticScore = Math.min(1, Math.max(0, computeSemanticScore(observation, elementRole, elementInteractive)));
  const interactivityScore = Math.min(1, Math.max(0, computeInteractivityScore(observation, elementInteractive)));
  const totalScore = Math.min(
    1,
    Math.max(
      0,
      0.55 * geo.geometricScore +
      0.30 * semanticScore +
      0.15 * interactivityScore
    )
  );

  return {
    iou: geo.iou,
    visualContainment: geo.visualContainment,
    elementContainment: geo.elementContainment,
    centerProximity: geo.centerProximity,
    isVisualCenterInsideDom: geo.isVisualCenterInsideDom,
    geometricScore: geo.geometricScore,
    semanticScore,
    interactivityScore,
    totalScore
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isFiniteRect(r: ScreenshotPixelRect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width >= 0 &&
    r.height >= 0
  );
}

function isValidElementBounds(b: { x: number; y: number; width: number; height: number } | undefined): b is { x: number; y: number; width: number; height: number } {
  if (!b) return false;
  return (
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height) &&
    b.width > 0 &&
    b.height > 0
  );
}

// ---------------------------------------------------------------------------
// Deterministic comparator for candidate ranking
// ---------------------------------------------------------------------------

function compareCandidates(
  a: GroundedCandidateMatch & { documentIndex: number },
  b: GroundedCandidateMatch & { documentIndex: number }
): number {
  // 1. Total score descending
  const scoreDiff = b.score - a.score;
  if (Math.abs(scoreDiff) > TIE_EPSILON) return scoreDiff;

  // 2. IoU descending
  const iouDiff = b.breakdown.iou - a.breakdown.iou;
  if (Math.abs(iouDiff) > TIE_EPSILON) return iouDiff;

  // 3. Interactive first
  const aInteractive = a.breakdown.interactivityScore >= 0.75 ? 1 : 0;
  const bInteractive = b.breakdown.interactivityScore >= 0.75 ? 1 : 0;
  if (bInteractive !== aInteractive) return bInteractive - aInteractive;

  // 4. Document index ascending
  if (a.documentIndex !== b.documentIndex) return a.documentIndex - b.documentIndex;

  // 5. Element ID lexicographically ascending
  return a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Core grounding function
// ---------------------------------------------------------------------------

/**
 * Grounds a single visual observation to a DOM PageElement.
 *
 * Pure function: deterministic, side-effect free, no DOM/Chrome dependencies.
 * Input objects are never mutated.
 */
export function groundVisualObservation(
  observation: GroundingVisualObservation,
  pageRepresentation: PageRepresentation,
  coordinateSpace: CoordinateSpaceMetadata,
  options?: GroundingOptions
): GroundingResult {
  const minScoreThreshold = options?.minScoreThreshold ?? DEFAULT_MIN_SCORE_THRESHOLD;
  const minOverlapThreshold = options?.minOverlapThreshold ?? DEFAULT_MIN_OVERLAP_THRESHOLD;
  const allowDisabled = options?.allowDisabled ?? false;

  // 1. Validate observation
  if (
    !observation ||
    typeof observation.id !== 'string' ||
    !Number.isFinite(observation.confidence) &&
      typeof observation.confidence !== 'number' ||
    !observation.boundingBox ||
    !isFiniteRect(observation.boundingBox)
  ) {
    return {
      matched: false,
      observationId: typeof observation?.id === 'string' ? observation.id : undefined,
      reason: 'INVALID_OBSERVATION',
      message: 'Observation has invalid or missing bounding box or confidence'
    };
  }

  // 2. Clamp vision confidence
  const clampedVisionConfidence = Math.max(
    0,
    Math.min(
      1,
      Number.isFinite(observation.confidence) ? observation.confidence : 0
    )
  );

  // 3. Coordinate normalization via Phase 2F-1
  let normalizedCssBox: CssViewportRect;
  try {
    normalizedCssBox = screenshotPixelsToCssRect(observation.boundingBox, coordinateSpace);
  } catch {
    return {
      matched: false,
      observationId: observation.id,
      reason: 'INVALID_OBSERVATION',
      message: 'Coordinate normalization failed: invalid coordinate space metadata'
    };
  }

  // 4. Out-of-bounds check: only if zero/negative area OR completely outside viewport
  const vw = coordinateSpace.viewportWidth;
  const vh = coordinateSpace.viewportHeight;
  const isZeroArea = normalizedCssBox.width <= 0 || normalizedCssBox.height <= 0;
  const isCompletelyOutside =
    normalizedCssBox.x + normalizedCssBox.width <= 0 ||
    normalizedCssBox.x >= vw ||
    normalizedCssBox.y + normalizedCssBox.height <= 0 ||
    normalizedCssBox.y >= vh;

  if (isZeroArea || isCompletelyOutside) {
    return {
      matched: false,
      observationId: observation.id,
      reason: 'OUT_OF_BOUNDS',
      normalizedCssBox,
      message: isZeroArea
        ? 'Visual observation has zero or negative area'
        : 'Visual observation is completely outside the CSS viewport'
    };
  }

  // 5. No elements at all
  if (pageRepresentation.elements.length === 0) {
    return {
      matched: false,
      observationId: observation.id,
      reason: 'NO_DOM_CANDIDATES',
      normalizedCssBox,
      message: 'No DOM elements in the page representation'
    };
  }

  // 6. Filter and score candidates
  type RankedCandidate = GroundedCandidateMatch & { documentIndex: number };
  const evaluated: RankedCandidate[] = [];
  let hadCandidates = false;

  for (let i = 0; i < pageRepresentation.elements.length; i++) {
    const element = pageRepresentation.elements[i]!;

    // Valid bounds required
    if (!isValidElementBounds(element.bounds)) continue;

    // Visibility filter
    if (element.state?.visible === false) continue;

    // Disabled filter
    if (!allowDisabled) {
      if (element.state?.disabled === true || element.state?.enabled === false) continue;
    }

    hadCandidates = true;

    // Coarse overlap filter
    const geo = computeGeometry(normalizedCssBox, element.bounds);
    const passesCoarseOverlap =
      geo.iou >= minOverlapThreshold ||
      geo.visualContainment >= CONTAINMENT_THRESHOLD ||
      geo.elementContainment >= CONTAINMENT_THRESHOLD;

    if (!passesCoarseOverlap) continue;

    // Full scoring
    const elementRole = element.role ?? 'unknown';
    const elementInteractive = element.interactive === true;

    const breakdown = computeFullScore(
      observation,
      normalizedCssBox,
      element.id,
      element.bounds,
      elementRole,
      elementInteractive
    );

    evaluated.push({
      elementId: element.id,
      score: breakdown.totalScore,
      breakdown,
      documentIndex: i
    });
  }

  // 7. No overlapping candidates
  if (evaluated.length === 0) {
    if (!hadCandidates) {
      return {
        matched: false,
        observationId: observation.id,
        reason: 'NO_DOM_CANDIDATES',
        normalizedCssBox,
        message: 'No eligible DOM elements (all filtered by bounds/visibility/disabled)'
      };
    }
    return {
      matched: false,
      observationId: observation.id,
      reason: 'NO_OVERLAPPING_CANDIDATES',
      normalizedCssBox,
      message: 'No DOM elements have sufficient geometric overlap with the visual observation'
    };
  }

  // 8. Deterministic sort
  const sorted = [...evaluated].sort(compareCandidates);
  const winner = sorted[0]!;

  // 9. Below threshold
  if (winner.score < minScoreThreshold) {
    return {
      matched: false,
      observationId: observation.id,
      reason: 'BELOW_SCORE_THRESHOLD',
      normalizedCssBox,
      message: `Best candidate score ${winner.score.toFixed(4)} is below threshold ${minScoreThreshold}`,
      highestScore: winner.score,
      closestCandidate: { elementId: winner.elementId, score: winner.score, breakdown: winner.breakdown }
    };
  }

  // 10. Grounding confidence: guaranteed [0,1]
  const groundingConfidence = Math.min(
    1,
    Math.max(0, winner.score * (0.80 + 0.20 * clampedVisionConfidence))
  );

  const candidates: GroundedCandidateMatch[] = sorted.map(({ elementId, score, breakdown }) => ({
    elementId,
    score,
    breakdown
  }));

  return {
    matched: true,
    observationId: observation.id,
    elementId: winner.elementId,
    normalizedCssBox,
    groundingConfidence,
    scoreBreakdown: winner.breakdown,
    candidates
  };
}

/**
 * Grounds multiple visual observations in batch.
 *
 * Preserves input order and returns an array of the same length.
 */
export function groundVisualObservations(
  observations: GroundingVisualObservation[],
  pageRepresentation: PageRepresentation,
  coordinateSpace: CoordinateSpaceMetadata,
  options?: GroundingOptions
): GroundingResult[] {
  return observations.map((obs) =>
    groundVisualObservation(obs, pageRepresentation, coordinateSpace, options)
  );
}
