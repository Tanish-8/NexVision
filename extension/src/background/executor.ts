/**
 * Phase 3B — Browser Action Executor.
 *
 * Background coordinator for executing IntendedActions in browser tabs.
 * Validates the IntendedAction, validates tab existence and safety,
 * and dispatches the execution request to the tab's content script via IPC.
 *
 * Invariants:
 * - Single-action execution only (no autonomous loops, retries, or re-perception).
 * - Supported actions ONLY: click, type, focus.
 * - Strict tab safety: rejects chrome://, devtools://, and internal URLs.
 * - Strict privacy: typed text is never logged, leaked, or included in execution results.
 * - Zero network calls (no fetch, XMLHttpRequest, or WebSocket).
 */

import {
  MessageType,
  type ExecuteActionOptions,
  type ExecuteActionRequest,
  type ExecutionFailureReason,
  type ExecutionFailureResult,
  type ExecutionResult,
  type ExtensionResponse
} from '../shared/types.js';
import { validateIntendedAction, type ActionType, type IntendedAction } from '../shared/actions.js';
import { sendToTab } from '../shared/messaging.js';

/** Default timeout for content-script execution IPC in milliseconds. */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 5000;

/** URL schemes on which content script execution is forbidden. */
const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:'
];

/**
 * Constructs a structured failure result.
 */
function makeFailure(
  reason: ExecutionFailureReason,
  message: string,
  action?: { type?: ActionType; target?: { elementId?: string }; id?: string }
): ExecutionFailureResult {
  return {
    success: false,
    ...(action?.type ? { actionType: action.type } : {}),
    ...(action?.target?.elementId ? { elementId: action.target.elementId } : {}),
    ...(action?.id ? { actionId: action.id } : {}),
    reason,
    message,
    timestamp: Date.now()
  };
}

type TabResolution =
  | { success: true; tab: chrome.tabs.Tab; tabId: number }
  | ExecutionFailureResult;

/**
 * Resolves the target tab and verifies that it is not on a restricted browser internal URL.
 */
async function resolveAndValidateTab(
  tabId?: number
): Promise<TabResolution> {
  let tab: chrome.tabs.Tab | undefined;
  let resolvedId: number | undefined = tabId;

  if (resolvedId !== undefined) {
    if (typeof resolvedId !== 'number' || !Number.isInteger(resolvedId) || resolvedId <= 0) {
      return makeFailure('TAB_NOT_FOUND', `Invalid tab ID: ${String(resolvedId)}`);
    }

    try {
      tab = await chrome.tabs.get(resolvedId);
    } catch {
      return makeFailure('TAB_NOT_FOUND', `Tab with ID ${resolvedId} not found`);
    }

    if (!tab) {
      return makeFailure('TAB_NOT_FOUND', `Tab with ID ${resolvedId} not found`);
    }
  } else {
    // Query active tab in the current window
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs[0];
    } catch {
      return makeFailure('TAB_NOT_FOUND', 'Failed to query active tab');
    }

    if (!tab?.id) {
      return makeFailure('TAB_NOT_FOUND', 'No active tab found');
    }
    resolvedId = tab.id;
  }

  // Safety check: verify tab URL is not an internal or restricted browser page
  const tabUrl = tab.url?.toLowerCase() || '';
  for (const scheme of RESTRICTED_SCHEMES) {
    if (tabUrl.startsWith(scheme)) {
      return makeFailure(
        'EXECUTION_ERROR',
        'Cannot execute action on restricted or internal browser page'
      );
    }
  }

  return { success: true, tab, tabId: resolvedId };
}

/**
 * Executes an IntendedAction against the target tab.
 *
 * @param request  The action execution request containing action and optional tabId.
 * @param options  Optional execution configuration (e.g. timeoutMs).
 */
export async function executeAction(
  request: ExecuteActionRequest,
  options?: ExecuteActionOptions
): Promise<ExecutionResult> {
  const untrustedAction = request?.action;

  // 1. Contract Validation via shared Phase 2F-3 validator
  const validation = validateIntendedAction(untrustedAction);
  if (!validation.success) {
    const rawAction = untrustedAction as unknown as Record<string, unknown> | undefined;
    const rawTarget = rawAction?.['target'] as Record<string, unknown> | undefined;
    const actionType =
      rawAction?.['type'] === 'click' ||
      rawAction?.['type'] === 'type' ||
      rawAction?.['type'] === 'focus'
        ? (rawAction['type'] as ActionType)
        : undefined;
    const elementId =
      typeof rawTarget?.['elementId'] === 'string'
        ? (rawTarget['elementId'] as string)
        : undefined;
    const actionId =
      typeof rawAction?.['id'] === 'string' ? (rawAction['id'] as string) : undefined;

    const reason: ExecutionFailureReason =
      validation.reason === 'UNSUPPORTED_ACTION_TYPE'
        ? 'INVALID_ACTION'
        : 'INVALID_TARGET';

    return makeFailure(reason, validation.message, {
      type: actionType,
      target: { elementId },
      id: actionId
    });
  }

  const action = validation.action;

  // 2. Tab Safety & Resolution
  const tabResolution = await resolveAndValidateTab(request.tabId);
  if (!tabResolution.success) {
    return {
      ...tabResolution,
      actionType: action.type,
      elementId: action.target.elementId,
      actionId: action.id
    };
  }

  const { tabId } = tabResolution;

  // 3. Dispatch execution IPC to content script with timeout
  const timeoutMs = options?.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;

  const ipcPromise = sendToTab<ExecutionResult>(
    tabId,
    MessageType.EXECUTE_ACTION_REQUEST,
    { action }
  );

  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => {
      reject(new Error(`Action execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let response: ExtensionResponse<ExecutionResult>;
  try {
    response = await Promise.race([ipcPromise, timeoutPromise]);
  } catch (error) {
    return makeFailure(
      'EXECUTION_ERROR',
      error instanceof Error ? error.message : 'Action execution transport failed',
      action
    );
  } finally {
    if (timerHandle !== undefined) {
      clearTimeout(timerHandle);
    }
  }

  // 4. Validate and map content script response
  if (!response.success || !response.data) {
    return makeFailure(
      'EXECUTION_ERROR',
      response.error || 'Content script failed to execute action',
      action
    );
  }

  return response.data;
}
