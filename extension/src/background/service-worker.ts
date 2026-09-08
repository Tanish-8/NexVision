/**
 * Background service worker for SIH26171 extension.
 * Coordinates between popup and content script.
 */

import { MessageType } from '../shared/types.js';
import { sendToBackground, sendToTab, MessageRouter } from '../shared/messaging.js';
import type { ExtensionMessage, ExtensionResponse, PageSnapshot } from '../shared/types.js';
import type { PageRepresentation } from '../shared/types.js';

const router = new MessageRouter();

/**
 * Log when service worker starts
 */
console.log('[SIH26171] Background service worker started');

/**
 * Handle messages from popup
 */
router.register(MessageType.INSPECT_PAGE_REQUEST, async (
  payload: any,
  sender: chrome.runtime.MessageSender
): Promise<ExtensionResponse> => {
  try {
    // Get the active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab?.id) {
      return {
        success: false,
        error: 'No active tab found'
      };
    }

    // Send request to content script in the active tab
    const response = await sendToTab<PageRepresentation>(
      activeTab.id,
      MessageType.INSPECT_PAGE_REQUEST,
      payload
    );

    return response;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Background error'
    };
  }
});

/**
 * Listen for messages from popup
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

/**
 * Handle extension installation/update
 */
chrome.runtime.onInstalled.addListener(({ reason }) => {
  switch (reason) {
    case 'install':
      console.log('[SIH26171] Extension installed');
      break;
    case 'update':
      console.log('[SIH26171] Extension updated');
      break;
  }
});

/**
 * Notify popup that extension is ready
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('[SIH26171] Extension started');
});