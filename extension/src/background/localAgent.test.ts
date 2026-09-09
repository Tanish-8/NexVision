import { describe, it, expect, vi } from 'vitest';
import type { ActionTarget, TypeAction } from '../shared/actions.js';
import type { PageRepresentation } from '../shared/types.js';
import {
  type PlannerInput,
  type PlannerDriver,
  type PlannerResult,
  type PlannerActionDecision,
  planNextStep
} from '../shared/planner.js';

import {
  LocalAgent,
  LocalAgentDriver,
  createLocalAgent,
  createLocalAgentDriver,
  buildModelPromptPayload,
  buildAgentUserPrompt,
  parseAdvisoryResponse,
  filterSafeGoalParameters,
  LOCAL_AGENT_SYSTEM_PROMPT,
  type LocalLlamaChatClient,
  DefaultLocalLlamaChatClient
} from './localAgent.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const MOCK_TARGET_1: ActionTarget = {
  elementId: 'elem-search-input',
  point: { x: 100, y: 50 },
  viewportBounds: { x: 50, y: 30, width: 200, height: 40 },
  confidence: 0.95,
  observationId: 'obs-1',
  role: 'textbox'
};

const MOCK_TARGET_2: ActionTarget = {
  elementId: 'elem-submit-btn',
  point: { x: 300, y: 50 },
  viewportBounds: { x: 260, y: 30, width: 80, height: 40 },
  confidence: 0.92,
  observationId: 'obs-2',
  role: 'button'
};

const MOCK_PAGE_REP: PageRepresentation = {
  schemaVersion: '1.0',
  metadata: {
    title: 'Example Shop',
    url: 'https://example.com/shop'
  },
  viewport: { width: 1280, height: 800 },
  elements: [
    {
      id: 'elem-search-input',
      role: 'textbox',
      accessibleName: 'Search products',
      visibleText: '',
      interactive: true,
      bounds: { x: 50, y: 30, width: 200, height: 40 }
    },
    {
      id: 'elem-submit-btn',
      role: 'button',
      accessibleName: 'Search',
      visibleText: 'Search',
      interactive: true,
      bounds: { x: 260, y: 30, width: 80, height: 40 }
    },
    {
      id: 'elem-disabled-btn',
      role: 'button',
      accessibleName: 'Disabled Action',
      visibleText: 'Unavailable',
      interactive: true,
      state: { disabled: true },
      bounds: { x: 400, y: 30, width: 100, height: 40 }
    },
    {
      id: 'elem-static-text',
      role: 'heading',
      accessibleName: 'Welcome',
      visibleText: 'Welcome',
      interactive: false,
      bounds: { x: 50, y: 10, width: 150, height: 20 }
    }
  ]
};

const FIXED_TIME = 1710000000000;

function createMockPlannerInput(overrides?: Partial<PlannerInput>): PlannerInput {
  return {
    goal: {
      id: 'goal-search-laptop',
      description: 'Search for laptops under ₹50,000',
      intent: 'search',
      parameters: { query: 'laptops' }
    },
    context: {
      page: MOCK_PAGE_REP,
      availableTargets: [MOCK_TARGET_1, MOCK_TARGET_2],
      capturedAt: FIXED_TIME - 500,
      currentTime: FIXED_TIME,
      stepIndex: 1,
      completion: { satisfied: false }
    },
    options: {
      minConfidence: 0.0,
      maxPerceptionAgeMs: 10000,
      strictRoleMatching: false
    },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Test Suite: Phase 5A Local AI Agent Integration
// ---------------------------------------------------------------------------

describe('Phase 5A — Local AI Agent / PlannerDriver Integration', () => {
  describe('Required 25 Test Cases', () => {
    // 1. valid ACTION response
    it('1. valid ACTION response: parses model action and returns validated IntendedAction via planNextStep', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { text: 'laptop' },
            rationale: 'Enter search term into textbox',
            estimatedProgress: 0.3
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result: PlannerResult = await agent.planNextStep(input);

      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');

      expect(result.planId).toBe('plan_goal-search-laptop_step_1');
      expect(result.action.type).toBe('type');
      expect(result.action.target.elementId).toBe('elem-search-input');
      expect((result.action as TypeAction).payload.text).toBe('laptop');
      expect(result.rationale).toBe('Enter search term into textbox');
      expect(result.estimatedProgress).toBe(0.3);
      expect(result.action.timestamp).toBe(FIXED_TIME);
    });

    // 2. valid COMPLETED response
    it('2. valid COMPLETED response: completes successfully when planner context allows it', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'COMPLETED',
            rationale: 'Search results displayed and goal satisfied'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput({
        context: {
          page: MOCK_PAGE_REP,
          availableTargets: [MOCK_TARGET_1, MOCK_TARGET_2],
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          stepIndex: 1,
          completion: { satisfied: true, summary: 'Already satisfied' }
        }
      });
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('COMPLETED');
      if (result.status !== 'COMPLETED') throw new Error('Expected COMPLETED');
      expect(result.summary).toBeDefined();
    });

    // 3. malformed JSON
    it('3. malformed JSON: rejects unparseable response with MODEL_ERROR', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: 'Here is what you should do: click the button'
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('Failed to parse model output as valid JSON');
    });

    // 4. missing type
    it('4. missing type: rejects response lacking "type" discriminator', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            targetElementId: 'elem-search-input',
            actionType: 'click'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('missing required "type" property');
    });

    // 5. unsupported action type
    it('5. unsupported action type: rejects actions outside click/type/focus with MODEL_ERROR', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'hover'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('Unsupported actionType "hover"');
    });

    // 6. missing target
    it('6. missing target: rejects ACTION proposal with missing targetElementId', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            actionType: 'click'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('missing required non-empty "targetElementId"');
    });

    // 7. unknown target
    it('7. unknown target: Phase 3A fails with UNKNOWN_TARGET_ELEMENT when model picks non-existent target', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-ghost-button',
            actionType: 'click'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('UNKNOWN_TARGET_ELEMENT');
      expect(result.message).toContain('does not exist in availableTargets');
    });

    // 8. target not in availableTargets
    it('8. target not in availableTargets: Phase 3A authoritative membership check rejects ungrounded target', async () => {
      const driver = createLocalAgentDriver({
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-not-in-targets',
            actionType: 'click'
          })
        })
      });

      const input = createMockPlannerInput();
      const result = await planNextStep(input, driver);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('UNKNOWN_TARGET_ELEMENT');
    });

    // 9. malformed type payload
    it('9. malformed type payload: rejects invalid type action payload structure', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { notText: 123 }
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('payload.text must be a string');
    });

    // 10. invalid estimatedProgress
    it('10. invalid estimatedProgress: rejects non-numeric estimatedProgress', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click',
            estimatedProgress: 'halfway'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('Invalid estimatedProgress');
    });

    // 11. negative estimatedProgress
    it('11. negative estimatedProgress: rejects negative estimatedProgress values', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click',
            estimatedProgress: -0.2
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('Invalid estimatedProgress');
    });

    // 12. estimatedProgress > 1
    it('12. estimatedProgress > 1: rejects estimatedProgress exceeding 1.0', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click',
            estimatedProgress: 1.5
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('Invalid estimatedProgress');
    });

    // 13. model/server failure
    it('13. model/server failure: maps chat client error cleanly into MODEL_ERROR failure', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: false,
          error: {
            code: 'UNREACHABLE',
            message: 'Local inference server is offline'
          }
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('Local inference server is offline');
    });

    // 14. timeout
    it('14. timeout: cleanly maps client timeout into MODEL_ERROR failure', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: false,
          error: {
            code: 'TIMEOUT',
            message: 'Local inference timed out after 120000ms'
          }
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('Local inference timed out after 120000ms');
    });

    // 15. privacy allowlist
    it('15. privacy allowlist: allows safe semantic parameters and strips sensitive keys', () => {
      const filtered = filterSafeGoalParameters({
        query: 'laptops',
        userPassword: 'secretPassword123',
        auth_token: 'bearer xyz123',
        profile_ref: 'profile.email',
        creditCard: '4111111111111111'
      });

      expect(filtered).toEqual({
        query: 'laptops',
        profile_ref: 'profile.email'
      });
      expect(filtered?.userPassword).toBeUndefined();
      expect(filtered?.auth_token).toBeUndefined();
      expect(filtered?.creditCard).toBeUndefined();
    });

    // 16. password exclusion
    it('16. password exclusion: password input elements never include visibleText in DTO', () => {
      const pageWithPassword: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { title: 'Login', url: 'https://example.com/login' },
        viewport: { width: 1000, height: 800 },
        elements: [
          {
            id: 'elem-pwd',
            role: 'textbox',
            inputType: 'password',
            visibleText: 'my_super_secret_pwd_999',
            interactive: true,
            bounds: { x: 10, y: 10, width: 100, height: 30 }
          }
        ]
      };

      const target: ActionTarget = {
        elementId: 'elem-pwd',
        point: { x: 60, y: 25 },
        viewportBounds: { x: 10, y: 10, width: 100, height: 30 },
        confidence: 0.9,
        observationId: 'obs-pwd',
        role: 'textbox'
      };

      const input = createMockPlannerInput({
        context: {
          page: pageWithPassword,
          availableTargets: [target],
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          stepIndex: 1,
          completion: { satisfied: false }
        }
      });

      const serialized = buildAgentUserPrompt(input);
      expect(serialized).not.toContain('my_super_secret_pwd_999');
    });

    // 17. input/textarea value exclusion
    it('17. input/textarea value exclusion: input and textarea elements omit visibleText in DTO', () => {
      const pageWithInput: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { title: 'Form', url: 'https://example.com/form' },
        viewport: { width: 1000, height: 800 },
        elements: [
          {
            id: 'elem-user-input',
            role: 'textbox',
            tagName: 'input',
            visibleText: 'user_typed_value',
            interactive: true,
            bounds: { x: 10, y: 10, width: 100, height: 30 }
          },
          {
            id: 'elem-textarea',
            role: 'textbox',
            tagName: 'textarea',
            visibleText: 'textarea_entered_text',
            interactive: true,
            bounds: { x: 10, y: 50, width: 100, height: 50 }
          }
        ]
      };

      const targets: ActionTarget[] = [
        {
          elementId: 'elem-user-input',
          point: { x: 60, y: 25 },
          viewportBounds: { x: 10, y: 10, width: 100, height: 30 },
          confidence: 0.9,
          observationId: 'obs-in',
          role: 'textbox'
        },
        {
          elementId: 'elem-textarea',
          point: { x: 60, y: 75 },
          viewportBounds: { x: 10, y: 50, width: 100, height: 50 },
          confidence: 0.9,
          observationId: 'obs-txt',
          role: 'textbox'
        }
      ];

      const input = createMockPlannerInput({
        context: {
          page: pageWithInput,
          availableTargets: targets,
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          stepIndex: 1,
          completion: { satisfied: false }
        }
      });

      const serialized = buildAgentUserPrompt(input);
      expect(serialized).not.toContain('user_typed_value');
      expect(serialized).not.toContain('textarea_entered_text');
    });

    // 18. target membership enforcement
    it('18. target membership enforcement: planNextStep enforces target element existence in availableTargets', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-unregistered-id',
            actionType: 'click'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('UNKNOWN_TARGET_ELEMENT');
    });

    // 19. local-only endpoint
    it('19. local-only endpoint: DefaultLocalLlamaChatClient defaults strictly to 127.0.0.1:8080', () => {
      const defaultClient = new DefaultLocalLlamaChatClient();
      expect(defaultClient['baseUrl']).toBe('http://127.0.0.1:8080');
    });

    // 20. deterministic prompt construction
    it('20. deterministic prompt construction: serializes identical PlannerInput to identical strings', () => {
      const input1 = createMockPlannerInput();
      const input2 = createMockPlannerInput();

      const prompt1 = buildAgentUserPrompt(input1);
      const prompt2 = buildAgentUserPrompt(input2);

      expect(prompt1).toBe(prompt2);
    });

    // 21. integration with the EXISTING Phase 3A PlannerDriver
    it('21. integration with the EXISTING Phase 3A PlannerDriver: proves LocalAgentDriver is accepted by planNextStep', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click',
            rationale: 'Click search button'
          })
        })
      };

      const driver: PlannerDriver = createLocalAgentDriver(mockChatClient);
      expect(driver.name).toBe('LocalAgentDriver');

      const input = createMockPlannerInput();
      // Directly call Phase 3A planNextStep with LocalAgentDriver
      const result: PlannerResult = await planNextStep(input, driver);

      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');

      // Verified result conforms to Phase 3A PlannerActionDecision
      expect(result.planId).toBe('plan_goal-search-laptop_step_1');
      expect(result.targetElementId).toBe('elem-submit-btn');
      expect(result.action.id).toBe('intent_obs-2_click');
      expect(result.action.target.point).toEqual({ x: 300, y: 50 });
    });

    // 22. malicious model attempting to synthesize an element ID
    it('22. malicious model attempting to synthesize an element ID: rejected as UNKNOWN_TARGET_ELEMENT', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'fake-synthesized-id-123',
            actionType: 'click'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const result = await agent.planNextStep(createMockPlannerInput());

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('UNKNOWN_TARGET_ELEMENT');
    });

    // 23. malicious model attempting to synthesize coordinates
    it('23. malicious model attempting to synthesize coordinates: model coordinates are ignored; grounded target point is authoritative', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click',
            coordinates: { x: 9999, y: 9999 } // malicious coordinate injection
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const result = await agent.planNextStep(createMockPlannerInput());

      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');

      // Point must remain grounded point (300, 50), not injected (9999, 9999)
      expect(result.action.target.point).toEqual({ x: 300, y: 50 });
      expect(result.action.target.viewportBounds).toEqual({ x: 260, y: 30, width: 80, height: 40 });
    });

    // 24. malformed model output containing extra unsupported fields
    it('24. malformed model output containing extra unsupported fields: parses valid fields safely without corruption', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click',
            extraField1: 'unsupported',
            extraScript: 'alert(1)',
            rationale: 'Clean click'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const result = await agent.planNextStep(createMockPlannerInput());

      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.action.type).toBe('click');
      expect(result.rationale).toBe('Clean click');
    });

    // 25. COMPLETED rejected when planner context does not permit completion
    it('25. COMPLETED rejected when planner context does not permit completion', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'COMPLETED',
            rationale: 'Premature model completion'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput({
        context: {
          page: MOCK_PAGE_REP,
          availableTargets: [MOCK_TARGET_1],
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          stepIndex: 1,
          completion: { satisfied: false } // explicit incomplete state
        }
      });

      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('UNSUPPORTED_GOAL');
    });
  });

  // -------------------------------------------------------------------------
  // Additional Edge Cases & Contract Tests
  // -------------------------------------------------------------------------

  describe('Edge Cases & Defense in Depth', () => {
    it('should strip markdown fences from valid JSON responses', () => {
      const wrapped = '```json\n{"type": "ACTION", "targetElementId": "elem-1", "actionType": "click"}\n```';
      const parsed = parseAdvisoryResponse(wrapped);

      expect(parsed.status).toBe('ACTION');
      if (parsed.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(parsed.proposal.targetElementId).toBe('elem-1');
    });

    it('should fail with INCOMPATIBLE_ACTION_FOR_ROLE when trying to type into a button', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'type',
            payload: { text: 'cannot type into button' }
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('INCOMPATIBLE_ACTION_FOR_ROLE');
    });

    it('DefaultLocalLlamaChatClient handles HTTP error response cleanly without leaking secrets', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      const agent = createLocalAgent({
        fetchFn: mockFetch as any
      });

      const result = await agent.planNextStep(createMockPlannerInput());
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('HTTP 500 Internal Server Error');
    });

    it('DefaultLocalLlamaChatClient handles network connection failure cleanly', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:8080'));

      const agent = createLocalAgent({
        fetchFn: mockFetch as any
      });

      const result = await agent.planNextStep(createMockPlannerInput());
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('offline or unreachable');
    });
  });
});
