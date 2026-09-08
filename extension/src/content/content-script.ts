/**
 * Content script for SIH26171 extension.
 * Runs on every page and inspects the DOM to produce a sanitized page snapshot.
 */

import { MessageType } from '../shared/types.js';
import { sendToTab, MessageRouter } from '../shared/messaging.js';
import type { ExtensionMessage, PageSnapshot, ExtensionResponse } from '../shared/types.js';
import { extractPageRepresentationFromDom } from './domPerception.js';
import type { PageRepresentation } from '../shared/types.js';

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

/**
 * Listen for messages from the background script / popup
 */
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

export { extractPageRepresentationFromDom, router };
export type { PageSnapshot, PageRepresentation };