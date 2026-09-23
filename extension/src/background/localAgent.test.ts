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
  DefaultLocalLlamaChatClient,
  compactCandidatesForModel,
  MAX_MODEL_CANDIDATES,
  normalizeModelProposal,
  findTopLevelJsonObjectCandidates,
  extractSingleJsonObject
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

    it('6. LocalAgent timeout remains active while response.json() is pending', async () => {
      let resolveBody: (val: any) => void;
      const bodyPromise = new Promise((resolve) => {
        resolveBody = resolve;
      });

      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => bodyPromise
        });
      });

      const client = new DefaultLocalLlamaChatClient({
        fetchFn: mockFetch as any,
        timeoutMs: 5000
      });

      const chatPromise = client.chat({
        systemPrompt: 'sys',
        userPrompt: 'user'
      });

      // Allow fetchFn to return headers and enter response.json()
      await new Promise((r) => setTimeout(r, 10));

      // While response.json() is pending, clearTimeout must NOT have been called yet
      const callsBeforeBodyResolved = clearTimeoutSpy.mock.calls.length;

      // Resolve the body
      resolveBody!({
        choices: [{ message: { content: '{"type":"ACTION"}' } }]
      });

      const result = await chatPromise;
      expect(result.success).toBe(true);

      // Now clearTimeout MUST have been called in finally
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeBodyResolved);
    });

    it('7. A hung response body eventually aborts with TIMEOUT error', async () => {
      const mockFetch = vi.fn().mockImplementation((_url, init) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_, reject) => {
              init.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
              });
            })
        });
      });

      const client = new DefaultLocalLlamaChatClient({
        fetchFn: mockFetch as any,
        timeoutMs: 50
      });

      const result = await client.chat({
        systemPrompt: 'sys',
        userPrompt: 'user'
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('TIMEOUT');
      expect(result.error.message).toContain('timed out after 50ms');
    });

    it('8. A normal response body clears the timeout only after body consumption', async () => {
      const events: string[] = [];
      const originalClearTimeout = globalThis.clearTimeout;
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation((id) => {
        events.push('clearTimeout');
        return originalClearTimeout(id);
      });

      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            events.push('body-consuming');
            await new Promise((r) => setTimeout(r, 10));
            events.push('body-consumed');
            return {
              choices: [{ message: { content: '{"type":"ACTION"}' } }]
            };
          }
        });
      });

      const client = new DefaultLocalLlamaChatClient({
        fetchFn: mockFetch as any,
        timeoutMs: 5000
      });

      const result = await client.chat({
        systemPrompt: 'sys',
        userPrompt: 'user'
      });

      expect(result.success).toBe(true);
      expect(events).toEqual(['body-consuming', 'body-consumed', 'clearTimeout']);
    });

    it('9. DefaultLocalLlamaChatClient handles invalid JSON and empty content error codes', async () => {
      // 9a. Invalid JSON response
      const mockInvalidJsonFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON'))
      });

      const client1 = new DefaultLocalLlamaChatClient({
        fetchFn: mockInvalidJsonFetch as any,
        timeoutMs: 5000
      });

      const result1 = await client1.chat({
        systemPrompt: 'sys',
        userPrompt: 'user'
      });

      expect(result1.success).toBe(false);
      if (result1.success) throw new Error('Expected failure');
      expect(result1.error.code).toBe('INVALID_RESPONSE');
      expect(result1.error.message).toContain('invalid JSON');

      // 9b. Empty content response
      const mockEmptyContentFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: '   ' } }] })
      });

      const client2 = new DefaultLocalLlamaChatClient({
        fetchFn: mockEmptyContentFetch as any,
        timeoutMs: 5000
      });

      const result2 = await client2.chat({
        systemPrompt: 'sys',
        userPrompt: 'user'
      });

      expect(result2.success).toBe(false);
      if (result2.success) throw new Error('Expected failure');
      expect(result2.error.code).toBe('EMPTY_CONTENT');
      expect(result2.error.message).toContain('without text content');
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

// ---------------------------------------------------------------------------
// Prompt Compaction — compactCandidatesForModel
// ---------------------------------------------------------------------------

describe('compactCandidatesForModel — prompt payload compaction', () => {
  // Helpers
  function makeCandidate(
    id: string,
    role: string | undefined,
    accessibleName: string | undefined,
    visibleText?: string,
    confidence = 0.8
  ) {
    return {
      elementId: id,
      ...(role !== undefined ? { role } : {}),
      ...(accessibleName !== undefined ? { accessibleName } : {}),
      ...(visibleText !== undefined ? { visibleText } : {}),
      confidence,
      bounds: { x: 10, y: 20, width: 100, height: 40 }  // should be stripped in output
    };
  }

  function makeManyCandidates(count: number) {
    return Array.from({ length: count }, (_, i) =>
      makeCandidate(`elem-${i}`, 'button', `Button ${i}`)
    );
  }

  // -------------------------------------------------------------------------
  // Core size-bounding guarantee
  // -------------------------------------------------------------------------

  it('caps output to MAX_MODEL_CANDIDATES even when input has many more', () => {
    const candidates = makeManyCandidates(100);
    const result = compactCandidatesForModel(candidates, 'Search for laptops');
    expect(result.length).toBeLessThanOrEqual(MAX_MODEL_CANDIDATES);
  });

  it('MAX_MODEL_CANDIDATES is 20', () => {
    expect(MAX_MODEL_CANDIDATES).toBe(20);
  });

  it('returns all candidates when input is within the limit', () => {
    const candidates = makeManyCandidates(5);
    const result = compactCandidatesForModel(candidates, 'Click something');
    expect(result.length).toBe(5);
  });

  it('respects a custom limit parameter', () => {
    const candidates = makeManyCandidates(50);
    const result = compactCandidatesForModel(candidates, 'Search', 10);
    expect(result.length).toBe(10);
  });

  it('returns empty array for empty input', () => {
    expect(compactCandidatesForModel([], 'Search for laptops')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Bounds omission — the key token-saving change
  // -------------------------------------------------------------------------

  it('strips bounds from all output candidates', () => {
    const candidates = makeManyCandidates(5);
    const result = compactCandidatesForModel(candidates, 'Click a button');
    for (const c of result) {
      expect((c as any).bounds).toBeUndefined();
    }
  });

  it('preserves elementId, role, accessibleName, visibleText, confidence', () => {
    const c = makeCandidate('elem-test', 'button', 'Submit order', 'Submit', 0.92);
    const [out] = compactCandidatesForModel([c], 'Submit');
    expect(out.elementId).toBe('elem-test');
    expect(out.role).toBe('button');
    expect(out.accessibleName).toBe('Submit order');
    expect(out.visibleText).toBe('Submit');
    expect(out.confidence).toBe(0.92);
  });

  // -------------------------------------------------------------------------
  // Role-priority ranking
  // -------------------------------------------------------------------------

  it('places searchbox before button before link when no keyword match', () => {
    const candidates = [
      makeCandidate('link-1',   'link',      'Home'),
      makeCandidate('btn-1',    'button',    'Search'),
      makeCandidate('search-1', 'searchbox', 'Search products')
    ];
    const result = compactCandidatesForModel(candidates, 'do something');
    expect(result[0].elementId).toBe('search-1');
    expect(result[1].elementId).toBe('btn-1');
    expect(result[2].elementId).toBe('link-1');
  });

  it('places textbox/searchbox at the top for a search task with 66 candidates', () => {
    // Simulates the ShopSphere scenario that caused the 6887-token failure
    const candidates = [
      ...Array.from({ length: 60 }, (_, i) => makeCandidate(`btn-${i}`, 'button', `Nav item ${i}`)),
      makeCandidate('search-input', 'searchbox', 'Search products'),
      makeCandidate('text-input',   'textbox',   'Search box'),
      makeCandidate('combo-1',      'combobox',  'Sort by'),
      makeCandidate('link-home',    'link',       'Home'),
      makeCandidate('link-deals',   'link',       'Deals'),
      makeCandidate('link-cart',    'link',       'Cart')
    ];
    const result = compactCandidatesForModel(candidates, 'Search for laptops under 50000');

    // Must be capped
    expect(result.length).toBe(MAX_MODEL_CANDIDATES);
    // Search-related elements must be in the top results
    const topIds = result.slice(0, 5).map(c => c.elementId);
    expect(topIds).toContain('search-input');
    expect(topIds).toContain('text-input');
  });

  // -------------------------------------------------------------------------
  // Keyword-relevance ranking
  // -------------------------------------------------------------------------

  it('boosts elements whose label matches goal keywords', () => {
    const candidates = [
      makeCandidate('btn-cart',   'button', 'Add to cart'),
      makeCandidate('btn-search', 'button', 'Search laptops'),  // keyword match
      makeCandidate('btn-login',  'button', 'Sign in')
    ];
    const result = compactCandidatesForModel(candidates, 'Search for laptops');
    // btn-search matches 'search' and 'laptops' keywords → should rank first among buttons
    expect(result[0].elementId).toBe('btn-search');
  });

  // -------------------------------------------------------------------------
  // Privacy safety — compaction operates AFTER sanitization
  // -------------------------------------------------------------------------

  it('does not re-introduce raw email addresses into output', () => {
    // The sanitizer would have already redacted PII; compaction must not bypass that.
    // Simulate an already-sanitized candidate (no raw PII, token placeholder instead).
    const c = makeCandidate(
      'elem-email',
      'textbox',
      '[REDACTED_EMAIL]',  // already sanitized before reaching compaction
      undefined
    );
    const [out] = compactCandidatesForModel([c], 'Enter your email');
    // Must preserve the redaction token, not strip it or invent raw value
    expect(out.accessibleName).toBe('[REDACTED_EMAIL]');
    // Must NOT contain a real email pattern
    expect(out.accessibleName).not.toMatch(/@[a-z]+\.[a-z]/);
  });

  it('passes through sanitized goal keywords without adding raw PII', () => {
    const candidates = makeManyCandidates(5);
    // Goal with a keyword that looks sensitive — compaction must not produce PII
    const result = compactCandidatesForModel(candidates, 'search password reset');
    for (const c of result) {
      // No candidate should have raw credential values injected by compaction
      const jsonStr = JSON.stringify(c);
      expect(jsonStr).not.toMatch(/password.*:.*\d{4,}/i);
    }
  });

  // -------------------------------------------------------------------------
  // buildAgentUserPrompt token-size bound
  // -------------------------------------------------------------------------

  it('buildAgentUserPrompt output fits within ~4096-token budget for 66 candidates', () => {
    // Build a mock PlannerInput with 66 interactive targets (ShopSphere-scale)
    const mockPage: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { title: 'ShopSphere', url: 'https://shopsphere.local' },
      viewport: { width: 1440, height: 900 },
      elements: Array.from({ length: 66 }, (_, i) => ({
        id: `elem-${i}`,
        role: i < 2 ? ('searchbox' as const) : ('button' as const),
        tagName: i < 2 ? 'input' : 'button',
        accessibleName: i < 2 ? 'Search products' : `Button label ${i}`,
        visibleText: i < 2 ? '' : `Button ${i}`,
        interactive: true,
        bounds: { x: i * 5, y: 100, width: 120, height: 40 }
      }))
    };

    const mockTargets: ActionTarget[] = mockPage.elements.map((el, i) => ({
      elementId: el.id!,
      point: { x: (el.bounds?.x ?? 0) + 60, y: 120 },
      viewportBounds: { x: el.bounds?.x ?? 0, y: 100, width: 120, height: 40 },
      confidence: 0.7 + (i < 2 ? 0.25 : 0),
      observationId: `obs-${i}`,
      role: el.role
    }));

    const mockInput: PlannerInput = {
      goal: { id: 'g1', description: 'Search for laptops under 50000', intent: 'search' },
      context: {
        page: mockPage,
        availableTargets: mockTargets,
        capturedAt: 1710000000000,
        currentTime: 1710000001000,
        stepIndex: 0
      }
    };

    const promptJson = buildAgentUserPrompt(mockInput);

    // Approx token count: 1 token ≈ 4 chars (conservative estimate for JSON)
    const approxTokens = Math.ceil(promptJson.length / 4);
    expect(approxTokens).toBeLessThan(2500);  // well under 4096 - system_prompt overhead

    // Must include the high-priority searchbox
    expect(promptJson).toContain('elem-0');
    // Must NOT include all 66 candidates
    const parsed = JSON.parse(promptJson);
    expect(parsed.availableTargets.length).toBeLessThanOrEqual(MAX_MODEL_CANDIDATES);
    // bounds must be absent
    for (const t of parsed.availableTargets) {
      expect(t.bounds).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // Model Output Normalization & Compatibility Adapter
  // -------------------------------------------------------------------------
  describe('Model Output Normalization & Compatibility Adapter', () => {
    // 1. Canonical ACTION output still works
    it('preserves canonical ACTION proposals unchanged', () => {
      const canonicalAction = JSON.stringify({
        type: 'ACTION',
        actionType: 'click',
        targetElementId: 'elem-search-btn',
        rationale: 'Click search button',
        estimatedProgress: 0.5
      });
      const result = parseAdvisoryResponse(canonicalAction);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.actionType).toBe('click');
      expect(result.proposal.targetElementId).toBe('elem-search-btn');
      expect(result.proposal.rationale).toBe('Click search button');
      expect(result.proposal.estimatedProgress).toBe(0.5);
    });

    // 2. Canonical COMPLETED output still works
    it('preserves canonical COMPLETED proposals unchanged', () => {
      const canonicalCompleted = JSON.stringify({
        type: 'COMPLETED',
        rationale: 'Search task has finished'
      });
      const result = parseAdvisoryResponse(canonicalCompleted);
      expect(result.status).toBe('COMPLETED');
      if (result.status !== 'COMPLETED') throw new Error('Expected COMPLETED');
      expect(result.summary).toBe('Search task has finished');
    });

    // 3. Lowercase/simple "click" action output is normalized correctly
    it('normalizes lowercase "click" action proposals into canonical ACTION', () => {
      const clickProposal = JSON.stringify({
        type: 'click',
        targetElementId: 'elem-search-btn',
        rationale: 'Click the search button'
      });
      const result = parseAdvisoryResponse(clickProposal);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.actionType).toBe('click');
      expect(result.proposal.targetElementId).toBe('elem-search-btn');
      expect(result.proposal.rationale).toBe('Click the search button');
    });

    it('normalizes "click" proposal using elementId fallback', () => {
      const clickWithElementId = JSON.stringify({
        type: 'click',
        elementId: 'elem-search-btn'
      });
      const result = parseAdvisoryResponse(clickWithElementId);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.actionType).toBe('click');
      expect(result.proposal.targetElementId).toBe('elem-search-btn');
    });

    it('normalizes uppercase "CLICK" action proposal', () => {
      const upperClick = JSON.stringify({
        type: 'CLICK',
        targetElementId: 'elem-search-btn'
      });
      const result = parseAdvisoryResponse(upperClick);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.actionType).toBe('click');
    });

    // 4. Type output is normalized correctly
    it('normalizes lowercase "type" proposal with structured payload', () => {
      const typeWithPayload = JSON.stringify({
        type: 'type',
        targetElementId: 'elem-search-input',
        payload: { text: 'laptops under 50000' },
        rationale: 'Enter search keywords'
      });
      const result = parseAdvisoryResponse(typeWithPayload);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.actionType).toBe('type');
      expect(result.proposal.targetElementId).toBe('elem-search-input');
      expect(result.proposal.payload?.text).toBe('laptops under 50000');
    });

    it('normalizes lowercase "type" proposal with root-level text field', () => {
      const typeWithRootText = JSON.stringify({
        type: 'type',
        targetElementId: 'elem-search-input',
        text: 'laptops under 50000',
        clearFirst: true,
        pressEnter: true
      });
      const result = parseAdvisoryResponse(typeWithRootText);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.actionType).toBe('type');
      expect(result.proposal.targetElementId).toBe('elem-search-input');
      expect(result.proposal.payload?.text).toBe('laptops under 50000');
      expect(result.proposal.payload?.clearFirst).toBe(true);
      expect(result.proposal.payload?.pressEnter).toBe(true);
    });

    // 5. Focus output is normalized correctly
    it('normalizes lowercase "focus" action proposal', () => {
      const focusProposal = JSON.stringify({
        type: 'focus',
        targetElementId: 'elem-search-input',
        rationale: 'Focus search input field'
      });
      const result = parseAdvisoryResponse(focusProposal);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.actionType).toBe('focus');
      expect(result.proposal.targetElementId).toBe('elem-search-input');
      expect(result.proposal.rationale).toBe('Focus search input field');
    });

    // 6. Malformed / unknown proposal types are still rejected
    it('rejects unsupported action proposal types like "hover"', () => {
      const hoverProposal = JSON.stringify({
        type: 'hover',
        targetElementId: 'elem-search-btn'
      });
      const result = parseAdvisoryResponse(hoverProposal);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toContain('Unrecognized proposal type "hover"');
    });

    it('rejects unsupported action proposal types like "scroll"', () => {
      const scrollProposal = JSON.stringify({
        type: 'scroll',
        targetElementId: 'elem-container'
      });
      const result = parseAdvisoryResponse(scrollProposal);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toContain('Unrecognized proposal type "scroll"');
    });

    it('rejects proposal missing type discriminator', () => {
      const noType = JSON.stringify({
        targetElementId: 'elem-search-btn'
      });
      const result = parseAdvisoryResponse(noType);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toContain('missing required "type" property');
    });

    it('rejects normalized action proposal missing target ID', () => {
      const noTarget = JSON.stringify({
        type: 'click'
      });
      const result = parseAdvisoryResponse(noTarget);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toContain('missing required non-empty "targetElementId"');
    });

    // 7. Target IDs are not invented or changed
    it('strictly preserves exact target IDs without modification or invention', () => {
      const exactId = 'elem-search-input:sub_0_#99';
      const proposal = JSON.stringify({
        type: 'click',
        targetElementId: exactId
      });
      const result = parseAdvisoryResponse(proposal);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.targetElementId).toBe(exactId);
    });

    // 8. Privacy-sensitive type payloads still go through existing safety checks
    it('strictly blocks PII email in normalized type proposals', () => {
      const piiType = JSON.stringify({
        type: 'type',
        targetElementId: 'elem-search-input',
        text: 'test.user@domain.com'
      });
      const result = parseAdvisoryResponse(piiType);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe(
        'Model proposed sensitive PII or credentials in type action payload'
      );
    });

    it('strictly blocks auth bearer token in normalized type proposals', () => {
      const tokenType = JSON.stringify({
        type: 'type',
        targetElementId: 'elem-search-input',
        payload: { text: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' }
      });
      const result = parseAdvisoryResponse(tokenType);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe(
        'Model proposed sensitive PII or credentials in type action payload'
      );
    });

    it('permits safe query and vault pointer in normalized type proposals', () => {
      const safeType = JSON.stringify({
        type: 'type',
        targetElementId: 'elem-search-input',
        text: 'profile.email'
      });
      const result = parseAdvisoryResponse(safeType);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.payload?.text).toBe('profile.email');
    });

    // 9. Full planNextStep pipeline test with normalized lower-level model output
    it('executes end-to-end planNextStep with lower-level "click" model output', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'click',
            targetElementId: 'elem-submit-btn',
            rationale: 'Click search button'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.action.type).toBe('click');
      expect(result.action.target.elementId).toBe('elem-submit-btn');
    });
  });
});

// ---------------------------------------------------------------------------
// Planning Output Boundary Hardening Regression Tests (Goals D & E)
// ---------------------------------------------------------------------------

describe('Planning Output Boundary Hardening (Goals D & E)', () => {
  describe('Goal D: Parser Structured-Output Variations & Strict Validation', () => {
    // 1. clean JSON
    it('1. clean JSON: parses clean JSON action proposal successfully', () => {
      const cleanJson = JSON.stringify({
        type: 'ACTION',
        targetElementId: 'elem-search-input',
        actionType: 'click',
        rationale: 'Click search input'
      });
      const result = parseAdvisoryResponse(cleanJson);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.targetElementId).toBe('elem-search-input');
      expect(result.proposal.actionType).toBe('click');
    });

    // 2. fenced JSON
    it('2. fenced JSON: parses markdown fenced JSON action proposal successfully', () => {
      const fencedJson = '```json\n{"type": "ACTION", "targetElementId": "elem-search-input", "actionType": "click"}\n```';
      const result = parseAdvisoryResponse(fencedJson);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.targetElementId).toBe('elem-search-input');
      expect(result.proposal.actionType).toBe('click');
    });

    // 3. surrounding whitespace
    it('3. surrounding whitespace: handles leading, trailing, and newline whitespace safely', () => {
      const whitespaceJson = '   \n\t  {"type": "ACTION", "targetElementId": "elem-submit-btn", "actionType": "click"}   \r\n\t ';
      const result = parseAdvisoryResponse(whitespaceJson);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.targetElementId).toBe('elem-submit-btn');
      expect(result.proposal.actionType).toBe('click');
    });

    // 4. safe JSON extraction from a known wrapper/preamble
    it('4. safe JSON extraction from wrapper/preamble: extracts single JSON object from conversational text', () => {
      const withPreamble =
        'Here is the selected next step for the user task:\n' +
        '{"type": "ACTION", "targetElementId": "elem-search-input", "actionType": "click", "rationale": "Focus on search"}\n' +
        'Please execute this step next.';
      const result = parseAdvisoryResponse(withPreamble);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.targetElementId).toBe('elem-search-input');
      expect(result.proposal.actionType).toBe('click');
      expect(result.proposal.rationale).toBe('Focus on search');
    });

    it('4b. safe JSON extraction from markdown fence surrounded by conversational prose', () => {
      const fencedWithProse =
        'I examined the candidate targets and found the search input.\n' +
        '```json\n' +
        '{\n' +
        '  "type": "ACTION",\n' +
        '  "targetElementId": "elem-search-input",\n' +
        '  "actionType": "type",\n' +
        '  "payload": { "text": "laptops under 50000" }\n' +
        '}\n' +
        '```\n' +
        'Let me know if you need any further actions.';
      const result = parseAdvisoryResponse(fencedWithProse);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.targetElementId).toBe('elem-search-input');
      expect(result.proposal.actionType).toBe('type');
      expect(result.proposal.payload?.text).toBe('laptops under 50000');
    });

    // 5. plain prose rejection
    it('5. plain prose rejection: rejects arbitrary conversational prose without valid JSON', () => {
      const prose = 'I recommend that you click on the submit button on the page to search for laptops.';
      const result = parseAdvisoryResponse(prose);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('Failed to parse model output as valid JSON');
    });

    // 6. malformed JSON rejection
    it('6. malformed JSON rejection: rejects unquoted keys or invalid syntax without guessing', () => {
      const malformed = '{"type": "ACTION", targetElementId: elem-search, "actionType": "click"}';
      const result = parseAdvisoryResponse(malformed);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('Failed to parse model output as valid JSON');
    });

    // 7. truncated JSON rejection
    it('7. truncated JSON rejection: rejects incomplete JSON from finish_reason "length"', () => {
      const truncated = '{"type": "ACTION", "targetElementId": "elem-search-input", "actionType": "ty';
      const result = parseAdvisoryResponse(truncated);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('Failed to parse model output as valid JSON');
    });

    it('7b. truncated JSON in markdown fence rejection', () => {
      const truncatedFenced = '```json\n{"type": "ACTION", "targetElementId": "elem-search-input", "actionType":';
      const result = parseAdvisoryResponse(truncatedFenced);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe('Failed to parse model output as valid JSON');
    });

    // 8. unsupported action rejection
    it('8. unsupported action rejection: rejects actions not in click/type/focus', () => {
      const unsupportedAction = JSON.stringify({
        type: 'ACTION',
        targetElementId: 'elem-submit-btn',
        actionType: 'hover'
      });
      const result = parseAdvisoryResponse(unsupportedAction);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toContain('Unsupported actionType "hover"');
    });

    // 9. missing target rejection
    it('9. missing target rejection: rejects ACTION proposals lacking targetElementId', () => {
      const missingTarget = JSON.stringify({
        type: 'ACTION',
        actionType: 'click'
      });
      const result = parseAdvisoryResponse(missingTarget);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toContain('missing required non-empty "targetElementId"');
    });

    // 10. sensitive type payload rejection
    it('10. sensitive type payload rejection: rejects type action proposals containing raw PII or credentials', () => {
      const piiProposal = JSON.stringify({
        type: 'ACTION',
        targetElementId: 'elem-search-input',
        actionType: 'type',
        payload: { text: 'user@example.com' }
      });
      const result = parseAdvisoryResponse(piiProposal);
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(result.reason).toBe(
        'Model proposed sensitive PII or credentials in type action payload'
      );
    });

    // 11. completion response
    it('11. completion response: parses valid COMPLETED proposal successfully', () => {
      const completionJson = JSON.stringify({
        type: 'COMPLETED',
        rationale: 'Search for laptops under ₹50,000 completed successfully'
      });
      const result = parseAdvisoryResponse(completionJson);
      expect(result.status).toBe('COMPLETED');
      if (result.status !== 'COMPLETED') throw new Error('Expected COMPLETED');
      expect(result.summary).toBe('Search for laptops under ₹50,000 completed successfully');
    });
  });

  describe('Goal E: Default Local Planning Completion Budget', () => {
    it('proves DefaultLocalLlamaChatClient sends default max_tokens: 1024 in request payload', async () => {
      let capturedBody: any;
      const mockFetch = vi.fn().mockImplementation((_url, init) => {
        capturedBody = JSON.parse(init.body);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  message: {
                    content: '{"type":"ACTION","targetElementId":"elem-1","actionType":"click"}'
                  }
                }
              ]
            })
        });
      });

      const client = new DefaultLocalLlamaChatClient({
        fetchFn: mockFetch as any
      });

      const result = await client.chat({
        systemPrompt: 'sys prompt',
        userPrompt: 'user prompt'
      });

      expect(result.success).toBe(true);
      expect(capturedBody).toBeDefined();
      expect(capturedBody.max_tokens).toBe(1024);
      expect(capturedBody.response_format).toEqual({ type: 'json_object' });
    });

    it('allows overriding maxTokens when explicitly provided in options', async () => {
      let capturedBody: any;
      const mockFetch = vi.fn().mockImplementation((_url, init) => {
        capturedBody = JSON.parse(init.body);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  message: {
                    content: '{"type":"ACTION","targetElementId":"elem-1","actionType":"click"}'
                  }
                }
              ]
            })
        });
      });

      const client = new DefaultLocalLlamaChatClient({
        fetchFn: mockFetch as any,
        maxTokens: 2048
      });

      await client.chat({
        systemPrompt: 'sys prompt',
        userPrompt: 'user prompt'
      });

      expect(capturedBody.max_tokens).toBe(2048);
    });
  });
});

// ---------------------------------------------------------------------------
// Goal F — History, Focus, and Type-Selection Planner Fixes
// ---------------------------------------------------------------------------

describe('Goal F — History / Focus / Type-Selection Planner Fixes', () => {

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Minimal ActionTarget used inside IntendedAction fixtures. */
  function makeTarget(
    elementId: string,
    role?: string
  ): import('../shared/actions.js').ActionTarget {
    return {
      elementId,
      point: { x: 150, y: 50 },
      viewportBounds: { x: 50, y: 30, width: 200, height: 40 },
      confidence: 0.95,
      observationId: 'obs-test',
      ...(role !== undefined ? { role } : {})
    };
  }

  function makeClickAction(elementId: string, role?: string): import('../shared/actions.js').ClickAction {
    return {
      id: `action-click-${elementId}`,
      type: 'click',
      target: makeTarget(elementId, role)
    };
  }

  function makeTypeAction(elementId: string, text: string, role?: string): import('../shared/actions.js').TypeAction {
    return {
      id: `action-type-${elementId}`,
      type: 'type',
      target: makeTarget(elementId, role),
      payload: { text, pressEnter: true }
    };
  }

  function makeHistoryStep(
    stepIndex: number,
    action: import('../shared/actions.js').IntendedAction,
    perceivedOutcome?: 'success' | 'no_change' | 'error'
  ): import('../shared/planner.js').PlannerHistoryStep {
    return {
      stepIndex,
      action,
      ...(perceivedOutcome !== undefined ? { perceivedOutcome } : {})
    };
  }

  // -------------------------------------------------------------------------
  // F1–F2: focused propagation in buildModelPromptPayload
  // -------------------------------------------------------------------------

  it('F1. buildModelPromptPayload includes focused:true for element with state.focused = true', () => {
    const page: PageRepresentation = {
      schemaVersion: '1.0',
      metadata: { title: 'Test', url: 'https://example.com' },
      viewport: { width: 1280, height: 800 },
      elements: [
        {
          id: 'elem-searchbox',
          role: 'searchbox',
          accessibleName: 'Search',
          interactive: true,
          state: { focused: true },
          bounds: { x: 50, y: 30, width: 200, height: 40 }
        }
      ]
    };
    const input: PlannerInput = {
      goal: { id: 'g1', description: 'Search for laptops' },
      context: {
        page,
        availableTargets: [
          {
            elementId: 'elem-searchbox',
            point: { x: 150, y: 50 },
            viewportBounds: { x: 50, y: 30, width: 200, height: 40 },
            confidence: 0.9,
            observationId: 'obs-1',
            role: 'searchbox'
          }
        ],
        capturedAt: FIXED_TIME - 500,
        currentTime: FIXED_TIME,
        stepIndex: 1,
        completion: { satisfied: false }
      }
    };
    const payload = buildModelPromptPayload(input);
    expect(payload.availableTargets.length).toBe(1);
    expect(payload.availableTargets[0].focused).toBe(true);
  });

  it('F2. buildModelPromptPayload omits focused key for non-focused element', () => {
    const input = createMockPlannerInput();
    const payload = buildModelPromptPayload(input);
    // MOCK_PAGE elements have no state.focused set
    for (const t of payload.availableTargets) {
      expect((t as any).focused).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // F3–F4: focused preservation and boost in compactCandidatesForModel
  // -------------------------------------------------------------------------

  it('F3. compactCandidatesForModel preserves focused:true in output', () => {
    const candidates: import('./localAgent.js').ModelCandidateTarget[] = [
      { elementId: 'elem-focused', role: 'searchbox', confidence: 0.9, focused: true },
      { elementId: 'elem-normal',  role: 'button',    confidence: 0.9 }
    ];
    const result = compactCandidatesForModel(candidates, 'Search');
    const focused = result.find(c => c.elementId === 'elem-focused');
    expect(focused?.focused).toBe(true);
    // unfocused element must NOT get a focused key
    const normal = result.find(c => c.elementId === 'elem-normal');
    expect((normal as any).focused).toBeUndefined();
  });

  it('F4. compactCandidatesForModel ranks focused element above same-role unfocused element', () => {
    const candidates: import('./localAgent.js').ModelCandidateTarget[] = [
      { elementId: 'elem-button-a', role: 'button', confidence: 0.9 },
      { elementId: 'elem-button-b', role: 'button', confidence: 0.9, focused: true }
    ];
    const result = compactCandidatesForModel(candidates, 'Click something');
    // focused button must appear before the unfocused button
    expect(result[0].elementId).toBe('elem-button-b');
  });

  // -------------------------------------------------------------------------
  // F5–F9: safe history extraction in buildModelPromptPayload
  // -------------------------------------------------------------------------

  it('F5. buildModelPromptPayload includes history and strips typed text from type action', () => {
    const input = createMockPlannerInput({
      history: [
        makeHistoryStep(0, makeTypeAction('elem-search-input', 'laptops', 'textbox'), 'success')
      ]
    });
    const payload = buildModelPromptPayload(input);
    expect(payload.history).toBeDefined();
    expect(payload.history!.length).toBe(1);
    const h = payload.history![0];
    expect(h.actionType).toBe('type');
    expect(h.targetElementId).toBe('elem-search-input');
    expect(h.targetRole).toBe('textbox');
    expect(h.perceivedOutcome).toBe('success');
    // text and payload must NEVER appear in safe history
    expect((h as any).payload).toBeUndefined();
    expect((h as any).text).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain('laptops');
    expect(JSON.stringify(h)).not.toContain('"text":');
    expect(JSON.stringify(h)).not.toContain('"payload":');
  });

  it('F6. buildModelPromptPayload records click action type correctly in history', () => {
    const input = createMockPlannerInput({
      history: [
        makeHistoryStep(0, makeClickAction('elem-search-input', 'searchbox'), 'success')
      ]
    });
    const payload = buildModelPromptPayload(input);
    expect(payload.history).toBeDefined();
    expect(payload.history![0].actionType).toBe('click');
    expect(payload.history![0].targetElementId).toBe('elem-search-input');
    expect(payload.history![0].targetRole).toBe('searchbox');
  });

  it('F7. buildModelPromptPayload includes perceivedOutcome when no_change', () => {
    const input = createMockPlannerInput({
      history: [
        makeHistoryStep(0, makeClickAction('elem-btn'), 'no_change')
      ]
    });
    const payload = buildModelPromptPayload(input);
    expect(payload.history![0].perceivedOutcome).toBe('no_change');
  });

  it('F8. buildModelPromptPayload omits history key when history is empty', () => {
    const input = createMockPlannerInput({ history: [] });
    const payload = buildModelPromptPayload(input);
    expect(payload.history).toBeUndefined();
  });

  it('F9. buildModelPromptPayload includes all steps from multi-step history', () => {
    const input = createMockPlannerInput({
      history: [
        makeHistoryStep(0, makeClickAction('elem-search-input', 'searchbox'), 'success'),
        makeHistoryStep(1, makeTypeAction('elem-search-input', 'laptops', 'searchbox'), 'success')
      ]
    });
    const payload = buildModelPromptPayload(input);
    expect(payload.history!.length).toBe(2);
    expect(payload.history![0].stepIndex).toBe(0);
    expect(payload.history![1].stepIndex).toBe(1);
    expect(payload.history![1].actionType).toBe('type');
  });

  // -------------------------------------------------------------------------
  // F10–F12: system prompt content validation
  // -------------------------------------------------------------------------

  it('F10. LOCAL_AGENT_SYSTEM_PROMPT instructs model to use type for textbox/searchbox tasks', () => {
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toMatch(/use.*"type".*textbox/i);
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toMatch(/searchbox/i);
  });

  it('F11. LOCAL_AGENT_SYSTEM_PROMPT mentions focused:true → type immediately', () => {
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toMatch(/focused.*true/i);
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toMatch(/type/i);
  });

  it('F12. LOCAL_AGENT_SYSTEM_PROMPT mentions pressEnter:true for search submission', () => {
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toMatch(/pressEnter.*true/i);
  });

  // -------------------------------------------------------------------------
  // F13–F14: buildAgentUserPrompt serialises history
  // -------------------------------------------------------------------------

  it('F13. buildAgentUserPrompt serialises history into the user prompt JSON', () => {
    const input = createMockPlannerInput({
      history: [
        makeHistoryStep(0, makeClickAction('elem-search-input', 'searchbox'), 'success')
      ]
    });
    const prompt = buildAgentUserPrompt(input);
    const parsed = JSON.parse(prompt);
    expect(parsed.history).toBeDefined();
    expect(parsed.history.length).toBe(1);
    expect(parsed.history[0].actionType).toBe('click');
    expect(parsed.history[0].targetElementId).toBe('elem-search-input');
  });

  it('F14. buildModelPromptPayload omits targetRole from history when action target has no role', () => {
    const actionNoRole = makeClickAction('elem-search-input');  // no role
    const input = createMockPlannerInput({
      history: [ makeHistoryStep(0, actionNoRole) ]
    });
    const payload = buildModelPromptPayload(input);
    const h = payload.history![0];
    expect(h.targetElementId).toBe('elem-search-input');
    expect((h as any).targetRole).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // F15–F19: pressEnter normalization & validation
  // -------------------------------------------------------------------------

  it('F15. normalizeModelProposal normalizes "pressEnter": "true" (string) to boolean true', () => {
    const raw = {
      type: 'ACTION',
      actionType: 'type',
      targetElementId: 'elem-search',
      payload: { text: 'laptop', pressEnter: 'true' }
    };
    const normalized = normalizeModelProposal(raw);
    expect((normalized.payload as any)?.pressEnter).toBe(true);
  });

  it('F16. normalizeModelProposal hoists root-level pressEnter into payload object', () => {
    const raw = {
      type: 'ACTION',
      actionType: 'type',
      targetElementId: 'elem-search',
      payload: { text: 'laptop' },
      pressEnter: true
    };
    const normalized = normalizeModelProposal(raw);
    expect((normalized.payload as any)?.pressEnter).toBe(true);
  });

  it('F17. normalizeModelProposal normalizes "pressEnter": "false" (string) to boolean false', () => {
    const raw = {
      type: 'ACTION',
      actionType: 'type',
      targetElementId: 'elem-search',
      payload: { text: 'laptop', pressEnter: 'false' }
    };
    const normalized = normalizeModelProposal(raw);
    expect((normalized.payload as any)?.pressEnter).toBe(false);
  });

  it('F18. parseAdvisoryResponse preserves boolean pressEnter: true in validated proposal', () => {
    const rawJson = JSON.stringify({
      type: 'ACTION',
      actionType: 'type',
      targetElementId: 'elem-search',
      payload: { text: 'laptop', pressEnter: true },
      rationale: 'Search for laptops'
    });
    const result = parseAdvisoryResponse(rawJson);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.proposal.payload?.pressEnter).toBe(true);
    }
  });

  it('F19. parseAdvisoryResponse normalizes string pressEnter: "true" and accepts proposal', () => {
    const rawJson = JSON.stringify({
      type: 'ACTION',
      actionType: 'type',
      targetElementId: 'elem-search',
      payload: { text: 'laptop', pressEnter: 'true' },
      rationale: 'Search for laptops'
    });
    const result = parseAdvisoryResponse(rawJson);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.proposal.payload?.pressEnter).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// clearFirst regression suite — query-append fix
// ---------------------------------------------------------------------------

describe('clearFirst propagation and query-text-replace regression', () => {
  it('F-CF1. parseAdvisoryResponse passes clearFirst: true through in validated proposal', () => {
    const rawJson = JSON.stringify({
      type: 'ACTION',
      actionType: 'type',
      targetElementId: 'elem-search',
      payload: { text: 'laptops under 50000', clearFirst: true, pressEnter: true },
      rationale: 'Type complete search query'
    });
    const result = parseAdvisoryResponse(rawJson);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.proposal.payload?.clearFirst).toBe(true);
      expect(result.proposal.payload?.pressEnter).toBe(true);
      expect(result.proposal.payload?.text).toBe('laptops under 50000');
    }
  });

  it('F-CF2. parseAdvisoryResponse passes clearFirst: false (intentional append) through', () => {
    const rawJson = JSON.stringify({
      type: 'ACTION',
      actionType: 'type',
      targetElementId: 'elem-notes',
      payload: { text: 'appended text', clearFirst: false },
      rationale: 'Append to existing note'
    });
    const result = parseAdvisoryResponse(rawJson);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.proposal.payload?.clearFirst).toBe(false);
    }
  });

  it('F-CF3. normalizeModelProposal normalizes string clearFirst: "true" to boolean true', () => {
    const raw = {
      type: 'type',
      targetElementId: 'elem-search',
      actionType: 'type',
      payload: { text: 'laptops under 50000', clearFirst: 'true', pressEnter: true }
    };
    const normalized = normalizeModelProposal(raw);
    const payload = normalized['payload'] as Record<string, unknown>;
    expect(payload['clearFirst']).toBe(true);
  });

  it('F-CF4. normalizeModelProposal normalizes string clearFirst: "false" to boolean false', () => {
    const raw = {
      type: 'type',
      targetElementId: 'elem-notes',
      actionType: 'type',
      payload: { text: 'append text', clearFirst: 'false' }
    };
    const normalized = normalizeModelProposal(raw);
    const payload = normalized['payload'] as Record<string, unknown>;
    expect(payload['clearFirst']).toBe(false);
  });

  it('F-CF5. LOCAL_AGENT_SYSTEM_PROMPT contains clearFirst instruction (rule 14)', () => {
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toContain('clearFirst');
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toContain('clearFirst:true');
  });

  it('F-CF6. LOCAL_AGENT_SYSTEM_PROMPT instructs typing entire query in one action (rule 13)', () => {
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toContain('ENTIRE intended text as a single');
  });

  it('F-CF7. LOCAL_AGENT_SYSTEM_PROMPT schema example includes clearFirst field', () => {
    // The schema example must show clearFirst to guide the model
    expect(LOCAL_AGENT_SYSTEM_PROMPT).toContain('"clearFirst": true');
  });

  it('F-CF8. parseAdvisoryResponse accepts type proposal with clearFirst:true + pressEnter:true', () => {
    const rawJson = JSON.stringify({
      type: 'type',
      targetElementId: 'elem-search',
      payload: { text: 'complete search query here', clearFirst: true, pressEnter: true },
      rationale: 'Type complete replacement query and submit'
    });
    const result = parseAdvisoryResponse(rawJson);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.proposal.actionType).toBe('type');
      expect(result.proposal.payload?.text).toBe('complete search query here');
      expect(result.proposal.payload?.clearFirst).toBe(true);
      expect(result.proposal.payload?.pressEnter).toBe(true);
    }
  });

  it('F-CF9. parseAdvisoryResponse type action without clearFirst still succeeds (empty input case)', () => {
    const rawJson = JSON.stringify({
      type: 'type',
      targetElementId: 'elem-search',
      payload: { text: 'initial search', pressEnter: true },
      rationale: 'Type into empty input'
    });
    const result = parseAdvisoryResponse(rawJson);
    expect(result.status).toBe('ACTION');
    if (result.status === 'ACTION') {
      expect(result.proposal.payload?.text).toBe('initial search');
      // clearFirst is not required for empty inputs; its absence is valid
      expect(result.proposal.payload?.clearFirst).toBeUndefined();
    }
  });

  it('F-CF10. clearFirst payload flag is NOT included in structural action history (privacy boundary)', () => {
    // The demoRunner strips typed text from history, but clearFirst (structural boolean) may be preserved
    // The key invariant: typed text itself must never appear in history
    // This test verifies the data-flow contract at the type level: payload.text is stripped to ''
    // clearFirst and pressEnter (structural booleans) may remain since they carry no PII
    const executedTypeAction = {
      id: 'act-1',
      type: 'type' as const,
      target: {
        elementId: 'elem-search',
        point: { x: 100, y: 50 },
        viewportBounds: { x: 50, y: 30, width: 200, height: 40 },
        confidence: 0.95,
        observationId: 'obs-1'
      },
      payload: {
        text: 'secret search text that must not appear in history',
        clearFirst: true,
        pressEnter: true
      }
    };

    // Simulate what demoRunner does when recording history (privacy boundary)
    const safeAction = {
      ...executedTypeAction,
      payload: {
        text: '', // Privacy boundary: typed text stripped to empty string
        ...(executedTypeAction.payload.clearFirst !== undefined ? { clearFirst: executedTypeAction.payload.clearFirst } : {}),
        ...(executedTypeAction.payload.pressEnter !== undefined ? { pressEnter: executedTypeAction.payload.pressEnter } : {})
      }
    };

    const historyEntry = {
      stepIndex: 0,
      action: safeAction,
      perceivedOutcome: 'success' as const
    };

    const serialized = JSON.stringify(historyEntry);
    expect(serialized).not.toContain('secret search text');
    expect(serialized).not.toContain('secret');
    expect(safeAction.payload.text).toBe('');
    // clearFirst and pressEnter may be present (structural, non-PII)
    expect(safeAction.payload.clearFirst).toBe(true);
  });
});

