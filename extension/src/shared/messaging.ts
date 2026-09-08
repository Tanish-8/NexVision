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

  async route(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender
  ): Promise<ExtensionResponse> {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      return {
        success: false,
        error: `No handler for message type: ${message.type}`
      };
    }

    try {
      return await handler(message.payload, sender);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Handler error'
      };
    }
  }
}