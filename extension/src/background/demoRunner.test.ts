/**
 * Integration tests for demoRunner.ts — the E2E demo loop integration seam.
 *
 * Tests the new integration code (runDemoAgentWithProvider, buildAvailableTargets
 * behaviour, bounded step loop) using mocked DomPerceptionProvider and
 * LocalLlamaChatClient, without requiring Chrome APIs, a real browser,
 * or a live llama-server.
 *
 * Existing tests for planner, actions, grounding, executor, localAgent, and
 * privacy engine are NOT duplicated here; they live in their respective test files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock chrome.tabs.sendMessage / captureVisibleTab path
vi.mock('./screenshot.js', () => ({
  captureVisibleTab: vi.fn().mockImplementation(async () => ({
    dataUrl: 'data:image/png;base64,abc123',
    format: 'png',
    timestamp: Date.now()
  }))
}));

// Mock service-worker nullVisionAdapter import
vi.mock('./service-worker.js', () => ({
  nullVisionAdapter: {
    name: 'NullVisionAdapter',
    perceive: async () => ({ success: true, observations: [] })
  },
  createDomProvider: vi.fn(),
  DOM_IPC_TIMEOUT_MS: 5000
}));

// Mock llamaVisionAdapter to default to null (no server)
vi.mock('./llamaVisionAdapter.js', () => ({
  createLlamaVisionAdapter: () => ({
    name: 'MockLlamaVisionAdapter',
    perceive: async () => ({
      success: false,
      error: { code: 'UNREACHABLE', message: 'llama-server not running in test' }
    })
  }),
  stripMarkdownFences: (s: string) => s
}));

// Mock executor
vi.mock('./executor.js', () => ({
  executeAction: vi.fn().mockImplementation(async ({ action }: { action: any }) => ({
    success: true,
    actionType: action?.type ?? 'type',
    elementId: action?.target?.elementId ?? 'elem-search-input',
    actionId: action?.id ?? 'action-1',
    timestamp: 1710000001000
  }))
}));

import {
  runDemoAgentWithProvider,
  MAX_STEPS,
  verifyActionEffect,
  verifyGoalSatisfaction,
  DEFAULT_DEMO_VISION_TIMEOUT_MS
} from './demoRunner.js';
import type { DomPerceptionProvider } from './orchestrator.js';
import type { PageRepresentation } from '../shared/types.js';
import type { ActionTarget, IntendedAction } from '../shared/actions.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_PAGE: PageRepresentation = {
  schemaVersion: '1.0',
  metadata: { title: 'NexMart — Laptops', url: 'file:///nexvision-demo.html' },
  viewport: { width: 1280, height: 800 },
  elements: [
    {
      id: 'elem-search-input',
      role: 'searchbox',
      tagName: 'input',
      accessibleName: 'Search products',
      visibleText: '',
      interactive: true,
      bounds: { x: 80, y: 20, width: 500, height: 40 }
    },
    {
      id: 'elem-search-btn',
      role: 'button',
      tagName: 'button',
      accessibleName: 'Search',
      visibleText: 'Search',
      interactive: true,
      bounds: { x: 590, y: 20, width: 100, height: 40 }
    },
    {
      id: 'elem-heading',
      role: 'heading',
      tagName: 'h1',
      visibleText: 'NexMart',
      interactive: false,
      bounds: { x: 10, y: 5, width: 60, height: 30 }
    }
  ]
};

function makeDomProvider(page: PageRepresentation = MOCK_PAGE): DomPerceptionProvider {
  return async () => page;
}

/**
 * Creates a mock chat client that returns a valid type action for search-input.
 */
function makeSearchClient(text: string = 'laptops') {
  return {
    chat: vi.fn().mockResolvedValue({
      success: true,
      content: JSON.stringify({
        type: 'ACTION',
        targetElementId: 'elem-search-input',
        actionType: 'type',
        payload: { text, pressEnter: true },
        rationale: `Type "${text}" into search box`,
        estimatedProgress: 0.4
      })
    })
  };
}

/**
 * Creates a mock chat client that returns COMPLETED.
 */
function makeCompletedClient() {
  return {
    chat: vi.fn().mockResolvedValue({
      success: true,
      content: JSON.stringify({
        type: 'COMPLETED',
        rationale: 'Search results are visible'
      })
    })
  };
}

/**
 * Creates a mock LocalAgentDriver that uses an injected chat client.
 */
async function makeDriverWithClient(chatClient: { chat: any }) {
  const { LocalAgentDriver } = await import('./localAgent.js');
  return new LocalAgentDriver(chatClient as any);
}

// ---------------------------------------------------------------------------
// Override LocalAgentDriver used inside demoRunner via vi.mock
// ---------------------------------------------------------------------------

// We cannot easily inject the driver into runDemoAgentWithProvider without
// changing its signature. Instead we mock the entire localAgent module.

const { mockProposeStepSpy } = vi.hoisted(() => ({
  mockProposeStepSpy: vi.fn()
}));

vi.mock('./localAgent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./localAgent.js')>();

  // Default export: a driver that proposes a type action for elem-search-input
  class MockLocalAgentDriver {
    readonly name = 'MockLocalAgentDriver';
    async proposeStep(input: any) {
      const custom = mockProposeStepSpy(input);
      if (custom) return custom;
      return {
        status: 'ACTION' as const,
        proposal: {
          targetElementId: 'elem-search-input',
          actionType: 'type' as const,
          payload: { text: 'laptops', pressEnter: true },
          rationale: 'Type search query into search box',
          estimatedProgress: 0.4
        }
      };
    }
  }

  return {
    ...actual,
    LocalAgentDriver: MockLocalAgentDriver
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('demoRunner — runDemoAgentWithProvider integration', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Basic happy path
  // -------------------------------------------------------------------------

  it('completes a single step with DOM-only fallback when llama-server is unavailable', async () => {
    const domProvider = makeDomProvider();
    const result = await runDemoAgentWithProvider(
      1,          // tabId
      1,          // windowId
      'Search for laptops under ₹50,000',
      domProvider
    );

    expect(['COMPLETED', 'MAX_STEPS_REACHED', 'PLAN_FAILED']).toContain(result.status);
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    expect(result.totalSteps).toBe(result.steps.length);
  });

  it('returns at least one step with a valid perception summary', async () => {
    const result = await runDemoAgentWithProvider(
      1, 1, 'Search for laptops under ₹50,000', makeDomProvider()
    );

    const firstStep = result.steps[0];
    expect(firstStep).toBeDefined();
    expect(firstStep.stepIndex).toBe(0);
    expect(firstStep.perception.elementCount).toBeGreaterThan(0);
    expect(firstStep.perception.interactiveCount).toBeGreaterThan(0);
  });

  it('perception summary reports DOM-only path when vision fails', async () => {
    const result = await runDemoAgentWithProvider(
      1, 1, 'Search for laptops under ₹50,000', makeDomProvider()
    );

    // The mock llama-server fails → vision falls back to nullVisionAdapter
    const first = result.steps[0];
    expect(first.perception.visualObservationCount).toBe(0);
    expect(first.perception.visionAdapterName).toMatch(/null|Null/i);
  });

  it('perception includes privacy finding count (synthetic email in footer)', async () => {
    // Page with a synthetic email-like string that the privacy engine should detect
    const pageWithEmail: PageRepresentation = {
      ...MOCK_PAGE,
      elements: [
        ...MOCK_PAGE.elements,
        {
          id: 'elem-support',
          role: 'generic',
          tagName: 'div',
          visibleText: 'support@nexmart-demo.local',
          interactive: false,
          bounds: { x: 10, y: 750, width: 200, height: 20 }
        }
      ]
    };

    const result = await runDemoAgentWithProvider(
      1, 1, 'Search for laptops', async () => pageWithEmail
    );

    // Privacy engine should find at least one finding (email)
    const first = result.steps[0];
    expect(first.perception.privacyFindingCount).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Bounded loop
  // -------------------------------------------------------------------------

  it('never exceeds MAX_STEPS regardless of model behaviour', async () => {
    const result = await runDemoAgentWithProvider(
      1, 1, 'Search for laptops', makeDomProvider()
    );
    expect(result.steps.length).toBeLessThanOrEqual(MAX_STEPS);
  });

  it('MAX_STEPS is 3', () => {
    expect(MAX_STEPS).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Perception failure path
  // -------------------------------------------------------------------------

  it('returns PERCEPTION_FAILED when DOM provider throws', async () => {
    const failingDomProvider: DomPerceptionProvider = async () => {
      throw new Error('Content script not responding');
    };

    const result = await runDemoAgentWithProvider(
      1, 1, 'Search for laptops', failingDomProvider
    );

    expect(result.status).toBe('PERCEPTION_FAILED');
    expect(result.steps).toHaveLength(1);
    expect(result.message).toContain('Content script not responding');
  });

  // -------------------------------------------------------------------------
  // Step structure
  // -------------------------------------------------------------------------

  it('each step has required fields: stepIndex, perception, plan', async () => {
    const result = await runDemoAgentWithProvider(
      1, 1, 'Search for laptops', makeDomProvider()
    );

    for (const step of result.steps) {
      expect(typeof step.stepIndex).toBe('number');
      expect(step.perception).toBeDefined();
      expect(typeof step.perception.elementCount).toBe('number');
      expect(typeof step.perception.interactiveCount).toBe('number');
      expect(step.plan).toBeDefined();
      expect(typeof step.plan.status).toBe('string');
    }
  });

  it('step indices are sequential starting from 0', async () => {
    const result = await runDemoAgentWithProvider(
      1, 1, 'Search for laptops', makeDomProvider()
    );

    result.steps.forEach((step, i) => {
      expect(step.stepIndex).toBe(i);
    });
  });

  // -------------------------------------------------------------------------
  // Empty page — no interactive elements
  // -------------------------------------------------------------------------

  it('returns PLAN_FAILED when page has no interactive elements', async () => {
    const emptyPage: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { title: 'Blank', url: 'about:blank' },
      viewport: { width: 1280, height: 800 },
      elements: [
        {
          id: 'elem-heading',
          role: 'heading',
          visibleText: 'Hello',
          interactive: false,
          bounds: { x: 0, y: 0, width: 100, height: 30 }
        }
      ]
    };

    const result = await runDemoAgentWithProvider(
      1, 1, 'Click something', async () => emptyPage
    );

    expect(result.status).toBe('PLAN_FAILED');
    expect(result.message).toContain('No actionable targets');
  });

  // -------------------------------------------------------------------------
  // Goal description fallback
  // -------------------------------------------------------------------------

  it('uses fallback goal when description is empty string', async () => {
    // Should not throw; empty string is treated gracefully
    const result = await runDemoAgentWithProvider(
      1, 1, '', makeDomProvider()
    );
    // Any result is acceptable — just must not throw
    expect(result).toBeDefined();
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Vision timeout constant & configuration
  // -------------------------------------------------------------------------

  it('DEFAULT_DEMO_VISION_TIMEOUT_MS is 65000ms based on measured latency', () => {
    expect(DEFAULT_DEMO_VISION_TIMEOUT_MS).toBe(65000);
  });

  it('accepts options with custom visionTimeoutMs', async () => {
    const result = await runDemoAgentWithProvider(
      1, 1, 'Search for laptops', makeDomProvider(), undefined, undefined, { visionTimeoutMs: 1000 }
    );
    expect(result).toBeDefined();
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Privacy invariant
  // -------------------------------------------------------------------------

  it('never leaks screenshot bytes or dataUrl into step results or serialization', async () => {
    const result = await runDemoAgentWithProvider(
      1, 1, 'Search for laptops', makeDomProvider()
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('data:image/');
    expect(serialized).not.toContain('base64');
  });

  // -------------------------------------------------------------------------
  // Semantic Post-Action Verification (verifyActionEffect)
  // -------------------------------------------------------------------------

  describe('verifyActionEffect', () => {
    function makeActionTarget(elementId: string): ActionTarget {
      return {
        elementId,
        point: { x: 100, y: 30 },
        viewportBounds: { x: 80, y: 20, width: 500, height: 40 },
        confidence: 0.9,
        observationId: 'dom-1'
      };
    }

    it('verifies type action when target input element reflects typed text', async () => {
      const beforePage = MOCK_PAGE;
      const afterPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            ...MOCK_PAGE.elements[0]!,
            visibleText: 'laptops under 50000'
          },
          ...MOCK_PAGE.elements.slice(1)
        ]
      };

      const action: IntendedAction = {
        id: 'act-1',
        type: 'type',
        target: makeActionTarget('elem-search-input'),
        payload: { text: 'laptops under 50000' }
      };

      const result = await verifyActionEffect(action, beforePage, async () => afterPage, 0);
      expect(result.verified).toBe(true);
      expect(result.message).toContain('Input populated with "laptops under 50000"');
    });

    it('verifies type action with pressEnter when URL changes', async () => {
      const beforePage = MOCK_PAGE;
      const afterPage: PageRepresentation = {
        ...MOCK_PAGE,
        metadata: { title: 'NexMart — Laptops', url: 'file:///nexvision-demo.html?q=laptops' }
      };

      const action: IntendedAction = {
        id: 'act-2',
        type: 'type',
        target: makeActionTarget('elem-search-input'),
        payload: { text: 'laptops', pressEnter: true }
      };

      const result = await verifyActionEffect(action, beforePage, async () => afterPage, 0);
      expect(result.verified).toBe(true);
      expect(result.message).toContain('Search submitted (page URL updated)');
    });

    it('verifies click action when page navigates or title changes', async () => {
      const beforePage = MOCK_PAGE;
      const afterPage: PageRepresentation = {
        ...MOCK_PAGE,
        metadata: { title: 'Product Detail — Dell Inspiron', url: 'file:///product/1' }
      };

      const action: IntendedAction = {
        id: 'act-3',
        type: 'click',
        target: makeActionTarget('elem-search-btn')
      };

      const result = await verifyActionEffect(action, beforePage, async () => afterPage, 0);
      expect(result.verified).toBe(true);
      expect(result.message).toContain('Navigated to file:///product/1');
    });

    it('verifies click action when new DOM elements appear', async () => {
      const beforePage = MOCK_PAGE;
      const afterPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          ...MOCK_PAGE.elements,
          {
            id: 'elem-dropdown-item',
            role: 'option',
            tagName: 'div',
            visibleText: 'Laptops in Electronics',
            interactive: true,
            bounds: { x: 80, y: 60, width: 500, height: 30 }
          }
        ]
      };

      const action: IntendedAction = {
        id: 'act-4',
        type: 'click',
        target: makeActionTarget('elem-search-btn')
      };

      const result = await verifyActionEffect(action, beforePage, async () => afterPage, 0);
      expect(result.verified).toBe(true);
      expect(result.message).toContain('1 new element(s) observed');
    });

    it('reports failure when domProvider throws during re-perception', async () => {
      const action: IntendedAction = {
        id: 'act-5',
        type: 'click',
        target: makeActionTarget('elem-search-btn')
      };

      const result = await verifyActionEffect(
        action,
        MOCK_PAGE,
        async () => { throw new Error('Tab crashed'); },
        0
      );
      expect(result.verified).toBe(false);
      expect(result.message).toContain('Re-perception failed');
    });
  });

  // -------------------------------------------------------------------------
  // Safe Action History & Multi-Step Progression
  // -------------------------------------------------------------------------

  describe('Safe action history preservation and progression', () => {
    it('forwards safe action history from step 0 into step 1 planner input', async () => {
      mockProposeStepSpy.mockReset();
      // On step 0 propose click; on step 1 propose COMPLETED
      let callCount = 0;
      mockProposeStepSpy.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 'ACTION' as const,
            proposal: {
              targetElementId: 'elem-search-input',
              actionType: 'click' as const,
              rationale: 'Initial click to activate searchbox'
            }
          };
        }
        return {
          status: 'COMPLETED' as const,
          summary: 'Goal completed after search'
        };
      });

      const result = await runDemoAgentWithProvider(
        1, 1, 'Search for laptops', makeDomProvider()
      );

      expect(result.status).toBe('COMPLETED');
      expect(result.steps.length).toBe(2);

      // Verify that step 1 received history from step 0
      expect(mockProposeStepSpy).toHaveBeenCalledTimes(2);
      const step0Input = mockProposeStepSpy.mock.calls[0][0];
      const step1Input = mockProposeStepSpy.mock.calls[1][0];

      expect(step0Input.history).toHaveLength(0);
      expect(step1Input.history).toBeDefined();
      expect(step1Input.history).toHaveLength(1);
      expect(step1Input.history[0].stepIndex).toBe(0);
      expect(step1Input.history[0].action.type).toBe('click');
      expect(step1Input.history[0].action.target.elementId).toBe('elem-search-input');
      expect(step1Input.history[0].perceivedOutcome).toBe('success');
    });

    it('strips typed text from executed action before persisting in demoRunner history', async () => {
      mockProposeStepSpy.mockReset();
      let callCount = 0;
      mockProposeStepSpy.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 'ACTION' as const,
            proposal: {
              targetElementId: 'elem-search-input',
              actionType: 'type' as const,
              payload: { text: 'secret_user_query', pressEnter: true },
              rationale: 'Type search query'
            }
          };
        }
        return {
          status: 'COMPLETED' as const,
          summary: 'Goal completed'
        };
      });

      const result = await runDemoAgentWithProvider(
        1, 1, 'Search for laptops', makeDomProvider()
      );

      expect(result.status).toBe('COMPLETED');
      expect(mockProposeStepSpy).toHaveBeenCalledTimes(2);

      const step1Input = mockProposeStepSpy.mock.calls[1][0];
      expect(step1Input.history).toHaveLength(1);
      const histStep = step1Input.history[0];
      expect(histStep.action.type).toBe('type');
      // In-memory action payload text must be stripped (empty string) to prevent retention of typed values
      expect((histStep.action as any).payload?.text).toBe('');
      expect(JSON.stringify(histStep)).not.toContain('secret_user_query');
    });

    it('resets action history between separate agent runs', async () => {
      mockProposeStepSpy.mockReset();
      // Run 1: completes in 1 step
      mockProposeStepSpy.mockImplementation(() => ({
        status: 'COMPLETED' as const,
        summary: 'Run 1 completed'
      }));

      await runDemoAgentWithProvider(1, 1, 'Run 1', makeDomProvider(), undefined, 'run-1');
      expect(mockProposeStepSpy).toHaveBeenCalledTimes(1);
      expect(mockProposeStepSpy.mock.calls[0][0].history).toHaveLength(0);

      // Run 2: start separate run
      mockProposeStepSpy.mockReset();
      mockProposeStepSpy.mockImplementation(() => ({
        status: 'COMPLETED' as const,
        summary: 'Run 2 completed'
      }));

      await runDemoAgentWithProvider(1, 1, 'Run 2', makeDomProvider(), undefined, 'run-2');
      expect(mockProposeStepSpy).toHaveBeenCalledTimes(1);
      // Run 2 must start with empty history, not retaining Run 1 state
      expect(mockProposeStepSpy.mock.calls[0][0].history).toHaveLength(0);
    });

    it('progresses from CLICK in step 0 to TYPE in step 1 and completes', async () => {
      mockProposeStepSpy.mockReset();
      mockProposeStepSpy.mockImplementation((input: any) => {
        // If no history, propose click to activate
        if (!input.history || input.history.length === 0) {
          return {
            status: 'ACTION' as const,
            proposal: {
              targetElementId: 'elem-search-input',
              actionType: 'click' as const,
              rationale: 'Activate search input'
            }
          };
        }
        // If history contains prior click, progress to type
        const prevAction = input.history[0]?.action;
        if (prevAction?.type === 'click' && prevAction?.target?.elementId === 'elem-search-input') {
          return {
            status: 'ACTION' as const,
            proposal: {
              targetElementId: 'elem-search-input',
              actionType: 'type' as const,
              payload: { text: 'laptops under 50000', pressEnter: true },
              rationale: 'Type search text and press Enter'
            }
          };
        }
        return {
          status: 'COMPLETED' as const,
          summary: 'Search completed'
        };
      });

      const result = await runDemoAgentWithProvider(
        1, 1, 'Search for laptops under ₹50,000', makeDomProvider()
      );

      expect(result.steps.length).toBeGreaterThanOrEqual(2);
      expect(result.steps[0].plan.actionType).toBe('click');
      expect(result.steps[1].plan.actionType).toBe('type');
    });
  });

  describe('Phase 7 — Deterministic Goal Completion', () => {
    it('1. verifyGoalSatisfaction returns false when action verification fails', () => {
      const goal = { id: 'g1', description: 'Search for books', intent: 'search' };
      const action: IntendedAction = {
        id: 'a1',
        type: 'type',
        target: {
          elementId: 'elem-search-input',
          point: { x: 100, y: 100 },
          viewportBounds: { x: 80, y: 80, width: 200, height: 40 },
          confidence: 0.9,
          observationId: 'obs-1'
        },
        payload: { text: 'books', pressEnter: true }
      };
      const beforePage = MOCK_PAGE;
      const afterPage = MOCK_PAGE;
      const verification = { verified: false, message: 'Re-perception failed' };

      const res = verifyGoalSatisfaction(goal, action, beforePage, afterPage, verification);
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toBe('Action effect was not verified');
    });

    it('2. Search: submitted action + verified result-state evidence -> satisfied: true', () => {
      const goal = { id: 'g2', description: 'Search for electronics', intent: 'search' };
      const action: IntendedAction = {
        id: 'a2',
        type: 'type',
        target: {
          elementId: 'elem-search-input',
          point: { x: 100, y: 100 },
          viewportBounds: { x: 80, y: 80, width: 200, height: 40 },
          confidence: 0.9,
          observationId: 'obs-2'
        },
        payload: { text: 'electronics', pressEnter: true }
      };
      const beforePage = MOCK_PAGE;
      const afterPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://generic-store.test/search?q=electronics', title: 'Search Results' },
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'elem-heading-results',
            role: 'heading',
            tagName: 'h2',
            visibleText: 'Search Results for electronics',
            interactive: false
          }
        ]
      };
      const verification = { verified: true, message: 'Search submitted (page URL updated)' };

      const res = verifyGoalSatisfaction(goal, action, beforePage, afterPage, verification);
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Search submitted and verified result-state observed');
    });

    it('3. Search: type without submission -> satisfied: false', () => {
      const goal = { id: 'g3', description: 'Search for cameras', intent: 'search' };
      const action: IntendedAction = {
        id: 'a3',
        type: 'type',
        target: {
          elementId: 'elem-search-input',
          point: { x: 100, y: 100 },
          viewportBounds: { x: 80, y: 80, width: 200, height: 40 },
          confidence: 0.9,
          observationId: 'obs-3'
        },
        payload: { text: 'cameras', pressEnter: false }
      };
      const beforePage = MOCK_PAGE;
      const afterPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: 'elem-search-input',
            role: 'searchbox',
            tagName: 'input',
            attributes: { value: 'cameras' },
            interactive: true
          }
        ]
      };
      const verification = { verified: true, message: 'Input populated with "cameras"' };

      const res = verifyGoalSatisfaction(goal, action, beforePage, afterPage, verification);
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('not submitted');
    });

    it('4. Search: submission causes URL change but no reliable result-state evidence -> satisfied: false', () => {
      const goal = { id: 'g4', description: 'Search for headphones', intent: 'search' };
      const action: IntendedAction = {
        id: 'a4',
        type: 'type',
        target: {
          elementId: 'elem-search-input',
          point: { x: 100, y: 100 },
          viewportBounds: { x: 80, y: 80, width: 200, height: 40 },
          confidence: 0.9,
          observationId: 'obs-4'
        },
        payload: { text: 'headphones', pressEnter: true }
      };
      const beforePage = MOCK_PAGE;
      const afterPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://generic-store.test/redirect', title: 'Loading' },
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'elem-spinner',
            role: 'generic',
            tagName: 'div',
            visibleText: 'Loading...',
            interactive: false
          }
        ]
      };
      const verification = { verified: true, message: 'Search submitted (page URL updated)' };

      const res = verifyGoalSatisfaction(goal, action, beforePage, afterPage, verification);
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('does not contain reliable search result evidence');
    });

    it('5. Input/type goal: verified target value/state -> satisfied: true', () => {
      const goal = { id: 'g5', description: 'Enter username into form', intent: 'type' };
      const action: IntendedAction = {
        id: 'a5',
        type: 'type',
        target: {
          elementId: 'elem-user-input',
          point: { x: 100, y: 100 },
          viewportBounds: { x: 80, y: 80, width: 200, height: 40 },
          confidence: 0.9,
          observationId: 'obs-5'
        },
        payload: { text: 'johndoe' }
      };
      const beforePage = MOCK_PAGE;
      const afterPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'file:///form.html', title: 'Login' },
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'elem-user-input',
            role: 'textbox',
            tagName: 'input',
            attributes: { value: 'johndoe' },
            interactive: true
          }
        ]
      };
      const verification = { verified: true, message: 'Input populated with "johndoe"' };

      const res = verifyGoalSatisfaction(goal, action, beforePage, afterPage, verification);
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toBe('Target input element populated and verified');
    });

    it('6. runDemoAgentWithProvider: goal becomes satisfied on step 1 -> status COMPLETED, stops immediately, does not execute another step', async () => {
      mockProposeStepSpy.mockReset();
      mockProposeStepSpy.mockImplementation((input: any) => {
        if (!input.history || input.history.length === 0) {
          return {
            status: 'ACTION' as const,
            proposal: {
              targetElementId: 'elem-search-input',
              actionType: 'click' as const,
              rationale: 'Focus search bar'
            }
          };
        }
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'elem-search-input',
            actionType: 'type' as const,
            payload: { text: 'shoes', pressEnter: true },
            rationale: 'Type query and submit'
          }
        };
      });

      let callCount = 0;
      const stepAwareProvider: DomPerceptionProvider = async () => {
        callCount++;
        // Re-perception after step 1 execution (callCount >= 4: step 0 initial, step 0 re-perceive, step 1 initial, step 1 re-perceive)
        if (callCount >= 4) {
          return {
            schemaVersion: '1.0',
            metadata: { url: 'https://store.example/search?q=shoes', title: 'Search Results' },
            viewport: { width: 1280, height: 800 },
            elements: [
              ...MOCK_PAGE.elements,
              {
                id: 'res-heading',
                role: 'heading',
                tagName: 'h1',
                visibleText: 'Search Results for shoes',
                interactive: false
              }
            ]
          };
        }
        return MOCK_PAGE;
      };

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Search for shoes',
        stepAwareProvider,
        undefined,
        'test-run-step1-completion',
        { verificationSettleMs: 0 }
      );

      expect(result.status).toBe('COMPLETED');
      expect(result.totalSteps).toBe(2);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].plan.actionType).toBe('click');
      expect(result.steps[1].plan.actionType).toBe('type');
    });

    it('7. Unsatisfied goal continues until MAX_STEPS', async () => {
      mockProposeStepSpy.mockReset();
      mockProposeStepSpy.mockReturnValue({
        status: 'ACTION' as const,
        proposal: {
          targetElementId: 'elem-search-btn',
          actionType: 'click' as const,
          rationale: 'Click button'
        }
      });

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Search for widgets',
        makeDomProvider(),
        undefined,
        'test-run-unsatisfied',
        { verificationSettleMs: 0 }
      );

      expect(result.status).toBe('MAX_STEPS_REACHED');
      expect(result.totalSteps).toBe(MAX_STEPS);
      expect(result.steps).toHaveLength(MAX_STEPS);
    });

    it('8. Completion state does not leak between independent runs', async () => {
      mockProposeStepSpy.mockReset();
      mockProposeStepSpy.mockReturnValue({
        status: 'ACTION' as const,
        proposal: {
          targetElementId: 'elem-search-input',
          actionType: 'type' as const,
          payload: { text: 'test query', pressEnter: true },
          rationale: 'Search'
        }
      });

      const satisfyingProvider: DomPerceptionProvider = async () => ({
        schemaVersion: '1.0',
        metadata: { url: 'https://store.example/search', title: 'Results' },
        viewport: { width: 1280, height: 800 },
        elements: [
          ...MOCK_PAGE.elements,
          {
            id: 'h-res',
            role: 'heading',
            visibleText: 'Results',
            interactive: false
          }
        ]
      });

      const run1 = await runDemoAgentWithProvider(
        1,
        1,
        'Search for test query',
        satisfyingProvider,
        undefined,
        'run-1-isolated',
        { verificationSettleMs: 0 }
      );
      expect(run1.status).toBe('COMPLETED');
      expect(run1.totalSteps).toBe(1);

      const run2 = await runDemoAgentWithProvider(
        1,
        1,
        'Search for test query',
        makeDomProvider(),
        undefined,
        'run-2-isolated',
        { verificationSettleMs: 0 }
      );
      expect(run2.status).toBe('MAX_STEPS_REACHED');
      expect(run2.totalSteps).toBe(MAX_STEPS);
    });

    it('9. No website-specific assumptions: works with arbitrary generic tag names and roles', () => {
      const goal = { id: 'g9', description: 'Search for articles', intent: 'search' };
      const action: IntendedAction = {
        id: 'a9',
        type: 'click',
        target: {
          elementId: 'btn-go',
          point: { x: 50, y: 50 },
          viewportBounds: { x: 40, y: 40, width: 20, height: 20 },
          confidence: 0.95,
          observationId: 'obs-go',
          role: 'button'
        }
      };
      const beforePage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example-domain.org/', title: 'Portal' },
        viewport: { width: 1024, height: 768 },
        elements: [
          {
            id: 'btn-go',
            role: 'button',
            tagName: 'button',
            visibleText: 'Search',
            interactive: true
          }
        ]
      };
      const afterPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example-domain.org/items', title: 'Articles' },
        viewport: { width: 1024, height: 768 },
        elements: [
          {
            id: 'container-results',
            role: 'container',
            tagName: 'section',
            attributes: { class: 'search-results' },
            childIds: ['item-1', 'item-2'],
            interactive: false
          },
          {
            id: 'item-1',
            role: 'option',
            tagName: 'article',
            visibleText: 'First Article',
            interactive: true
          }
        ]
      };
      const verification = { verified: true, message: 'Click interaction confirmed on btn-go' };

      const res = verifyGoalSatisfaction(goal, action, beforePage, afterPage, verification);
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Search submitted and verified result-state observed');
    });
  });
});
