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
  isSensitiveParameterKey,
  isSemanticProfileReference,
  sanitizeFreeFormText,
  redactObviousCredentials,
  isSafeTypeActionText,
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

  // -------------------------------------------------------------------------
  // Privacy Boundary Hardening Tests (Phase 5A Requirements 1-8)
  // -------------------------------------------------------------------------

  describe('Privacy Boundary Hardening (Requirements 1-8)', () => {
    describe('Deterministic Credential Redaction (Requirement 6)', () => {
      it('redacts obvious Bearer tokens', () => {
        const text = 'Authorization: Bearer my-secret-bearer-token-123456';
        const redacted = redactObviousCredentials(text);
        expect(redacted).not.toContain('my-secret-bearer-token-123456');
        expect(redacted).toBe('Authorization: [REDACTED_TOKEN]');
      });

      it('redacts obvious API key formats (sk-..., ghp_..., glpat-...)', () => {
        const text1 = 'API key is sk-1234567890abcdef1234567890abcdef for OpenAI';
        expect(redactObviousCredentials(text1)).toBe('API key is [REDACTED_TOKEN] for OpenAI');

        const text2 = 'GitHub token ghp_123456789012345678901234567890123456 used here';
        expect(redactObviousCredentials(text2)).toBe('GitHub token [REDACTED_TOKEN] used here');
      });

      it('redacts explicit credential key-value assignments', () => {
        const text = 'credentials: api_key=secretKeyABC123 and password="SuperSecretPassword"';
        const redacted = redactObviousCredentials(text);
        expect(redacted).not.toContain('secretKeyABC123');
        expect(redacted).not.toContain('SuperSecretPassword');
        expect(redacted).toBe('credentials: [REDACTED_TOKEN] and [REDACTED_TOKEN]');
      });

      it('leaves safe task text untouched', () => {
        expect(redactObviousCredentials('Search for laptops')).toBe('Search for laptops');
        expect(redactObviousCredentials('Submit search form')).toBe('Submit search form');
      });
    });

    describe('Sensitive Parameter Keys (Requirement 3)', () => {
      it('correctly identifies all 20 required sensitive parameter keys', () => {
        const requiredKeys = [
          'password',
          'passwd',
          'secret',
          'token',
          'auth',
          'credential',
          'cookie',
          'card',
          'cvv',
          'cvc',
          'email',
          'phone',
          'telephone',
          'name',
          'firstName',
          'lastName',
          'address',
          'street',
          'postal',
          'zip'
        ];

        for (const key of requiredKeys) {
          expect(isSensitiveParameterKey(key)).toBe(true);
          expect(isSensitiveParameterKey(key.toLowerCase())).toBe(true);
          expect(isSensitiveParameterKey(key.toUpperCase())).toBe(true);
        }
      });

      it('identifies compound sensitive keys', () => {
        expect(isSensitiveParameterKey('first_name')).toBe(true);
        expect(isSensitiveParameterKey('last_name')).toBe(true);
        expect(isSensitiveParameterKey('user_password')).toBe(true);
        expect(isSensitiveParameterKey('auth_token')).toBe(true);
        expect(isSensitiveParameterKey('phone_number')).toBe(true);
        expect(isSensitiveParameterKey('zip_code')).toBe(true);
        expect(isSensitiveParameterKey('postal_code')).toBe(true);
        expect(isSensitiveParameterKey('credit_card')).toBe(true);
      });

      it('returns false for safe task/query keys', () => {
        expect(isSensitiveParameterKey('query')).toBe(false);
        expect(isSensitiveParameterKey('category')).toBe(false);
        expect(isSensitiveParameterKey('sort')).toBe(false);
        expect(isSensitiveParameterKey('filter')).toBe(false);
        expect(isSensitiveParameterKey('brand')).toBe(false);
        expect(isSensitiveParameterKey('maxPrice')).toBe(false);
      });
    });

    describe('Semantic Profile References (Requirement 4)', () => {
      it('identifies semantic profile references', () => {
        expect(isSemanticProfileReference('profile.email')).toBe(true);
        expect(isSemanticProfileReference('profile.firstName')).toBe(true);
        expect(isSemanticProfileReference('profile.lastName')).toBe(true);
        expect(isSemanticProfileReference('profile.phone')).toBe(true);
        expect(isSemanticProfileReference('profile.address')).toBe(true);
        expect(isSemanticProfileReference('profile.street')).toBe(true);
        expect(isSemanticProfileReference('profile.zip')).toBe(true);
      });

      it('rejects raw PII values from being considered profile references', () => {
        expect(isSemanticProfileReference('test@example.com')).toBe(false);
        expect(isSemanticProfileReference('John Doe')).toBe(false);
        expect(isSemanticProfileReference('+91 98765 43210')).toBe(false);
        expect(isSemanticProfileReference('MyPassword123')).toBe(false);
        expect(isSemanticProfileReference('4532012345678910')).toBe(false);
      });
    });

    describe('Goal Parameters Filtering (Requirements 3, 4, 5)', () => {
      it('drops sensitive keys when values are raw PII / credentials', () => {
        const filtered = filterSafeGoalParameters({
          password: 'SecretPassword!',
          passwd: 'oldPassword',
          secret: 'apiSecretKey',
          token: 'token123456',
          auth: 'bearer abc',
          credential: 'myCredential',
          cookie: 'session=12345',
          card: '4532012345678910',
          cvv: '123',
          cvc: '456',
          email: 'user@example.com',
          phone: '+91 98765 43210',
          telephone: '022-12345678',
          name: 'Alice Smith',
          firstName: 'Alice',
          lastName: 'Smith',
          address: '123 Main St',
          street: 'Main St',
          postal: '10001',
          zip: '90210'
        });

        expect(filtered).toBeUndefined();
      });

      it('preserves semantic profile references even on sensitive keys', () => {
        const filtered = filterSafeGoalParameters({
          email: 'profile.email',
          firstName: 'profile.firstName',
          lastName: 'profile.lastName',
          phone: 'profile.phone',
          address: 'profile.address'
        });

        expect(filtered).toEqual({
          email: 'profile.email',
          firstName: 'profile.firstName',
          lastName: 'profile.lastName',
          phone: 'profile.phone',
          address: 'profile.address'
        });
      });

      it('preserves non-sensitive task parameters and redacts free-form PII within them', () => {
        const filtered = filterSafeGoalParameters({
          query: 'Search for laptops',
          note: 'Please email invoice to billing@example.com or call +91 98765 43210 with Bearer secret-auth-tok-123'
        });

        expect(filtered).toBeDefined();
        expect(filtered?.query).toBe('Search for laptops');
        expect(filtered?.note).not.toContain('billing@example.com');
        expect(filtered?.note).not.toContain('+91 98765 43210');
        expect(filtered?.note).not.toContain('secret-auth-tok-123');
        expect(filtered?.note).toContain('[REDACTED_EMAIL]');
        expect(filtered?.note).toContain('[REDACTED_PHONE]');
        expect(filtered?.note).toContain('[REDACTED_TOKEN]');
      });
    });

    describe('Sanitization of Model-Facing Free-Form Text (Requirement 2)', () => {
      it('sanitizes goal.description, goal.targetHint, page.title, page.url, accessibleName, and visibleText', () => {
        const pageWithPii: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: {
            title: 'Account Settings for +91 98765 43210',
            url: 'https://example.com/checkout?token=secret-token-xyz&user=test%40example.com&orderId=100'
          },
          viewport: { width: 1280, height: 800 },
          elements: [
            {
              id: 'elem-support-btn',
              role: 'button',
              accessibleName: 'Call support at +91 98765 43210',
              visibleText: 'Support: test@example.com',
              interactive: true,
              bounds: { x: 10, y: 10, width: 200, height: 40 }
            }
          ]
        };

        const target: ActionTarget = {
          elementId: 'elem-support-btn',
          point: { x: 110, y: 30 },
          viewportBounds: { x: 10, y: 10, width: 200, height: 40 },
          confidence: 0.95,
          observationId: 'obs-pii-btn',
          role: 'button'
        };

        const input = createMockPlannerInput({
          goal: {
            id: 'goal-pii-check',
            description: 'Notify test@example.com and call +91 98765 43210 with Bearer secret-token-456',
            targetHint: 'Button near user@company.org'
          },
          context: {
            page: pageWithPii,
            availableTargets: [target],
            capturedAt: FIXED_TIME - 500,
            currentTime: FIXED_TIME,
            stepIndex: 1,
            completion: { satisfied: false }
          }
        });

        const payload = buildModelPromptPayload(input);

        // goal.description sanitized
        expect(payload.goal.description).not.toContain('test@example.com');
        expect(payload.goal.description).not.toContain('+91 98765 43210');
        expect(payload.goal.description).not.toContain('secret-token-456');
        expect(payload.goal.description).toContain('[REDACTED_EMAIL]');
        expect(payload.goal.description).toContain('[REDACTED_PHONE]');
        expect(payload.goal.description).toContain('[REDACTED_TOKEN]');

        // goal.targetHint sanitized
        expect(payload.goal.targetHint).not.toContain('user@company.org');
        expect(payload.goal.targetHint).toContain('[REDACTED_EMAIL]');

        // page.title sanitized
        expect(payload.page.title).not.toContain('+91 98765 43210');
        expect(payload.page.title).toContain('[REDACTED_PHONE]');

        // page.url sanitized via sanitizeUrl()
        expect(payload.page.url).not.toContain('secret-token-xyz');
        expect(payload.page.url).not.toContain('test@example.com');
        expect(payload.page.url).toContain('[REDACTED_PARAM]');

        // candidate.accessibleName sanitized
        expect(payload.availableTargets[0].accessibleName).not.toContain('+91 98765 43210');
        expect(payload.availableTargets[0].accessibleName).toContain('[REDACTED_PHONE]');

        // candidate.visibleText sanitized
        expect(payload.availableTargets[0].visibleText).not.toContain('test@example.com');
        expect(payload.availableTargets[0].visibleText).toContain('[REDACTED_EMAIL]');
      });
    });

    describe('Final Model Prompt PII Exclusion (Requirement 7)', () => {
      it('guarantees buildAgentUserPrompt(input) does NOT contain raw PII or credentials', () => {
        const RAW_EMAIL = 'test@example.com';
        const RAW_PHONE = '+91 98765 43210';
        const RAW_CARD = '4532012345678910'; // Valid Luhn Visa card number
        const RAW_PASSWORD = 'SuperSecretPassword!999';
        const RAW_SECRET = 'my_top_secret_token_abc123';
        const RAW_TOKEN = 'bearer-auth-xyz-789';

        const pageWithPii: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: {
            title: `Account for ${RAW_PHONE}`,
            url: `https://example.com/checkout?token=${RAW_SECRET}&email=${RAW_EMAIL}`
          },
          viewport: { width: 1280, height: 800 },
          elements: [
            {
              id: 'elem-card-btn',
              role: 'button',
              accessibleName: `Pay with card ${RAW_CARD}`,
              visibleText: `Contact ${RAW_EMAIL}`,
              interactive: true,
              bounds: { x: 10, y: 10, width: 200, height: 40 }
            }
          ]
        };

        const target: ActionTarget = {
          elementId: 'elem-card-btn',
          point: { x: 110, y: 30 },
          viewportBounds: { x: 10, y: 10, width: 200, height: 40 },
          confidence: 0.95,
          observationId: 'obs-card',
          role: 'button'
        };

        const input = createMockPlannerInput({
          goal: {
            id: 'goal-pii-comprehensive',
            description: `Send payment receipt to ${RAW_EMAIL} or call ${RAW_PHONE}`,
            targetHint: `Click button for ${RAW_EMAIL}`,
            parameters: {
              password: RAW_PASSWORD,
              secret: RAW_SECRET,
              token: RAW_TOKEN,
              email: RAW_EMAIL,
              phone: RAW_PHONE,
              card: RAW_CARD,
              query: 'Purchase subscription'
            }
          },
          context: {
            page: pageWithPii,
            availableTargets: [target],
            capturedAt: FIXED_TIME - 500,
            currentTime: FIXED_TIME,
            stepIndex: 1,
            completion: { satisfied: false }
          }
        });

        const prompt = buildAgentUserPrompt(input);

        // Strict assertions: raw PII and credentials must NEVER appear anywhere in the serialized prompt
        expect(prompt).not.toContain(RAW_EMAIL);
        expect(prompt).not.toContain(RAW_PHONE);
        expect(prompt).not.toContain(RAW_CARD);
        expect(prompt).not.toContain(RAW_PASSWORD);
        expect(prompt).not.toContain(RAW_SECRET);
        expect(prompt).not.toContain(RAW_TOKEN);

        // Valid JSON check
        expect(() => JSON.parse(prompt)).not.toThrow();
      });
    });

    describe('Safe Semantic and Task Content Preservation (Requirement 8)', () => {
      it('preserves safe task descriptions, element text, and semantic profile references', () => {
        const page: PageRepresentation = {
          schemaVersion: '1.0',
          metadata: {
            title: 'Shop NexVision',
            url: 'https://example.com/shop'
          },
          viewport: { width: 1280, height: 800 },
          elements: [
            {
              id: 'elem-search-btn',
              role: 'button',
              accessibleName: 'Search products',
              visibleText: 'Search products',
              interactive: true,
              bounds: { x: 50, y: 50, width: 120, height: 40 }
            }
          ]
        };

        const target: ActionTarget = {
          elementId: 'elem-search-btn',
          point: { x: 110, y: 70 },
          viewportBounds: { x: 50, y: 50, width: 120, height: 40 },
          confidence: 0.95,
          observationId: 'obs-search',
          role: 'button'
        };

        const input = createMockPlannerInput({
          goal: {
            id: 'goal-safe-content',
            description: 'Search for laptops',
            parameters: {
              query: 'Search for laptops',
              email: 'profile.email',
              firstName: 'profile.firstName',
              phone: 'profile.phone'
            }
          },
          context: {
            page,
            availableTargets: [target],
            capturedAt: FIXED_TIME - 500,
            currentTime: FIXED_TIME,
            stepIndex: 1,
            completion: { satisfied: false }
          }
        });

        const prompt = buildAgentUserPrompt(input);

        // Positive assertions: safe semantic/task content must be preserved
        expect(prompt).toContain('Search for laptops');
        expect(prompt).toContain('Search products');
        expect(prompt).toContain('profile.email');
        expect(prompt).toContain('profile.firstName');
        expect(prompt).toContain('profile.phone');
      });
    });
  });
});
// ---------------------------------------------------------------------------
// Output-Side Privacy Safety Regression Tests
// ---------------------------------------------------------------------------

describe('Phase 5A — Output-Side Type Action Privacy Safety', () => {
  // -------------------------------------------------------------------------
  // isSafeTypeActionText unit tests
  // -------------------------------------------------------------------------
  describe('isSafeTypeActionText — safe text accepted', () => {
    it('accepts ordinary search phrase', () => {
      expect(isSafeTypeActionText('gaming laptop')).toBe(true);
    });

    it('accepts ordinary task button label', () => {
      expect(isSafeTypeActionText('Search products')).toBe(true);
    });

    it('accepts numeric task value (e.g. budget)', () => {
      expect(isSafeTypeActionText('50000')).toBe(true);
    });

    it('accepts short search keyword', () => {
      expect(isSafeTypeActionText('laptop')).toBe(true);
    });

    it('accepts profile.email semantic reference', () => {
      expect(isSafeTypeActionText('profile.email')).toBe(true);
    });

    it('accepts profile.firstName semantic reference', () => {
      expect(isSafeTypeActionText('profile.firstName')).toBe(true);
    });

    it('accepts profile.phone semantic reference', () => {
      expect(isSafeTypeActionText('profile.phone')).toBe(true);
    });

    it('accepts profile.lastName semantic reference', () => {
      expect(isSafeTypeActionText('profile.lastName')).toBe(true);
    });

    it('accepts profile.address semantic reference', () => {
      expect(isSafeTypeActionText('profile.address')).toBe(true);
    });
  });

  describe('isSafeTypeActionText — PII/credential text rejected', () => {
    it('rejects raw email address', () => {
      expect(isSafeTypeActionText('user@example.com')).toBe(false);
    });

    it('rejects raw phone number (ITU-T format)', () => {
      // redactText handles validated phone numbers
      expect(isSafeTypeActionText('+14155552671')).toBe(false);
    });

    it('rejects bearer token credential', () => {
      expect(isSafeTypeActionText('Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456')).toBe(false);
    });

    it('rejects GitHub PAT credential', () => {
      expect(isSafeTypeActionText('ghp_abcdefghijklmnopqrstuvwxyz123456')).toBe(false);
    });

    it('rejects OpenAI sk- API key credential', () => {
      expect(isSafeTypeActionText('sk-abcdefghijklmnopqrstuv')).toBe(false);
    });

    it('rejects api_key=... credential pattern', () => {
      expect(isSafeTypeActionText('api_key=my-secret-value')).toBe(false);
    });

    it('rejects JWT token', () => {
      expect(
        isSafeTypeActionText(
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
        )
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // parseAdvisoryResponse integration: type payload safety check
  // -------------------------------------------------------------------------
  describe('parseAdvisoryResponse — type payload safety enforcement', () => {
    function makeTypeAction(text: string): string {
      return JSON.stringify({
        type: 'ACTION',
        targetElementId: 'elem-search-input',
        actionType: 'type',
        payload: { text },
        rationale: 'fill in search field',
        estimatedProgress: 0.3
      });
    }

    it('accepts safe ordinary text in type payload', () => {
      const result = parseAdvisoryResponse(makeTypeAction('gaming laptop'));
      expect(result.status).toBe('ACTION');
    });

    it('accepts numeric task value in type payload', () => {
      const result = parseAdvisoryResponse(makeTypeAction('50000'));
      expect(result.status).toBe('ACTION');
    });

    it('accepts profile.email reference in type payload', () => {
      const result = parseAdvisoryResponse(makeTypeAction('profile.email'));
      expect(result.status).toBe('ACTION');
    });

    it('accepts profile.firstName reference in type payload', () => {
      const result = parseAdvisoryResponse(makeTypeAction('profile.firstName'));
      expect(result.status).toBe('ACTION');
    });

    it('accepts profile.phone reference in type payload', () => {
      const result = parseAdvisoryResponse(makeTypeAction('profile.phone'));
      expect(result.status).toBe('ACTION');
    });

    it('rejects raw email address in type payload with deterministic reason', () => {
      const result = parseAdvisoryResponse(makeTypeAction('user@example.com'));
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') {
        expect(result.reason).toBe(
          'Model proposed sensitive PII or credentials in type action payload'
        );
      }
    });

    it('rejects raw phone number in type payload', () => {
      const result = parseAdvisoryResponse(makeTypeAction('+14155552671'));
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') {
        expect(result.reason).toBe(
          'Model proposed sensitive PII or credentials in type action payload'
        );
      }
    });

    it('rejects bearer token credential in type payload', () => {
      const result = parseAdvisoryResponse(
        makeTypeAction('Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456')
      );
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') {
        expect(result.reason).toBe(
          'Model proposed sensitive PII or credentials in type action payload'
        );
      }
    });

    it('rejects sk- API key in type payload', () => {
      const result = parseAdvisoryResponse(
        makeTypeAction('sk-abcdefghijklmnopqrstuv')
      );
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') {
        expect(result.reason).toBe(
          'Model proposed sensitive PII or credentials in type action payload'
        );
      }
    });

    it('does NOT apply safety check to click actions (only type is guarded)', () => {
      // click has no payload.text; safety check must not block click actions
      const clickJson = JSON.stringify({
        type: 'ACTION',
        targetElementId: 'elem-submit-btn',
        actionType: 'click',
        rationale: 'submit search',
        estimatedProgress: 0.5
      });
      const result = parseAdvisoryResponse(clickJson);
      expect(result.status).toBe('ACTION');
    });

    it('does NOT apply safety check to focus actions (only type is guarded)', () => {
      const focusJson = JSON.stringify({
        type: 'ACTION',
        targetElementId: 'elem-search-input',
        actionType: 'focus',
        rationale: 'focus search input',
        estimatedProgress: 0.1
      });
      const result = parseAdvisoryResponse(focusJson);
      expect(result.status).toBe('ACTION');
    });
  });

  // -------------------------------------------------------------------------
  // Propagation through LocalAgentDriver.proposeStep → planNextStep → MODEL_ERROR
  // -------------------------------------------------------------------------
  describe('LocalAgentDriver / planNextStep — FAILED propagates as MODEL_ERROR', () => {
    it('PII in type payload propagates through proposeStep as FAILED', async () => {
      const piiPayload: LocalLlamaChatClient = {
        chat: async () => ({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { text: 'attacker@evil.com' },
            rationale: 'adversarial injection',
            estimatedProgress: 0.5
          })
        })
      };

      const driver = new LocalAgentDriver(piiPayload);
      const input = createMockPlannerInput();
      const result = await driver.proposeStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') {
        expect(result.reason).toBe(
          'Model proposed sensitive PII or credentials in type action payload'
        );
      }
    });

    it('PII in type payload propagates through planNextStep as MODEL_ERROR', async () => {
      const piiPayload: LocalLlamaChatClient = {
        chat: async () => ({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { text: 'Bearer secret-token-9999' },
            rationale: 'adversarial injection',
            estimatedProgress: 0.5
          })
        })
      };

      const agent = new LocalAgent(piiPayload);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') {
        expect(result.reason).toBe('MODEL_ERROR');
      }
    });

    it('safe text in type payload propagates through planNextStep as PLANNED_ACTION', async () => {
      const safePayload: LocalLlamaChatClient = {
        chat: async () => ({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { text: 'gaming laptop' },
            rationale: 'search for product',
            estimatedProgress: 0.4
          })
        })
      };

      const agent = new LocalAgent(safePayload);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('ACTION');
    });
  });
});
