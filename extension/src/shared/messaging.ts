/**
 * Shared messaging utilities for Chrome extension communication
 */

import type { ExtensionMessage, ExtensionResponse } from './types.js';

let messageCounter = 0;

/**
 * Generate unique message ID
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

/**
 * Send a message to the background service worker
 */
export async function sendToBackground<T = any>(
  type: string,
  payload?: any
): Promise<ExtensionResponse<T>> {
  const message: ExtensionMessage = {
    type,
    payload,
    id: generateMessageId()
  };

  try {
    const response = await chrome.runtime.sendMessage(message);
    return response as ExtensionResponse<T>;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Send a message to a specific tab
 */
export async function sendToTab<T = any>(
  tabId: number,
  type: string,
  payload?: any
): Promise<ExtensionResponse<T>> {
  const message: ExtensionMessage = {
    type,
    payload,
    id: generateMessageId()
  };

  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response as ExtensionResponse<T>;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Type-safe message handler registration for content scripts
 */
export type MessageHandler<T = any> = (
  payload: T,
  sender: chrome.runtime.MessageSender
) => Promise<ExtensionResponse> | ExtensionResponse;

export class MessageRouter {
  private handlers = new Map<string, MessageHandler>();

  register<T = any>(type: string, handler: MessageHandler<T>): void {
    this.handlers.set(type, handler as MessageHandler);
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  async route(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender
  ): Promise<ExtensionResponse> {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return {
        success: false,
        error: 'Invalid message structure'
      };
    }

    const handler = this.handlers.get(message.type);
    if (!handler) {
      return {
        success: false,
        error: `No handler for message type: ${message.type}`
      };
    }

    try {
      const response = await handler(message.payload, sender);
      if (!response || typeof response !== 'object') {
        return {
          success: false,
          error: `Handler for "${message.type}" returned an invalid response`
        };
      }
      return response;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Handler error'
      };
    }
  }
}

/**
 * Dispatches an incoming Chrome runtime message through a MessageRouter,
 * guaranteeing that sendResponse() is called exactly once with a valid ExtensionResponse
 * regardless of whether the handler succeeds, rejects, throws synchronously,
 * or returns an invalid payload.
 *
 * Always returns true synchronously to maintain asynchronous response capability.
 */
export function dispatchMessageToRouter(
  router: MessageRouter,
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: ExtensionResponse) => void
): boolean {
  let hasResponded = false;

  const safeSend = (response: ExtensionResponse): void => {
    if (hasResponded) return;
    hasResponded = true;
    try {
      sendResponse(response);
    } catch {
      // Port or message channel might have already been closed
    }
  };

  try {
    router
      .route(message as ExtensionMessage, sender)
      .then((response) => {
        safeSend(
          response ?? {
            success: false,
            error: 'Empty response returned from message handler'
          }
        );
      })
      .catch((error) => {
        safeSend({
          success: false,
          error: error instanceof Error ? error.message : 'Asynchronous routing failure'
        });
      });
  } catch (syncError) {
    safeSend({
      success: false,
      error:
        syncError instanceof Error
          ? syncError.message
          : 'Synchronous dispatch failure'
    });
  }

  return true;
}