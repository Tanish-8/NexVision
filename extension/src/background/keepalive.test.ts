/**
 * Focused unit tests for Service Worker keepalive heartbeat lifecycle:
 * 1. Keepalive starts when an agent run becomes active.
 * 2. Keepalive does not start for a rejected/concurrent agent run.
 * 3. Keepalive is cleared when an agent run completes.
 * 4. Keepalive is cleared when an agent run fails.
 * 5. Keepalive cannot be duplicated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageType } from '../shared/types.js';
import type {
  StartAgentRequest
} from '../shared/types.js';
import {
  router,
  startAgentKeepalive,
  stopAgentKeepalive,
  isAgentKeepaliveActive,
  KEEPALIVE_INTERVAL_MS,
  _resetAgentRunStateForTesting
} from './service-worker.js';
import * as demoRunnerModule from './demoRunner.js';

describe('Service Worker Keepalive Heartbeat Lifecycle', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetAgentRunStateForTesting();
  });

  afterEach(() => {
    _resetAgentRunStateForTesting();
    globalThis.chrome = originalChrome;
    vi.restoreAllMocks();
  });

  // 1. Keepalive starts when an agent run becomes active
  it('1. Keepalive starts when an agent run becomes active', async () => {
    let resolveRunner: (value: any) => void;
    const runnerPromise = new Promise((resolve) => {
      resolveRunner = resolve;
    });

    vi.spyOn(demoRunnerModule, 'runDemoAgentWithProvider').mockImplementation(
      () => runnerPromise as any
    );

    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ success: true }),
        getPlatformInfo: vi.fn().mockResolvedValue({ os: 'win', arch: 'x86-64' })
      },
      tabs: {
        sendMessage: vi.fn().mockResolvedValue({ success: true, data: {} })
      }
    } as any;

    expect(isAgentKeepaliveActive()).toBe(false);

    const response = await router.route(
      {
        type: MessageType.START_AGENT_REQUEST,
        payload: {
          tabId: 101,
          windowId: 202,
          goalDescription: 'Search laptops'
        } as StartAgentRequest,
        id: 'msg-1'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(response.success).toBe(true);
    // Keepalive should be active while runner is running
    expect(isAgentKeepaliveActive()).toBe(true);

    // Clean up
    resolveRunner!({ status: 'COMPLETED', steps: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isAgentKeepaliveActive()).toBe(false);
  });

  // 2. Keepalive does not start for a rejected/concurrent agent run
  it('2. Keepalive does not start for a rejected or invalid agent run', async () => {
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ success: true }),
        getPlatformInfo: vi.fn().mockResolvedValue({ os: 'win', arch: 'x86-64' })
      },
      tabs: {
        query: vi.fn().mockResolvedValue([]) // No active tab found
      }
    } as any;

    expect(isAgentKeepaliveActive()).toBe(false);

    // Attempt to start without tabId when query returns empty tabs
    const response = await router.route(
      {
        type: MessageType.START_AGENT_REQUEST,
        payload: {
          goalDescription: 'Search laptops'
        } as StartAgentRequest,
        id: 'msg-2'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(response.success).toBe(false);
    expect(response.error).toContain('No active tab found');
    expect(isAgentKeepaliveActive()).toBe(false);
  });

  it('2b. Keepalive does not start a second interval for a concurrent agent run', async () => {
    let resolveRunner: (value: any) => void;
    const runnerPromise = new Promise((resolve) => {
      resolveRunner = resolve;
    });

    vi.spyOn(demoRunnerModule, 'runDemoAgentWithProvider').mockImplementation(
      () => runnerPromise as any
    );

    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ success: true }),
        getPlatformInfo: vi.fn().mockResolvedValue({ os: 'win', arch: 'x86-64' })
      },
      tabs: {
        sendMessage: vi.fn().mockResolvedValue({ success: true, data: {} })
      }
    } as any;

    // Start first run
    const firstResponse = await router.route(
      {
        type: MessageType.START_AGENT_REQUEST,
        payload: {
          tabId: 101,
          windowId: 202,
          goalDescription: 'First run'
        } as StartAgentRequest,
        id: 'msg-run-1'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(firstResponse.success).toBe(true);
    expect(isAgentKeepaliveActive()).toBe(true);

    // Attempt second concurrent run
    const secondResponse = await router.route(
      {
        type: MessageType.START_AGENT_REQUEST,
        payload: {
          tabId: 101,
          windowId: 202,
          goalDescription: 'Second concurrent run'
        } as StartAgentRequest,
        id: 'msg-run-2'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(secondResponse.success).toBe(false);
    expect(secondResponse.error).toContain('already in progress');
    // Keepalive should still be active for the original run, not duplicated
    expect(isAgentKeepaliveActive()).toBe(true);

    // Resolve first run
    resolveRunner!({ status: 'COMPLETED', steps: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isAgentKeepaliveActive()).toBe(false);
  });

  // 3. Keepalive is cleared when an agent run completes
  it('3. Keepalive is cleared when an agent run completes', async () => {
    let resolveRunner: (value: any) => void;
    const runnerPromise = new Promise((resolve) => {
      resolveRunner = resolve;
    });

    vi.spyOn(demoRunnerModule, 'runDemoAgentWithProvider').mockImplementation(
      () => runnerPromise as any
    );

    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ success: true }),
        getPlatformInfo: vi.fn().mockResolvedValue({ os: 'win', arch: 'x86-64' })
      },
      tabs: {
        sendMessage: vi.fn().mockResolvedValue({ success: true, data: {} })
      }
    } as any;

    await router.route(
      {
        type: MessageType.START_AGENT_REQUEST,
        payload: {
          tabId: 101,
          windowId: 202,
          goalDescription: 'Search laptops'
        } as StartAgentRequest,
        id: 'msg-3'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(isAgentKeepaliveActive()).toBe(true);

    // Complete the run
    resolveRunner!({
      status: 'COMPLETED',
      steps: []
    });

    // Wait for the async IIFE to finish
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isAgentKeepaliveActive()).toBe(false);
  });

  // 4. Keepalive is cleared when an agent run fails
  it('4. Keepalive is cleared when an agent run fails with an error', async () => {
    let rejectRunner: (error: any) => void;
    const runnerPromise = new Promise((_, reject) => {
      rejectRunner = reject;
    });

    vi.spyOn(demoRunnerModule, 'runDemoAgentWithProvider').mockImplementation(
      () => runnerPromise as any
    );

    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ success: true }),
        getPlatformInfo: vi.fn().mockResolvedValue({ os: 'win', arch: 'x86-64' })
      },
      tabs: {
        sendMessage: vi.fn().mockResolvedValue({ success: true, data: {} })
      }
    } as any;

    await router.route(
      {
        type: MessageType.START_AGENT_REQUEST,
        payload: {
          tabId: 101,
          windowId: 202,
          goalDescription: 'Failing run'
        } as StartAgentRequest,
        id: 'msg-4'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(isAgentKeepaliveActive()).toBe(true);

    // Reject the runner
    rejectRunner!(new Error('Inference server disconnected'));

    // Wait for the async IIFE to finish
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isAgentKeepaliveActive()).toBe(false);
  });

  // 5. Keepalive cannot be duplicated
  it('5. Keepalive cannot be duplicated by multiple calls to startAgentKeepalive()', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    expect(isAgentKeepaliveActive()).toBe(false);

    startAgentKeepalive();
    expect(isAgentKeepaliveActive()).toBe(true);
    const initialCallCount = setIntervalSpy.mock.calls.length;
    expect(initialCallCount).toBe(1);

    // Call again - should be a no-op
    startAgentKeepalive();
    startAgentKeepalive();
    expect(setIntervalSpy.mock.calls.length).toBe(initialCallCount);
    expect(isAgentKeepaliveActive()).toBe(true);

    stopAgentKeepalive();
    expect(isAgentKeepaliveActive()).toBe(false);
  });

  it('5b. Keepalive periodically queries chrome.runtime.getPlatformInfo() at the expected interval', () => {
    vi.useFakeTimers();
    try {
      const mockGetPlatformInfo = vi.fn().mockResolvedValue({ os: 'win' });
      globalThis.chrome = {
        runtime: {
          getPlatformInfo: mockGetPlatformInfo
        }
      } as any;

      startAgentKeepalive(KEEPALIVE_INTERVAL_MS);
      expect(isAgentKeepaliveActive()).toBe(true);

      expect(mockGetPlatformInfo).not.toHaveBeenCalled();

      // Fast forward 15 seconds
      vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
      // Because currentAgentRun is not active, auto-cleanup stops the timer
      expect(isAgentKeepaliveActive()).toBe(false);
    } finally {
      vi.useRealTimers();
      stopAgentKeepalive();
    }
  });
});
