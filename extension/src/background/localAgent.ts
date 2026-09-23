/**
 * Phase 5A — Local AI Agent / Task Understanding Integration.
 *
 * Connects local LLM inference infrastructure to the authoritative Phase 3A
 * Planner architecture by implementing the PlannerDriver contract.
 *
 * Invariants:
 * - Implements PlannerDriver; delegates ALL validation, coordinate resolution,
 *   role compatibility, and IntendedAction creation to Phase 3A planNextStep().
 * - Reasoning layer only: NO browser execution, NO clicks, NO typing, NO DOM mutation (Phase 6).
 * - NO autonomous loops, NO SEE->THINK->ACT loops, NO recovery loops (Phase 7).
 * - Strictly local LLM inference: connects only to local llama-server (default 127.0.0.1:8080).
 * - Privacy-first: model receives only an allowlisted, sanitized DTO.
 * - Never forwards raw DOM, passwords, input values, cookies, storage, or screenshot bytes.
 * - Single atomic action per cycle: exactly one of 'click' | 'type' | 'focus', or 'COMPLETED'.
 * - Strict JSON advisory response parsing; rejects prose, malformed JSON, and out-of-bounds values.
 */

import type { ActionType } from '../shared/actions.js';
import type { PageElement } from '../shared/types.js';
import {
  type AdvisoryProposalResult,
  type AdvisoryStepProposal,
  type PlannerDriver,
  type PlannerInput,
  type PlannerResult,
  planNextStep
} from '../shared/planner.js';

import { stripMarkdownFences } from './llamaVisionAdapter.js';
import { redactText, sanitizeUrl, REDACTION_TOKENS } from '../privacy/index.js';

// Re-export authoritative planner contracts for consumers
export type {
  AdvisoryProposalResult,
  AdvisoryStepProposal,
  PlannerDriver,
  PlannerInput,
  PlannerResult
};
export { planNextStep };

// ---------------------------------------------------------------------------
// 1. Allowlisted Model-Facing DTO (Privacy Boundary)
// ---------------------------------------------------------------------------

/**
 * Safe, allowlisted representation of a candidate target for LLM consumption.
 * Contains NO arbitrary DOM attributes, credentials, or raw input values.
 */
export interface ModelCandidateTarget {
  readonly elementId: string;
  readonly role?: string;
  readonly accessibleName?: string;
  readonly visibleText?: string;
  readonly confidence: number;
  /** Whether the element currently has focus (propagated from PageElement.state.focused). */
  readonly focused?: boolean;
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * Safe, allowlisted history step for LLM consumption.
 * Contains NO typed text or PII — structural summary only.
 * The typed text from a previous TypeAction is intentionally omitted to preserve the privacy boundary.
 */
export interface ModelHistoryStep {
  readonly stepIndex: number;
  readonly actionType: 'click' | 'type' | 'focus';
  readonly targetElementId: string;
  readonly targetRole?: string;
  readonly perceivedOutcome?: 'success' | 'no_change' | 'error';
}

/**
 * Safe, allowlisted page metadata for LLM consumption.
 */
export interface ModelPageContext {
  readonly title?: string;
  readonly url?: string;
}

/**
 * Explicit model-facing DTO constructed from PlannerInput.
 * Blind serialization of raw structures is prohibited.
 */
export interface ModelPromptPayload {
  readonly goal: {
    readonly id: string;
    readonly description: string;
    readonly intent?: string;
    readonly targetHint?: string;
    readonly parameters?: Record<string, string>;
  };
  readonly page: ModelPageContext;
  readonly availableTargets: readonly ModelCandidateTarget[];
  readonly stepIndex?: number;
  /** Structural action history for the current goal. No typed text is included. */
  readonly history?: readonly ModelHistoryStep[];
}

// ---------------------------------------------------------------------------
// 2. Prompt Compaction
// ---------------------------------------------------------------------------

/**
 * Maximum number of candidate targets sent to the model per prompt.
 *
 * Keeps the user-prompt within the default llama-server context window
 * (-c 4096) even for large pages with 100+ interactive elements.
 * Interactive elements are ranked by search-relevance before the cap is applied,
 * so high-priority targets (textboxes, searchboxes, buttons) are always included.
 */
export const MAX_MODEL_CANDIDATES = 20;

/**
 * Roles that are most likely to be the primary target for common tasks.
 * Listed in descending priority order.
 */
const SEARCH_ROLE_PRIORITY: ReadonlyMap<string, number> = new Map([
  ['searchbox', 10],
  ['textbox', 9],
  ['combobox', 8],
  ['button', 7],
  ['link', 6],
  ['checkbox', 5],
  ['radio', 4],
  ['select', 3],
  ['option', 2]
]);

/**
 * Returns a relevance score for a candidate in the context of a goal description.
 * Higher is more relevant. Pure function: no side-effects, no privacy data emitted.
 *
 * Scoring:
 * - Role priority bonus  (0–10)
 * - Goal-keyword match in label (+5 per match, capped)
 * - accessibleName presence bonus (+2)
 */
function scoreCandidateRelevance(
  role: string | undefined,
  accessibleName: string | undefined,
  visibleText: string | undefined,
  goalKeywords: readonly string[]
): number {
  let score = SEARCH_ROLE_PRIORITY.get(role ?? '') ?? 0;

  if (accessibleName !== undefined) score += 2;

  const labelText = ((accessibleName ?? '') + ' ' + (visibleText ?? '')).toLowerCase();
  let keywordHits = 0;
  for (const kw of goalKeywords) {
    if (kw.length > 2 && labelText.includes(kw)) {
      keywordHits++;
    }
  }
  score += Math.min(keywordHits * 5, 15);

  return score;
}

/**
 * Compacts and ranks candidate targets before model serialization.
 *
 * 1. Ranks by `scoreCandidateRelevance` (role priority + goal-keyword hits).
 * 2. Caps the list at `MAX_MODEL_CANDIDATES`.
 * 3. Omits `bounds` from the model-facing DTO (the model needs elementId, not pixels).
 *
 * Privacy: this function operates AFTER sanitization — it never receives or
 * forwards raw/unsanitized text. It only reorders and truncates the already-sanitized list.
 *
 * @param candidates  Already-sanitized ModelCandidateTarget[] (may include bounds).
 * @param goalDescription  Sanitized goal description used for keyword scoring.
 * @param limit  Maximum number of candidates to return. Default: MAX_MODEL_CANDIDATES.
 */
export function compactCandidatesForModel(
  candidates: readonly ModelCandidateTarget[],
  goalDescription: string,
  limit: number = MAX_MODEL_CANDIDATES
): ModelCandidateTarget[] {
  if (candidates.length === 0) return [];

  // Tokenize the sanitized goal description into keywords
  const goalKeywords = goalDescription
    .toLowerCase()
    .split(/[\s,;.!?]+/)
    .filter(w => w.length > 2);

  // Score each candidate (bounds intentionally excluded from output).
  // Focused elements receive a +8 bonus so the model sees them near the top
  // when it is already on a step that requires typing.
  const scored = candidates.map(c => ({
    candidate: c,
    score: scoreCandidateRelevance(c.role, c.accessibleName, c.visibleText, goalKeywords)
          + (c.focused === true ? 8 : 0)
  }));

  // Stable descending sort (preserve original order among equal-scored candidates)
  scored.sort((a, b) => b.score - a.score);

  // Cap and strip bounds from model-facing DTO; preserve focused flag.
  return scored.slice(0, limit).map(({ candidate: c }) => ({
    elementId: c.elementId,
    ...(c.role !== undefined ? { role: c.role } : {}),
    ...(c.accessibleName !== undefined ? { accessibleName: c.accessibleName } : {}),
    ...(c.visibleText !== undefined ? { visibleText: c.visibleText } : {}),
    ...(c.focused === true ? { focused: true } : {}),
    confidence: c.confidence
    // bounds intentionally omitted — the executor resolves the element by id,
    // not by pixel coordinates. Omitting bounds saves ~40 chars/candidate.
  }));
}

// ---------------------------------------------------------------------------
// 3. System Instruction & Prompt Construction
// ---------------------------------------------------------------------------

export const LOCAL_AGENT_SYSTEM_PROMPT =
  'You are an on-device browser-agent planning assistant for NexVision. Given a user goal and sanitized page context, select exactly ONE next atomic action.\n' +
  'Strict rules:\n' +
  '1. You may ONLY select an element from the provided availableTargets by its elementId.\n' +
  '2. Supported action types are ONLY: "click", "type", "focus".\n' +
  '3. NEVER invent element IDs or synthesize coordinates.\n' +
  '4. Do NOT request or expose private or sensitive values.\n' +
  '5. If the goal is already satisfied, return a COMPLETED response.\n' +
  '6. Exactly ONE action per response.\n' +
  '7. Return strictly valid JSON only. Do NOT output markdown code blocks or prose outside JSON.\n\n' +
  'Action selection guidance:\n' +
  '8. Use "click" for buttons, links, and initial element activation.\n' +
  '9. Use "type" for entering text into textbox, searchbox, and input elements. Typed text must come directly from the user task, not from private profile data or guessed information.\n' +
  '10. If a relevant input element is already focused (focused:true) or was successfully activated in a previous step (see history), do NOT repeat "click" — use "type" immediately when text entry is the next task requirement.\n' +
  '11. Set pressEnter:true in payload when submitting a search query is appropriate.\n' +
  '12. Do not repeat an action that already succeeded in history unless current page state provides clear evidence that repeating it is necessary.\n' +
  '13. When typing a COMPLETE search query or replacement value into an input, ALWAYS type the ENTIRE intended text as a single "type" action — do NOT split the text across multiple steps. For example, to search for "laptops under 50000", type the full string in one action, not in parts.\n' +
  '14. When typing into an input that may already contain text (e.g. after a previous "type" action on the same element, or when the input is focused), set clearFirst:true in the payload to replace the existing content rather than append to it.\n\n' +
  'Schema for action:\n' +
  '{"type": "ACTION", "targetElementId": "<id>", "actionType": "click"|"type"|"focus", "payload": {"text": "...", "clearFirst": true, "pressEnter": true}, "rationale": "<brief reason>", "estimatedProgress": 0.5}\n\n' +
  'Schema for completion:\n' +
  '{"type": "COMPLETED", "rationale": "<brief reason>"}';

/**
 * Small deterministic helper specifically targeting obvious credential/bearer/token patterns
 * in free-form text. Replaces obvious secrets with REDACTION_TOKENS.AUTH_TOKEN.
 * Does NOT build a generic PII classifier.
 */
const OBVIOUS_CREDENTIAL_PATTERNS = [
  // Bearer tokens (e.g. "Bearer eyJ...", "bearer secret-tok-12345")
  /bearer\s+[a-zA-Z0-9_\-\.+=/]+/gi,
  // Obvious token prefixes (e.g. sk-..., ghp_..., gho_..., glpat-...)
  /\b(?:sk-[a-zA-Z0-9]{20,}|gh[pousr]_[a-zA-Z0-9]{30,}|glpat-[a-zA-Z0-9_\-]{20,})\b/g,
  // JWT tokens (3 dot-separated base64 segments)
  /\beyJ[a-zA-Z0-9_\-]{8,}\.eyJ[a-zA-Z0-9_\-]{8,}\.[a-zA-Z0-9_\-]{8,}\b/g,
  // Explicit key-value assignments for sensitive credentials (e.g. api_key=..., auth_token: ...)
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|password|passwd)\s*[:=]\s*['"]?[a-zA-Z0-9_\-\.+=/]{6,}['"]?/gi,
  // Session/token query-like patterns
  /\b(?:session_?id|access_?token|auth_?token|jwt)=[a-zA-Z0-9_\-\.+=/]{8,}\b/gi
];

/**
 * Deterministically redacts obvious bearer/auth/token credentials from text.
 */
export function redactObviousCredentials(text: string): string {
  let result = text;
  for (const pattern of OBVIOUS_CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, REDACTION_TOKENS.AUTH_TOKEN);
  }
  return result;
}

/**
 * Sanitizes free-form text:
 * 1. Uses existing privacy engine redactText() (emails, validated Luhn cards, ITU-T phones).
 * 2. Uses deterministic credential/token helper for obvious auth/bearer secrets.
 */
export function sanitizeFreeFormText(text: string | undefined): string | undefined {
  if (text === undefined || text === null || text === '') {
    return text;
  }
  const redacted = redactText(text) ?? text;
  return redactObviousCredentials(redacted);
}

/**
 * Checks whether a model-generated type-action text is safe to use.
 *
 * A value is safe when:
 * - It is a semantic profile reference (e.g. 'profile.email', 'profile.firstName',
 *   'profile.phone'). These are unresolved pointers, never raw PII.
 * - Passing the text through sanitizeFreeFormText() does NOT alter it, meaning the
 *   existing privacy engine and credential redactor found nothing to redact.
 *
 * A value is unsafe (returns false) when:
 * - The privacy sanitizer would alter the text (e.g. it contains a raw email address,
 *   phone number, Luhn-valid card number, bearer token, or API key).
 *
 * This is deliberately narrow: it does NOT build a second general-purpose PII classifier.
 * It reuses the authoritative sanitizeFreeFormText() already used for model input.
 */
export function isSafeTypeActionText(text: string): boolean {
  // Semantic profile references are always safe (unresolved vault pointers)
  if (isSemanticProfileReference(text.trim())) {
    return true;
  }
  // Safe when sanitization leaves the text unchanged
  const sanitized = sanitizeFreeFormText(text);
  return sanitized === text;
}

/**
 * Sensitive goal parameter keys per Requirement 3:
 * - password, passwd, secret, token, auth, credential, cookie
 * - card, cvv, cvc, email, phone, telephone
 * - name, firstName, lastName, address, street, postal, zip
 */
const SENSITIVE_PARAM_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'auth',
  'credential',
  'cookie',
  'card',
  'cvv',
  'cvc',
  'email',
  'phone',
  'telephone',
  'name',
  'firstname',
  'lastname',
  'address',
  'street',
  'postal',
  'zip'
]);

/**
 * Identifies sensitive parameter keys.
 */
export function isSensitiveParameterKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  const lower = key.trim().toLowerCase();
  if (SENSITIVE_PARAM_KEYS.has(lower)) {
    return true;
  }
  // Strip non-alphanumeric characters (e.g. first_name -> firstname, zip-code -> zipcode)
  const alphaOnly = lower.replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_PARAM_KEYS.has(alphaOnly)) {
    return true;
  }
  // Check common compound patterns
  return (
    /(?:^|[_\-.])(?:password|passwd|secret|token|auth|credential|cookie|card|cvv|cvc|email|phone|telephone|firstname|lastname|address|street|postal|zip)(?:[_\-.]|$)/i.test(lower) ||
    /^(?:user_?name|full_?name|first_?name|last_?name|phone_?number|zip_?code|postal_?code|email_?address|card_?number|credit_?card|billing_?address|shipping_?address)$/i.test(lower) ||
    /(?:password|passwd|secret|credential|cookie|cvv|cvc)/i.test(lower)
  );
}

/**
 * Checks if a value is a semantic profile reference (e.g., 'profile.email', 'profile.firstName').
 * Semantic profile references represent unresolved vault pointers rather than raw PII.
 */
export function isSemanticProfileReference(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return /^profile\.[a-zA-Z0-9_.-]+$/i.test(trimmed);
}

/**
 * Filters goal parameters to ensure they are privacy-safe.
 * - Sensitive parameter keys with raw values are NOT copied into the model-facing payload.
 * - Semantic profile references (e.g. 'profile.email', 'profile.firstName', 'profile.phone') are strictly preserved.
 * - Non-sensitive parameter values are sanitized using redactText() and credential redaction.
 * - Recursively handles simple JSON-compatible objects if present.
 */
export function filterSafeGoalParameters(
  params?: Record<string, unknown>
): Record<string, string> | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }

  const safeParams: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(params)) {
    if (typeof key !== 'string') {
      continue;
    }

    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();

      // Semantic profile references (e.g. 'profile.email', 'profile.firstName') are strictly preserved
      if (isSemanticProfileReference(trimmed)) {
        safeParams[key] = trimmed;
        continue;
      }

      // Sensitive parameter keys must NOT be copied into the model-facing payload
      if (isSensitiveParameterKey(key)) {
        continue;
      }

      // Non-sensitive parameter keys: redact free-form PII / credentials
      const sanitized = sanitizeFreeFormText(trimmed);
      if (sanitized !== undefined && sanitized !== '') {
        safeParams[key] = sanitized;
      }
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      if (isSensitiveParameterKey(key)) {
        continue;
      }
      safeParams[key] = String(rawValue);
    } else if (typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)) {
      if (isSensitiveParameterKey(key)) {
        continue;
      }
      const nestedSafe = filterSafeGoalParameters(rawValue as Record<string, unknown>);
      if (nestedSafe && Object.keys(nestedSafe).length > 0) {
        safeParams[key] = JSON.stringify(nestedSafe);
      }
    }
  }

  return Object.keys(safeParams).length > 0 ? safeParams : undefined;
}

/**
 * Builds the allowlisted model-facing DTO from PlannerInput.
 * Deterministic: preserves candidate ordering and allowlists safe fields only.
 * Sanitizes all model-facing free-form text (goal description, targetHint, page title,
 * page URL via sanitizeUrl, and candidate accessibleName / visibleText).
 */
export function buildModelPromptPayload(input: PlannerInput): ModelPromptPayload {
  const pageRep = input.context.page;

  // Build element lookup map for enriching candidate targets
  const elementMap = new Map<string, PageElement>();
  if (Array.isArray(pageRep.elements)) {
    for (const el of pageRep.elements) {
      if (el && typeof el.id === 'string') {
        elementMap.set(el.id, el);
      }
    }
  }

  // Allowlisted candidate targets (preserves input order deterministically)
  const candidateTargets: ModelCandidateTarget[] = [];
  for (const target of input.context.availableTargets) {
    if (!target || typeof target.elementId !== 'string') {
      continue;
    }

    const matchedElement = elementMap.get(target.elementId);
    const role = target.role || matchedElement?.role;
    const rawAccessibleName = matchedElement?.accessibleName;

    // Check if element could contain sensitive user input
    const isPassword =
      matchedElement?.inputType?.toLowerCase() === 'password' ||
      matchedElement?.role?.toLowerCase() === 'password' ||
      target.role?.toLowerCase() === 'password';

    const isInputOrTextarea =
      isPassword ||
      matchedElement?.inputType?.toLowerCase() === 'hidden' ||
      matchedElement?.tagName?.toLowerCase() === 'input' ||
      matchedElement?.tagName?.toLowerCase() === 'textarea';

    // Never forward visibleText for password or input/textarea elements
    const rawVisibleText = isInputOrTextarea ? undefined : matchedElement?.visibleText;

    // Sanitize accessibleName and visibleText with privacy sanitizer
    const accessibleName =
      rawAccessibleName !== undefined && rawAccessibleName.trim() !== ''
        ? sanitizeFreeFormText(rawAccessibleName.trim())
        : undefined;

    const visibleText =
      rawVisibleText !== undefined && rawVisibleText.trim() !== ''
        ? sanitizeFreeFormText(rawVisibleText.trim())
        : undefined;

    candidateTargets.push({
      elementId: target.elementId,
      ...(role !== undefined ? { role } : {}),
      ...(accessibleName !== undefined ? { accessibleName } : {}),
      ...(visibleText !== undefined ? { visibleText } : {}),
      confidence: target.confidence,
      // Propagate focus state so the model can skip redundant click→focus steps
      ...(matchedElement?.state?.focused === true ? { focused: true } : {}),
      bounds: {
        x: target.viewportBounds.x,
        y: target.viewportBounds.y,
        width: target.viewportBounds.width,
        height: target.viewportBounds.height
      }
    });
  }

  const safeParameters = filterSafeGoalParameters(input.goal.parameters);

  // Build safe history: structural summary only, typed text is never included.
  // This respects the privacy boundary while giving the model enough context
  // to avoid repeating the same click on a textbox it has already interacted with.
  const safeHistory: ModelHistoryStep[] = [];
  if (Array.isArray(input.history)) {
    for (const h of input.history) {
      if (!h || typeof h.stepIndex !== 'number') continue;
      safeHistory.push({
        stepIndex: h.stepIndex,
        actionType: h.action.type,
        targetElementId: h.action.target.elementId,
        ...(h.action.target.role !== undefined ? { targetRole: h.action.target.role } : {}),
        ...(h.perceivedOutcome !== undefined ? { perceivedOutcome: h.perceivedOutcome } : {})
      });
    }
  }

  // Sanitize goal description and targetHint
  const sanitizedDescription = sanitizeFreeFormText(input.goal.description) || '';
  const sanitizedTargetHint =
    input.goal.targetHint !== undefined
      ? sanitizeFreeFormText(input.goal.targetHint)
      : undefined;

  // Sanitize page title and URL
  const sanitizedTitle =
    pageRep.metadata?.title !== undefined
      ? sanitizeFreeFormText(pageRep.metadata.title)
      : undefined;

  const sanitizedUrlValue =
    pageRep.metadata?.url !== undefined
      ? sanitizeUrl(pageRep.metadata.url)
      : undefined;

  return {
    goal: {
      id: input.goal.id,
      description: sanitizedDescription,
      ...(input.goal.intent !== undefined ? { intent: input.goal.intent } : {}),
      ...(sanitizedTargetHint !== undefined ? { targetHint: sanitizedTargetHint } : {}),
      ...(safeParameters !== undefined ? { parameters: safeParameters } : {})
    },
    page: {
      ...(sanitizedTitle !== undefined ? { title: sanitizedTitle } : {}),
      ...(sanitizedUrlValue !== undefined ? { url: sanitizedUrlValue } : {})
    },
    availableTargets: candidateTargets,
    ...(input.context.stepIndex !== undefined ? { stepIndex: input.context.stepIndex } : {}),
    ...(safeHistory.length > 0 ? { history: safeHistory } : {})
  };
}

/**
 * Serializes the user prompt deterministically into JSON format.
 *
 * The candidates list is compacted (ranked + capped at MAX_MODEL_CANDIDATES,
 * bounds omitted) before serialization so that the prompt always fits within
 * the default llama-server context window (-c 4096).
 */
export function buildAgentUserPrompt(input: PlannerInput): string {
  const payload = buildModelPromptPayload(input);
  // Compact the already-sanitized candidate list before serialization
  const compacted: ModelPromptPayload = {
    ...payload,
    availableTargets: compactCandidatesForModel(
      payload.availableTargets,
      payload.goal.description
    )
  };
  return JSON.stringify(compacted);
}

// ---------------------------------------------------------------------------
// 3. Strict Output Parsing into AdvisoryProposalResult
// ---------------------------------------------------------------------------

const SUPPORTED_ACTION_TYPES: readonly ActionType[] = ['click', 'type', 'focus'];

/**
 * Normalizes lower-level or slightly divergent model action proposals into the
 * canonical ACTION / COMPLETED schema before strict validation.
 *
 * Supported normalizations:
 * 1. Lowercase/simple action type as discriminator:
 *    {"type": "click"|"type"|"focus", ...} -> {"type": "ACTION", "actionType": "click"|"type"|"focus", ...}
 * 2. Fallback discriminator from "action" or "actionType" if "type" is omitted.
 * 3. Fallback target element ID from "elementId" or "target" if "targetElementId" is omitted.
 * 4. Root-level "text" normalized into "payload.text" for type actions.
 * 5. Case normalization for action types ("CLICK" -> "click").
 *
 * Invariants:
 * - Never invents element IDs, coordinates, or actions.
 * - Unknown or invalid proposal types are preserved so standard validation rejects them.
 */
export function normalizeModelProposal(
  rawObj: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...rawObj };

  // Strict: type discriminator must be present as a string
  if (typeof normalized['type'] !== 'string') {
    return normalized;
  }

  const rawType = normalized['type'].trim();
  if (rawType === '') {
    return normalized;
  }

  const upperType = rawType.toUpperCase();
  const lowerType = rawType.toLowerCase();

  // Canonical COMPLETED
  if (upperType === 'COMPLETED') {
    normalized['type'] = 'COMPLETED';
    return normalized;
  }

  // Canonical ACTION or lower-level action ("click" | "type" | "focus")
  const isDirectActionType = (SUPPORTED_ACTION_TYPES as readonly string[]).includes(lowerType);
  const isCanonicalAction = upperType === 'ACTION';

  if (isDirectActionType || isCanonicalAction) {
    normalized['type'] = 'ACTION';

    // Resolve actionType
    if (isDirectActionType) {
      normalized['actionType'] = lowerType;
    } else if (typeof normalized['actionType'] === 'string') {
      const lowerActionType = normalized['actionType'].trim().toLowerCase();
      if ((SUPPORTED_ACTION_TYPES as readonly string[]).includes(lowerActionType)) {
        normalized['actionType'] = lowerActionType;
      }
    } else if (typeof normalized['action'] === 'string') {
      const lowerAction = normalized['action'].trim().toLowerCase();
      if ((SUPPORTED_ACTION_TYPES as readonly string[]).includes(lowerAction)) {
        normalized['actionType'] = lowerAction;
      }
    }

    // Resolve targetElementId (preserve exact ID without inventing)
    if (
      typeof normalized['targetElementId'] !== 'string' ||
      normalized['targetElementId'].trim() === ''
    ) {
      if (
        typeof normalized['elementId'] === 'string' &&
        normalized['elementId'].trim() !== ''
      ) {
        normalized['targetElementId'] = normalized['elementId'].trim();
      } else if (
        typeof normalized['target'] === 'string' &&
        normalized['target'].trim() !== ''
      ) {
        normalized['targetElementId'] = normalized['target'].trim();
      }
    }

    // Resolve payload for "type" action
    if (normalized['actionType'] === 'type') {
      const normalizeBoolean = (val: unknown): boolean | undefined => {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'string') {
          const lower = val.trim().toLowerCase();
          if (lower === 'true') return true;
          if (lower === 'false') return false;
        }
        return undefined;
      };

      if (
        (typeof normalized['payload'] !== 'object' || normalized['payload'] === null) &&
        typeof normalized['text'] === 'string'
      ) {
        const clearFirst = normalizeBoolean(normalized['clearFirst']);
        const pressEnter = normalizeBoolean(normalized['pressEnter']);
        normalized['payload'] = {
          text: normalized['text'],
          ...(clearFirst !== undefined ? { clearFirst } : {}),
          ...(pressEnter !== undefined ? { pressEnter } : {})
        };
      } else if (typeof normalized['payload'] === 'object' && normalized['payload'] !== null) {
        const payloadObj = { ...(normalized['payload'] as Record<string, unknown>) };
        const pressEnterVal = payloadObj['pressEnter'] !== undefined
          ? payloadObj['pressEnter']
          : normalized['pressEnter'];
        const normalizedPressEnter = normalizeBoolean(pressEnterVal);
        if (normalizedPressEnter !== undefined) {
          payloadObj['pressEnter'] = normalizedPressEnter;
        }

        const clearFirstVal = payloadObj['clearFirst'] !== undefined
          ? payloadObj['clearFirst']
          : normalized['clearFirst'];
        const normalizedClearFirst = normalizeBoolean(clearFirstVal);
        if (normalizedClearFirst !== undefined) {
          payloadObj['clearFirst'] = normalizedClearFirst;
        }

        normalized['payload'] = payloadObj;
      }
    }

    // Fallback rationale from summary/reason if rationale is missing
    if (
      typeof normalized['rationale'] !== 'string' ||
      normalized['rationale'].trim() === ''
    ) {
      if (
        typeof normalized['summary'] === 'string' &&
        normalized['summary'].trim() !== ''
      ) {
        normalized['rationale'] = normalized['summary'].trim();
      } else if (
        typeof normalized['reason'] === 'string' &&
        normalized['reason'].trim() !== ''
      ) {
        normalized['rationale'] = normalized['reason'].trim();
      }
    }

    // Parse numeric estimatedProgress if supplied as valid numeric string
    if (typeof normalized['estimatedProgress'] === 'string') {
      const parsedNum = Number(normalized['estimatedProgress']);
      if (Number.isFinite(parsedNum) && parsedNum >= 0 && parsedNum <= 1) {
        normalized['estimatedProgress'] = parsedNum;
      }
    }

    return normalized;
  }

  // Preserve raw type so parseAdvisoryResponse produces standard error message
  normalized['type'] = rawType;
  return normalized;
}

/**
 * Scans a string for balanced top-level curly-brace candidate substrings `{ ... }`.
 * Tracks string literals (including escaped quotes) so that braces inside strings
 * do not alter object depth.
 */
export function findTopLevelJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let startIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (char === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          candidates.push(text.slice(startIndex, i + 1));
          startIndex = -1;
        }
      }
    }
  }

  return candidates;
}

/**
 * Safely extracts a single JSON object from raw model output when direct parsing fails.
 *
 * Supports:
 * - Markdown code fences surrounded by conversational preamble or notes
 * - Raw JSON objects embedded in conversational preamble or wrapper text
 *
 * Invariants:
 * - Deterministic and safe.
 * - Rejects plain prose.
 * - Rejects malformed or truncated JSON (never guesses missing fields or closing braces).
 * - Rejects ambiguous responses containing multiple distinct valid JSON objects.
 * - Returns null if a single valid JSON object cannot be extracted.
 */
export function extractSingleJsonObject(raw: string): Record<string, unknown> | null {
  // Strategy 1: Check for markdown code fences
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  const fenceMatches = [...raw.matchAll(fenceRegex)];

  if (fenceMatches.length > 0) {
    const validFenceObjects: Record<string, unknown>[] = [];
    for (const match of fenceMatches) {
      const inner = match[1].trim();
      try {
        const parsed = JSON.parse(inner);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          validFenceObjects.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Content within this fence is not valid JSON
      }
    }

    if (validFenceObjects.length === 1) {
      return validFenceObjects[0];
    }
    if (validFenceObjects.length > 1) {
      // Ambiguous multiple fenced JSON objects
      return null;
    }
  }

  // Strategy 2: Scan for top-level balanced curly-brace candidate substrings
  const candidates = findTopLevelJsonObjectCandidates(raw);
  const validObjects: Record<string, unknown>[] = [];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        validObjects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Candidate substring is not valid JSON
    }
  }

  // Exactly one valid JSON object must be found
  if (validObjects.length === 1) {
    return validObjects[0];
  }

  return null;
}

/**
 * Strictly parses and validates raw model text output into an AdvisoryProposalResult.
 * Rejects prose, missing types, invalid action types, out-of-range numbers, and malformed payloads.
 * Safely extracts a single JSON object if wrapped in markdown fences or known preamble/wrapper text.
 */
export function parseAdvisoryResponse(rawContent: string): AdvisoryProposalResult {
  if (typeof rawContent !== 'string' || rawContent.trim() === '') {
    return {
      status: 'FAILED',
      reason: 'Model returned empty or non-string response'
    };
  }

  // Strip code fences if present (per local llama-server JSON convention)
  const cleaned = stripMarkdownFences(rawContent);

  let parsed: unknown;
  let directParseSucceeded = false;
  try {
    parsed = JSON.parse(cleaned);
    directParseSucceeded = true;
  } catch {
    // Direct parse failed; attempt safe single JSON object extraction
  }

  if (directParseSucceeded) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        status: 'FAILED',
        reason: 'Model output must be a non-null JSON object'
      };
    }
  } else {
    const extracted = extractSingleJsonObject(rawContent);
    if (!extracted) {
      return {
        status: 'FAILED',
        reason: 'Failed to parse model output as valid JSON'
      };
    }
    parsed = extracted;
  }

  const obj = normalizeModelProposal(parsed as Record<string, unknown>);

  // 1. Validate type discriminator
  if (typeof obj['type'] !== 'string') {
    return {
      status: 'FAILED',
      reason: 'Model response missing required "type" property'
    };
  }

  const type = obj['type'].trim();

  // 2. Handle COMPLETED
  if (type === 'COMPLETED') {
    const summary =
      typeof obj['rationale'] === 'string' && obj['rationale'].trim() !== ''
        ? obj['rationale'].trim()
        : typeof obj['summary'] === 'string' && obj['summary'].trim() !== ''
          ? obj['summary'].trim()
          : 'Goal completed according to model reasoning';

    return {
      status: 'COMPLETED',
      summary
    };
  }

  // 3. Handle ACTION
  if (type === 'ACTION') {
    // Validate targetElementId
    if (
      typeof obj['targetElementId'] !== 'string' ||
      obj['targetElementId'].trim() === ''
    ) {
      return {
        status: 'FAILED',
        reason: 'Model ACTION proposal missing required non-empty "targetElementId"'
      };
    }
    const targetElementId = obj['targetElementId'].trim();

    // Validate actionType
    if (
      typeof obj['actionType'] !== 'string' ||
      !SUPPORTED_ACTION_TYPES.includes(obj['actionType'] as ActionType)
    ) {
      return {
        status: 'FAILED',
        reason: `Unsupported actionType "${String(obj['actionType'])}". Supported: ${SUPPORTED_ACTION_TYPES.join(', ')}`
      };
    }
    const actionType = obj['actionType'] as ActionType;

    // Validate estimatedProgress if present
    let estimatedProgress: number | undefined;
    if (obj['estimatedProgress'] !== undefined && obj['estimatedProgress'] !== null) {
      const prog = obj['estimatedProgress'];
      if (
        typeof prog !== 'number' ||
        !Number.isFinite(prog) ||
        prog < 0 ||
        prog > 1
      ) {
        return {
          status: 'FAILED',
          reason: `Invalid estimatedProgress "${String(prog)}": must be a finite number between 0 and 1`
        };
      }
      estimatedProgress = prog;
    }

    // Validate payload
    let payload: AdvisoryStepProposal['payload'];
    if (actionType === 'type') {
      if (typeof obj['payload'] !== 'object' || obj['payload'] === null) {
        return {
          status: 'FAILED',
          reason: 'Action "type" requires a payload object with a "text" string'
        };
      }

      const rawPayload = obj['payload'] as Record<string, unknown>;
      if (typeof rawPayload['text'] !== 'string') {
        return {
          status: 'FAILED',
          reason: 'payload.text must be a string for "type" actions'
        };
      }

      if (
        rawPayload['clearFirst'] !== undefined &&
        typeof rawPayload['clearFirst'] !== 'boolean'
      ) {
        return {
          status: 'FAILED',
          reason: 'payload.clearFirst must be a boolean when supplied'
        };
      }

      if (
        rawPayload['pressEnter'] !== undefined &&
        typeof rawPayload['pressEnter'] !== 'boolean'
      ) {
        return {
          status: 'FAILED',
          reason: 'payload.pressEnter must be a boolean when supplied'
        };
      }

      // Output-side privacy safety: reject type payloads containing raw PII or credentials.
      // isSafeTypeActionText() passes the text through the existing sanitizeFreeFormText()
      // privacy sanitizer; it allows ordinary task text and semantic profile references
      // while rejecting any text that sanitization would alter (email, phone, card, token).
      if (!isSafeTypeActionText(rawPayload['text'] as string)) {
        return {
          status: 'FAILED',
          reason: 'Model proposed sensitive PII or credentials in type action payload'
        };
      }

      payload = {
        text: rawPayload['text'],
        ...(rawPayload['clearFirst'] !== undefined
          ? { clearFirst: rawPayload['clearFirst'] as boolean }
          : {}),
        ...(rawPayload['pressEnter'] !== undefined
          ? { pressEnter: rawPayload['pressEnter'] as boolean }
          : {})
      };
    }

    const rationale =
      typeof obj['rationale'] === 'string' && obj['rationale'].trim() !== ''
        ? obj['rationale'].trim()
        : `Action '${actionType}' planned for target '${targetElementId}'`;

    return {
      status: 'ACTION',
      proposal: {
        targetElementId,
        actionType,
        ...(payload !== undefined ? { payload } : {}),
        rationale,
        ...(estimatedProgress !== undefined ? { estimatedProgress } : {})
      }
    };
  }

  // Unrecognized type
  return {
    status: 'FAILED',
    reason: `Unrecognized proposal type "${type}". Expected "ACTION" or "COMPLETED"`
  };
}

// ---------------------------------------------------------------------------
// 4. Local LLM Client Abstraction & Factory
// ---------------------------------------------------------------------------

/**
 * Options for configuring local llama inference.
 */
export interface LocalLlamaAgentOptions {
  /** Host address. Default: '127.0.0.1' */
  readonly host?: string;
  /** Port number. Default: 8080 */
  readonly port?: number;
  /** Request timeout in milliseconds. Default: 120000 (120s) */
  readonly timeoutMs?: number;
  /** Model identifier. Default: 'qwen2.5-vl-3b' */
  readonly modelId?: string;
  /** Custom base URL override (useful for testing) */
  readonly baseUrl?: string;
  /** Custom fetch implementation (useful for testing) */
  readonly fetchFn?: typeof fetch;
  /** Sampling temperature. Default: 0.1 */
  readonly temperature?: number;
  /** Max completion tokens. Default: 1024 */
  readonly maxTokens?: number;
}

/**
 * Interface for dependency-injected local chat inference.
 */
export interface LocalLlamaChatClient {
  chat(request: {
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<
    | { success: true; content: string }
    | { success: false; error: { code: string; message: string } }
  >;
}

/**
 * Default local llama chat client communicating with external llama-server.
 */
export class DefaultLocalLlamaChatClient implements LocalLlamaChatClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly modelId: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly fetchFn: typeof fetch;

  constructor(options?: LocalLlamaAgentOptions) {
    const host = options?.host?.trim() || '127.0.0.1';
    const port = options?.port ?? 8080;

    this.baseUrl = options?.baseUrl?.trim() || `http://${host}:${port}`;
    this.timeoutMs = options?.timeoutMs ?? 120000;
    this.modelId = options?.modelId?.trim() || 'qwen2.5-vl-3b';
    this.temperature = options?.temperature ?? 0.1;
    this.maxTokens = options?.maxTokens ?? 1024;
    this.fetchFn =
      options?.fetchFn ||
      (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : globalThis.fetch);

    if (typeof this.fetchFn !== 'function') {
      throw new Error('fetch is not available in the current environment');
    }
  }

  async chat(request: {
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<
    | { success: true; content: string }
    | { success: false; error: { code: string; message: string } }
  > {
    const endpoint = `${this.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    const payload = {
      model: this.modelId,
      messages: [
        {
          role: 'system',
          content: request.systemPrompt
        },
        {
          role: 'user',
          content: request.userPrompt
        }
      ],
      temperature: request.temperature ?? this.temperature,
      max_tokens: request.maxTokens ?? this.maxTokens,
      response_format: {
        type: 'json_object'
      }
    };

    try {
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        return {
          success: false,
          error: {
            code: 'HTTP_ERROR',
            message: `Local inference server returned HTTP ${response.status} ${response.statusText}`
          }
        };
      }

      let responseBody: any;
      try {
        responseBody = await response.json();
      } catch (jsonError: unknown) {
        if (controller.signal.aborted) {
          return {
            success: false,
            error: {
              code: 'TIMEOUT',
              message: `Local inference timed out after ${this.timeoutMs}ms`
            }
          };
        }
        return {
          success: false,
          error: {
            code: 'INVALID_RESPONSE',
            message: 'Local inference server returned invalid JSON response body'
          }
        };
      }

      const content = responseBody?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        return {
          success: false,
          error: {
            code: 'EMPTY_CONTENT',
            message: 'Local inference server returned response without text content'
          }
        };
      }

      return {
        success: true,
        content
      };
    } catch (fetchError: unknown) {
      if (controller.signal.aborted) {
        return {
          success: false,
          error: {
            code: 'TIMEOUT',
            message: `Local inference timed out after ${this.timeoutMs}ms`
          }
        };
      }

      return {
        success: false,
        error: {
          code: 'UNREACHABLE',
          message: `Local inference server is offline or unreachable on ${this.baseUrl}: ${String(fetchError)}`
        }
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Local Agent PlannerDriver Implementation
// ---------------------------------------------------------------------------

/**
 * Local AI agent advisory driver implementing the Phase 3A PlannerDriver contract.
 * Generates structured AdvisoryStepProposal outputs for Phase 3A validation.
 */
export class LocalAgentDriver implements PlannerDriver {
  readonly name: string = 'LocalAgentDriver';
  private readonly client: LocalLlamaChatClient;

  constructor(clientOrOptions?: LocalLlamaChatClient | LocalLlamaAgentOptions) {
    if (clientOrOptions && 'chat' in clientOrOptions) {
      this.client = clientOrOptions;
    } else {
      this.client = new DefaultLocalLlamaChatClient(clientOrOptions);
    }
  }

  /**
   * Proposes the next advisory step for a given PlannerInput context.
   */
  async proposeStep(input: PlannerInput): Promise<AdvisoryProposalResult> {
    // 1. Safe allowlisted prompt construction
    const userPrompt = buildAgentUserPrompt(input);
    const parsedPayload = JSON.parse(userPrompt);
    console.log(
      `[NexVision LocalAgent] Step ${input.context.stepIndex}: ` +
      `targets=${parsedPayload.availableTargets?.length ?? 0}, ` +
      `historySteps=${parsedPayload.history?.length ?? 0}`
    );

    // 2. Asynchronous local inference call
    const chatResult = await this.client.chat({
      systemPrompt: LOCAL_AGENT_SYSTEM_PROMPT,
      userPrompt
    });

    if (chatResult.success) {
      console.log(
        `[NexVision LocalAgent] Step ${input.context.stepIndex}: raw model response = ${chatResult.content}`
      );
    }

    if (!chatResult.success) {
      return {
        status: 'FAILED',
        reason: chatResult.error.message
      };
    }

    // 3. Strict response parsing
    const parsed = parseAdvisoryResponse(chatResult.content);

    // 4. Respect explicit completion preconditions
    if (parsed.status === 'COMPLETED') {
      if (input.context.completion?.satisfied !== true) {
        return {
          status: 'FAILED',
          reason: 'UNSUPPORTED_GOAL'
        };
      }
    }

    return parsed;
  }
}

/**
 * Factory function creating a LocalAgentDriver.
 */
export function createLocalAgentDriver(
  clientOrOptions?: LocalLlamaChatClient | LocalLlamaAgentOptions
): LocalAgentDriver {
  return new LocalAgentDriver(clientOrOptions);
}

// ---------------------------------------------------------------------------
// 6. High-Level LocalAgent Wrapper
// ---------------------------------------------------------------------------

/**
 * High-level LocalAgent combining LocalAgentDriver with the authoritative
 * Phase 3A planNextStep() validation pipeline.
 */
export class LocalAgent {
  readonly driver: LocalAgentDriver;

  constructor(clientOrOptions?: LocalLlamaChatClient | LocalLlamaAgentOptions) {
    this.driver = new LocalAgentDriver(clientOrOptions);
  }

  /**
   * Plans the next validated step by delegating to Phase 3A planNextStep().
   */
  async planNextStep(input: PlannerInput): Promise<PlannerResult> {
    return planNextStep(input, this.driver);
  }
}

/**
 * Factory function creating a LocalAgent.
 */
export function createLocalAgent(
  clientOrOptions?: LocalLlamaChatClient | LocalLlamaAgentOptions
): LocalAgent {
  return new LocalAgent(clientOrOptions);
}
