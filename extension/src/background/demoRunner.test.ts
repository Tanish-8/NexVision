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
  verifyPhaseMilestone,
  calculateDynamicStepBudget,
  MIN_STEP_BUDGET,
  MAX_STEP_BUDGET,
  MAX_PHASE_RETRIES,
  DEFAULT_DEMO_VISION_TIMEOUT_MS,
  hasSufficientDomTargets,
  DOM_SUFFICIENT_INTERACTIVE_THRESHOLD,
  isCompoundSearchGoal,
  isPostSearchPhase,
  hasSearchResultEvidence,
  verifyWholeGoalOutcome,
  isPhaseAlreadySatisfied,
  type DemoStepVerification
} from './demoRunner.js';
import type { DomPerceptionProvider } from './orchestrator.js';
import type { PageRepresentation } from '../shared/types.js';
import type { PlannerGoal, PlannerHistoryStep, TaskPlan, TaskPhase, PhaseExecutionState } from '../shared/planner.js';
import type { ActionTarget, IntendedAction } from '../shared/actions.js';
import { sanitizePageRepresentation } from '../privacy/sanitizer.js';

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

  // ---------------------------------------------------------------------------
  // Phase 8 — DOM-Sufficient Vision Skip
  // ---------------------------------------------------------------------------

  describe('Phase 8 — DOM-sufficient vision skip', () => {

    it('1. hasSufficientDomTargets: true when DOM has ≥1 interactive bounded element', () => {
      const page: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {},
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'e1',
            role: 'searchbox',
            interactive: true,
            bounds: { x: 10, y: 10, width: 200, height: 40 }
          }
        ]
      };
      expect(hasSufficientDomTargets(page)).toBe(true);
    });

    it('2. hasSufficientDomTargets: false when no interactive elements', () => {
      const page: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {},
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'h1',
            role: 'heading',
            interactive: false,
            bounds: { x: 10, y: 10, width: 200, height: 40 }
          }
        ]
      };
      expect(hasSufficientDomTargets(page)).toBe(false);
    });

    it('3. hasSufficientDomTargets: false when interactive elements have zero-size bounds', () => {
      const page: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {},
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'e-hidden',
            role: 'button',
            interactive: true,
            bounds: { x: 0, y: 0, width: 0, height: 0 }
          }
        ]
      };
      expect(hasSufficientDomTargets(page)).toBe(false);
    });

    it('4. hasSufficientDomTargets: false when interactive elements have no bounds at all', () => {
      const page: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {},
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'e-no-bounds',
            role: 'button',
            interactive: true
            // no bounds property
          }
        ]
      };
      expect(hasSufficientDomTargets(page)).toBe(false);
    });

    it('5. hasSufficientDomTargets: respects custom threshold (threshold=3 requires 3 usable targets)', () => {
      const make = (id: string, interactive: boolean, w = 100): PageRepresentation['elements'][number] => ({
        id,
        role: 'button',
        interactive,
        bounds: { x: 0, y: 0, width: w, height: 40 }
      });
      const twoTargets: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {},
        viewport: { width: 1280, height: 800 },
        elements: [make('a', true), make('b', true)]
      };
      const threeTargets: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {},
        viewport: { width: 1280, height: 800 },
        elements: [make('a', true), make('b', true), make('c', true)]
      };
      expect(hasSufficientDomTargets(twoTargets, 3)).toBe(false);
      expect(hasSufficientDomTargets(threeTargets, 3)).toBe(true);
    });

    it('6. DOM_SUFFICIENT_INTERACTIVE_THRESHOLD is exported and equals 1', () => {
      expect(DOM_SUFFICIENT_INTERACTIVE_THRESHOLD).toBe(1);
    });

    it('7. runDemoAgentWithProvider uses DOM-only perception (visionAdapterName NullVisionAdapter) when DOM has sufficient targets', async () => {
      // MOCK_PAGE has 2 interactive bounded elements, so DOM is sufficient.
      // The mock llamaVisionAdapter would return a failure, but it should NOT
      // be called at all when DOM is sufficient.
      // The visionAdapterName in perceptionSummary should be 'NullVisionAdapter'.
      const progressEvents: any[] = [];
      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Search for laptops',
        makeDomProvider(MOCK_PAGE),
        (e) => progressEvents.push(e),
        'run-dom-sufficient',
        { verificationSettleMs: 0 }
      );

      // The agent should run without vision timeout
      expect(result.status).not.toBe('PERCEPTION_FAILED');

      // perceptionSummary.visionAdapterName should reflect NullVisionAdapter
      const perceptionStep = result.steps[0];
      expect(perceptionStep.perception.visionAdapterName).toBe('NullVisionAdapter');

      // The DOM elements must still be returned (elementCount unchanged)
      expect(perceptionStep.perception.elementCount).toBeGreaterThan(0);
      expect(perceptionStep.perception.interactiveCount).toBeGreaterThan(0);

      // A skip-vision progress event must have been emitted
      const skipEvent = progressEvents.find(
        (e) => e.phase === 'perception' && typeof e.message === 'string' && e.message.includes('skipping vision')
      );
      expect(skipEvent).toBeDefined();
    });

    it('8. runDemoAgentWithProvider still uses vision when DOM has zero interactive bounded targets', async () => {
      // Page with only non-interactive elements — DOM is insufficient
      const emptyPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { title: 'Empty', url: 'about:blank' },
        viewport: { width: 1280, height: 800 },
        elements: [
          { id: 'h1', role: 'heading', interactive: false, bounds: { x: 0, y: 0, width: 200, height: 30 } }
        ]
      };
      const progressEvents: any[] = [];

      // With zero interactive targets and the mocked vision adapter returning failure,
      // the system will attempt vision (createLlamaVisionAdapter) and then fall back
      // to NullVisionAdapter. The key proof is that NO 'skipping vision' event is emitted.
      await runDemoAgentWithProvider(
        1,
        1,
        'Search for laptops',
        makeDomProvider(emptyPage),
        (e) => progressEvents.push(e),
        'run-dom-insufficient',
        { verificationSettleMs: 0 }
      );

      const skipEvent = progressEvents.find(
        (e) => e.phase === 'perception' && typeof e.message === 'string' && e.message.includes('skipping vision')
      );
      // No skip event: vision was attempted (then fell back to DOM after mock failure)
      expect(skipEvent).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 9 — Compound Goal Detection
  // ---------------------------------------------------------------------------

  describe('Phase 9 — Compound goal detection', () => {

    // ---- isCompoundSearchGoal unit tests (pure predicate) ----

    it('1. Search-only goal: "Search for X" is NOT compound', () => {
      expect(isCompoundSearchGoal('Search for laptops under ₹50,000')).toBe(false);
      expect(isCompoundSearchGoal('Search YouTube for MrBeast')).toBe(false);
      expect(isCompoundSearchGoal('Find headphones on Amazon')).toBe(false);
      expect(isCompoundSearchGoal('Look up the latest news')).toBe(false);
    });

    it('2. Compound search+play goal is detected', () => {
      expect(isCompoundSearchGoal('search for mr beast and play I Built A City To Save Kids')).toBe(true);
      expect(isCompoundSearchGoal('Search YouTube for MrBeast and play the first video')).toBe(true);
      expect(isCompoundSearchGoal('find the tutorial video and watch it')).toBe(true);
    });

    it('3. Compound search+open goal is detected', () => {
      expect(isCompoundSearchGoal('Search for laptops and open the first result')).toBe(true);
      expect(isCompoundSearchGoal('find the article and open it')).toBe(true);
    });

    it('4. Compound search+navigate goal is detected', () => {
      expect(isCompoundSearchGoal('search for X and navigate to the result')).toBe(true);
      expect(isCompoundSearchGoal('Search and go to the product page')).toBe(true);
    });

    it('5. Compound search+click goal is detected', () => {
      expect(isCompoundSearchGoal('Search for laptops and click the top result')).toBe(true);
      expect(isCompoundSearchGoal('find the video and select it')).toBe(true);
    });

    it('6. Non-search compound (no search clause) is NOT compound search', () => {
      // "watch" alone without search clause
      expect(isCompoundSearchGoal('Watch a video on YouTube')).toBe(false);
      // "open" alone
      expect(isCompoundSearchGoal('Open the settings page')).toBe(false);
    });

    // ---- verifyGoalSatisfaction integration tests ----

    // Shared fixtures for goal-verification tests
    const searchAction: IntendedAction = {
      id: 'a-search',
      type: 'type',
      target: {
        elementId: 'elem-search-input',
        point: { x: 100, y: 100 },
        viewportBounds: { x: 80, y: 80, width: 200, height: 40 },
        confidence: 0.9,
        observationId: 'obs-s'
      },
      payload: { text: 'mr beast', pressEnter: true }
    };

    const resultsPage: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'https://www.youtube.com/results?search_query=mr+beast', title: 'mr beast - YouTube' },
      viewport: { width: 1280, height: 800 },
      elements: [
        {
          id: 'search-results-container',
          role: 'region',
          tagName: 'ul',
          attributes: { class: 'search-results' },
          childIds: ['video-item-1', 'video-item-2'],
          interactive: false
        },
        {
          id: 'video-item-1',
          role: 'link',
          tagName: 'a',
          visibleText: 'I Built A City To Save Kids From Illegal Labor',
          interactive: true,
          bounds: { x: 10, y: 100, width: 400, height: 80 }
        },
        {
          id: 'video-item-2',
          role: 'link',
          tagName: 'a',
          visibleText: 'MrBeast - Another Video',
          interactive: true,
          bounds: { x: 10, y: 200, width: 400, height: 80 }
        }
      ]
    };

    const verifiedSubmission = { verified: true, message: 'Search submitted (page URL updated)' };

    it('7. Search-only goal + result evidence -> satisfied:true (existing behavior preserved)', () => {
      const goal = { id: 'g-so', description: 'Search for MrBeast', intent: 'search' as const };
      const res = verifyGoalSatisfaction(goal, searchAction, MOCK_PAGE, resultsPage, verifiedSubmission);
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Search submitted and verified result-state observed');
    });

    it('8. Compound search+play goal + result evidence -> satisfied:false (premature completion blocked)', () => {
      const goal = {
        id: 'g-cp',
        description: 'search for mr beast and play I Built A City To Save Kids From Illegal Labor'
      };
      const res = verifyGoalSatisfaction(goal, searchAction, MOCK_PAGE, resultsPage, verifiedSubmission);
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('compound goal');
    });

    it('9. Compound search+open goal + result evidence -> satisfied:false', () => {
      const goal = { id: 'g-co', description: 'Search for laptops and open the first result' };
      const res = verifyGoalSatisfaction(goal, searchAction, MOCK_PAGE, resultsPage, verifiedSubmission);
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('compound goal');
    });

    it('10. Compound search+navigate goal + result evidence -> satisfied:false', () => {
      const goal = { id: 'g-cn', description: 'Search for X and navigate to the result' };
      const res = verifyGoalSatisfaction(goal, searchAction, MOCK_PAGE, resultsPage, verifiedSubmission);
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('compound goal');
    });

    it('11. ShopSphere search-only ("Search for laptops under ₹50,000") + result evidence -> still satisfied:true (no regression)', () => {
      const goal = { id: 'g-shop', description: 'Search for laptops under ₹50,000', intent: 'search' as const };
      const shopResultsPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://shopsphere.example/products?keyword=laptops', title: 'Search Results' },
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'results-heading',
            role: 'heading',
            tagName: 'h1',
            visibleText: 'Search Results for laptops',
            interactive: false
          },
          {
            id: 'product-1',
            role: 'link',
            tagName: 'a',
            visibleText: 'Laptop A',
            interactive: true,
            bounds: { x: 10, y: 100, width: 300, height: 60 }
          }
        ]
      };
      const res = verifyGoalSatisfaction(goal, searchAction, MOCK_PAGE, shopResultsPage, verifiedSubmission);
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Search submitted and verified result-state observed');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 10 — Compound goal progression and terminal verification
  // -------------------------------------------------------------------------

  describe('Phase 10 — Compound goal progression and terminal verification', () => {
    // Generic fixtures ensuring complete website independence (Requirement H)
    const GENERIC_SEARCH_ACTION: IntendedAction = {
      id: 'a-search-10',
      type: 'type',
      target: {
        elementId: 'elem-search-input',
        point: { x: 100, y: 20 },
        viewportBounds: { x: 80, y: 20, width: 200, height: 40 },
        confidence: 0.9,
        observationId: 'obs-s10'
      },
      payload: { text: 'alpha query', pressEnter: true }
    };

    const GENERIC_CLICK_ACTION: IntendedAction = {
      id: 'a-click-10',
      type: 'click',
      target: {
        elementId: 'result-link-1',
        point: { x: 200, y: 150 },
        viewportBounds: { x: 10, y: 100, width: 400, height: 80 },
        confidence: 0.95,
        observationId: 'obs-c10'
      }
    };

    const GENERIC_SEARCH_RESULTS_PAGE: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'https://example.com/search?q=alpha', title: 'Search Results' },
      viewport: { width: 1280, height: 800 },
      elements: [
        {
          id: 'results-container',
          role: 'region',
          tagName: 'section',
          attributes: { class: 'search-results' },
          childIds: ['result-link-1'],
          interactive: false
        },
        {
          id: 'result-link-1',
          role: 'link',
          tagName: 'a',
          visibleText: 'Destination Beta Item',
          interactive: true,
          bounds: { x: 10, y: 100, width: 400, height: 80 }
        }
      ]
    };

    const GENERIC_NAVIGATED_DESTINATION_PAGE: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'https://example.com/items/beta', title: 'Destination Beta Item' },
      viewport: { width: 1280, height: 800 },
      elements: [
        {
          id: 'heading-title',
          role: 'heading',
          tagName: 'h1',
          visibleText: 'Destination Beta Item',
          interactive: false
        },
        {
          id: 'action-button',
          role: 'button',
          tagName: 'button',
          visibleText: 'Start Action',
          interactive: true,
          bounds: { x: 10, y: 100, width: 120, height: 40 }
        }
      ]
    };

    const GENERIC_URL_ONLY_PAGE: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'https://example.com/items/beta' },
      viewport: { width: 1280, height: 800 },
      elements: []
    };

    const verifiedSubmission = { verified: true, message: 'Search submitted' };
    const verifiedClick = { verified: true, message: 'Click verified' };

    it('A. Compound search does not complete after search alone', () => {
      const goal = { id: 'g-comp', description: 'search for alpha and play beta', intent: 'custom' };
      const res = verifyGoalSatisfaction(goal, GENERIC_SEARCH_ACTION, MOCK_PAGE, GENERIC_SEARCH_RESULTS_PAGE, verifiedSubmission);
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('compound goal');
    });

    it('B. Post-search phase detection identifies verified type+pressEnter action', () => {
      const historyWithSearch: PlannerHistoryStep[] = [
        {
          stepIndex: 0,
          action: {
            id: 'a1',
            type: 'type',
            target: {
              elementId: 'elem-search-input',
              point: { x: 100, y: 20 },
              viewportBounds: { x: 80, y: 20, width: 200, height: 40 },
              confidence: 0.9,
              observationId: 'obs-1'
            },
            payload: { text: '', pressEnter: true }
          },
          perceivedOutcome: 'success'
        }
      ];

      expect(isPostSearchPhase(historyWithSearch)).toBe(true);
      expect(isPostSearchPhase([])).toBe(false);
      expect(isPostSearchPhase(undefined)).toBe(false);

      // Fails when not type
      const clickAction: IntendedAction = { id: 'c1', type: 'click', target: historyWithSearch[0].action.target };
      expect(isPostSearchPhase([{ stepIndex: 0, action: clickAction, perceivedOutcome: 'success' }])).toBe(false);

      // Fails when pressEnter is false
      const noEnterAction: IntendedAction = {
        id: 'a-no-enter',
        type: 'type',
        target: historyWithSearch[0].action.target,
        payload: { text: '', pressEnter: false }
      };
      expect(isPostSearchPhase([{ stepIndex: 0, action: noEnterAction, perceivedOutcome: 'success' }])).toBe(false);

      // Fails when outcome is not success
      expect(isPostSearchPhase([{ ...historyWithSearch[0], perceivedOutcome: 'no_change' }])).toBe(false);
    });

    it('C & E. Compound planner intent transitions from custom to click after successful search, preventing search repetition', async () => {
      const stepIntents: string[] = [];

      let domCallCount = 0;
      const compoundDomProvider: DomPerceptionProvider = async () => {
        domCallCount++;
        // Call 1: Step 0 perception (initial page)
        // Call 2: Step 0 verification (search results page)
        // Call 3: Step 1 perception (search results page)
        // Call 4+: Step 1 verification (navigated destination page)
        if (domCallCount === 1) {
          return MOCK_PAGE;
        }
        if (domCallCount <= 3) {
          return GENERIC_SEARCH_RESULTS_PAGE;
        }
        return GENERIC_NAVIGATED_DESTINATION_PAGE;
      };

      mockProposeStepSpy.mockImplementation((input: any) => {
        stepIntents.push(input.goal.intent);
        if (input.context.stepIndex === 0) {
          return {
            status: 'ACTION' as const,
            proposal: {
              targetElementId: 'elem-search-input',
              actionType: 'type' as const,
              payload: { text: 'alpha query', pressEnter: true },
              rationale: 'Execute search for alpha'
            }
          };
        }
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'result-link-1',
            actionType: 'click' as const,
            rationale: 'Select destination result link'
          }
        };
      });

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'search for alpha and play beta',
        compoundDomProvider
      );

      // Step 0 received intent 'custom'
      expect(stepIntents[0]).toBe('custom');
      // Step 1 transitioned to intent 'click'
      expect(stepIntents[1]).toBe('click');
      // Succeeded within MAX_STEPS = 3
      expect(result.status).toBe('COMPLETED');
      expect(result.totalSteps).toBe(2);
    });

    it('D. Search-only regression: "Search for laptops under ₹50,000" completes in step 0', () => {
      const goal = { id: 'g-search', description: 'Search for laptops under ₹50,000', intent: 'search' as const };
      const res = verifyGoalSatisfaction(goal, GENERIC_SEARCH_ACTION, MOCK_PAGE, GENERIC_SEARCH_RESULTS_PAGE, verifiedSubmission);
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Search submitted and verified result-state observed');
    });

    it('F. Compound CLICK completion: verified click + genuine URL change + structural content completes', () => {
      const goal = { id: 'g-comp', description: 'search for alpha and play beta', intent: 'click' as const };
      const res = verifyGoalSatisfaction(
        goal,
        GENERIC_CLICK_ACTION,
        GENERIC_SEARCH_RESULTS_PAGE,
        GENERIC_NAVIGATED_DESTINATION_PAGE,
        verifiedClick
      );
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Post-search click completed navigation');
      expect(res.rationale).toContain('actual playback verification not supported');
    });

    it('G. URL-only rejection: click + URL changed without structural content does NOT complete', () => {
      const goal = { id: 'g-comp', description: 'search for alpha and play beta', intent: 'click' as const };
      const res = verifyGoalSatisfaction(
        goal,
        GENERIC_CLICK_ACTION,
        GENERIC_SEARCH_RESULTS_PAGE,
        GENERIC_URL_ONLY_PAGE,
        verifiedClick
      );
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('lacks sufficient structural page content');
    });

    it('H. Website independence: verification works purely generically with no website-specific logic', () => {
      const genericGoal = { id: 'g-gen', description: 'find report and open summary item' };
      const destinationPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://anyportal.org/documents/summary-42', title: 'Document Summary' },
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'doc-heading',
            role: 'heading',
            tagName: 'h2',
            visibleText: 'Summary Report 42',
            interactive: false
          },
          {
            id: 'doc-content',
            role: 'region',
            tagName: 'article',
            visibleText: 'Report contents here.',
            interactive: false
          }
        ]
      };

      const res = verifyGoalSatisfaction(
        genericGoal,
        GENERIC_CLICK_ACTION,
        GENERIC_SEARCH_RESULTS_PAGE,
        destinationPage,
        verifiedClick
      );
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Post-search click completed navigation');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 11 — Post-search compound click completion & search-result rejection
  // -------------------------------------------------------------------------

  describe('Phase 11 — Post-search compound click completion & search-result rejection', () => {
    const verifiedClick = { verified: true, message: 'Click verified' };
    const verifiedSubmission = { verified: true, message: 'Search submitted' };

    const GENERIC_CLICK_ACTION: IntendedAction = {
      id: 'a-click-11',
      type: 'click',
      target: {
        elementId: 'result-link-1',
        point: { x: 200, y: 150 },
        viewportBounds: { x: 10, y: 100, width: 400, height: 80 },
        confidence: 0.95,
        observationId: 'obs-c11'
      }
    };

    const SEARCH_RESULTS_PAGE_ORIGINAL: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'https://example.com/search?q=alpha', title: 'Search Results for alpha' },
      viewport: { width: 1280, height: 800 },
      elements: [
        {
          id: 'results-heading',
          role: 'heading',
          tagName: 'h1',
          visibleText: 'Search results for alpha',
          interactive: false
        },
        {
          id: 'result-link-1',
          role: 'link',
          tagName: 'a',
          visibleText: 'Target Destination Item',
          interactive: true,
          bounds: { x: 10, y: 100, width: 400, height: 80 }
        }
      ]
    };

    const SEARCH_RESULTS_PAGE_MUTATED_QUERY: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'https://example.com/search?q=alpha&page=2', title: 'Search Results for alpha - Page 2' },
      viewport: { width: 1280, height: 800 },
      elements: [
        {
          id: 'results-heading',
          role: 'heading',
          tagName: 'h1',
          visibleText: 'Search results for alpha',
          interactive: false
        },
        {
          id: 'result-link-2',
          role: 'link',
          tagName: 'a',
          visibleText: 'Another Target Item',
          interactive: true,
          bounds: { x: 10, y: 100, width: 400, height: 80 }
        }
      ]
    };

    const GENUINE_DESTINATION_PAGE: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'https://example.com/items/target-item', title: 'Target Destination Item' },
      viewport: { width: 1280, height: 800 },
      elements: [
        {
          id: 'item-heading',
          role: 'heading',
          tagName: 'h1',
          visibleText: 'Target Destination Item',
          interactive: false
        },
        {
          id: 'item-description',
          role: 'region',
          tagName: 'article',
          visibleText: 'Full content of the destination item.',
          interactive: false
        },
        {
          id: 'action-btn',
          role: 'button',
          tagName: 'button',
          visibleText: 'Activate Item',
          interactive: true,
          bounds: { x: 10, y: 200, width: 120, height: 40 }
        }
      ]
    };

    const EMPTY_DESTINATION_PAGE: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'https://example.com/items/target-item' },
      viewport: { width: 1280, height: 800 },
      elements: []
    };

    it('1 & A. Compound search + changed search-results URL (e.g. page/filter query mutated) -> satisfied:false', () => {
      const goal = { id: 'g-cp1', description: 'search for alpha and play target item', intent: 'click' };
      const res = verifyGoalSatisfaction(
        goal,
        GENERIC_CLICK_ACTION,
        SEARCH_RESULTS_PAGE_ORIGINAL,
        SEARCH_RESULTS_PAGE_MUTATED_QUERY,
        verifiedClick
      );
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('still displaying search results rather than destination content');
    });

    it('2 & B. Compound search + search-result structural evidence present on afterPage -> satisfied:false', () => {
      const goal = { id: 'g-cp2', description: 'search for alpha and open target item', intent: 'click' };
      // Even with changed URL, because afterPage retains search result evidence, completion is blocked
      expect(hasSearchResultEvidence(SEARCH_RESULTS_PAGE_MUTATED_QUERY)).toBe(true);

      const res = verifyGoalSatisfaction(
        goal,
        GENERIC_CLICK_ACTION,
        SEARCH_RESULTS_PAGE_ORIGINAL,
        SEARCH_RESULTS_PAGE_MUTATED_QUERY,
        verifiedClick
      );
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('still displaying search results rather than destination content');
    });

    it('5. Search-only goal -> existing completion behavior unchanged (search submission + results -> satisfied:true)', () => {
      const searchAction: IntendedAction = {
        id: 'a-search-11',
        type: 'type',
        target: {
          elementId: 'elem-search-input',
          point: { x: 100, y: 20 },
          viewportBounds: { x: 80, y: 20, width: 200, height: 40 },
          confidence: 0.9,
          observationId: 'obs-s11'
        },
        payload: { text: 'alpha query', pressEnter: true }
      };

      const searchOnlyGoal = { id: 'g-so1', description: 'search for alpha', intent: 'search' as const };
      const res = verifyGoalSatisfaction(
        searchOnlyGoal,
        searchAction,
        MOCK_PAGE,
        SEARCH_RESULTS_PAGE_ORIGINAL,
        verifiedSubmission
      );
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Search submitted and verified result-state observed');
    });

    it('6 & D. Compound click with genuine destination structure + no search-result evidence -> satisfied:true', () => {
      const goal = { id: 'g-cp3', description: 'search for alpha and play target item', intent: 'click' };
      expect(hasSearchResultEvidence(GENUINE_DESTINATION_PAGE)).toBe(false);

      const res = verifyGoalSatisfaction(
        goal,
        GENERIC_CLICK_ACTION,
        SEARCH_RESULTS_PAGE_ORIGINAL,
        GENUINE_DESTINATION_PAGE,
        verifiedClick
      );
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Post-search click completed navigation to destination');
      expect(res.rationale).toContain('actual playback verification not supported');
    });

    it('7 & C. URL change alone (no destination structural evidence) -> satisfied:false', () => {
      const goal = { id: 'g-cp4', description: 'search for alpha and open target item', intent: 'click' };
      const res = verifyGoalSatisfaction(
        goal,
        GENERIC_CLICK_ACTION,
        SEARCH_RESULTS_PAGE_ORIGINAL,
        EMPTY_DESTINATION_PAGE,
        verifiedClick
      );
      expect(res.satisfied).toBe(false);
      expect(res.rationale).toContain('lacks sufficient structural page content');
    });

    it('8. Website independence: purely generic PageRepresentation with no hardcoded strings or selectors', () => {
      const genericGoal = { id: 'g-ind', description: 'find manual and read chapter one' };
      const intranetSearchPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://intranet.corp/query?k=manuals', title: 'Search Results' },
        viewport: { width: 1280, height: 800 },
        elements: [
          { id: 'h1', role: 'heading', tagName: 'h1', visibleText: 'Search results for manuals', interactive: false },
          { id: 'lnk1', role: 'link', tagName: 'a', visibleText: 'Chapter One Manual', interactive: true, bounds: { x: 10, y: 100, width: 300, height: 40 } }
        ]
      };
      const intranetDocPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://intranet.corp/docs/chapter-one', title: 'Chapter One: Getting Started' },
        viewport: { width: 1280, height: 800 },
        elements: [
          { id: 'h1', role: 'heading', tagName: 'h1', visibleText: 'Chapter One: Getting Started', interactive: false },
          { id: 'sec1', role: 'region', tagName: 'article', visibleText: 'Welcome to chapter one contents.', interactive: false }
        ]
      };

      const res = verifyGoalSatisfaction(
        genericGoal,
        GENERIC_CLICK_ACTION,
        intranetSearchPage,
        intranetDocPage,
        verifiedClick
      );
      expect(res.satisfied).toBe(true);
      expect(res.rationale).toContain('Post-search click completed navigation to destination');
    });
  });

  // -------------------------------------------------------------------------
  // Phase B — Upfront Task Decomposition Integration in demoRunner
  // -------------------------------------------------------------------------

  describe('Phase B — Upfront Task Decomposition Integration in demoRunner', () => {
    it('10. falls back cleanly to undefined taskPlan when chat client is unreachable or decomposition fails', async () => {
      let capturedGoal: any = null;
      mockProposeStepSpy.mockImplementation((input: any) => {
        capturedGoal = input.goal;
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'elem-search-input',
            actionType: 'type' as const,
            payload: { text: 'fallback query', pressEnter: true },
            rationale: 'Search fallback',
            estimatedProgress: 0.5
          }
        };
      });

      const failingClient = {
        chat: vi.fn().mockRejectedValue(new Error('Connection reset by peer'))
      };

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Search for laptops under ₹50,000',
        makeDomProvider(),
        undefined,
        undefined,
        { chatClient: failingClient as any }
      );

      // Single-step fallback preserved
      expect(['COMPLETED', 'MAX_STEPS_REACHED', 'PLAN_FAILED']).toContain(result.status);
      expect(capturedGoal).toBeDefined();
      expect(capturedGoal.taskPlan).toBeUndefined();
    });

    it('attaches validated TaskPlan to planner goal context when decomposition succeeds', async () => {
      let capturedGoal: any = null;
      mockProposeStepSpy.mockImplementation((input: any) => {
        capturedGoal = input.goal;
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'elem-search-input',
            actionType: 'type' as const,
            payload: { text: 'MrBeast', pressEnter: true },
            rationale: 'Type search query',
            estimatedProgress: 0.3
          }
        };
      });

      const mockDecomposition = {
        archetype: 'search_and_act',
        userGoal: 'Search for MrBeast and play target video',
        phases: [
          {
            phaseId: 'p0',
            phaseIndex: 0,
            intent: 'search',
            description: 'Search for MrBeast',
            allowedActions: ['type']
          },
          {
            phaseId: 'p1',
            phaseIndex: 1,
            intent: 'select_result',
            description: 'Play target video',
            allowedActions: ['click']
          },
          {
            phaseId: 'p2',
            phaseIndex: 2,
            intent: 'verify_outcome',
            description: 'Verify video starts playing',
            allowedActions: []
          }
        ]
      };

      const successfulClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify(mockDecomposition)
        })
      };

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Search for MrBeast and play target video',
        makeDomProvider(),
        undefined,
        undefined,
        { chatClient: successfulClient as any }
      );

      expect(['COMPLETED', 'MAX_STEPS_REACHED', 'PLAN_FAILED']).toContain(result.status);
      expect(capturedGoal).toBeDefined();
      expect(capturedGoal.taskPlan).toBeDefined();
      expect(capturedGoal.taskPlan.archetype).toBe('search_and_act');
      expect(capturedGoal.taskPlan.phases).toHaveLength(3);
    });

    it('honors pre-provided options.taskPlan without re-invoking chat client', async () => {
      let capturedGoal: any = null;
      mockProposeStepSpy.mockImplementation((input: any) => {
        capturedGoal = input.goal;
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'elem-search-input',
            actionType: 'type' as const,
            payload: { text: 'test query', pressEnter: true },
            rationale: 'Type query',
            estimatedProgress: 0.5
          }
        };
      });

      const chatSpy = vi.fn();
      const client = { chat: chatSpy };

      const explicitPlan: TaskPlan = {
        planId: 'plan-explicit-1',
        archetype: 'navigation_act',
        summary: 'Go to settings and toggle mode',
        phases: [
          {
            phaseId: 'p0',
            phaseIndex: 0,
            intent: 'navigate',
            description: 'Go to settings',
            allowedActions: ['click']
          },
          {
            phaseId: 'p1',
            phaseIndex: 1,
            intent: 'verify_outcome',
            description: 'Verify settings active',
            allowedActions: []
          }
        ],
        currentPhaseIndex: 0
      };

      await runDemoAgentWithProvider(
        1,
        1,
        'Go to settings and toggle mode',
        makeDomProvider(),
        undefined,
        undefined,
        { taskPlan: explicitPlan, chatClient: client as any }
      );

      // chat client should NOT be called when taskPlan is provided upfront
      expect(chatSpy).not.toHaveBeenCalled();
      expect(capturedGoal).toBeDefined();
      expect(capturedGoal.taskPlan).toBeDefined();
      expect(capturedGoal.taskPlan.planId).toBe('plan-explicit-1');
    });
  });

  // -------------------------------------------------------------------------
  // Phase D — Runtime Phase Progression, Milestone Verification & Execution
  // -------------------------------------------------------------------------

  describe('Phase D — Runtime Phase Progression, Milestone Verification & Execution', () => {
    it('D1: atomic action succeeds but phase milestone is not satisfied -> phase remains active', async () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-d1',
        archetype: 'form_submission',
        summary: 'Fill title and submit',
        phases: [
          {
            phaseId: 'p0',
            phaseIndex: 0,
            intent: 'fill_field',
            description: 'Enter task title',
            fieldParameter: { fieldName: 'taskTitle', targetValue: 'college' },
            allowedActions: ['type']
          },
          {
            phaseId: 'p1',
            phaseIndex: 1,
            intent: 'submit',
            description: 'Submit task form',
            allowedActions: ['click']
          }
        ],
        currentPhaseIndex: 0
      };

      const pageWithWrongValue: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: 'elem-title-input',
            role: 'textbox',
            tagName: 'input',
            accessibleName: 'Task Title',
            visibleText: '',
            attributes: { value: 'wrong_value' },
            interactive: true,
            bounds: { x: 10, y: 10, width: 200, height: 40 }
          }
        ]
      };

      const capturedPhases: TaskPhase[] = [];
      mockProposeStepSpy.mockImplementation((input: any) => {
        if (input.context?.phaseState?.activePhase) {
          capturedPhases.push(input.context.phaseState.activePhase);
        }
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'elem-title-input',
            actionType: 'type' as const,
            payload: { text: 'wrong_value' },
            rationale: 'Typing wrong value',
            estimatedProgress: 0.2
          }
        };
      });

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Create task with name college',
        makeDomProvider(pageWithWrongValue),
        undefined,
        undefined,
        { taskPlan, maxSteps: 2 }
      );

      // Phase milestone was not satisfied because targetValue "college" was not entered
      // Therefore, on step 1, the active phase is STILL phase p0 (did not advance to p1)
      expect(capturedPhases.length).toBeGreaterThanOrEqual(2);
      expect(capturedPhases[0].phaseId).toBe('p0');
      expect(capturedPhases[1].phaseId).toBe('p0');
      expect(result.status).not.toBe('COMPLETED');
    });

    it('D2: atomic action succeeds and phase milestone is satisfied -> phase advances', async () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-d2',
        archetype: 'form_submission',
        summary: 'Fill title and submit',
        phases: [
          {
            phaseId: 'p0',
            phaseIndex: 0,
            intent: 'fill_field',
            description: 'Enter task title',
            fieldParameter: { fieldName: 'taskTitle', targetValue: 'college' },
            allowedActions: ['type']
          },
          {
            phaseId: 'p1',
            phaseIndex: 1,
            intent: 'submit',
            description: 'Submit task form',
            allowedActions: ['click']
          }
        ],
        currentPhaseIndex: 0
      };

      const pageWithCollege: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: 'elem-title-input',
            role: 'textbox',
            tagName: 'input',
            accessibleName: 'Task Title',
            visibleText: '',
            attributes: { value: 'college' },
            interactive: true,
            bounds: { x: 10, y: 10, width: 200, height: 40 }
          },
          {
            id: 'elem-submit-btn',
            role: 'button',
            tagName: 'button',
            accessibleName: 'Submit Task',
            visibleText: 'Submit Task',
            interactive: true,
            bounds: { x: 10, y: 60, width: 100, height: 40 }
          }
        ]
      };

      const capturedActivePhases: string[] = [];
      mockProposeStepSpy.mockImplementation((input: any) => {
        const active = input.context?.phaseState?.activePhase?.phaseId;
        if (active) capturedActivePhases.push(active);
        if (active === 'p0') {
          return {
            status: 'ACTION' as const,
            proposal: {
              targetElementId: 'elem-title-input',
              actionType: 'type' as const,
              payload: { text: 'college' },
              rationale: 'Type task title college',
              estimatedProgress: 0.5
            }
          };
        }
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'elem-submit-btn',
            actionType: 'click' as const,
            payload: {},
            rationale: 'Click submit button',
            estimatedProgress: 1.0
          }
        };
      });

      let domCallCount = 0;
      const domProviderD2 = async (): Promise<PageRepresentation> => {
        domCallCount++;
        if (domCallCount >= 4) {
          return {
            ...pageWithCollege,
            elements: [
              {
                id: 'status-msg',
                role: 'status',
                visibleText: 'Task created successfully',
                interactive: false
              }
            ]
          };
        }
        return pageWithCollege;
      };

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Create task with name college',
        domProviderD2,
        undefined,
        undefined,
        { taskPlan, maxSteps: 3 }
      );

      // Phase 0 completed and advanced to phase 1
      expect(capturedActivePhases[0]).toBe('p0');
      expect(capturedActivePhases[1]).toBe('p1');
      expect(result.status).toBe('COMPLETED');
    });

    it('D3, D4, D5: phase advancement updates planner context, preserves completed phases, and updates remaining phases', async () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-d345',
        archetype: 'generic_workflow',
        summary: '3-phase workflow',
        phases: [
          { phaseId: 'phase-0', phaseIndex: 0, intent: 'open_surface', description: 'Open form', allowedActions: ['click'] },
          { phaseId: 'phase-1', phaseIndex: 1, intent: 'fill_field', description: 'Enter name', fieldParameter: { fieldName: 'name', targetValue: 'Alice' }, allowedActions: ['type'] },
          { phaseId: 'phase-2', phaseIndex: 2, intent: 'submit', description: 'Submit form', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 0
      };

      const pageState: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          { id: 'elem-open', role: 'button', tagName: 'button', accessibleName: 'New Task', visibleText: 'New Task', interactive: true, bounds: { x: 10, y: 10, width: 100, height: 30 } },
          { id: 'elem-name', role: 'textbox', tagName: 'input', accessibleName: 'Name', visibleText: '', attributes: { value: 'Alice' }, interactive: true, bounds: { x: 10, y: 50, width: 200, height: 30 } },
          { id: 'elem-submit', role: 'button', tagName: 'button', accessibleName: 'Save', visibleText: 'Save', interactive: true, bounds: { x: 10, y: 90, width: 100, height: 30 } }
        ]
      };

      const statesCaptured: PhaseExecutionState[] = [];
      mockProposeStepSpy.mockImplementation((input: any) => {
        if (input.context?.phaseState) {
          statesCaptured.push(JSON.parse(JSON.stringify(input.context.phaseState)));
        }
        const activeId = input.context?.phaseState?.activePhase?.phaseId;
        const targetId = activeId === 'phase-0' ? 'elem-open' : activeId === 'phase-1' ? 'elem-name' : 'elem-submit';
        const actionType = activeId === 'phase-1' ? 'type' as const : 'click' as const;
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: targetId,
            actionType,
            payload: activeId === 'phase-1' ? { text: 'Alice' } : {},
            rationale: `Act on ${activeId}`,
            estimatedProgress: 0.5
          }
        };
      });

      let d345CallCount = 0;
      const domProviderD345 = async (): Promise<PageRepresentation> => {
        d345CallCount++;
        if (d345CallCount >= 6) {
          return {
            ...pageState,
            elements: [
              {
                id: 'status-saved',
                role: 'status',
                visibleText: 'Saved successfully',
                interactive: false
              }
            ]
          };
        }
        return pageState;
      };

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Complete 3-phase workflow',
        domProviderD345,
        undefined,
        undefined,
        { taskPlan, maxSteps: 5 }
      );

      expect(statesCaptured.length).toBe(3);

      // Step 0:
      expect(statesCaptured[0].activePhase?.phaseId).toBe('phase-0');
      expect(statesCaptured[0].completedPhaseIds).toEqual([]);
      expect(statesCaptured[0].remainingPhaseIds).toEqual(['phase-1', 'phase-2']);

      // Step 1:
      expect(statesCaptured[1].activePhase?.phaseId).toBe('phase-1');
      expect(statesCaptured[1].completedPhaseIds).toEqual(['phase-0']);
      expect(statesCaptured[1].remainingPhaseIds).toEqual(['phase-2']);

      // Step 2:
      expect(statesCaptured[2].activePhase?.phaseId).toBe('phase-2');
      expect(statesCaptured[2].completedPhaseIds).toEqual(['phase-0', 'phase-1']);
      expect(statesCaptured[2].remainingPhaseIds).toEqual([]);

      expect(result.status).toBe('COMPLETED');
    });

    it('D6: dynamic action budget is bounded and clamped correctly', () => {
      // No plan: minBudget (3)
      expect(calculateDynamicStepBudget(undefined)).toBe(MIN_STEP_BUDGET);

      // 1 phase: clamp(1 + 2, 3, 10) = 3
      const plan1: TaskPlan = {
        planId: 'p1',
        archetype: 'search_and_act',
        summary: '1 phase',
        phases: [{ phaseId: '0', phaseIndex: 0, intent: 'search', description: 's', allowedActions: ['type'] }],
        currentPhaseIndex: 0
      };
      expect(calculateDynamicStepBudget(plan1)).toBe(3);

      // 5 phases: clamp(5 + 2, 3, 10) = 7
      const plan5: TaskPlan = {
        planId: 'p5',
        archetype: 'form_submission',
        summary: '5 phases',
        phases: Array.from({ length: 5 }, (_, i) => ({
          phaseId: `p${i}`,
          phaseIndex: i,
          intent: 'fill_field',
          description: `f${i}`,
          allowedActions: ['type']
        })),
        currentPhaseIndex: 0
      };
      expect(calculateDynamicStepBudget(plan5)).toBe(7);

      // 12 phases: clamp(12 + 2, 3, 10) = 10 (clamped at MAX_STEP_BUDGET)
      const plan12: TaskPlan = {
        planId: 'p12',
        archetype: 'generic_workflow',
        summary: '12 phases',
        phases: Array.from({ length: 12 }, (_, i) => ({
          phaseId: `p${i}`,
          phaseIndex: i,
          intent: 'custom',
          description: `c${i}`,
          allowedActions: ['click']
        })),
        currentPhaseIndex: 0
      };
      expect(calculateDynamicStepBudget(plan12)).toBe(MAX_STEP_BUDGET);
    });

    it('D7: repeated ineffective action is detected within same phase and triggers bounded failure', async () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-d7',
        archetype: 'form_submission',
        summary: 'Repeated failing phase',
        phases: [
          {
            phaseId: 'p0',
            phaseIndex: 0,
            intent: 'fill_field',
            description: 'Enter required title',
            fieldParameter: { fieldName: 'title', targetValue: 'expected_title' },
            allowedActions: ['type']
          }
        ],
        currentPhaseIndex: 0
      };

      const emptyPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: 'elem-broken-input',
            role: 'textbox',
            tagName: 'input',
            accessibleName: 'Title',
            visibleText: '',
            attributes: { value: '' },
            interactive: true,
            bounds: { x: 10, y: 10, width: 200, height: 30 }
          }
        ]
      };

      mockProposeStepSpy.mockImplementation(() => ({
        status: 'ACTION' as const,
        proposal: {
          targetElementId: 'elem-broken-input',
          actionType: 'type' as const,
          payload: { text: '' },
          rationale: 'Repeatedly typing into broken input',
          estimatedProgress: 0.1
        }
      }));

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Enter title',
        makeDomProvider(emptyPage),
        undefined,
        undefined,
        { taskPlan, maxSteps: 8 }
      );

      expect(result.status).toBe('PLAN_FAILED');
      expect(result.message).toMatch(/(Exceeded maximum retries|Repeated ineffective action)/);
      expect(result.totalSteps).toBeLessThanOrEqual(MAX_PHASE_RETRIES + 2);
    });

    it('D8: multi-phase task does not complete after one successful action', async () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-d8',
        archetype: 'form_submission',
        summary: 'Multi-phase form',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'fill_field', description: 'Name', fieldParameter: { fieldName: 'name', targetValue: 'Bob' }, allowedActions: ['type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'fill_field', description: 'Email', fieldParameter: { fieldName: 'email', targetValue: 'bob@example.com' }, allowedActions: ['type'] },
          { phaseId: 'p2', phaseIndex: 2, intent: 'submit', description: 'Submit', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 0
      };

      const pageRep: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          { id: 'f-name', role: 'textbox', tagName: 'input', accessibleName: 'Name', visibleText: '', attributes: { value: 'Bob' }, interactive: true, bounds: { x: 10, y: 10, width: 100, height: 30 } },
          { id: 'f-email', role: 'textbox', tagName: 'input', accessibleName: 'Email', visibleText: '', attributes: { value: 'bob@example.com' }, interactive: true, bounds: { x: 10, y: 50, width: 100, height: 30 } },
          { id: 'f-sub', role: 'button', tagName: 'button', accessibleName: 'Submit', visibleText: 'Submit', interactive: true, bounds: { x: 10, y: 90, width: 100, height: 30 } }
        ]
      };

      let stepCallCount = 0;
      mockProposeStepSpy.mockImplementation((input: any) => {
        stepCallCount++;
        const active = input.context?.phaseState?.activePhase?.phaseId;
        const target = active === 'p0' ? 'f-name' : active === 'p1' ? 'f-email' : 'f-sub';
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: target,
            actionType: active === 'p2' ? 'click' as const : 'type' as const,
            payload: { text: 'test' },
            rationale: `Act on ${active}`,
            estimatedProgress: 0.3
          }
        };
      });

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Create user',
        makeDomProvider(pageRep),
        undefined,
        undefined,
        { taskPlan, maxSteps: 1 }
      );

      expect(result.status).toBe('MAX_STEPS_REACHED');
      expect(result.steps[0].plan.status).toBe('ACTION');
      expect(stepCallCount).toBe(1);
    });

    it('D9: final phase completion triggers whole-task completion', async () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-d9',
        archetype: 'navigation_act',
        summary: 'Two-phase navigation',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'navigate', description: 'Nav', allowedActions: ['click'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'verify_outcome', description: 'Verify', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 0
      };

      mockProposeStepSpy.mockImplementation(() => ({
        status: 'ACTION' as const,
        proposal: {
          targetElementId: 'elem-search-btn',
          actionType: 'click' as const,
          payload: {},
          rationale: 'Click navigation target',
          estimatedProgress: 1.0
        }
      }));

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Navigate and verify',
        makeDomProvider(),
        undefined,
        undefined,
        { taskPlan, maxSteps: 4 }
      );

      expect(result.status).toBe('COMPLETED');
    });

    it('D10: existing search-only behavior remains intact without TaskPlan', async () => {
      mockProposeStepSpy.mockImplementation(() => ({
        status: 'ACTION' as const,
        proposal: {
          targetElementId: 'elem-search-input',
          actionType: 'type' as const,
          payload: { text: 'macbook', pressEnter: true },
          rationale: 'Search for macbook',
          estimatedProgress: 0.8
        }
      }));

      const searchPageWithResults: PageRepresentation = {
        ...MOCK_PAGE,
        metadata: { title: 'Search Results for macbook', url: 'https://example.com/search?q=macbook' },
        elements: [
          ...MOCK_PAGE.elements,
          { id: 'h1-res', role: 'heading', tagName: 'h1', visibleText: 'Search results for macbook', interactive: false }
        ]
      };

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'search for macbook',
        makeDomProvider(searchPageWithResults),
        undefined,
        undefined,
        { maxSteps: 3 }
      );

      expect(result.status).toBe('COMPLETED');
      expect(result.steps.length).toBe(1);
    });

    it('D11: existing YouTube search/select-result behavior remains intact', async () => {
      const compoundGoal = 'Search for MrBeast and play the first video';
      const searchPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://video.example.com', title: 'Video Home' },
        viewport: { width: 1280, height: 800 },
        elements: [
          { id: 'search-input', role: 'searchbox', tagName: 'input', accessibleName: 'Search', visibleText: '', interactive: true, bounds: { x: 10, y: 10, width: 300, height: 40 } }
        ]
      };
      const resultsPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://video.example.com/results?search_query=MrBeast', title: 'Search Results' },
        viewport: { width: 1280, height: 800 },
        elements: [
          { id: 'search-input', role: 'searchbox', tagName: 'input', accessibleName: 'Search', visibleText: 'MrBeast', interactive: true, bounds: { x: 10, y: 10, width: 300, height: 40 } },
          { id: 'h-res', role: 'heading', tagName: 'h1', visibleText: 'Search results for MrBeast', interactive: false },
          { id: 'vid-1', role: 'link', tagName: 'a', accessibleName: 'MrBeast $1,000,000 Video', visibleText: 'MrBeast $1,000,000 Video', interactive: true, bounds: { x: 10, y: 100, width: 400, height: 80 } }
        ]
      };
      const watchPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://video.example.com/watch?v=123', title: 'MrBeast $1,000,000 Video' },
        viewport: { width: 1280, height: 800 },
        elements: [
          { id: 'vid-title', role: 'heading', tagName: 'h1', visibleText: 'MrBeast $1,000,000 Video', interactive: false },
          { id: 'vid-desc', role: 'region', tagName: 'article', visibleText: 'Video description and details', interactive: false }
        ]
      };

      let pageState = searchPage;
      const dynamicDomProvider = async () => pageState;

      mockProposeStepSpy.mockImplementation((input: any) => {
        const step = input.context.stepIndex;
        if (step === 0) {
          pageState = resultsPage;
          return {
            status: 'ACTION' as const,
            proposal: {
              targetElementId: 'search-input',
              actionType: 'type' as const,
              payload: { text: 'MrBeast', pressEnter: true },
              rationale: 'Search for MrBeast',
              estimatedProgress: 0.5
            }
          };
        }
        pageState = watchPage;
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'vid-1',
            actionType: 'click' as const,
            payload: {},
            rationale: 'Click video link',
            estimatedProgress: 1.0
          }
        };
      });

      const result = await runDemoAgentWithProvider(
        1,
        1,
        compoundGoal,
        dynamicDomProvider,
        undefined,
        undefined,
        { maxSteps: 3 }
      );

      expect(result.status).toBe('COMPLETED');
      expect(result.steps.length).toBe(2);
      expect(result.steps[0].plan.actionType).toBe('type');
      expect(result.steps[1].plan.actionType).toBe('click');
    });

    it('D12: privacy-sensitive field values are not exposed in logs/history', async () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-d12',
        archetype: 'form_submission',
        summary: 'Enter sensitive password',
        phases: [
          {
            phaseId: 'p0',
            phaseIndex: 0,
            intent: 'fill_field',
            description: 'Enter password',
            fieldParameter: { fieldName: 'password', targetValue: 'super_secret_123' },
            allowedActions: ['type']
          }
        ],
        currentPhaseIndex: 0
      };

      const passwordPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: 'elem-pwd',
            role: 'textbox',
            tagName: 'input',
            accessibleName: 'Password',
            visibleText: '',
            attributes: { type: 'password', value: 'super_secret_123' },
            interactive: true,
            bounds: { x: 10, y: 10, width: 200, height: 30 }
          }
        ]
      };

      let capturedHistory: PlannerHistoryStep[] = [];
      mockProposeStepSpy.mockImplementation((input: any) => {
        capturedHistory = input.history ?? [];
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'elem-pwd',
            actionType: 'type' as const,
            payload: { text: 'super_secret_123' },
            rationale: 'Typing sensitive credentials',
            estimatedProgress: 0.5
          }
        };
      });

      await runDemoAgentWithProvider(
        1,
        1,
        'Enter password',
        makeDomProvider(passwordPage),
        undefined,
        undefined,
        { taskPlan, maxSteps: 2 }
      );

      if (capturedHistory.length > 0) {
        for (const h of capturedHistory) {
          if (h.action.type === 'type') {
            expect(h.action.payload?.text).toBe('');
          }
        }
      }
    });

    it('D13: unsupported action is rejected rather than invented', async () => {
      mockProposeStepSpy.mockImplementation(() => ({
        status: 'ACTION' as const,
        proposal: {
          targetElementId: 'elem-search-input',
          actionType: 'drag_and_drop' as any,
          payload: {},
          rationale: 'Attempting unsupported action',
          estimatedProgress: 0.5
        }
      }));

      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Drag element',
        makeDomProvider()
      );

      expect(result.status).toBe('PLAN_FAILED');
      expect(result.message).toMatch(/(Unsupported action type|invalid actionType)/i);
    });

    it('D14: backward compatibility when no TaskPlan is available', async () => {
      const result = await runDemoAgentWithProvider(
        1,
        1,
        'Search for laptops',
        makeDomProvider()
      );

      expect(result.steps.length).toBeLessThanOrEqual(MAX_STEPS);
      expect(['COMPLETED', 'MAX_STEPS_REACHED', 'PLAN_FAILED']).toContain(result.status);
    });

    it('E1: select_option active phase does not fall through to search intent in demoRunner', async () => {
      const selectPhase: TaskPhase = {
        phaseId: 'p-status',
        phaseIndex: 1,
        intent: 'select_option',
        description: 'Select status',
        targetHint: 'status',
        allowedActions: ['click', 'type'],
        fieldParameter: { fieldName: 'status', targetValue: 'pending' }
      };

      const taskPlan: TaskPlan = {
        planId: 'tp-status',
        archetype: 'form_submission',
        summary: 'Form flow',
        phases: [
          { phaseId: 'p-title', phaseIndex: 0, intent: 'fill_field', description: 'Enter title', allowedActions: ['type'] },
          selectPhase
        ],
        currentPhaseIndex: 1
      };

      let capturedGoalIntent: string | undefined;
      mockProposeStepSpy.mockImplementation((input: any) => {
        capturedGoalIntent = input.goal.intent;
        return {
          status: 'ACTION' as const,
          proposal: {
            targetElementId: 'elem-status',
            actionType: 'type' as const,
            payload: { text: 'pending' },
            rationale: 'Select status as pending'
          }
        };
      });

      const pageWithSelect: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: 'elem-status',
            role: 'combobox',
            tagName: 'select',
            accessibleName: 'Status',
            visibleText: 'Pending',
            interactive: true,
            bounds: { x: 10, y: 50, width: 150, height: 30 }
          }
        ]
      };

      await runDemoAgentWithProvider(
        1,
        1,
        'Create and add a task with name college and status pending',
        makeDomProvider(pageWithSelect),
        undefined,
        undefined,
        { taskPlan, maxSteps: 1 }
      );

      // Verify planner input received 'custom' or non-search intent, never 'search'
      expect(capturedGoalIntent).not.toBe('search');
    });
  });

  // =========================================================================
  // PHASE MILESTONE VERIFICATION — SEMANTIC DATE INPUTS
  // =========================================================================

  describe('Phase Milestone Verification — Semantic Date Inputs', () => {
    function makeDateVerificationContext(options: {
      expectedValue: string;
      actualValue?: string;
      isDateInput?: boolean;
      rawTargetValue?: string;
      fieldName?: string;
    }) {
      const fieldName = options.fieldName ?? 'dueDate';
      const isDate = options.isDateInput !== false;

      const phase: TaskPhase = {
        phaseId: 'phase-date-test',
        phaseIndex: 2,
        intent: 'fill_field',
        description: `Enter ${fieldName}`,
        fieldParameter: {
          fieldName,
          targetValue: options.expectedValue,
          ...(options.rawTargetValue ? { rawTargetValue: options.rawTargetValue } : {})
        },
        allowedActions: ['type']
      };

      const action: IntendedAction = {
        id: 'action-test-1',
        type: 'type',
        target: {
          elementId: 'target-input',
          point: { x: 50, y: 50 },
          viewportBounds: { x: 0, y: 0, width: 100, height: 30 },
          confidence: 1.0,
          observationId: 'obs-date-1',
          role: 'textbox'
        },
        payload: { text: options.expectedValue }
      };

      const beforePage: PageRepresentation = { ...MOCK_PAGE };

      const afterPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: 'target-input',
            role: 'textbox',
            tagName: 'input',
            attributes: {
              type: isDate ? 'date' : 'text',
              ...(options.actualValue !== undefined ? { value: options.actualValue } : {})
            },
            visibleText: '',
            interactive: true,
            bounds: { x: 0, y: 0, width: 100, height: 30 }
          }
        ]
      };

      const actionVerification = { verified: true, message: 'Action executed' };

      return { phase, action, beforePage, afterPage, actionVerification };
    }

    it('A. Date exact match: expected "2026-09-29", actual "2026-09-29" => satisfied', () => {
      const ctx = makeDateVerificationContext({
        expectedValue: '2026-09-29',
        actualValue: '2026-09-29'
      });
      const result = verifyPhaseMilestone(
        ctx.phase,
        ctx.action,
        ctx.beforePage,
        ctx.afterPage,
        ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('populated with expected date');
    });

    it('B. Date mismatch: expected "2026-09-29", actual "2026-09-28" => not satisfied', () => {
      const ctx = makeDateVerificationContext({
        expectedValue: '2026-09-29',
        actualValue: '2026-09-28'
      });
      const result = verifyPhaseMilestone(
        ctx.phase,
        ctx.action,
        ctx.beforePage,
        ctx.afterPage,
        ctx.actionVerification
      );
      expect(result.satisfied).toBe(false);
      expect(result.rationale).toContain('does not reflect expected target value');
    });

    it('C. Date empty: expected "2026-09-29", actual "" => not satisfied', () => {
      const ctx = makeDateVerificationContext({
        expectedValue: '2026-09-29',
        actualValue: ''
      });
      const result = verifyPhaseMilestone(
        ctx.phase,
        ctx.action,
        ctx.beforePage,
        ctx.afterPage,
        ctx.actionVerification
      );
      expect(result.satisfied).toBe(false);
      expect(result.rationale).toContain('does not reflect expected target value');
    });

    it('D. Raw semantic value preserved in metadata but normalized target used', () => {
      const ctx = makeDateVerificationContext({
        expectedValue: '2026-09-29',
        rawTargetValue: "today's date",
        actualValue: '2026-09-29'
      });
      const result = verifyPhaseMilestone(
        ctx.phase,
        ctx.action,
        ctx.beforePage,
        ctx.afterPage,
        ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
    });

    it('E. Regression for normal text field: expected "college", actual "college" => satisfied', () => {
      const ctx = makeDateVerificationContext({
        expectedValue: 'college',
        actualValue: 'college',
        isDateInput: false,
        fieldName: 'title'
      });
      const result = verifyPhaseMilestone(
        ctx.phase,
        ctx.action,
        ctx.beforePage,
        ctx.afterPage,
        ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('populated with expected value');
    });

    it('F. Normal text mismatch: expected "college", actual "school" => not satisfied', () => {
      const ctx = makeDateVerificationContext({
        expectedValue: 'college',
        actualValue: 'school',
        isDateInput: false,
        fieldName: 'title'
      });
      const result = verifyPhaseMilestone(
        ctx.phase,
        ctx.action,
        ctx.beforePage,
        ctx.afterPage,
        ctx.actionVerification
      );
      expect(result.satisfied).toBe(false);
      expect(result.rationale).toContain('does not reflect expected target value');
    });

    it('G. Substring matching is NOT used for native date inputs', () => {
      // Substring of expected: "2026-09-2" is inside "2026-09-29", but must NOT satisfy date input
      const ctx1 = makeDateVerificationContext({
        expectedValue: '2026-09-29',
        actualValue: '2026-09-2'
      });
      const result1 = verifyPhaseMilestone(
        ctx1.phase,
        ctx1.action,
        ctx1.beforePage,
        ctx1.afterPage,
        ctx1.actionVerification
      );
      expect(result1.satisfied).toBe(false);

      // Superstring: "2026" is a substring of "2026-09-29", but must NOT satisfy
      const ctx2 = makeDateVerificationContext({
        expectedValue: '2026',
        actualValue: '2026-09-29'
      });
      const result2 = verifyPhaseMilestone(
        ctx2.phase,
        ctx2.action,
        ctx2.beforePage,
        ctx2.afterPage,
        ctx2.actionVerification
      );
      expect(result2.satisfied).toBe(false);
    });

    it('H. Boundary date values: handles month/year boundary comparisons correctly', () => {
      // Match on month boundary
      const ctxMonth = makeDateVerificationContext({
        expectedValue: '2026-10-01',
        actualValue: '2026-10-01'
      });
      expect(verifyPhaseMilestone(
        ctxMonth.phase,
        ctxMonth.action,
        ctxMonth.beforePage,
        ctxMonth.afterPage,
        ctxMonth.actionVerification
      ).satisfied).toBe(true);

      // Mismatch across year boundary
      const ctxYear = makeDateVerificationContext({
        expectedValue: '2027-01-01',
        actualValue: '2026-12-31'
      });
      expect(verifyPhaseMilestone(
        ctxYear.phase,
        ctxYear.action,
        ctxYear.beforePage,
        ctxYear.afterPage,
        ctxYear.actionVerification
      ).satisfied).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // PHASE MILESTONE VERIFICATION — PRIVACY-SAFE VALUEMATCH CONTRACT
  // ---------------------------------------------------------------------------
  describe('Phase Milestone Verification — Privacy-Safe ValueMatch Contract', () => {
    function makePrivacySafeContext(options: {
      fieldName?: string;
      targetValue?: string;
      actionText?: string;
      valueMatch?: boolean;
      verified?: boolean;
      isDateInput?: boolean;
      elementId?: string;
      actionType?: 'type' | 'click' | 'focus';
    }) {
      const fieldName = options.fieldName ?? 'title';
      const targetId = options.elementId ?? 'elem-40';
      const phase: TaskPhase = {
        phaseId: 'phase-0',
        phaseIndex: 0,
        intent: 'fill_field',
        description: `Enter the task ${fieldName}`,
        fieldParameter: {
          fieldName,
          targetValue: options.targetValue ?? 'college'
        },
        allowedActions: ['type']
      };

      const action: IntendedAction = {
        id: 'action-test-1',
        type: options.actionType ?? 'type',
        target: {
          elementId: targetId,
          point: { x: 50, y: 50 },
          viewportBounds: { x: 0, y: 0, width: 100, height: 30 },
          confidence: 1.0,
          observationId: 'obs-1',
          role: 'textbox'
        },
        payload: {
          text: options.actionText ?? options.targetValue ?? 'college'
        }
      };

      const beforePage: PageRepresentation = { ...MOCK_PAGE };

      // afterPage strictly preserves privacy: NO input value in attributes or visibleText
      const afterPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: targetId,
            role: 'textbox',
            tagName: 'input',
            attributes: {
              type: options.isDateInput ? 'date' : 'text'
            },
            visibleText: undefined,
            interactive: true,
            bounds: { x: 0, y: 0, width: 100, height: 30 }
          }
        ]
      };

      const actionVerification: DemoStepVerification = {
        verified: options.verified !== false,
        message: 'Action executed',
        ...(options.valueMatch !== undefined ? { valueMatch: options.valueMatch } : {})
      };

      return { phase, action, beforePage, afterPage, actionVerification };
    }

    it('H. Phase milestone integration: fill_field with target "college" becomes satisfied when verified=true, valueMatch=true, and target matches', () => {
      const ctx = makePrivacySafeContext({
        targetValue: 'college',
        actionText: 'college',
        valueMatch: true,
        verified: true
      });

      const result = verifyPhaseMilestone(
        ctx.phase,
        ctx.action,
        ctx.beforePage,
        ctx.afterPage,
        ctx.actionVerification
      );

      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('populated with expected value');
    });

    it('I. Negative phase integration: verified=true but valueMatch=false keeps phase incomplete', () => {
      const ctx = makePrivacySafeContext({
        targetValue: 'college',
        actionText: 'college',
        valueMatch: false,
        verified: true
      });

      const result = verifyPhaseMilestone(
        ctx.phase,
        ctx.action,
        ctx.beforePage,
        ctx.afterPage,
        ctx.actionVerification
      );

      expect(result.satisfied).toBe(false);
      expect(result.rationale).toContain('does not reflect expected target value');
    });

    it('J. Existing date verification regression: canonical date is accepted with valueMatch=true and rejected with valueMatch=false', () => {
      const dateMatchCtx = makePrivacySafeContext({
        fieldName: 'dueDate',
        targetValue: '2026-09-29',
        actionText: '2026-09-29',
        isDateInput: true,
        valueMatch: true,
        verified: true
      });
      const matchResult = verifyPhaseMilestone(
        dateMatchCtx.phase,
        dateMatchCtx.action,
        dateMatchCtx.beforePage,
        dateMatchCtx.afterPage,
        dateMatchCtx.actionVerification
      );
      expect(matchResult.satisfied).toBe(true);
      expect(matchResult.rationale).toContain('populated with expected date');

      const dateMismatchCtx = makePrivacySafeContext({
        fieldName: 'dueDate',
        targetValue: '2026-09-29',
        actionText: '2026-09-29',
        isDateInput: true,
        valueMatch: false,
        verified: true
      });
      const mismatchResult = verifyPhaseMilestone(
        dateMismatchCtx.phase,
        dateMismatchCtx.action,
        dateMismatchCtx.beforePage,
        dateMismatchCtx.afterPage,
        dateMismatchCtx.actionVerification
      );
      expect(mismatchResult.satisfied).toBe(false);
      expect(mismatchResult.rationale).toContain('does not reflect expected target value');
    });

    it('K. Existing non-date phase verification regression: non-date phases (open_surface, submit) verify properly', () => {
      // 1. open_surface phase
      const openSurfacePhase: TaskPhase = {
        phaseId: 'phase-open',
        phaseIndex: 0,
        intent: 'open_surface',
        description: 'Open task form',
        allowedActions: ['click']
      };
      const clickAction: IntendedAction = {
        id: 'act-click',
        type: 'click',
        target: {
          elementId: 'btn-add-task',
          point: { x: 10, y: 10 },
          viewportBounds: { x: 0, y: 0, width: 50, height: 20 },
          confidence: 1.0,
          observationId: 'obs-click',
          role: 'button'
        }
      };
      const openPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: 'btn-add-task',
            role: 'button',
            tagName: 'button',
            interactive: true,
            bounds: { x: 0, y: 0, width: 50, height: 20 }
          },
          {
            id: 'new-form-elem',
            role: 'textbox',
            tagName: 'input',
            interactive: true,
            bounds: { x: 0, y: 30, width: 100, height: 30 }
          }
        ]
      };
      const openVerification: DemoStepVerification = {
        verified: true,
        message: '1 new element(s) observed'
      };
      const openResult = verifyPhaseMilestone(
        openSurfacePhase,
        clickAction,
        MOCK_PAGE,
        openPage,
        openVerification
      );
      expect(openResult.satisfied).toBe(true);

      // 2. submit phase: creation surface closes and confirmation is observed
      const submitPhase: TaskPhase = {
        phaseId: 'phase-submit',
        phaseIndex: 3,
        intent: 'submit',
        description: 'Submit task',
        allowedActions: ['click']
      };
      const closedPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: 'btn-add-task',
            role: 'button',
            tagName: 'button',
            interactive: true,
            bounds: { x: 0, y: 0, width: 50, height: 20 }
          },
          {
            id: 'status-msg',
            role: 'status',
            visibleText: 'Task created',
            interactive: false
          }
        ]
      };
      const submitVerification: DemoStepVerification = {
        verified: true,
        message: 'Button clicked',
        afterPage: closedPage
      };
      const submitResult = verifyPhaseMilestone(
        submitPhase,
        clickAction,
        openPage,
        closedPage,
        submitVerification
      );
      expect(submitResult.satisfied).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // PHASE MILESTONE VERIFICATION — SELECT_OPTION CAPABILITY CORRECTION
  // ---------------------------------------------------------------------------
  describe('Phase Milestone Verification — Select-Option Capability', () => {
    function makeSelectOptionContext(options: {
      targetValue?: string;
      actionType?: 'type' | 'click' | 'focus';
      actionText?: string;
      valueMatch?: boolean;
      verified?: boolean;
      tagName?: string;
      visibleText?: string;
      accessibleName?: string;
      elementId?: string;
      role?: string;
      stateChecked?: boolean;
      ariaSelected?: string;
      valueAttribute?: string;
    }) {
      const targetId = options.elementId ?? 'elem-priority';
      const phase: TaskPhase = {
        phaseId: 'phase-select',
        phaseIndex: 0,
        intent: 'select_option',
        description: 'Select option',
        fieldParameter: options.targetValue !== undefined ? {
          fieldName: 'priority',
          targetValue: options.targetValue
        } : undefined,
        allowedActions: ['click', 'type']
      };

      const actionType = options.actionType ?? 'type';
      const target = {
        elementId: targetId,
        point: { x: 50, y: 50 },
        viewportBounds: { x: 0, y: 0, width: 100, height: 30 },
        confidence: 1.0,
        observationId: 'obs-1',
        role: (options.role ?? 'combobox') as any
      };
      let action: IntendedAction;
      if (actionType === 'click') {
        action = {
          id: 'action-select-1',
          type: 'click',
          target
        };
      } else if (actionType === 'type') {
        action = {
          id: 'action-select-1',
          type: 'type',
          target,
          payload: { text: options.actionText ?? options.targetValue ?? '' }
        };
      } else {
        action = {
          id: 'action-select-1',
          type: 'focus',
          target
        };
      }

      const beforePage: PageRepresentation = { ...MOCK_PAGE };

      const afterPage: PageRepresentation = {
        ...MOCK_PAGE,
        elements: [
          {
            id: targetId,
            role: (options.role ?? 'combobox') as any,
            tagName: options.tagName ?? 'select',
            visibleText: options.visibleText,
            accessibleName: options.accessibleName,
            interactive: true,
            bounds: { x: 0, y: 0, width: 100, height: 30 },
            attributes: {
              ...(options.ariaSelected !== undefined ? { 'aria-selected': options.ariaSelected } : {}),
              ...(options.valueAttribute !== undefined ? { value: options.valueAttribute } : {})
            },
            state: {
              ...(options.stateChecked !== undefined ? { checked: options.stateChecked } : {})
            }
          }
        ]
      };

      const actionVerification: DemoStepVerification = {
        verified: options.verified !== false,
        message: 'Action executed',
        ...(options.valueMatch !== undefined ? { valueMatch: options.valueMatch } : {})
      };

      return { phase, action, beforePage, afterPage, actionVerification };
    }

    it('A. Native select Medium -> High via type with valueMatch=true => satisfied', () => {
      const ctx = makeSelectOptionContext({
        targetValue: 'high',
        actionType: 'type',
        actionText: 'high',
        valueMatch: true,
        visibleText: 'High',
        tagName: 'select'
      });
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('selected via native control');
    });

    it('B. Native select already at target value (visibleText matches) => satisfied', () => {
      const ctx = makeSelectOptionContext({
        targetValue: 'high',
        actionType: 'type',
        actionText: 'high',
        visibleText: 'High',
        tagName: 'select',
        valueMatch: true
      });
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
    });

    it('C. Native select invalid option: valueMatch=false => not satisfied', () => {
      const ctx = makeSelectOptionContext({
        targetValue: 'critical',
        actionType: 'type',
        actionText: 'critical',
        valueMatch: false,
        visibleText: 'Medium',
        tagName: 'select'
      });
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(false);
      expect(result.rationale).toContain('does not match');
    });

    it('D. Native select case normalization: targetValue="high", visibleText="High" => satisfied', () => {
      const ctx = makeSelectOptionContext({
        targetValue: 'high',
        actionType: 'type',
        actionText: 'high',
        visibleText: 'High',
        tagName: 'select'
        // No valueMatch, so falls through to text-based check
      });
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('Option matching');
    });

    it('E. Radio regression: click on radio with state.checked=true => satisfied', () => {
      const ctx = makeSelectOptionContext({
        targetValue: 'medium',
        actionType: 'click',
        tagName: 'input',
        role: 'radio',
        stateChecked: true,
        accessibleName: 'Medium Priority'
      });
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('confirmed selected');
    });

    it('F. Checkbox regression: click on checkbox with state.checked=true => satisfied', () => {
      const ctx = makeSelectOptionContext({
        targetValue: 'agree',
        actionType: 'click',
        tagName: 'input',
        role: 'checkbox',
        stateChecked: true,
        accessibleName: 'I Agree'
      });
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('confirmed selected');
    });

    it('G. Click on native <select> WITHOUT state change => NOT satisfied (no false positive)', () => {
      const ctx = makeSelectOptionContext({
        targetValue: 'high',
        actionType: 'click',
        tagName: 'select',
        visibleText: 'Medium',  // Still shows Medium, not High
        accessibleName: 'Priority'
      });
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(false);
      expect(result.rationale).toContain('not confirmed');
    });

    it('H. ARIA combobox with aria-selected=true => satisfied', () => {
      const ctx = makeSelectOptionContext({
        targetValue: 'electronics',
        actionType: 'click',
        tagName: 'div',
        role: 'option',
        ariaSelected: 'true',
        visibleText: 'Electronics'
      });
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('confirmed selected');
    });

    it('I. Value attribute matches targetValue => satisfied', () => {
      const ctx = makeSelectOptionContext({
        targetValue: 'high',
        actionType: 'type',
        actionText: 'high',
        tagName: 'select',
        valueAttribute: 'High'
      });
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('Option matching');
    });

    it('J. No targetValue and no state evidence => not satisfied', () => {
      const ctx = makeSelectOptionContext({
        actionType: 'click',
        tagName: 'select',
        visibleText: 'Medium'
      });
      // Phase has no fieldParameter (targetValue is undefined)
      const result = verifyPhaseMilestone(
        ctx.phase, ctx.action, ctx.beforePage, ctx.afterPage, ctx.actionVerification
      );
      expect(result.satisfied).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // PHASE MILESTONE & WHOLE-GOAL POSTCONDITION VERIFICATION (FIX 2)
  // ---------------------------------------------------------------------------
  describe('FIX 2: Generic Whole-Goal Postcondition & Submit Verification', () => {
    const baseSubmitPhase: TaskPhase = {
      phaseId: 'phase-submit',
      phaseIndex: 1,
      intent: 'submit',
      description: 'Submit creation form',
      allowedActions: ['click']
    };

    function makeAction(type: 'click' | 'type' | 'focus', elementId: string): IntendedAction {
      if (type === 'type') {
        return {
          id: `act-${elementId}`,
          type: 'type',
          target: {
            elementId,
            point: { x: 10, y: 10 },
            viewportBounds: { x: 0, y: 0, width: 50, height: 20 },
            confidence: 1.0,
            observationId: `obs-${elementId}`,
            role: 'textbox'
          },
          payload: { text: '' }
        };
      }
      if (type === 'focus') {
        return {
          id: `act-${elementId}`,
          type: 'focus',
          target: {
            elementId,
            point: { x: 10, y: 10 },
            viewportBounds: { x: 0, y: 0, width: 50, height: 20 },
            confidence: 1.0,
            observationId: `obs-${elementId}`,
            role: 'combobox'
          }
        };
      }
      return {
        id: `act-${elementId}`,
        type: 'click',
        target: {
          elementId,
          point: { x: 10, y: 10 },
          viewportBounds: { x: 0, y: 0, width: 50, height: 20 },
          confidence: 1.0,
          observationId: `obs-${elementId}`,
          role: 'button'
        }
      };
    }

    const submitAction = makeAction('click', 'submit-btn');

    const actionVerified: DemoStepVerification = {
      verified: true,
      message: 'Click executed'
    };

    const pageWithOpenForm: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'https://example.com/app/new', title: 'New Item' },
      elements: [
        { id: 'input-title', role: 'textbox', tagName: 'input', interactive: true, bounds: { x: 0, y: 0, width: 100, height: 30 } },
        { id: 'submit-btn', role: 'button', tagName: 'button', interactive: true, bounds: { x: 0, y: 40, width: 100, height: 30 } }
      ],
      viewport: { width: 1280, height: 720 }
    };

    it('A. Submit click only: click verified, no URL change, no new content, no status/alert, creation surface remains => phase NOT satisfied', () => {
      // afterPage identical to beforePage: surface remains, click alone is ACTION_SUCCESS not PHASE_SUCCESS
      const result = verifyPhaseMilestone(
        baseSubmitPhase,
        submitAction,
        pageWithOpenForm,
        pageWithOpenForm,
        actionVerified
      );
      expect(result.satisfied).toBe(false);
      expect(result.rationale).toContain('Submission not confirmed');
    });

    it('B. Submit with surface disappearance => phase satisfied', () => {
      // afterPage: creation surface disappeared (dialog closed, or submit button absent, or inputs count 0)
      const pageAfterDisappearance: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/app/new', title: 'New Item' },
        elements: [],
        viewport: { width: 1280, height: 720 }
      };

      const result = verifyPhaseMilestone(
        baseSubmitPhase,
        submitAction,
        pageWithOpenForm,
        pageAfterDisappearance,
        actionVerified
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('closed input surface');
    });

    it('C. Submit with generic success/status evidence => phase satisfied', () => {
      // afterPage: contains a newly observed status/alert message
      const pageWithStatus: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/app/new', title: 'New Item' },
        elements: [
          ...pageWithOpenForm.elements,
          { id: 'alert-msg', role: 'status', visibleText: 'Item successfully saved', interactive: false }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const result = verifyPhaseMilestone(
        baseSubmitPhase,
        submitAction,
        pageWithOpenForm,
        pageWithStatus,
        actionVerified
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('confirmation message observed');
    });

    it('D. Submit with new content/entity + surface disappearance => phase satisfied', () => {
      // afterPage: submit surface gone, and a new entity/item container appeared without URL change
      const pageWithNewEntity: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/app/new', title: 'New Item' },
        elements: [
          { id: 'item-card-1', role: 'region', tagName: 'article', visibleText: 'Item Details', interactive: false }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const result = verifyPhaseMilestone(
        baseSubmitPhase,
        submitAction,
        pageWithOpenForm,
        pageWithNewEntity,
        actionVerified
      );
      expect(result.satisfied).toBe(true);
      expect(result.rationale).toContain('closed input surface');
    });

    it('E. Submit with delayed/inconclusive postcondition => NOT completed immediately', () => {
      // An inconclusive postcondition where surface is still active and no status exists
      const inconclusivePage = { ...pageWithOpenForm };
      const result = verifyPhaseMilestone(
        baseSubmitPhase,
        submitAction,
        pageWithOpenForm,
        inconclusivePage,
        actionVerified
      );
      expect(result.satisfied).toBe(false);
    });

    it('F. All phases complete but final goal evidence absent => NOT GOAL_SUCCESS', () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-f',
        archetype: 'form_submission',
        summary: 'Form submission',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'fill_field', description: 'Fill', allowedActions: ['type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'submit', description: 'Submit', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 1
      };

      // Form remains open and no status or navigation occurred
      const wholeGoalResult = verifyWholeGoalOutcome({
        goal: { id: 'g-f', description: 'Create and add an item' },
        taskPlan,
        completedPhaseIds: ['p0', 'p1'],
        currentPage: pageWithOpenForm,
        beforePage: pageWithOpenForm,
        lastAction: submitAction
      });

      expect(wholeGoalResult.satisfied).toBe(false);
      expect(wholeGoalResult.rationale).toContain('creation/editing surface remains open');
    });

    it('G. All phases complete + final generic postcondition satisfied => GOAL_SUCCESS', () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-g',
        archetype: 'form_submission',
        summary: 'Form submission',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'fill_field', description: 'Fill', allowedActions: ['type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'submit', description: 'Submit', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 1
      };

      const settledSuccessPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/app', title: 'Items' },
        elements: [
          { id: 'notif-banner', role: 'alert', visibleText: 'Successfully created item', interactive: false }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const wholeGoalResult = verifyWholeGoalOutcome({
        goal: { id: 'g-g', description: 'Create and add an item' },
        taskPlan,
        completedPhaseIds: ['p0', 'p1'],
        currentPage: settledSuccessPage,
        beforePage: pageWithOpenForm,
        lastAction: submitAction
      });

      expect(wholeGoalResult.satisfied).toBe(true);
      expect(wholeGoalResult.rationale).toContain('Whole goal verified');
    });

    it('H. Already-satisfied state: can satisfy goal/phase without requiring a fake action', () => {
      const phaseAlreadySet: TaskPhase = {
        phaseId: 'p-status',
        phaseIndex: 0,
        intent: 'select_option',
        description: 'Set status to pending',
        fieldParameter: { fieldName: 'status', targetValue: 'pending' },
        allowedActions: ['click', 'type']
      };

      const pageWithPending: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {},
        elements: [
          {
            id: 'select-status',
            role: 'combobox',
            tagName: 'select',
            visibleText: 'Pending',
            accessibleName: 'Status',
            interactive: true
          }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const check = isPhaseAlreadySatisfied(phaseAlreadySet, pageWithPending);
      expect(check.satisfied).toBe(true);
      expect(check.rationale).toContain('already set');

      // Milestone verification also confirms already-selected state without requiring state change
      const milestone = verifyPhaseMilestone(
        phaseAlreadySet,
        makeAction('focus', 'select-status'),
        pageWithPending,
        pageWithPending,
        { verified: true, message: 'Focused' }
      );
      expect(milestone.satisfied).toBe(true);
    });

    it('No website-specific selectors, IDs, classes, or strings are required by verifier', () => {
      // Uses generic custom IDs and generic roles with no "TaskFlow", "task-card", or domain words
      const genericPlan: TaskPlan = {
        planId: 'plan-custom-123',
        archetype: 'form_submission',
        summary: 'Generic entity creation',
        phases: [
          { phaseId: 'phase-x', phaseIndex: 0, intent: 'fill_field', description: 'Field X', fieldParameter: { fieldName: 'x', targetValue: 'val' }, allowedActions: ['type'] },
          { phaseId: 'phase-y', phaseIndex: 1, intent: 'submit', description: 'Submit X', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 1
      };

      const genericBeforePage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://myservice.org/dashboard' },
        elements: [
          { id: 'ctl-101', role: 'textbox', tagName: 'input', interactive: true },
          { id: 'ctl-102', role: 'button', tagName: 'button', interactive: true }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const genericAfterPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://myservice.org/dashboard' },
        elements: [
          { id: 'banner-99', role: 'status', visibleText: 'Entity registered', interactive: false }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const outcome = verifyWholeGoalOutcome({
        goal: { id: 'g-custom', description: 'Create and add an item' },
        taskPlan: genericPlan,
        completedPhaseIds: ['phase-x', 'phase-y'],
        currentPage: genericAfterPage,
        beforePage: genericBeforePage,
        lastAction: makeAction('click', 'ctl-102')
      });

      expect(outcome.satisfied).toBe(true);
      expect(outcome.rationale).toContain('Whole goal verified');
    });

    it('A. Compound goal "search and play": channel/profile result must NOT satisfy content-selection phase', () => {
      const selectResultPhase: TaskPhase = {
        phaseId: 'p-select',
        phaseIndex: 1,
        intent: 'select_result',
        description: 'Play the first video',
        targetHint: 'video',
        allowedActions: ['click']
      };

      const resultsBeforePage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/results?q=creator' },
        elements: [
          {
            id: 'channel-link',
            role: 'link',
            accessibleName: 'Creator Channel @Creator 1M subscribers',
            attributes: { href: '/@Creator' },
            interactive: true
          }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const channelAfterPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/@Creator' },
        elements: [
          { id: 'sub-btn', role: 'button', visibleText: 'Subscribe', interactive: true }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const clickChannelAction = makeAction('click', 'channel-link');
      const milestone = verifyPhaseMilestone(
        selectResultPhase,
        clickChannelAction,
        resultsBeforePage,
        channelAfterPage,
        { verified: true, message: 'Clicked channel' }
      );

      // Channel/profile result MUST NOT satisfy content-selection phase
      expect(milestone.satisfied).toBe(false);
      expect(milestone.rationale).toContain('Channel or profile target does not satisfy media content-selection');
    });

    it('C. Goal verification: channel/profile destination alone does NOT satisfy play/watch goal', () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-play',
        archetype: 'search_and_act',
        summary: 'Search and play video',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search', allowedActions: ['type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'select_result', description: 'Play video', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 1
      };

      const channelPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/@Creator', title: 'Creator Channel' },
        elements: [
          { id: 'header-banner', role: 'region', visibleText: '@Creator 100K subscribers', interactive: false }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const outcome = verifyWholeGoalOutcome({
        goal: { id: 'g-play', description: 'Search for Creator and play the first video' },
        taskPlan,
        completedPhaseIds: ['p0', 'p1'],
        currentPage: channelPage,
        lastAction: makeAction('click', 'channel-link')
      });

      // Channel/profile page must FAIL closed
      expect(outcome.satisfied).toBe(false);
      expect(outcome.rationale).toContain('destination is a channel or profile page');
    });

    it('D. Content/player evidence: valid generic evidence satisfies play/watch goal', () => {
      const taskPlan: TaskPlan = {
        planId: 'plan-play-ok',
        archetype: 'search_and_act',
        summary: 'Search and play video',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search', allowedActions: ['type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'select_result', description: 'Play video', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 1
      };

      // Case 1: Watch URL + HTML5 video element
      const watchPageWithVideo: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/watch?v=abc1234', title: 'Awesome Video' },
        elements: [
          { id: 'player-video', tagName: 'video', role: 'generic', state: { visible: true }, interactive: true }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const outcome1 = verifyWholeGoalOutcome({
        goal: { id: 'g-play-1', description: 'Search for Creator and play the first video' },
        taskPlan,
        completedPhaseIds: ['p0', 'p1'],
        currentPage: watchPageWithVideo,
        lastAction: makeAction('click', 'video-link')
      });
      expect(outcome1.satisfied).toBe(true);
      expect(outcome1.rationale).toContain('playable media/content destination reached and confirmed');

      // Case 2: Media playback controls (play/pause button)
      const watchPageWithControls: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/video/98765', title: 'Stream' },
        elements: [
          { id: 'btn-playpause', role: 'button', accessibleName: 'Play (k)', interactive: true }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const outcome2 = verifyWholeGoalOutcome({
        goal: { id: 'g-play-2', description: 'Watch the first video' },
        taskPlan,
        completedPhaseIds: ['p0', 'p1'],
        currentPage: watchPageWithControls,
        lastAction: makeAction('click', 'stream-btn')
      });
      expect(outcome2.satisfied).toBe(true);
      expect(outcome2.rationale).toContain('playable media/content destination reached and confirmed');
    });

    it('E. Search-only goal: existing behavior remains unchanged', () => {
      const searchOnlyPlan: TaskPlan = {
        planId: 'plan-search',
        archetype: 'search_and_act',
        summary: 'Search for items',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search', allowedActions: ['type'] }
        ],
        currentPhaseIndex: 0
      };

      const searchResultsPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/search?q=laptops', title: 'Search results for laptops' },
        elements: [
          { id: 'res-h1', role: 'heading', visibleText: 'Search results for laptops', interactive: false },
          { id: 'res-item-1', role: 'link', visibleText: 'Laptop X', attributes: { href: '/p/1' }, interactive: true }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const outcome = verifyWholeGoalOutcome({
        goal: { id: 'g-search', description: 'Search for laptops under ₹50,000' },
        taskPlan: searchOnlyPlan,
        completedPhaseIds: ['p0'],
        currentPage: searchResultsPage,
        lastAction: makeAction('type', 'search-box')
      });

      expect(outcome.satisfied).toBe(true);
      expect(outcome.rationale).toContain('Search results outcome verified');
    });
  });

  // -------------------------------------------------------------------------
  // NexBank & Generic Item-Retrieval Goal Verification (Regression Suite)
  // -------------------------------------------------------------------------
  describe('NexBank & Generic Item-Retrieval Goal Verification (Regression Suite)', () => {
    function makeAction(type: 'click' | 'type' | 'focus', elementId: string): IntendedAction {
      if (type === 'type') {
        return {
          id: `act-${elementId}`,
          type: 'type',
          target: {
            elementId,
            point: { x: 10, y: 10 },
            viewportBounds: { x: 0, y: 0, width: 50, height: 20 },
            confidence: 1.0,
            observationId: `obs-${elementId}`,
            role: 'textbox'
          },
          payload: { text: '' }
        };
      }
      if (type === 'focus') {
        return {
          id: `act-${elementId}`,
          type: 'focus',
          target: {
            elementId,
            point: { x: 10, y: 10 },
            viewportBounds: { x: 0, y: 0, width: 50, height: 20 },
            confidence: 1.0,
            observationId: `obs-${elementId}`,
            role: 'combobox'
          }
        };
      }
      return {
        id: `act-${elementId}`,
        type: 'click',
        target: {
          elementId,
          point: { x: 10, y: 10 },
          viewportBounds: { x: 0, y: 0, width: 50, height: 20 },
          confidence: 1.0,
          observationId: `obs-${elementId}`,
          role: 'button'
        }
      };
    }

    const itemPlan: TaskPlan = {
      planId: 'plan-item',
      archetype: 'search_and_act',
      summary: 'Find my latest Amazon transaction',
      phases: [
        { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search Amazon', allowedActions: ['type'] },
        { phaseId: 'p1', phaseIndex: 1, intent: 'select_result', description: 'Select latest transaction', allowedActions: ['click'] }
      ],
      currentPhaseIndex: 1
    };

    const searchResultsPageWithAmazonRows: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
      elements: [
        { id: 'search-input', role: 'searchbox', interactive: true, attributes: { value: 'Amazon' } },
        { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon Shopping −₹4,299 30 Sep 2026 Completed', interactive: true },
        { id: 'txn-008', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-25' }, visibleText: 'Amazon Shopping −₹2,199 25 Sep 2026 Completed', interactive: true },
        { id: 'txn-009', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-18' }, visibleText: 'Amazon Shopping −₹6,499 18 Sep 2026 Completed', interactive: true }
      ],
      viewport: { width: 1280, height: 720 }
    };

    it('4. Multiple matching transactions do not immediately satisfy the goal', () => {
      // Even if multiple rows are present, whole goal is not satisfied until the latest is opened
      const outcome = verifyWholeGoalOutcome({
        goal: { id: 'g-amazon', description: 'Find my latest Amazon transaction.' },
        taskPlan: itemPlan,
        completedPhaseIds: ['p0', 'p1'],
        currentPage: searchResultsPageWithAmazonRows,
        lastAction: makeAction('type', 'search-input'),
        history: [
          { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 }
        ]
      });

      expect(outcome.satisfied).toBe(false);
      expect(outcome.rationale).toContain('Goal not satisfied');
    });

    it('6. Opening the wrong transaction does not satisfy the goal', () => {
      // Suppose the agent opened the 25 Sep 2026 transaction instead of 30 Sep 2026
      const wrongDetailModalPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
        elements: [
          ...searchResultsPageWithAmazonRows.elements,
          { id: 'modal-overlay', role: 'dialog', accessibleName: 'Transaction details', interactive: true },
          { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' } },
          { id: 'd-amount', role: 'generic', visibleText: '−₹2,199', attributes: { 'data-detail': 'amount' } },
          { id: 'd-date', role: 'generic', visibleText: '25 Sep 2026', attributes: { 'data-detail': 'date' } },
          { id: 'd-txnid', role: 'generic', visibleText: 'TXN-927145', attributes: { 'data-detail': 'txnId' } }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const outcome = verifyWholeGoalOutcome({
        goal: { id: 'g-amazon', description: 'Find my latest Amazon transaction.' },
        taskPlan: itemPlan,
        completedPhaseIds: ['p0', 'p1'],
        currentPage: wrongDetailModalPage,
        beforePage: searchResultsPageWithAmazonRows,
        lastAction: makeAction('click', 'txn-008'),
        history: [
          { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 },
          { stepIndex: 1, action: makeAction('click', 'txn-008'), perceivedOutcome: 'success', phaseIndex: 1 }
        ]
      });

      expect(outcome.satisfied).toBe(false);
      expect(outcome.rationale).toContain('not the latest matching transaction');
    });

    it('7. Opening the latest matching transaction satisfies the goal', () => {
      // Agent opened the 30 Sep 2026 transaction
      const correctDetailModalPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
        elements: [
          ...searchResultsPageWithAmazonRows.elements,
          { id: 'modal-overlay', role: 'dialog', accessibleName: 'Transaction details', interactive: true },
          { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' } },
          { id: 'd-amount', role: 'generic', visibleText: '−₹4,299', attributes: { 'data-detail': 'amount' } },
          { id: 'd-date', role: 'generic', visibleText: '30 Sep 2026', attributes: { 'data-detail': 'date' } },
          { id: 'd-txnid', role: 'generic', visibleText: 'TXN-928374', attributes: { 'data-detail': 'txnId' } }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const outcome = verifyWholeGoalOutcome({
        goal: { id: 'g-amazon', description: 'Find my latest Amazon transaction.' },
        taskPlan: itemPlan,
        completedPhaseIds: ['p0', 'p1'],
        currentPage: correctDetailModalPage,
        beforePage: searchResultsPageWithAmazonRows,
        lastAction: makeAction('click', 'txn-001'),
        history: [
          { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 },
          { stepIndex: 1, action: makeAction('click', 'txn-001'), perceivedOutcome: 'success', phaseIndex: 1 }
        ]
      });

      expect(outcome.satisfied).toBe(true);
      expect(outcome.rationale).toContain('Whole goal verified');
      expect(outcome.rationale).toContain('Amazon');
    });

    it('8. Typing the search query alone never produces whole-goal completion', () => {
      // Even if a 1-phase plan was passed, typing search query alone MUST NOT satisfy item retrieval goal
      const singlePhasePlan: TaskPlan = {
        planId: 'plan-single',
        archetype: 'search_and_act',
        summary: 'Find my latest Amazon transaction',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search Amazon', allowedActions: ['type'] }
        ],
        currentPhaseIndex: 0
      };

      const outcome = verifyWholeGoalOutcome({
        goal: { id: 'g-amazon-single', description: 'Find my latest Amazon transaction.' },
        taskPlan: singlePhasePlan,
        completedPhaseIds: ['p0'],
        currentPage: searchResultsPageWithAmazonRows,
        lastAction: makeAction('type', 'search-input'),
        history: [
          { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 }
        ]
      });

      expect(outcome.satisfied).toBe(false);
      expect(outcome.rationale).toContain('Goal not satisfied');
    });

    it('9. Existing search-only goals continue working', () => {
      const searchOnlyPlan: TaskPlan = {
        planId: 'plan-search',
        archetype: 'search_and_act',
        summary: 'Search for laptops under ₹50,000',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search laptops', allowedActions: ['type'] }
        ],
        currentPhaseIndex: 0
      };

      const searchResultsPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'https://example.com/search?q=laptops', title: 'Search results for laptops' },
        elements: [
          { id: 'res-h1', role: 'heading', visibleText: 'Search results for laptops', interactive: false },
          { id: 'res-item-1', role: 'link', visibleText: 'Laptop X', attributes: { href: '/p/1' }, interactive: true }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const outcome = verifyWholeGoalOutcome({
        goal: { id: 'g-search-pure', description: 'Search for laptops under ₹50,000' },
        taskPlan: searchOnlyPlan,
        completedPhaseIds: ['p0'],
        currentPage: searchResultsPage,
        lastAction: makeAction('type', 'search-box')
      });

      expect(outcome.satisfied).toBe(true);
      expect(outcome.rationale).toContain('Search results outcome verified');
    });

    it('10. Existing privacy behavior remains unchanged', () => {
      const pageWithPII: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
        elements: [
          { id: 'e1', role: 'generic', visibleText: 'Support: support@nexbank.com', interactive: false },
          { id: 'e2', role: 'generic', visibleText: 'Call: +91 98765 43210', interactive: false },
          { id: 'e3', role: 'generic', visibleText: 'Card: 4111 1111 1111 1111', interactive: false }
        ],
        viewport: { width: 1280, height: 720 }
      };

      const sanitized = sanitizePageRepresentation(pageWithPII);
      expect(sanitized.findings.length).toBeGreaterThan(0);
      const emailElem = sanitized.pageRepresentation.elements.find(e => e.id === 'e1');
      expect(emailElem?.visibleText).toContain('[REDACTED_EMAIL]');
      expect(emailElem?.visibleText).not.toContain('support@nexbank.com');

      const phoneElem = sanitized.pageRepresentation.elements.find(e => e.id === 'e2');
      expect(phoneElem?.visibleText).toContain('[REDACTED_PHONE]');
      expect(phoneElem?.visibleText).not.toContain('98765 43210');
    });

    describe('Critical Intent Understanding & Goal Verification Repair Suite', () => {
      const selectResultPhase: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'select_result',
        description: 'Select latest Amazon transaction',
        targetHint: 'Amazon',
        allowedActions: ['click']
      };

      const itemPlan: TaskPlan = {
        planId: 'plan-item',
        archetype: 'search_and_act',
        summary: 'Find latest Amazon transaction and show details',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search Amazon', allowedActions: ['type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'select_result', description: 'Select latest Amazon transaction', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 1
      };

      it('Negative test: clicking Search button with zero matching rows cannot satisfy select_result milestone', () => {
        const zeroResultsPage: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
          elements: [
            { id: 'search-input', role: 'searchbox', attributes: { value: 'amazon transaction and show its' }, interactive: true },
            { id: 'search-btn', role: 'button', visibleText: 'Search', interactive: true },
            { id: 'status', role: 'status', visibleText: 'Showing 0 transactions for "amazon transaction and show its"', interactive: false }
          ],
          viewport: { width: 1280, height: 720 }
        };

        const clickSearchAction = makeAction('click', 'search-btn');
        const milestone = verifyPhaseMilestone(
          selectResultPhase,
          clickSearchAction,
          zeroResultsPage,
          zeroResultsPage,
          { verified: true, message: 'Clicked search button' }
        );

        expect(milestone.satisfied).toBe(false);
        expect(milestone.rationale).toMatch(/Search control or submit button|zero matching results/);
      });

      it('Negative test: clicking search input during select_result phase is rejected', () => {
        const searchInputPage: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
          elements: [
            { id: 'search-input', role: 'searchbox', interactive: true }
          ],
          viewport: { width: 1280, height: 720 }
        };

        const clickInputAction = makeAction('click', 'search-input');
        const milestone = verifyPhaseMilestone(
          selectResultPhase,
          clickInputAction,
          searchInputPage,
          searchInputPage,
          { verified: true, message: 'Clicked search input' }
        );

        expect(milestone.satisfied).toBe(false);
        expect(milestone.rationale).toContain('Search control or submit button');
      });

      it('Negative test: zero matching results message causes whole-goal verification to fail closed', () => {
        const zeroResultsPage: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
          elements: [
            { id: 'status', role: 'status', visibleText: 'Showing 0 transactions for "amazon transaction and show its"', interactive: false }
          ],
          viewport: { width: 1280, height: 720 }
        };

        const outcome = verifyWholeGoalOutcome({
          goal: { id: 'g-1', description: 'Find my latest Amazon transaction and show its details.' },
          taskPlan: itemPlan,
          completedPhaseIds: ['p0', 'p1'],
          currentPage: zeroResultsPage,
          lastAction: makeAction('click', 'search-btn')
        });

        expect(outcome.satisfied).toBe(false);
        expect(outcome.rationale).toContain('zero matching transactions');
      });

      it('False completion prevention: unpopulated / placeholder modal values rejected', () => {
        // Modal is closed / placeholder with "—" dashes
        const placeholderModalPage: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
          elements: [
            { id: 'modal-overlay', role: 'dialog', accessibleName: 'Transaction details', interactive: true },
            { id: 'd-merchant', role: 'generic', visibleText: '—', attributes: { 'data-detail': 'merchant' } },
            { id: 'd-amount', role: 'generic', visibleText: '—', attributes: { 'data-detail': 'amount' } },
            { id: 'd-date', role: 'generic', visibleText: '—', attributes: { 'data-detail': 'date' } },
            { id: 'd-txnid', role: 'generic', visibleText: '—', attributes: { 'data-detail': 'txnId' } }
          ],
          viewport: { width: 1280, height: 720 }
        };

        const outcome = verifyWholeGoalOutcome({
          goal: { id: 'g-2', description: 'Find my latest Amazon transaction and show its details.' },
          taskPlan: itemPlan,
          completedPhaseIds: ['p0', 'p1'],
          currentPage: placeholderModalPage,
          lastAction: makeAction('click', 'txn-001')
        });

        expect(outcome.satisfied).toBe(false);
        expect(outcome.rationale).toMatch(/empty or placeholder values|missing or unpopulated/);
      });

      it('Amount-based filtering: rejects transaction modal with mismatching amount', () => {
        const amountMismatchPage: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
          elements: [
            { id: 'modal-overlay', role: 'dialog', accessibleName: 'Transaction details', interactive: true },
            { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' } },
            { id: 'd-amount', role: 'generic', visibleText: '−₹2,199', attributes: { 'data-detail': 'amount' } },
            { id: 'd-date', role: 'generic', visibleText: '25 Sep 2026', attributes: { 'data-detail': 'date' } },
            { id: 'd-txnid', role: 'generic', visibleText: 'TXN-927145', attributes: { 'data-detail': 'txnId' } }
          ],
          viewport: { width: 1280, height: 720 }
        };

        const outcome = verifyWholeGoalOutcome({
          goal: { id: 'g-amt', description: 'Find the Amazon transaction for ₹4,299.' },
          taskPlan: itemPlan,
          completedPhaseIds: ['p0', 'p1'],
          currentPage: amountMismatchPage,
          lastAction: makeAction('click', 'txn-008')
        });

        expect(outcome.satisfied).toBe(false);
        expect(outcome.rationale).toContain('does not match requested amount');
      });

      it('Nonexistent merchant scenario fails closed honestly', () => {
        const nonexistentPage: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
          elements: [
            { id: 'status', role: 'status', visibleText: 'Showing 0 transactions for "NonexistentCorp"', interactive: false }
          ],
          viewport: { width: 1280, height: 720 }
        };

        const outcome = verifyWholeGoalOutcome({
          goal: { id: 'g-nonexistent', description: 'Find my latest NonexistentCorp transaction and show its details.' },
          taskPlan: itemPlan,
          completedPhaseIds: ['p0', 'p1'],
          currentPage: nonexistentPage,
          lastAction: makeAction('click', 'search-btn')
        });

        expect(outcome.satisfied).toBe(false);
        expect(outcome.rationale).toContain('zero matching transactions found');
      });

      it('Correct transaction detail verification on genuinely visible modal with all required fields', () => {
        const correctPage: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
          elements: [
            { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon −₹4,299 30 Sep 2026' },
            { id: 'modal-overlay', role: 'dialog', accessibleName: 'Transaction details', interactive: true },
            { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' } },
            { id: 'd-amount', role: 'generic', visibleText: '−₹4,299', attributes: { 'data-detail': 'amount' } },
            { id: 'd-date', role: 'generic', visibleText: '30 Sep 2026', attributes: { 'data-detail': 'date' } },
            { id: 'd-txnid', role: 'generic', visibleText: 'TXN-928374', attributes: { 'data-detail': 'txnId' } }
          ],
          viewport: { width: 1280, height: 720 }
        };

        const outcome = verifyWholeGoalOutcome({
          goal: { id: 'g-correct', description: 'Find my latest Amazon transaction and show its details.' },
          taskPlan: itemPlan,
          completedPhaseIds: ['p0', 'p1'],
          currentPage: correctPage,
          lastAction: makeAction('click', 'txn-001'),
          history: [
            { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 },
            { stepIndex: 1, action: makeAction('click', 'txn-001'), perceivedOutcome: 'success', phaseIndex: 1 }
          ]
        });

        expect(outcome.satisfied).toBe(true);
        expect(outcome.rationale).toContain('Whole goal verified');
        expect(outcome.rationale).toContain('Amazon');
      });

      describe('Phase 3 Regression: Modal Visibility and Verification', () => {
        const baseGoal: PlannerGoal = {
          id: 'g-modal-test',
          description: 'Find my latest Amazon transaction and show its details.'
        };

        it('1. Modal fully visible verifies successfully', () => {
          const page: PageRepresentation = {
            schemaVersion: '1.0',
            metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
            viewport: { width: 1280, height: 720 },
            elements: [
              { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon −₹4,299 30 Sep 2026' },
              { id: 'modal-overlay', role: 'dialog', attributes: { class: 'txn-detail-overlay visible', role: 'dialog' }, state: { visible: true }, interactive: true },
              { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' } },
              { id: 'd-amount', role: 'generic', visibleText: '−₹4,299', attributes: { 'data-detail': 'amount' } },
              { id: 'd-date', role: 'generic', visibleText: '30 Sep 2026', attributes: { 'data-detail': 'date' } },
              { id: 'd-txnid', role: 'generic', visibleText: 'TXN-928374', attributes: { 'data-detail': 'txnId' } }
            ]
          };

          const outcome = verifyWholeGoalOutcome({
            goal: baseGoal,
            taskPlan: itemPlan,
            completedPhaseIds: ['p0', 'p1'],
            currentPage: page,
            lastAction: makeAction('click', 'txn-001'),
            history: [
              { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 },
              { stepIndex: 1, action: makeAction('click', 'txn-001'), perceivedOutcome: 'success', phaseIndex: 1 }
            ]
          });

          expect(outcome.satisfied).toBe(true);
        });

        it('2. Modal during opacity transition is recognized and verified', () => {
          // Modal has .visible class and active transition, even if state.visible is false during transition
          const transitioningPage: PageRepresentation = {
            schemaVersion: '1.0',
            metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
            viewport: { width: 1280, height: 720 },
            elements: [
              { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon −₹4,299 30 Sep 2026' },
              {
                id: 'modal-overlay',
                role: 'dialog',
                attributes: { class: 'txn-detail-overlay visible', role: 'dialog', style: 'opacity: 0.3; transition: opacity .2s;' },
                state: { visible: false }, // Caught mid-transition
                interactive: true
              },
              { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' } },
              { id: 'd-amount', role: 'generic', visibleText: '−₹4,299', attributes: { 'data-detail': 'amount' } },
              { id: 'd-date', role: 'generic', visibleText: '30 Sep 2026', attributes: { 'data-detail': 'date' } },
              { id: 'd-txnid', role: 'generic', visibleText: 'TXN-928374', attributes: { 'data-detail': 'txnId' } }
            ]
          };

          const outcome = verifyWholeGoalOutcome({
            goal: baseGoal,
            taskPlan: itemPlan,
            completedPhaseIds: ['p0', 'p1'],
            currentPage: transitioningPage,
            lastAction: makeAction('click', 'txn-001'),
            history: [
              { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 },
              { stepIndex: 1, action: makeAction('click', 'txn-001'), perceivedOutcome: 'success', phaseIndex: 1 }
            ]
          });

          expect(outcome.satisfied).toBe(true);
        });

        it('3. Modal hidden with opacity zero without visible state is rejected', () => {
          const hiddenZeroOpacityPage: PageRepresentation = {
            schemaVersion: '1.0',
            metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
            viewport: { width: 1280, height: 720 },
            elements: [
              { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon −₹4,299 30 Sep 2026' },
              {
                id: 'modal-overlay',
                role: 'dialog',
                attributes: { class: 'txn-detail-overlay', role: 'dialog', style: 'opacity: 0;' },
                state: { visible: false },
                interactive: false
              },
              { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' }, state: { visible: false } }
            ]
          };

          const outcome = verifyWholeGoalOutcome({
            goal: baseGoal,
            taskPlan: itemPlan,
            completedPhaseIds: ['p0', 'p1'],
            currentPage: hiddenZeroOpacityPage,
            lastAction: makeAction('click', 'txn-001')
          });

          expect(outcome.satisfied).toBe(false);
          expect(outcome.rationale).toContain('no transaction details or detail dialog observable');
        });

        it('4. Modal without .visible class is rejected as not open', () => {
          const noVisibleClassPage: PageRepresentation = {
            schemaVersion: '1.0',
            metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
            viewport: { width: 1280, height: 720 },
            elements: [
              { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon −₹4,299 30 Sep 2026' },
              {
                id: 'modal-overlay',
                role: 'dialog',
                attributes: { class: 'txn-detail-overlay', role: 'dialog' },
                state: { visible: false },
                interactive: false
              }
            ]
          };

          const outcome = verifyWholeGoalOutcome({
            goal: baseGoal,
            taskPlan: itemPlan,
            completedPhaseIds: ['p0', 'p1'],
            currentPage: noVisibleClassPage,
            lastAction: makeAction('click', 'txn-001')
          });

          expect(outcome.satisfied).toBe(false);
          expect(outcome.rationale).toContain('no transaction details or detail dialog observable');
        });

        it('5. Stale modal from previous task or lacking click action is rejected', () => {
          const stalePage: PageRepresentation = {
            schemaVersion: '1.0',
            metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
            viewport: { width: 1280, height: 720 },
            elements: [
              { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon −₹4,299 30 Sep 2026' },
              { id: 'modal-overlay', role: 'dialog', attributes: { class: 'txn-detail-overlay visible', role: 'dialog' }, state: { visible: true } },
              { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' } },
              { id: 'd-amount', role: 'generic', visibleText: '−₹4,299', attributes: { 'data-detail': 'amount' } },
              { id: 'd-date', role: 'generic', visibleText: '30 Sep 2026', attributes: { 'data-detail': 'date' } },
              { id: 'd-txnid', role: 'generic', visibleText: 'TXN-928374', attributes: { 'data-detail': 'txnId' } }
            ]
          };

          // Agent only typed, never executed a click
          const outcome = verifyWholeGoalOutcome({
            goal: baseGoal,
            taskPlan: itemPlan,
            completedPhaseIds: ['p0', 'p1'],
            currentPage: stalePage,
            lastAction: makeAction('type', 'search-input'),
            history: [
              { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 }
            ]
          });

          expect(outcome.satisfied).toBe(false);
          expect(outcome.rationale).toContain('matching record was not selected or opened');
        });

        it('6. Unrelated dialog visible (e.g. Swiggy/Netflix) is rejected when Amazon was requested', () => {
          const unrelatedPage: PageRepresentation = {
            schemaVersion: '1.0',
            metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
            viewport: { width: 1280, height: 720 },
            elements: [
              { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon −₹4,299 30 Sep 2026' },
              { id: 'modal-overlay', role: 'dialog', attributes: { class: 'txn-detail-overlay visible', role: 'dialog' }, state: { visible: true } },
              { id: 'd-merchant', role: 'generic', visibleText: 'Swiggy', attributes: { 'data-detail': 'merchant' } },
              { id: 'd-amount', role: 'generic', visibleText: '−₹540', attributes: { 'data-detail': 'amount' } },
              { id: 'd-date', role: 'generic', visibleText: '29 Sep 2026', attributes: { 'data-detail': 'date' } },
              { id: 'd-txnid', role: 'generic', visibleText: 'TXN-112233', attributes: { 'data-detail': 'txnId' } }
            ]
          };

          const outcome = verifyWholeGoalOutcome({
            goal: baseGoal,
            taskPlan: itemPlan,
            completedPhaseIds: ['p0', 'p1'],
            currentPage: unrelatedPage,
            lastAction: makeAction('click', 'txn-002'),
            history: [
              { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 },
              { stepIndex: 1, action: makeAction('click', 'txn-002'), perceivedOutcome: 'success', phaseIndex: 1 }
            ]
          });

          expect(outcome.satisfied).toBe(false);
          expect(outcome.rationale).toContain('do not match requested entity "Amazon"');
        });

        it('7. Correct transaction details present verifies successfully', () => {
          const validPage: PageRepresentation = {
            schemaVersion: '1.0',
            metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
            viewport: { width: 1280, height: 720 },
            elements: [
              { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon −₹4,299 30 Sep 2026' },
              { id: 'modal-overlay', role: 'dialog', attributes: { class: 'txn-detail-overlay visible', role: 'dialog' }, state: { visible: true } },
              { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' } },
              { id: 'd-amount', role: 'generic', visibleText: '−₹4,299', attributes: { 'data-detail': 'amount' } },
              { id: 'd-date', role: 'generic', visibleText: '30 Sep 2026', attributes: { 'data-detail': 'date' } },
              { id: 'd-txnid', role: 'generic', visibleText: 'TXN-928374', attributes: { 'data-detail': 'txnId' } }
            ]
          };

          const outcome = verifyWholeGoalOutcome({
            goal: baseGoal,
            taskPlan: itemPlan,
            completedPhaseIds: ['p0', 'p1'],
            currentPage: validPage,
            lastAction: makeAction('click', 'txn-001'),
            history: [
              { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 },
              { stepIndex: 1, action: makeAction('click', 'txn-001'), perceivedOutcome: 'success', phaseIndex: 1 }
            ]
          });

          expect(outcome.satisfied).toBe(true);
          expect(outcome.rationale).toContain('Whole goal verified');
        });

        it('8. Dialog open but required details missing (placeholder or empty) is rejected', () => {
          const missingDetailsPage: PageRepresentation = {
            schemaVersion: '1.0',
            metadata: { url: 'file:///demo/nexvision-demo.html', title: 'NexBank' },
            viewport: { width: 1280, height: 720 },
            elements: [
              { id: 'txn-001', role: 'generic', attributes: { role: 'row', 'data-merchant': 'Amazon', 'data-date': '2026-09-30' }, visibleText: 'Amazon −₹4,299 30 Sep 2026' },
              { id: 'modal-overlay', role: 'dialog', attributes: { class: 'txn-detail-overlay visible', role: 'dialog' }, state: { visible: true } },
              { id: 'd-merchant', role: 'generic', visibleText: 'Amazon', attributes: { 'data-detail': 'merchant' } },
              { id: 'd-amount', role: 'generic', visibleText: '—', attributes: { 'data-detail': 'amount' } }, // placeholder!
              { id: 'd-date', role: 'generic', visibleText: '30 Sep 2026', attributes: { 'data-detail': 'date' } },
              { id: 'd-txnid', role: 'generic', visibleText: 'TXN-928374', attributes: { 'data-detail': 'txnId' } }
            ]
          };

          const outcome = verifyWholeGoalOutcome({
            goal: baseGoal,
            taskPlan: itemPlan,
            completedPhaseIds: ['p0', 'p1'],
            currentPage: missingDetailsPage,
            lastAction: makeAction('click', 'txn-001'),
            history: [
              { stepIndex: 0, action: makeAction('type', 'search-input'), perceivedOutcome: 'success', phaseIndex: 0 },
              { stepIndex: 1, action: makeAction('click', 'txn-001'), perceivedOutcome: 'success', phaseIndex: 1 }
            ]
          });

          expect(outcome.satisfied).toBe(false);
          expect(outcome.rationale).toContain('missing or unpopulated transaction fields');
        });
      });
    });
  });
});


