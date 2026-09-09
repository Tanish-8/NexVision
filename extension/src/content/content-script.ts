/**
 * Content script for SIH26171 extension.
 * Runs on every page and inspects the DOM to produce a sanitized page snapshot.
 */

import { MessageType } from '../shared/types.js';
import { sendToTab, MessageRouter } from '../shared/messaging.js';
import type { ExtensionMessage, PageSnapshot, ExtensionResponse } from '../shared/types.js';
import { extractPageRepresentationFromDom } from './domPerception.js';
import { executeDomAction } from './domExecutor.js';
import type { PageRepresentation, ExecutionResult } from '../shared/types.js';

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
router.register(MessageType.EXECUTE_ACTION_REQUEST, async (
  payload: any,
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
 * Listen for messages from the background script / popup
 */
if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    <T = any>(message: ExtensionMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: ExtensionResponse) => void) => {
      router.route(message, sender).then((response) => {
        if (sendResponse) {
          sendResponse(response);
        }
      });
      // Return true to indicate we'll respond asynchronously
      return true;
    }
  );
}

export { extractPageRepresentationFromDom, executeDomAction, router };
export type { PageSnapshot, PageRepresentation, ExecutionResult };