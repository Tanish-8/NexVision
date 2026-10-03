/**
 * Content script for SIH26171 extension.
 * Runs on every page and inspects the DOM to produce a sanitized page snapshot.
 */

import { MessageType } from '../shared/types.js';
import { sendToTab, MessageRouter, dispatchMessageToRouter } from '../shared/messaging.js';
import type { ExtensionMessage, PageSnapshot, ExtensionResponse } from '../shared/types.js';
import { extractPageRepresentationFromDom } from './domPerception.js';
import { executeDomAction } from './domExecutor.js';
import type { PageRepresentation, ExecutionResult, ExecuteActionRequest } from '../shared/types.js';

const router = new MessageRouter();

// Handle messages from background/popup
router.register(MessageType.INSPECT_PAGE_REQUEST, async (
  _payload: any,
  _sender
): Promise<ExtensionResponse> => {
  try {
    const pageRepresentation = extractPageRepresentationFromDom();
    return {
      success: true,
      data: pageRepresentation
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
});

// Handle action execution requests from background service worker
router.register<ExecuteActionRequest>(MessageType.EXECUTE_ACTION_REQUEST, async (
  payload: ExecuteActionRequest,
  _sender
): Promise<ExtensionResponse<ExecutionResult>> => {
  try {
    const result = executeDomAction(payload?.action);
    return {
      success: true,
      data: result
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Action execution failed'
    };
  }
});

/**
 * Global initialization sentinel to ensure idempotent initialization
 * and prevent duplicate listener registration upon script reinjection.
 */
const GLOBAL_INIT_KEY = '__NEXVISION_CONTENT_SCRIPT_INITIALIZED__';

export function initializeContentScript(targetGlobal: any = typeof window !== 'undefined' ? window : globalThis): boolean {
  if (targetGlobal && targetGlobal[GLOBAL_INIT_KEY]) {
    // Already initialized in this execution context
    return false;
  }
  if (targetGlobal) {
    targetGlobal[GLOBAL_INIT_KEY] = true;
  }

  /**
   * Listen for messages from the background script / popup
   */
  if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(
      <T = any>(message: ExtensionMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: ExtensionResponse) => void) => {
        if (!message || typeof message !== 'object' || !router.hasHandler(message.type)) {
          return false;
        }
        return dispatchMessageToRouter(router, message, sender, sendResponse);
      }
    );
  }
  return true;
}

// Auto-run on script execution
initializeContentScript();

export { extractPageRepresentationFromDom, executeDomAction, router };
export type { PageSnapshot, PageRepresentation, ExecutionResult };
