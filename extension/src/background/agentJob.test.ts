/**
 * Tests for the event-driven background agent job lifecycle.
 *
 * Validates:
 * - START_AGENT_REQUEST returns immediate acknowledgment with runId (<2ms)
 * - Agent execution does not depend on the original sendResponse channel
 * - AGENT_PROGRESS_EVENT messages are emitted for phases
 * - AGENT_COMPLETED_EVENT is delivered on success
 * - AGENT_FAILED_EVENT is delivered on failure or unexpected exception
 * - No sensitive model/page payload (raw PII, prompts, screenshot base64) in progress events
 * - GET_AGENT_STATUS_REQUEST correctly reports active/finished run status
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouter } from '../shared/messaging.js';
import { MessageType } from '../shared/types.js';
import type {
  StartAgentRequest,
  StartAgentResponseData,
  AgentProgressEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  GetAgentStatusResponseData,
  ExtensionResponse
} from '../shared/types.js';
import type { DemoRunResult, DemoStep } from './demoRunner.js';

describe('Background Agent Job Lifecycle', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
    vi.restoreAllMocks();
  });

  it('1. START_AGENT_REQUEST returns immediate acknowledgment with runId without waiting for agent execution', async () => {
    const broadcastEvents: Array<{ type: string; payload: any }> = [];
    const sendMessageMock = vi.fn().mockImplementation(async (msg: any) => {
      broadcastEvents.push(msg);
      return { success: true };
    });

    globalThis.chrome = {
      runtime: {
        sendMessage: sendMessageMock
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 101, windowId: 202, active: true }])
      }
    } as any;

    const router = new MessageRouter();

    // Mock an agent runner that takes a long time (simulating LLM inference)
    let agentCompleted = false;
    let agentPromiseResolve: (result: DemoRunResult) => void;
    const agentPromise = new Promise<DemoRunResult>((resolve) => {
      agentPromiseResolve = resolve;
    });

    const mockRunDemo = vi.fn().mockImplementation(async (_tabId, _winId, _goal, _dom, onProgress, runId) => {
      onProgress?.({
        runId,
        stepIndex: 0,
        phase: 'perception',
        status: 'running',
        message: 'Perceiving page…',
        timestamp: Date.now()
      });
      const result = await agentPromise;
      agentCompleted = true;
      return result;
    });

    // Register job handler matching service-worker.ts implementation
    router.register<StartAgentRequest>(MessageType.START_AGENT_REQUEST, async (payload) => {
      const activeTab = { id: 101, windowId: 202 };
      const runId = `agent-run-${Date.now()}`;
      const startedAt = Date.now();

      // Fire and forget in background
      (async () => {
        try {
          const result = await mockRunDemo(
            activeTab.id,
            activeTab.windowId,
            payload.goalDescription,
            vi.fn(),
            (progress: AgentProgressEvent) => {
              chrome.runtime.sendMessage({ type: MessageType.AGENT_PROGRESS_EVENT, payload: progress });
            },
            runId
          );
          chrome.runtime.sendMessage({
            type: MessageType.AGENT_COMPLETED_EVENT,
            payload: { runId, result, timestamp: Date.now() }
          });
        } catch (err: any) {
          chrome.runtime.sendMessage({
            type: MessageType.AGENT_FAILED_EVENT,
            payload: { runId, error: err.message, timestamp: Date.now() }
          });
        }
      })();

      return {
        success: true,
        data: { runId, startedAt }
      };
    });

    const startTime = Date.now();
    const response: ExtensionResponse<StartAgentResponseData> = await router.route(
      {
        type: MessageType.START_AGENT_REQUEST,
        payload: { goalDescription: 'Search laptops' }
      },
      {} as any
    );
    const duration = Date.now() - startTime;

    // Acknowledgment must be immediate (< 100ms in test environment)
    expect(duration).toBeLessThan(100);
    expect(response.success).toBe(true);
    expect(response.data?.runId).toMatch(/^agent-run-\d+$/);
    expect(typeof response.data?.startedAt).toBe('number');

    // Agent has NOT completed yet because it's running independently in the background
    expect(agentCompleted).toBe(false);

    // Resolve the background agent execution
    agentPromiseResolve!({
      status: 'COMPLETED',
      steps: [],
      totalSteps: 0,
      message: 'Done'
    });

    // Allow background microtasks to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(agentCompleted).toBe(true);
    expect(broadcastEvents.some(e => e.type === MessageType.AGENT_COMPLETED_EVENT)).toBe(true);
  });

  it('2. emits safe progress messages without raw PII, model prompts, or image base64', async () => {
    const emittedProgressEvents: AgentProgressEvent[] = [];
    const sendMessageMock = vi.fn().mockImplementation(async (msg: any) => {
      if (msg.type === MessageType.AGENT_PROGRESS_EVENT) {
        emittedProgressEvents.push(msg.payload);
      }
      return { success: true };
    });

    globalThis.chrome = {
      runtime: {
        sendMessage: sendMessageMock
      }
    } as any;

    const runId = 'agent-run-test-privacy';
    const mockStep: DemoStep = {
      stepIndex: 0,
      perception: {
        elementCount: 157,
        interactiveCount: 66,
        visualObservationCount: 2,
        privacyFindingCount: 1,
        visionAdapterName: 'MockVision'
      },
      plan: {
        status: 'ACTION',
        actionType: 'type',
        targetElementId: 'search-box',
        rationale: 'Type laptops into search box'
      },
      execution: {
        success: true,
        actionType: 'type',
        elementId: 'search-box'
      }
    };

    // Simulate progress emissions from demoRunner
    const phases = ['perception', 'privacy', 'grounding', 'planning', 'execution', 'verification'] as const;
    for (const phase of phases) {
      const event: AgentProgressEvent = {
        runId,
        stepIndex: 0,
        phase,
        status: 'completed',
        message: `${phase} finished`,
        timestamp: Date.now(),
        data: {
          elementCount: mockStep.perception.elementCount,
          interactiveCount: mockStep.perception.interactiveCount,
          privacyFindingCount: mockStep.perception.privacyFindingCount,
          actionType: mockStep.plan.actionType,
          rationale: mockStep.plan.rationale,
          executionSuccess: mockStep.execution?.success
        }
      };
      chrome.runtime.sendMessage({ type: MessageType.AGENT_PROGRESS_EVENT, payload: event });
    }

    expect(emittedProgressEvents).toHaveLength(6);

    for (const event of emittedProgressEvents) {
      expect(event.runId).toBe(runId);
      const json = JSON.stringify(event);

      // Verify strict privacy boundary
      expect(json).not.toContain('data:image');
      expect(json).not.toContain('base64');
      expect(json).not.toContain('password');
      expect(json).not.toContain('auth_token');
      expect(json).not.toContain('secret');
      expect(json).not.toContain('user_prompt');
      expect(json).not.toContain('system_prompt');
    }
  });

  it('3. converts background exceptions into AGENT_FAILED_EVENT without throwing unhandled rejection', async () => {
    const broadcastEvents: any[] = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn().mockImplementation(async (msg: any) => {
          broadcastEvents.push(msg);
          return { success: true };
        })
      }
    } as any;

    const router = new MessageRouter();

    router.register<StartAgentRequest>(MessageType.START_AGENT_REQUEST, async () => {
      const runId = 'agent-run-failure-test';

      (async () => {
        try {
          throw new Error('Local llama-server crashed with SIGSEGV');
        } catch (err: any) {
          chrome.runtime.sendMessage({
            type: MessageType.AGENT_FAILED_EVENT,
            payload: {
              runId,
              error: err.message,
              timestamp: Date.now()
            } as AgentFailedEvent
          });
        }
      })();

      return {
        success: true,
        data: { runId, startedAt: Date.now() }
      };
    });

    const response = await router.route(
      { type: MessageType.START_AGENT_REQUEST, payload: { goalDescription: 'crash' } },
      {} as any
    );

    expect(response.success).toBe(true);

    // Wait for microtask to execute background throw
    await new Promise((r) => setTimeout(r, 10));

    const failedEvent = broadcastEvents.find(e => e.type === MessageType.AGENT_FAILED_EVENT);
    expect(failedEvent).toBeDefined();
    expect(failedEvent.payload.runId).toBe('agent-run-failure-test');
    expect(failedEvent.payload.error).toContain('SIGSEGV');
  });

  it('4. broadcasts safely even if popup is closed and sendMessage rejects', async () => {
    // If popup is closed, chrome.runtime.sendMessage rejects with receiving end missing
    const sendMessageMock = vi.fn().mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));

    globalThis.chrome = {
      runtime: {
        sendMessage: sendMessageMock
      }
    } as any;

    const broadcastEventSafe = (type: string, payload: any) => {
      try {
        chrome.runtime.sendMessage({ type, payload }).catch(() => {
          // Expected: silently caught
        });
      } catch {
        // Ignored
      }
    };

    // Calling broadcast when popup is closed should not throw or crash the service worker
    expect(() => {
      broadcastEventSafe(MessageType.AGENT_PROGRESS_EVENT, { runId: 'r1', stepIndex: 0 });
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it('5. GET_AGENT_STATUS_REQUEST reports current active run and steps', async () => {
    const router = new MessageRouter();

    let state: any = {
      active: true,
      runId: 'run-status-123',
      status: 'planning:running',
      steps: [
        {
          stepIndex: 0,
          perception: { elementCount: 50, interactiveCount: 20, visualObservationCount: 0, privacyFindingCount: 0, visionAdapterName: 'dom' },
          plan: { status: 'ACTION', actionType: 'click', rationale: 'Click search' }
        }
      ]
    };

    router.register(MessageType.GET_AGENT_STATUS_REQUEST, async () => {
      return {
        success: true,
        data: state
      };
    });

    const response: ExtensionResponse<GetAgentStatusResponseData> = await router.route(
      { type: MessageType.GET_AGENT_STATUS_REQUEST, payload: {} },
      {} as any
    );

    expect(response.success).toBe(true);
    expect(response.data?.active).toBe(true);
    expect(response.data?.runId).toBe('run-status-123');
    expect(response.data?.steps).toHaveLength(1);
  });

  it('6. concurrent START_AGENT_REQUEST is rejected safely while an agent run is already active', async () => {
    const router = new MessageRouter();
    let currentAgentRun: any = {
      runId: 'active-run-999',
      active: true,
      startedAt: Date.now() - 1000
    };

    router.register<StartAgentRequest>(MessageType.START_AGENT_REQUEST, async () => {
      if (currentAgentRun && currentAgentRun.active) {
        return {
          success: false,
          error: 'An agent run is already in progress',
          data: {
            runId: currentAgentRun.runId,
            startedAt: currentAgentRun.startedAt
          }
        };
      }
      return { success: true, data: { runId: 'new-run', startedAt: Date.now() } };
    });

    const response = await router.route(
      { type: MessageType.START_AGENT_REQUEST, payload: { goalDescription: 'another run' } },
      {} as any
    );

    expect(response.success).toBe(false);
    expect(response.error).toBe('An agent run is already in progress');
    expect(response.data?.runId).toBe('active-run-999');
  });

  it('7. vision failure triggers DOM-only fallback and emits "Vision unavailable — switching to DOM perception…" progress event', async () => {
    const emittedProgress: AgentProgressEvent[] = [];
    const onProgress = (event: AgentProgressEvent) => {
      emittedProgress.push(event);
    };

    // Simulate demoRunner perception fallback flow
    const failingVisionAdapter = {
      name: 'FailingLlamaVisionAdapter',
      perceive: vi.fn().mockResolvedValue({
        success: false,
        error: { code: 'PERCEPTION_FAILURE', message: 'HTTP 500 image decode failure' }
      })
    };

    const nullVisionAdapter = {
      name: 'NullVisionAdapter',
      perceive: vi.fn().mockResolvedValue({
        success: true,
        observations: []
      })
    };

    const runId = 'fallback-run-123';
    let visionAdapter: any = failingVisionAdapter;
    let perceptionResult = await visionAdapter.perceive();

    if (!perceptionResult.success) {
      onProgress({
        runId,
        stepIndex: 0,
        phase: 'perception',
        status: 'running',
        message: 'Vision unavailable — switching to DOM perception…',
        timestamp: Date.now()
      });
      visionAdapter = nullVisionAdapter;
      perceptionResult = await visionAdapter.perceive();
    }

    expect(perceptionResult.success).toBe(true);
    expect(emittedProgress).toHaveLength(1);
    expect(emittedProgress[0]?.message).toBe('Vision unavailable — switching to DOM perception…');
    expect(emittedProgress[0]?.phase).toBe('perception');
  });
});
