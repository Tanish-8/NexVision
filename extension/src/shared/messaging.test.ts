import { describe, it, expect, vi } from 'vitest';
import { generateMessageId, MessageRouter, dispatchMessageToRouter } from './messaging.js';
import type { ExtensionMessage, ExtensionResponse } from './types.js';

describe('generateMessageId', () => {
  it('should generate unique IDs', () => {
    const id1 = generateMessageId();
    const id2 = generateMessageId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^msg-\d+-\d+$/);
    expect(id2).toMatch(/^msg-\d+-\d+$/);
  });
});

describe('MessageRouter', () => {
  const dummySender: chrome.runtime.MessageSender = { id: 'test-sender' };

  it('routes to registered handler and returns successful response', async () => {
    const router = new MessageRouter();
    router.register('TEST_TYPE', async (payload: { val: number }) => {
      return { success: true, data: payload.val * 2 };
    });

    const msg: ExtensionMessage = { type: 'TEST_TYPE', payload: { val: 21 }, id: '1' };
    const response = await router.route(msg, dummySender);

    expect(response.success).toBe(true);
    expect(response.data).toBe(42);
  });

  it('returns error when no handler is registered for message type', async () => {
    const router = new MessageRouter();
    const msg: ExtensionMessage = { type: 'UNKNOWN_TYPE', id: '2' };
    const response = await router.route(msg, dummySender);

    expect(response.success).toBe(false);
    expect(response.error).toContain('No handler for message type: UNKNOWN_TYPE');
  });

  it('safely handles null/undefined/malformed message structure without throwing', async () => {
    const router = new MessageRouter();
    const nullResponse = await router.route(null as any, dummySender);
    expect(nullResponse.success).toBe(false);
    expect(nullResponse.error).toContain('Invalid message structure');

    const nonObjectResponse = await router.route('not an object' as any, dummySender);
    expect(nonObjectResponse.success).toBe(false);

    const noTypeResponse = await router.route({} as any, dummySender);
    expect(noTypeResponse.success).toBe(false);
  });

  it('catches synchronous throw in handler and returns error response', async () => {
    const router = new MessageRouter();
    router.register('SYNC_FAIL', () => {
      throw new Error('Sync handler explosion');
    });

    const msg: ExtensionMessage = { type: 'SYNC_FAIL', id: '3' };
    const response = await router.route(msg, dummySender);

    expect(response.success).toBe(false);
    expect(response.error).toBe('Sync handler explosion');
  });

  it('catches asynchronous rejection in handler and returns error response', async () => {
    const router = new MessageRouter();
    router.register('ASYNC_FAIL', async () => {
      throw new Error('Async handler rejection');
    });

    const msg: ExtensionMessage = { type: 'ASYNC_FAIL', id: '4' };
    const response = await router.route(msg, dummySender);

    expect(response.success).toBe(false);
    expect(response.error).toBe('Async handler rejection');
  });

  it('returns error if handler returns undefined instead of ExtensionResponse', async () => {
    const router = new MessageRouter();
    router.register('RETURNS_NOTHING', (() => {}) as any);

    const msg: ExtensionMessage = { type: 'RETURNS_NOTHING', id: '5' };
    const response = await router.route(msg, dummySender);

    expect(response.success).toBe(false);
    expect(response.error).toContain('returned an invalid response');
  });
});

describe('dispatchMessageToRouter', () => {
  const dummySender: chrome.runtime.MessageSender = { id: 'test-sender' };

  it('returns true synchronously to keep asynchronous message channel open', () => {
    const router = new MessageRouter();
    const sendResponse = vi.fn();
    const msg: ExtensionMessage = { type: 'ANY', id: '1' };

    const returned = dispatchMessageToRouter(router, msg, dummySender, sendResponse);
    expect(returned).toBe(true);
  });

  it('guarantees sendResponse is called on success', async () => {
    const router = new MessageRouter();
    router.register('PING', async () => ({ success: true, data: 'PONG' }));

    let receivedResponse: ExtensionResponse | undefined;
    const sendResponse = vi.fn((res) => {
      receivedResponse = res;
    });

    const msg: ExtensionMessage = { type: 'PING', id: '2' };
    dispatchMessageToRouter(router, msg, dummySender, sendResponse);

    // Wait for microtasks
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });

    expect(receivedResponse?.success).toBe(true);
    expect(receivedResponse?.data).toBe('PONG');
  });

  it('guarantees sendResponse is called with error response on handler rejection', async () => {
    const router = new MessageRouter();
    router.register('FAIL', async () => {
      throw new Error('Failure occurred');
    });

    let receivedResponse: ExtensionResponse | undefined;
    const sendResponse = vi.fn((res) => {
      receivedResponse = res;
    });

    const msg: ExtensionMessage = { type: 'FAIL', id: '3' };
    dispatchMessageToRouter(router, msg, dummySender, sendResponse);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });

    expect(receivedResponse?.success).toBe(false);
    expect(receivedResponse?.error).toBe('Failure occurred');
  });

  it('guarantees sendResponse is called when message is malformed or null', async () => {
    const router = new MessageRouter();

    let receivedResponse: ExtensionResponse | undefined;
    const sendResponse = vi.fn((res) => {
      receivedResponse = res;
    });

    dispatchMessageToRouter(router, null, dummySender, sendResponse);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });

    expect(receivedResponse?.success).toBe(false);
    expect(receivedResponse?.error).toContain('Invalid message structure');
  });

  it('ensures sendResponse is called exactly once and does not duplicate', async () => {
    const router = new MessageRouter();
    router.register('ONCE', async () => ({ success: true }));

    const sendResponse = vi.fn();
    const msg: ExtensionMessage = { type: 'ONCE', id: '4' };

    dispatchMessageToRouter(router, msg, dummySender, sendResponse);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });

    // Verify it was only called once
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });
});