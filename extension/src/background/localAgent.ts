/**
 * Phase 5A — Local AI Agent / Task Understanding Integration.
 *
 * Implements the first AI-agent reasoning layer for NexVision, connecting
 * local LLM inference infrastructure to the Phase 2F-3 action contracts.
 *
 * Invariants:
 * - Reasoning layer only: NO DOM execution, NO clicks, NO typing, NO navigation (Phase 6 boundary).
 * - NO autonomous loops, NO SEE->THINK->ACT loop, NO recovery loops (Phase 7 boundary).
 * - Strictly local LLM inference: connects only to local llama-server (default 127.0.0.1:8080).
 * - Privacy-first: model receives only an allowlisted, sanitized DTO.
 * - Never forwards raw DOM, passwords, input values, cookies, storage, or screenshot bytes.
 * - Security boundary: LLM may ONLY select from availableTargets; never synthesizes coordinates or targets.
 * - Single atomic action per cycle: exactly one of 'click' | 'type' | 'focus', or 'COMPLETED'.
 * - Strict JSON advisory response parsing; rejects prose, malformed JSON, and out-of-bounds values.
 * - Passes proposals through the existing Phase 2F-3 action validation pipeline.
 */

import {
  type ActionTarget,
  type ActionType,
  type IntendedAction,
  type TypeActionPayload,
  createIntendedAction,
  validateIntendedAction
} from '../shared/actions.js';

import type {
  PageElement,
  PageRepresentation,
  SanitizedPageRepresentation
} from '../shared/types.js';

import { stripMarkdownFences } from './llamaVisionAdapter.js';

// ---------------------------------------------------------------------------
// 1. Contracts & Types
// ---------------------------------------------------------------------------

/**
 * Natural language user goal and optional structured intent/parameters.
 */
export interface GoalInput {
  readonly description: string;
  readonly intent?: string;
  readonly parameters?: Record<string, unknown>;
}

/**
 * Planner context containing sanitized page state and grounded candidate targets.
 */
export interface PlannerContext {
  readonly page: PageRepresentation | SanitizedPageRepresentation;
  readonly availableTargets: readonly ActionTarget[];
  /** Explicit completion flag from planner context. */
  readonly isCompleted?: boolean;
}

/**
 * Complete input contract provided to the local agent planner.
 */
export interface PlannerInput {
  readonly goal: GoalInput;
  readonly context: PlannerContext;
  readonly stepIndex?: number;
  readonly currentTime?: number;
}

/**
 * Strict structured advisory step proposal produced by the local LLM.
 */
export type AdvisoryStepProposal =
  | {
      readonly type: 'ACTION';
      readonly targetElementId: string;
      readonly actionType: ActionType;
      readonly payload?: TypeActionPayload;
      readonly rationale?: string;
      readonly estimatedProgress?: number;
    }
  | {
      readonly type: 'COMPLETED';
      readonly rationale?: string;
    };

/**
 * Result of advisory response parsing.
 */
export type AdvisoryProposalResult =
  | {
      readonly success: true;
      readonly proposal: AdvisoryStepProposal;
    }
  | {
      readonly success: false;
      readonly reason: PlannerFailureReason;
      readonly message: string;
    };

/**
 * Failure reasons aligned with Phase 3A / 5A planner vocabulary.
 */
export type PlannerFailureReason =
  | 'INVALID_INPUT'
  | 'STALE_PERCEPTION'
  | 'NO_FEASIBLE_TARGET'
  | 'LOW_CONFIDENCE'
  | 'UNKNOWN_TARGET'
  | 'INCOMPATIBLE_ACTION'
  | 'INVALID_ACTION_INTENT'
  | 'UNSUPPORTED_GOAL'
  | 'MODEL_ERROR';

/**
 * Validated planner result returned by the local agent.
 */
export type PlannerResult =
  | {
      readonly success: true;
      readonly status: 'ACTION_PLANNED';
      readonly action: IntendedAction;
      readonly rationale?: string;
      readonly estimatedProgress?: number;
    }
  | {
      readonly success: true;
      readonly status: 'COMPLETED';
      readonly rationale?: string;
    }
  | {
      readonly success: false;
      readonly status: 'FAILED';
      readonly reason: PlannerFailureReason;
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// 2. Allowlisted Model-Facing DTO (Privacy Boundary)
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
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
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
 * Blind serialization is prohibited.
 */
export interface ModelPromptPayload {
  readonly goal: {
    readonly description: string;
    readonly intent?: string;
    readonly parameters?: Record<string, unknown>;
  };
  readonly page: ModelPageContext;
  readonly availableTargets: readonly ModelCandidateTarget[];
  readonly stepIndex?: number;
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
  'Schema for action:\n' +
  '{"type": "ACTION", "targetElementId": "<id>", "actionType": "click"|"type"|"focus", "payload": {"text": "..."}, "rationale": "<brief reason>", "estimatedProgress": 0.5}\n\n' +
  'Schema for completion:\n' +
  '{"type": "COMPLETED", "rationale": "<brief reason>"}';

/**
 * Helper to unwrap PageRepresentation from either PageRepresentation or SanitizedPageRepresentation.
 */
function unwrapPageRepresentation(
  page: PageRepresentation | SanitizedPageRepresentation
): PageRepresentation {
  if ('pageRepresentation' in page && typeof page.pageRepresentation === 'object') {
    return page.pageRepresentation;
  }
  return page as PageRepresentation;
}

/**
 * Builds the allowlisted model-facing DTO from PlannerInput.
 * Deterministic: preserves candidate ordering and allowlists safe fields only.
 */
export function buildModelPromptPayload(input: PlannerInput): ModelPromptPayload {
  const pageRep = unwrapPageRepresentation(input.context.page);

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
    const accessibleName = matchedElement?.accessibleName;
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
    const visibleText = isInputOrTextarea ? undefined : matchedElement?.visibleText;

    candidateTargets.push({
      elementId: target.elementId,
      ...(role !== undefined ? { role } : {}),
      ...(accessibleName !== undefined && accessibleName.trim() !== ''
        ? { accessibleName: accessibleName.trim() }
        : {}),
      ...(visibleText !== undefined && visibleText.trim() !== ''
        ? { visibleText: visibleText.trim() }
        : {}),
      confidence: target.confidence,
      bounds: {
        x: target.viewportBounds.x,
        y: target.viewportBounds.y,
        width: target.viewportBounds.width,
        height: target.viewportBounds.height
      }
    });
  }

  return {
    goal: {
      description: input.goal.description,
      ...(input.goal.intent !== undefined ? { intent: input.goal.intent } : {}),
      ...(input.goal.parameters !== undefined ? { parameters: input.goal.parameters } : {})
    },
    page: {
      ...(pageRep.metadata?.title !== undefined ? { title: pageRep.metadata.title } : {}),
      ...(pageRep.metadata?.url !== undefined ? { url: pageRep.metadata.url } : {})
    },
    availableTargets: candidateTargets,
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {})
  };
}

/**
 * Serializes the user prompt deterministically into JSON format.
 */
export function buildAgentUserPrompt(input: PlannerInput): string {
  const payload = buildModelPromptPayload(input);
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// 4. Strict Output Parsing
// ---------------------------------------------------------------------------

const SUPPORTED_ACTION_TYPES: readonly ActionType[] = ['click', 'type', 'focus'];

/**
 * Strictly parses and validates raw model text output into an AdvisoryProposalResult.
 * Rejects prose, missing types, invalid action types, out-of-range numbers, and malformed payloads.
 */
export function parseAdvisoryResponse(rawContent: string): AdvisoryProposalResult {
  if (typeof rawContent !== 'string' || rawContent.trim() === '') {
    return {
      success: false,
      reason: 'MODEL_ERROR',
      message: 'Model returned empty or non-string response'
    };
  }

  // Strip code fences if present (per local llama-server JSON convention)
  const cleaned = stripMarkdownFences(rawContent);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      success: false,
      reason: 'MODEL_ERROR',
      message: 'Failed to parse model output as valid JSON'
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      success: false,
      reason: 'MODEL_ERROR',
      message: 'Model output must be a non-null JSON object'
    };
  }

  const obj = parsed as Record<string, unknown>;

  // 1. Validate type discriminator
  if (typeof obj['type'] !== 'string') {
    return {
      success: false,
      reason: 'MODEL_ERROR',
      message: 'Model response missing required "type" property'
    };
  }

  const type = obj['type'].trim();

  // 2. Handle COMPLETED
  if (type === 'COMPLETED') {
    const rationale =
      typeof obj['rationale'] === 'string' && obj['rationale'].trim() !== ''
        ? obj['rationale'].trim()
        : undefined;

    return {
      success: true,
      proposal: {
        type: 'COMPLETED',
        ...(rationale !== undefined ? { rationale } : {})
      }
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
        success: false,
        reason: 'MODEL_ERROR',
        message: 'Model ACTION proposal missing required non-empty "targetElementId"'
      };
    }
    const targetElementId = obj['targetElementId'].trim();

    // Validate actionType
    if (
      typeof obj['actionType'] !== 'string' ||
      !SUPPORTED_ACTION_TYPES.includes(obj['actionType'] as ActionType)
    ) {
      return {
        success: false,
        reason: 'INCOMPATIBLE_ACTION',
        message: `Unsupported actionType "${String(obj['actionType'])}". Supported: ${SUPPORTED_ACTION_TYPES.join(', ')}`
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
          success: false,
          reason: 'INVALID_INPUT',
          message: `Invalid estimatedProgress "${String(prog)}": must be a finite number between 0 and 1`
        };
      }
      estimatedProgress = prog;
    }

    // Validate payload
    let payload: TypeActionPayload | undefined;
    if (actionType === 'type') {
      if (typeof obj['payload'] !== 'object' || obj['payload'] === null) {
        return {
          success: false,
          reason: 'INVALID_ACTION_INTENT',
          message: 'Action "type" requires a payload object with a "text" string'
        };
      }

      const rawPayload = obj['payload'] as Record<string, unknown>;
      if (typeof rawPayload['text'] !== 'string') {
        return {
          success: false,
          reason: 'INVALID_ACTION_INTENT',
          message: 'payload.text must be a string for "type" actions'
        };
      }

      if (
        rawPayload['clearFirst'] !== undefined &&
        typeof rawPayload['clearFirst'] !== 'boolean'
      ) {
        return {
          success: false,
          reason: 'INVALID_ACTION_INTENT',
          message: 'payload.clearFirst must be a boolean when supplied'
        };
      }

      if (
        rawPayload['pressEnter'] !== undefined &&
        typeof rawPayload['pressEnter'] !== 'boolean'
      ) {
        return {
          success: false,
          reason: 'INVALID_ACTION_INTENT',
          message: 'payload.pressEnter must be a boolean when supplied'
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
        : undefined;

    return {
      success: true,
      proposal: {
        type: 'ACTION',
        targetElementId,
        actionType,
        ...(payload !== undefined ? { payload } : {}),
        ...(rationale !== undefined ? { rationale } : {}),
        ...(estimatedProgress !== undefined ? { estimatedProgress } : {})
      }
    };
  }

  // Unrecognized type
  return {
    success: false,
    reason: 'MODEL_ERROR',
    message: `Unrecognized proposal type "${type}". Expected "ACTION" or "COMPLETED"`
  };
}

// ---------------------------------------------------------------------------
// 5. Proposal Validation & Action Pipeline
// ---------------------------------------------------------------------------

/** Non-textual roles that cannot receive a 'type' action. */
const NON_TEXTUAL_ROLES: readonly string[] = [
  'button',
  'link',
  'image',
  'heading',
  'navigation',
  'alert',
  'dialog',
  'progressbar',
  'status',
  'region'
];

/**
 * Validates an AdvisoryStepProposal against the PlannerInput context and creates
 * a validated IntendedAction via Phase 2F-3 contracts.
 */
export function validateProposalAndCreateAction(
  proposal: AdvisoryStepProposal,
  input: PlannerInput
): PlannerResult {
  // 1. Completion handling (Section 17)
  if (proposal.type === 'COMPLETED') {
    if (input.context.isCompleted !== true) {
      return {
        success: false,
        status: 'FAILED',
        reason: 'UNSUPPORTED_GOAL',
        message:
          'Model proposed COMPLETED but planner context does not indicate completion is valid'
      };
    }
    return {
      success: true,
      status: 'COMPLETED',
      ...(proposal.rationale !== undefined ? { rationale: proposal.rationale } : {})
    };
  }

  // 2. Target membership validation (Section 9 Security Rule)
  // LLM can NEVER synthesize coordinates or elements; MUST select from availableTargets.
  const target = input.context.availableTargets.find(
    (t) => t.elementId === proposal.targetElementId
  );

  if (!target) {
    return {
      success: false,
      status: 'FAILED',
      reason: 'UNKNOWN_TARGET',
      message: `Target element "${proposal.targetElementId}" is not in availableTargets`
    };
  }

  // 3. Interactivity & Role/Action Compatibility Validation (Section 10)
  const pageRep = unwrapPageRepresentation(input.context.page);
  const matchedElement = Array.isArray(pageRep.elements)
    ? pageRep.elements.find((el) => el?.id === proposal.targetElementId)
    : undefined;

  // Interactivity check
  if (matchedElement?.interactive === false) {
    return {
      success: false,
      status: 'FAILED',
      reason: 'INCOMPATIBLE_ACTION',
      message: `Target element "${proposal.targetElementId}" is marked non-interactive`
    };
  }

  // Disabled check
  if (matchedElement?.state?.disabled === true) {
    return {
      success: false,
      status: 'FAILED',
      reason: 'INCOMPATIBLE_ACTION',
      message: `Target element "${proposal.targetElementId}" is disabled`
    };
  }

  // Role compatibility for 'type'
  const effectiveRole = target.role || matchedElement?.role;
  if (
    proposal.actionType === 'type' &&
    effectiveRole &&
    NON_TEXTUAL_ROLES.includes(effectiveRole.toLowerCase())
  ) {
    return {
      success: false,
      status: 'FAILED',
      reason: 'INCOMPATIBLE_ACTION',
      message: `Action "type" is incompatible with target role "${effectiveRole}"`
    };
  }

  // 4. Create IntendedAction via existing Phase 2F-3 contract
  const actionCreation = createIntendedAction({
    type: proposal.actionType,
    target,
    payload: proposal.payload,
    timestamp: input.currentTime
  });

  if (!actionCreation.success) {
    let mappedReason: PlannerFailureReason = 'INVALID_ACTION_INTENT';
    if (actionCreation.reason === 'INVALID_TARGET') {
      mappedReason = 'NO_FEASIBLE_TARGET';
    } else if (actionCreation.reason === 'UNSUPPORTED_ACTION_TYPE') {
      mappedReason = 'INCOMPATIBLE_ACTION';
    }

    return {
      success: false,
      status: 'FAILED',
      reason: mappedReason,
      message: actionCreation.message
    };
  }

  // 5. Validate IntendedAction via existing Phase 2F-3 contract
  const actionValidation = validateIntendedAction(actionCreation.action);
  if (!actionValidation.success) {
    return {
      success: false,
      status: 'FAILED',
      reason: 'INVALID_ACTION_INTENT',
      message: actionValidation.message
    };
  }

  return {
    success: true,
    status: 'ACTION_PLANNED',
    action: actionValidation.action,
    ...(proposal.rationale !== undefined ? { rationale: proposal.rationale } : {}),
    ...(proposal.estimatedProgress !== undefined
      ? { estimatedProgress: proposal.estimatedProgress }
      : {})
  };
}

// ---------------------------------------------------------------------------
// 6. Local LLM Client Abstraction & Factory
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
  /** Max completion tokens. Default: 512 */
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
    this.maxTokens = options?.maxTokens ?? 512;
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

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

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
    } catch {
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
  }
}

// ---------------------------------------------------------------------------
// 7. Local Agent Implementation
// ---------------------------------------------------------------------------

/**
 * Local AI agent reasoning layer for browser task understanding and planning.
 */
export class LocalAgent {
  private readonly client: LocalLlamaChatClient;

  constructor(clientOrOptions?: LocalLlamaChatClient | LocalLlamaAgentOptions) {
    if (clientOrOptions && 'chat' in clientOrOptions) {
      this.client = clientOrOptions;
    } else {
      this.client = new DefaultLocalLlamaChatClient(clientOrOptions);
    }
  }

  /**
   * Plans the single next atomic step for a given user goal and planner context.
   */
  async planNextStep(input: PlannerInput): Promise<PlannerResult> {
    // 1. Validate input structure
    if (!input || typeof input !== 'object') {
      return {
        success: false,
        status: 'FAILED',
        reason: 'INVALID_INPUT',
        message: 'PlannerInput must be a non-null object'
      };
    }

    if (!input.goal || typeof input.goal.description !== 'string' || input.goal.description.trim() === '') {
      return {
        success: false,
        status: 'FAILED',
        reason: 'INVALID_INPUT',
        message: 'goal.description must be a non-empty string'
      };
    }

    if (!input.context || typeof input.context !== 'object') {
      return {
        success: false,
        status: 'FAILED',
        reason: 'INVALID_INPUT',
        message: 'PlannerInput.context must be a non-null object'
      };
    }

    if (!Array.isArray(input.context.availableTargets)) {
      return {
        success: false,
        status: 'FAILED',
        reason: 'INVALID_INPUT',
        message: 'PlannerInput.context.availableTargets must be an array'
      };
    }

    // Check if targets are available when completion is not signaled
    if (input.context.availableTargets.length === 0 && input.context.isCompleted !== true) {
      return {
        success: false,
        status: 'FAILED',
        reason: 'NO_FEASIBLE_TARGET',
        message: 'No available action targets provided in planner context'
      };
    }

    // 2. Safe allowlisted prompt construction
    const userPrompt = buildAgentUserPrompt(input);

    // 3. Asynchronous local inference call
    const chatResult = await this.client.chat({
      systemPrompt: LOCAL_AGENT_SYSTEM_PROMPT,
      userPrompt
    });

    if (!chatResult.success) {
      return {
        success: false,
        status: 'FAILED',
        reason: 'MODEL_ERROR',
        message: chatResult.error.message
      };
    }

    // 4. Strict response parsing
    const parseResult = parseAdvisoryResponse(chatResult.content);
    if (!parseResult.success) {
      return {
        success: false,
        status: 'FAILED',
        reason: parseResult.reason,
        message: parseResult.message
      };
    }

    // 5. Action validation pipeline (target membership, compatibility, createIntendedAction)
    return validateProposalAndCreateAction(parseResult.proposal, input);
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
