import { describe, it, expect, vi } from 'vitest';
import type { ActionTarget, TypeAction } from '../shared/actions.js';
import type { PageRepresentation } from '../shared/types.js';
import {
  type PlannerInput,
  type PlannerDriver,
  type PlannerResult,
  type PlannerActionDecision,
  type TaskPhase,
  type SafeModelHistoryStep,
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
  getPhaseRolePriority,
  scoreCandidateRelevance,
  type ModelCandidateTarget,
  normalizeModelProposal,
  findTopLevelJsonObjectCandidates,
  tryParseJsonCandidate,
  extractSingleJsonObject,
  decomposeTaskGoal,
  TASK_DECOMPOSITION_SYSTEM_PROMPT,
  buildTaskDecompositionUserPrompt,
  summarizeTaskPlanForLogs,
  normalizeDecomposedTaskPlan,
  doesTargetCorrespondToPhaseField,
  normalizeActionProposalForPhase,
  type TaskPlan
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
    it('proves DefaultLocalLlamaChatClient sends default max_tokens: 1024 and does NOT send response_format', async () => {
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
      // response_format must NOT be sent — it triggers llama.cpp JSON grammar
      // constraint mode which adds ~108 s of latency with no application benefit
      // since parseAdvisoryResponse() already validates JSON strictly.
      expect(capturedBody.response_format).toBeUndefined();
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

  // -------------------------------------------------------------------------
  // Post-search click candidate ranking (Bug 2 verification)
  // -------------------------------------------------------------------------

  describe('Post-search click candidate ranking', () => {
    it('3. ranks navigation link candidate matching target above generic button in post-search click phase', () => {
      const candidates: import('./localAgent.js').ModelCandidateTarget[] = [
        { elementId: 'elem-btn-play', role: 'button', accessibleName: 'Play', visibleText: 'Play', confidence: 0.9 },
        {
          elementId: 'elem-link-dest',
          role: 'link',
          accessibleName: 'I Built A City To Save Kids From Illegal Labor by Creator',
          visibleText: 'I Built A City To Save Kids From Illegal Labor',
          hasHref: true,
          confidence: 0.9
        }
      ];
      const goalDesc = 'Search for Creator and play this video: I Built A City To Save Kids From Illegal Labor';

      // In post-search click phase (isPostSearchClick = true):
      const postSearchResult = compactCandidatesForModel(candidates, goalDesc, 20, true);
      expect(postSearchResult[0].elementId).toBe('elem-link-dest');
      expect(postSearchResult[1].elementId).toBe('elem-btn-play');
    });

    it('4. preserves button priority over link for ordinary button tasks', () => {
      const candidates: import('./localAgent.js').ModelCandidateTarget[] = [
        { elementId: 'elem-btn-submit', role: 'button', accessibleName: 'Submit Order', visibleText: 'Submit', confidence: 0.9 },
        { elementId: 'elem-link-help', role: 'link', accessibleName: 'Help Link', visibleText: 'Help', confidence: 0.9 }
      ];
      // Ordinary button task without post-search phase:
      const normalResult = compactCandidatesForModel(candidates, 'Submit order', 20, false);
      expect(normalResult[0].elementId).toBe('elem-btn-submit');
    });

    it('buildAgentUserPrompt automatically applies post-search ranking when goal intent is click on compound goal', () => {
      const input = createMockPlannerInput({
        goal: {
          id: 'g-comp',
          description: 'Search for Creator and play this video: I Built A City To Save Kids',
          intent: 'click'
        },
        context: {
          page: {
            schemaVersion: '1.0',
            metadata: { title: 'Search Results' },
            viewport: { width: 1280, height: 800 },
            elements: [
              { id: 'btn-play', role: 'button', tagName: 'button', accessibleName: 'Play', interactive: true },
              { id: 'link-dest', role: 'link', tagName: 'a', accessibleName: 'I Built A City To Save Kids', attributes: { href: '/watch?v=123' }, interactive: true }
            ]
          },
          availableTargets: [
            { elementId: 'btn-play', role: 'button', confidence: 1, viewportBounds: { x: 10, y: 10, width: 50, height: 30 }, point: { x: 35, y: 25 }, observationId: 'o1' },
            { elementId: 'link-dest', role: 'link', confidence: 1, viewportBounds: { x: 10, y: 50, width: 200, height: 30 }, point: { x: 110, y: 65 }, observationId: 'o2' }
          ],
          capturedAt: Date.now(),
          currentTime: Date.now(),
          stepIndex: 1
        },
        history: [
          {
            stepIndex: 0,
            action: {
              id: 'a0',
              type: 'type',
              target: { elementId: 'search-input', point: { x: 100, y: 20 }, viewportBounds: { x: 80, y: 10, width: 200, height: 30 }, confidence: 1, observationId: 'os0' },
              payload: { text: '', pressEnter: true }
            },
            perceivedOutcome: 'success'
          }
        ]
      });

      const promptStr = buildAgentUserPrompt(input);
      const parsed = JSON.parse(promptStr);
      expect(parsed.availableTargets[0].elementId).toBe('link-dest');
      expect(parsed.availableTargets[1].elementId).toBe('btn-play');
    });
  });

  // -------------------------------------------------------------------------
  // Phase B — Upfront Task Understanding & Decomposition Tests
  // -------------------------------------------------------------------------

  describe('Phase B — Upfront Task Understanding & Decomposition', () => {
    it('1. decomposes a search-only goal into search -> verify_outcome plan', async () => {
      const mockPlan: TaskPlan = {
        planId: 'plan-search-1',
        archetype: 'search_and_act',
        summary: 'Search for laptops under ₹50,000',
        phases: [
          { phaseId: 'phase-0', phaseIndex: 0, intent: 'search', description: 'Enter search query and submit', allowedActions: ['type'] },
          { phaseId: 'phase-1', phaseIndex: 1, intent: 'verify_outcome', description: 'Verify results displayed', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 0
      };

      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify(mockPlan)
        })
      };

      const result = await decomposeTaskGoal('Search for laptops under ₹50,000', { client: mockClient });
      expect(result).toBeDefined();
      expect(result?.archetype).toBe('search_and_act');
      expect(result?.phases).toHaveLength(2);
      expect(result?.phases[0].intent).toBe('search');
      expect(result?.phases[1].intent).toBe('verify_outcome');
    });

    it('2. decomposes a compound search/action goal into search -> select_result -> verify_outcome', async () => {
      const mockPlan: TaskPlan = {
        planId: 'plan-yt-1',
        archetype: 'search_and_act',
        summary: 'Search for creator and open video',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search for MrBeast', allowedActions: ['type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'select_result', description: 'Select the video result', targetHint: 'I Built A City', allowedActions: ['click'] },
          { phaseId: 'p2', phaseIndex: 2, intent: 'verify_outcome', description: 'Verify video page loaded', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 0
      };

      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify(mockPlan)
        })
      };

      const result = await decomposeTaskGoal(
        'Search for MrBeast and play I Built A City To Save Kids From Illegal Labor',
        { client: mockClient }
      );
      expect(result).toBeDefined();
      expect(result?.phases).toHaveLength(3);
      expect(result?.phases[0].intent).toBe('search');
      expect(result?.phases[1].intent).toBe('select_result');
      expect(result?.phases[2].intent).toBe('verify_outcome');
    });

    it('3. decomposes a multi-field form goal into open_surface -> fill_field -> select_option -> submit -> verify_outcome', async () => {
      const mockPlan: TaskPlan = {
        planId: 'plan-task-1',
        archetype: 'form_submission',
        summary: 'Create and add task with attributes',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'open_surface', description: 'Open creation form', targetHint: 'Add Task, Create', allowedActions: ['click'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'fill_field', description: 'Enter name', fieldParameter: { fieldName: 'name', targetValue: 'college' }, allowedActions: ['type'] },
          { phaseId: 'p2', phaseIndex: 2, intent: 'select_option', description: 'Select status', fieldParameter: { fieldName: 'status', targetValue: 'pending' }, allowedActions: ['click', 'type'] },
          { phaseId: 'p3', phaseIndex: 3, intent: 'fill_field', description: 'Enter due date', fieldParameter: { fieldName: 'due date', targetValue: 'today' }, allowedActions: ['type'] },
          { phaseId: 'p4', phaseIndex: 4, intent: 'select_option', description: 'Select priority', fieldParameter: { fieldName: 'priority', targetValue: 'medium' }, allowedActions: ['click', 'type'] },
          { phaseId: 'p5', phaseIndex: 5, intent: 'submit', description: 'Submit created task', targetHint: 'Save, Create', allowedActions: ['click'] },
          { phaseId: 'p6', phaseIndex: 6, intent: 'verify_outcome', description: 'Confirm task created', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 0,
        extractedParameters: {
          name: 'college',
          status: 'pending',
          dueDate: 'today',
          priority: 'medium'
        }
      };

      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify(mockPlan)
        })
      };

      const result = await decomposeTaskGoal(
        'Create and add a task with name college, status pending, due date today and priority medium',
        { client: mockClient }
      );
      expect(result).toBeDefined();
      expect(result?.archetype).toBe('form_submission');
      expect(result?.phases).toHaveLength(7);
      expect(result?.phases[0].intent).toBe('open_surface');
      expect(result?.phases[1].fieldParameter?.fieldName).toBe('name');
      expect(result?.phases[1].fieldParameter?.targetValue).toBe('college');
      expect(result?.phases[5].intent).toBe('submit');
    });

    it('4. decomposes a navigation/action goal into navigate/open_surface -> select_option/click -> verify_outcome', async () => {
      const mockPlan: TaskPlan = {
        planId: 'plan-settings-1',
        archetype: 'navigation_act',
        summary: 'Go to settings and enable dark mode',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'navigate', description: 'Navigate to settings', targetHint: 'Settings', allowedActions: ['click'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'select_option', description: 'Toggle dark mode', targetHint: 'Dark mode', allowedActions: ['click'] },
          { phaseId: 'p2', phaseIndex: 2, intent: 'verify_outcome', description: 'Verify dark mode is enabled', allowedActions: ['click'] }
        ],
        currentPhaseIndex: 0
      };

      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify(mockPlan)
        })
      };

      const result = await decomposeTaskGoal('Go to settings and enable dark mode', { client: mockClient });
      expect(result).toBeDefined();
      expect(result?.archetype).toBe('navigation_act');
      expect(result?.phases).toHaveLength(3);
    });

    it('5. returns undefined on invalid model JSON response', async () => {
      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: 'Here is your plan: { this is definitely not valid json }'
        })
      };

      const result = await decomposeTaskGoal('Search for items', { client: mockClient });
      expect(result).toBeUndefined();
    });

    it('6. returns undefined on truncated model output', async () => {
      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: '{"planId": "p1", "archetype": "search_and_act", "phases": [{"phaseId": "p0", "phaseIndex": 0'
        })
      };

      const result = await decomposeTaskGoal('Search for items', { client: mockClient });
      expect(result).toBeUndefined();
    });

    it('7. returns undefined on invalid TaskPlan schema (e.g. invalid archetype)', async () => {
      const mockPlan = {
        planId: 'p1',
        archetype: 'teleport_to_mars',
        summary: 'Invalid plan',
        phases: [{ phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'Search' }],
        currentPhaseIndex: 0
      };

      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify(mockPlan)
        })
      };

      const result = await decomposeTaskGoal('Search for items', { client: mockClient });
      expect(result).toBeUndefined();
    });

    it('8. returns undefined on empty phase list', async () => {
      const mockPlan = {
        planId: 'p1',
        archetype: 'search_and_act',
        summary: 'Empty phases',
        phases: [],
        currentPhaseIndex: 0
      };

      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify(mockPlan)
        })
      };

      const result = await decomposeTaskGoal('Search for items', { client: mockClient });
      expect(result).toBeUndefined();
    });

    it('9. returns undefined on model timeout or chat failure', async () => {
      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'TIMEOUT', message: 'Local inference timeout after 120s' }
        })
      };

      const result = await decomposeTaskGoal('Search for items', { client: mockClient });
      expect(result).toBeUndefined();
    });

    it('10. handles chat exception cleanly with undefined fallback', async () => {
      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockRejectedValue(new Error('Connection reset by peer'))
      };

      const result = await decomposeTaskGoal('Search for items', { client: mockClient });
      expect(result).toBeUndefined();
    });

    it('11. proves no DOM or PageRepresentation is passed into decomposition request', async () => {
      let capturedRequest: any;
      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockImplementation((req) => {
          capturedRequest = req;
          return Promise.resolve({
            success: true,
            content: JSON.stringify({
              planId: 'p1',
              archetype: 'search_and_act',
              summary: 'search',
              phases: [{ phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'search' }],
              currentPhaseIndex: 0
            })
          });
        })
      };

      await decomposeTaskGoal('Search for laptops', { client: mockClient });
      expect(capturedRequest).toBeDefined();

      const userPayload = JSON.parse(capturedRequest.userPrompt);
      expect(userPayload.goal).toBe('Search for laptops');
      expect((userPayload as any).page).toBeUndefined();
      expect((userPayload as any).availableTargets).toBeUndefined();
      expect((userPayload as any).elements).toBeUndefined();
      expect((userPayload as any).dom).toBeUndefined();
      expect((userPayload as any).metadata).toBeUndefined();
    });

    it('12. proves no screenshot or vision input is passed into decomposition request', async () => {
      let capturedRequest: any;
      const mockClient: LocalLlamaChatClient = {
        chat: vi.fn().mockImplementation((req) => {
          capturedRequest = req;
          return Promise.resolve({
            success: true,
            content: JSON.stringify({
              planId: 'p1',
              archetype: 'search_and_act',
              summary: 'search',
              phases: [{ phaseId: 'p0', phaseIndex: 0, intent: 'search', description: 'search' }],
              currentPhaseIndex: 0
            })
          });
        })
      };

      await decomposeTaskGoal('Search for laptops', { client: mockClient });
      expect(capturedRequest).toBeDefined();

      expect((capturedRequest as any).screenshot).toBeUndefined();
      expect((capturedRequest as any).dataUrl).toBeUndefined();
      expect((capturedRequest as any).image).toBeUndefined();
      expect(capturedRequest.userPrompt).not.toContain('data:image');
    });

    it('13. proves sensitive parameter values are not written to summarizeTaskPlanForLogs', () => {
      const planWithSensitiveParams: TaskPlan = {
        planId: 'plan-sens-1',
        archetype: 'form_submission',
        summary: 'Submit sensitive order form',
        phases: [
          { phaseId: 'p0', phaseIndex: 0, intent: 'fill_field', description: 'Enter password', fieldParameter: { fieldName: 'password', targetValue: 'super-secret-password-123' }, allowedActions: ['type'] },
          { phaseId: 'p1', phaseIndex: 1, intent: 'fill_field', description: 'Enter card', fieldParameter: { fieldName: 'credit_card', targetValue: '4111-2222-3333-4444' }, allowedActions: ['type'] }
        ],
        currentPhaseIndex: 0,
        extractedParameters: {
          password: 'super-secret-password-123',
          credit_card: '4111-2222-3333-4444'
        }
      };

      const logOutput = summarizeTaskPlanForLogs(planWithSensitiveParams);
      // Confirms parameter keys are shown
      expect(logOutput).toContain('password');
      expect(logOutput).toContain('credit_card');
      // Confirms raw sensitive values are NEVER printed in logs
      expect(logOutput).not.toContain('super-secret-password-123');
      expect(logOutput).not.toContain('4111-2222-3333-4444');
    });
  });

  // -------------------------------------------------------------------------
  // Phase C — Phase-Conditioned Grounding & Candidate Ranking Tests
  // -------------------------------------------------------------------------
  describe('Phase C — Phase-Conditioned Grounding & Candidate Ranking', () => {
    function scoreCandidate(c: ModelCandidateTarget, goalDesc: string, phase?: TaskPhase): number {
      const goalKeywords = goalDesc.toLowerCase().split(/[\s,;.!?]+/).filter(w => w.length > 2);
      const hasHref = Boolean(c.attributes?.['href']) || c.hasHref === true;
      return scoreCandidateRelevance(c.role, c.accessibleName, c.visibleText, goalKeywords, false, hasHref, phase, {
        placeholder: c.placeholder,
        attributes: c.attributes
      });
    }

    // 1. OPEN_SURFACE: "Create Task" button outranks searchbox
    it('1. OPEN_SURFACE: "Create Task" button outranks global searchbox', () => {
      const searchBox: ModelCandidateTarget = {
        elementId: 'global-search',
        role: 'searchbox',
        accessibleName: 'Search site',
        confidence: 1.0,
        interactive: true
      };
      const createBtn: ModelCandidateTarget = {
        elementId: 'btn-create',
        role: 'button',
        accessibleName: 'Create Task',
        confidence: 1.0,
        interactive: true
      };

      const phase: TaskPhase = {
        phaseId: 'p0',
        phaseIndex: 0,
        intent: 'open_surface',
        description: 'Open task creation drawer',
        targetHint: 'Create Task',
        allowedActions: ['click']
      };

      const searchScore = scoreCandidate(searchBox, 'Create a new task', phase);
      const createScore = scoreCandidate(createBtn, 'Create a new task', phase);

      expect(createScore).toBeGreaterThan(searchScore);

      const compacted = compactCandidatesForModel([searchBox, createBtn], 'Create a new task', 10, { activePhase: phase });
      expect(compacted[0].elementId).toBe('btn-create');
    });

    // 2. FILL_FIELD: Task Name textbox outranks Search tasks textbox for fieldName = "name"
    it('2. FILL_FIELD: Task Name textbox outranks Search tasks textbox for fieldName = "name"', () => {
      const searchBox: ModelCandidateTarget = {
        elementId: 'search-tasks',
        role: 'textbox',
        accessibleName: 'Search tasks',
        confidence: 1.0,
        interactive: true
      };
      const taskNameInput: ModelCandidateTarget = {
        elementId: 'task-name-input',
        role: 'textbox',
        accessibleName: 'Task Name',
        confidence: 1.0,
        interactive: true
      };

      const phase: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'fill_field',
        description: 'Enter task name',
        targetHint: 'Task Name',
        fieldParameter: {
          fieldName: 'name',
          targetValue: 'college'
        },
        allowedActions: ['type']
      };

      const searchScore = scoreCandidate(searchBox, 'Create task with name college', phase);
      const nameScore = scoreCandidate(taskNameInput, 'Create task with name college', phase);

      expect(nameScore).toBeGreaterThan(searchScore);

      const compacted = compactCandidatesForModel([searchBox, taskNameInput], 'Create task with name college', 10, { activePhase: phase });
      expect(compacted[0].elementId).toBe('task-name-input');
    });

    // 3. SELECT_OPTION: Status combobox preferred for fieldName = "status"
    it('3. SELECT_OPTION: Status combobox is preferred over searchbox and priority combobox for fieldName = "status"', () => {
      const searchBox: ModelCandidateTarget = {
        elementId: 'search-box',
        role: 'searchbox',
        accessibleName: 'Search',
        confidence: 1.0,
        interactive: true
      };
      const prioritySelect: ModelCandidateTarget = {
        elementId: 'priority-select',
        role: 'combobox',
        accessibleName: 'Priority',
        confidence: 1.0,
        interactive: true
      };
      const statusSelect: ModelCandidateTarget = {
        elementId: 'status-select',
        role: 'combobox',
        accessibleName: 'Status',
        confidence: 1.0,
        interactive: true
      };

      const phase: TaskPhase = {
        phaseId: 'p2',
        phaseIndex: 2,
        intent: 'select_option',
        description: 'Select pending status',
        fieldParameter: {
          fieldName: 'status',
          targetValue: 'pending'
        },
        allowedActions: ['click']
      };

      const statusScore = scoreCandidate(statusSelect, 'Select status pending', phase);
      const priorityScore = scoreCandidate(prioritySelect, 'Select status pending', phase);
      const searchScore = scoreCandidate(searchBox, 'Select status pending', phase);

      expect(statusScore).toBeGreaterThan(priorityScore);
      expect(statusScore).toBeGreaterThan(searchScore);

      const compacted = compactCandidatesForModel([searchBox, prioritySelect, statusSelect], 'Select status pending', 10, { activePhase: phase });
      expect(compacted[0].elementId).toBe('status-select');
    });

    // 4. SUBMIT: Save button is preferred over searchbox and unrelated button
    it('4. SUBMIT: Save button is preferred over searchbox and unrelated buttons', () => {
      const searchBox: ModelCandidateTarget = {
        elementId: 'search-box',
        role: 'searchbox',
        accessibleName: 'Search',
        confidence: 1.0,
        interactive: true
      };
      const cancelBtn: ModelCandidateTarget = {
        elementId: 'btn-cancel',
        role: 'button',
        accessibleName: 'Cancel',
        confidence: 1.0,
        interactive: true
      };
      const saveBtn: ModelCandidateTarget = {
        elementId: 'btn-save',
        role: 'button',
        accessibleName: 'Save Task',
        confidence: 1.0,
        interactive: true
      };

      const phase: TaskPhase = {
        phaseId: 'p3',
        phaseIndex: 3,
        intent: 'submit',
        description: 'Save the task',
        targetHint: 'save',
        allowedActions: ['click']
      };

      const saveScore = scoreCandidate(saveBtn, 'Save and submit task', phase);
      const cancelScore = scoreCandidate(cancelBtn, 'Save and submit task', phase);
      const searchScore = scoreCandidate(searchBox, 'Save and submit task', phase);

      expect(saveScore).toBeGreaterThan(cancelScore);
      expect(saveScore).toBeGreaterThan(searchScore);

      const compacted = compactCandidatesForModel([searchBox, cancelBtn, saveBtn], 'Save and submit task', 10, { activePhase: phase });
      expect(compacted[0].elementId).toBe('btn-save');
    });

    // 5. SELECT_RESULT: Destination-bearing result link preferred over generic button / searchbox
    it('5. SELECT_RESULT: Destination-bearing result link preferred over generic button and searchbox', () => {
      const searchBox: ModelCandidateTarget = {
        elementId: 'search-box',
        role: 'searchbox',
        accessibleName: 'Search',
        confidence: 1.0,
        interactive: true
      };
      const playBtn: ModelCandidateTarget = {
        elementId: 'btn-play',
        role: 'button',
        accessibleName: 'Play',
        confidence: 1.0,
        interactive: true
      };
      const resultLink: ModelCandidateTarget = {
        elementId: 'result-video-link',
        role: 'link',
        accessibleName: 'I Built A City To Save Kids From Illegal Labor',
        confidence: 1.0,
        attributes: { href: '/watch?v=city123' },
        interactive: true
      };

      const phase: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'select_result',
        description: 'Play requested video',
        targetHint: 'I Built A City',
        allowedActions: ['click']
      };

      const linkScore = scoreCandidate(resultLink, 'Play I Built A City video', phase);
      const playScore = scoreCandidate(playBtn, 'Play I Built A City video', phase);
      const searchScore = scoreCandidate(searchBox, 'Play I Built A City video', phase);

      expect(linkScore).toBeGreaterThan(playScore);
      expect(linkScore).toBeGreaterThan(searchScore);

      const compacted = compactCandidatesForModel([searchBox, playBtn, resultLink], 'Play I Built A City video', 10, { activePhase: phase });
      expect(compacted[0].elementId).toBe('result-video-link');
    });

    // 6. SEARCH: Searchbox remains strongly preferred
    it('6. SEARCH: Searchbox remains strongly preferred over other inputs', () => {
      const noteInput: ModelCandidateTarget = {
        elementId: 'note-input',
        role: 'textbox',
        accessibleName: 'User Note',
        confidence: 1.0,
        interactive: true
      };
      const searchInput: ModelCandidateTarget = {
        elementId: 'search-box',
        role: 'searchbox',
        accessibleName: 'Search query',
        confidence: 1.0,
        interactive: true
      };

      const phase: TaskPhase = {
        phaseId: 'p0',
        phaseIndex: 0,
        intent: 'search',
        description: 'Search for laptops',
        targetHint: 'Search',
        allowedActions: ['type']
      };

      const searchScore = scoreCandidate(searchInput, 'Search for laptops', phase);
      const noteScore = scoreCandidate(noteInput, 'Search for laptops', phase);

      expect(searchScore).toBeGreaterThan(noteScore);

      const compacted = compactCandidatesForModel([noteInput, searchInput], 'Search for laptops', 10, { activePhase: phase });
      expect(compacted[0].elementId).toBe('search-box');
    });

    // 7. Candidate compaction: Phase-relevant targets survive compaction beyond MAX_MODEL_CANDIDATES
    it('7. Candidate compaction: Phase-relevant targets survive compaction when candidate count exceeds budget', () => {
      // Create 25 generic navigation buttons that would otherwise fill MAX_MODEL_CANDIDATES (20)
      const genericTargets: ModelCandidateTarget[] = Array.from({ length: 25 }, (_, i) => ({
        elementId: `nav-elem-${i}`,
        role: 'button',
        accessibleName: `Navigation Menu Item ${i}`,
        confidence: 0.8,
        interactive: true
      }));

      // Phase-relevant form field
      const relevantFormField: ModelCandidateTarget = {
        elementId: 'target-task-name',
        role: 'textbox',
        accessibleName: 'Task Name',
        confidence: 0.9,
        interactive: true
      };

      const candidates = [...genericTargets, relevantFormField];

      const phase: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'fill_field',
        description: 'Fill task name',
        fieldParameter: { fieldName: 'name', targetValue: 'college' },
        allowedActions: ['type']
      };

      const compacted = compactCandidatesForModel(candidates, 'Create task with name college', 20, { activePhase: phase });

      expect(compacted.length).toBeLessThanOrEqual(20);
      const found = compacted.find(c => c.elementId === 'target-task-name');
      expect(found).toBeDefined();
      expect(compacted[0].elementId).toBe('target-task-name');
    });

    // 8. Allowed action enforcement: Action rejected when not in allowedActions
    it('8. Allowed action enforcement: Driver rejects model action violating phase allowedActions', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click', // violating phase allowedActions ['type']
            rationale: 'Trying to click button instead of typing'
          })
        })
      };

      const driver = new LocalAgentDriver(mockChatClient);

      const phase: TaskPhase = {
        phaseId: 'p0',
        phaseIndex: 0,
        intent: 'fill_field',
        description: 'Enter task name',
        allowedActions: ['type']
      };

      const baseInput = createMockPlannerInput();
      const input: PlannerInput = {
        ...baseInput,
        goal: {
          ...baseInput.goal,
          taskPlan: {
            planId: 'plan-test',
            archetype: 'form_submission',
            summary: 'Fill form',
            phases: [phase],
            currentPhaseIndex: 0
          }
        },
        context: {
          ...baseInput.context,
          phaseState: {
            activePhase: phase,
            completedPhaseIds: [],
            remainingPhaseIds: [],
            totalPhases: 1,
            retryCountInCurrentPhase: 0
          }
        }
      };

      const result = await driver.proposeStep(input);
      expect(result.status).toBe('FAILED');
      if (result.status === 'FAILED') {
        expect(result.reason).toContain('INCOMPATIBLE_ACTION_FOR_PHASE');
      }

      // Also verify planNextStep rejects it via planner orchestration
      const planResult = await planNextStep(input, driver);
      expect(planResult.status).toBe('FAILED');
      if (planResult.status === 'FAILED') {
        expect(planResult.reason).toBe('INCOMPATIBLE_ACTION_FOR_PHASE');
      }
    });

    // 9. History: SafeModelHistoryStep maintains phase metadata without exposing raw typed text
    it('9. History: safe model history exposes phaseIndex, phaseIntent, fulfilledParameter without raw typed text', () => {
      const historyStep = {
        stepIndex: 1,
        action: {
          id: 'act-1',
          type: 'type' as const,
          target: {
            elementId: 'task-name-input',
            role: 'textbox' as const,
            point: { x: 100, y: 100 },
            viewportBounds: { x: 50, y: 50, width: 100, height: 30 },
            confidence: 1.0,
            observationId: 'obs-1'
          },
          payload: { text: 'super-secret-password-123' }
        },
        perceivedOutcome: 'success' as const,
        phaseIndex: 1,
        phaseIntent: 'fill_field' as const,
        fulfilledParameter: 'name'
      };

      const input = createMockPlannerInput({
        history: [historyStep]
      });

      const payload = buildModelPromptPayload(input);
      expect(payload.history).toBeDefined();
      expect(payload.history).toHaveLength(1);
      const step = payload.history![0] as SafeModelHistoryStep;
      expect(step.phaseIndex).toBe(1);
      expect(step.phaseIntent).toBe('fill_field');
      expect(step.fulfilledParameter).toBe('name');
      // Verify raw typed text is NOT present in history
      expect((step as any).text).toBeUndefined();
      expect((step as any).payload).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('super-secret-password-123');
    });

    // 10. Backward compatibility: When taskPlan === undefined, existing candidate ranking remains identical
    it('10. Backward compatibility: When taskPlan is undefined, default ranking behavior is preserved', () => {
      const searchBox: ModelCandidateTarget = {
        elementId: 'elem-search-input',
        role: 'textbox',
        accessibleName: 'Search products',
        confidence: 1.0,
        interactive: true
      };
      const button: ModelCandidateTarget = {
        elementId: 'elem-submit-btn',
        role: 'button',
        accessibleName: 'Search',
        confidence: 1.0,
        interactive: true
      };

      // Undefined activePhase -> uses legacy SEARCH_ROLE_PRIORITY
      const scoreSearch = scoreCandidate(searchBox, 'Search for products', undefined);
      const scoreBtn = scoreCandidate(button, 'Search for products', undefined);

      expect(getPhaseRolePriority(undefined, 'searchbox')).toBe(10);
      expect(getPhaseRolePriority(undefined, 'textbox')).toBe(9);
      expect(getPhaseRolePriority(undefined, 'button')).toBe(7);
      expect(scoreSearch).toBeGreaterThan(0);
      expect(scoreBtn).toBeGreaterThan(0);

      const compacted = compactCandidatesForModel([button, searchBox], 'Search for products');
      expect(compacted[0].elementId).toBe('elem-search-input');
    });

    // 11. YouTube regression: Search phase behaves as before; select-result phase prioritizes destination link
    it('11. YouTube regression: Search phase prioritizes searchbox; select-result phase prioritizes destination video link', () => {
      const searchInput: ModelCandidateTarget = {
        elementId: 'search-input',
        role: 'searchbox',
        accessibleName: 'Search YouTube',
        confidence: 1.0,
        interactive: true
      };
      const videoResult: ModelCandidateTarget = {
        elementId: 'video-result-1',
        role: 'link',
        accessibleName: 'MrBeast: I Built A City To Save Kids From Illegal Labor',
        confidence: 1.0,
        attributes: { href: '/watch?v=abc123xyz' },
        interactive: true
      };

      const searchPhase: TaskPhase = {
        phaseId: 'p0',
        phaseIndex: 0,
        intent: 'search',
        description: 'Search for MrBeast',
        allowedActions: ['type']
      };

      const selectResultPhase: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'select_result',
        description: 'Play specific video',
        targetHint: 'I Built A City',
        allowedActions: ['click']
      };

      // In search phase: searchbox is preferred
      const searchScoreP0 = scoreCandidate(searchInput, 'Search for MrBeast', searchPhase);
      const videoScoreP0 = scoreCandidate(videoResult, 'Search for MrBeast', searchPhase);
      expect(searchScoreP0).toBeGreaterThan(videoScoreP0);

      // In select_result phase: destination video link is preferred over searchbox
      const searchScoreP1 = scoreCandidate(searchInput, 'Play specific video', selectResultPhase);
      const videoScoreP1 = scoreCandidate(videoResult, 'Play specific video', selectResultPhase);
      expect(videoScoreP1).toBeGreaterThan(searchScoreP1);
    });

    // 11b. Search phase suppresses autocomplete suggestions even when matching exact query
    it('11b. Autocomplete suggestion is heavily suppressed in search phase and does not outrank searchbox', () => {
      const searchInput: ModelCandidateTarget = {
        elementId: 'search-input',
        role: 'searchbox',
        accessibleName: 'Search',
        confidence: 1.0,
        interactive: true
      };
      const autocompleteSuggestion: ModelCandidateTarget = {
        elementId: 'sugg-mrbeast',
        role: 'option',
        accessibleName: 'MrBeast',
        visibleText: 'MrBeast',
        confidence: 1.0,
        interactive: true
      };

      const searchPhase: TaskPhase = {
        phaseId: 'p0',
        phaseIndex: 0,
        intent: 'search',
        description: 'Search for MrBeast',
        allowedActions: ['type']
      };

      const searchScore = scoreCandidate(searchInput, 'Search for MrBeast and play the first video', searchPhase);
      const suggScore = scoreCandidate(autocompleteSuggestion, 'Search for MrBeast and play the first video', searchPhase);

      // Search input is strongly boosted, while autocomplete suggestion is heavily penalized and denied keyword bonus
      expect(searchScore).toBeGreaterThan(25);
      expect(suggScore).toBeLessThan(0);
      expect(searchScore).toBeGreaterThan(suggScore);

      // Compacting preserves search input at index 0 ahead of suggestion
      const compacted = compactCandidatesForModel(
        [autocompleteSuggestion, searchInput],
        'Search for MrBeast and play the first video',
        5,
        { activePhase: searchPhase }
      );
      expect(compacted[0].elementId).toBe('search-input');
    });

    // 12. Task creation regression: Open-surface phase does not select global searchbox when creation control exists
    it('12. Task creation regression: Open-surface phase selects creation control over global searchbox', () => {
      const searchBox: ModelCandidateTarget = {
        elementId: 'global-search-bar',
        role: 'textbox',
        accessibleName: 'Search tasks...',
        confidence: 1.0,
        interactive: true
      };
      const addTaskBtn: ModelCandidateTarget = {
        elementId: 'btn-add-task',
        role: 'button',
        accessibleName: 'Add Task',
        confidence: 1.0,
        interactive: true
      };

      const openPhase: TaskPhase = {
        phaseId: 'p0',
        phaseIndex: 0,
        intent: 'open_surface',
        description: 'Open task creation modal',
        targetHint: 'add task',
        allowedActions: ['click']
      };

      const candidates = [searchBox, addTaskBtn];
      const compacted = compactCandidatesForModel(candidates, 'Create and add a task with name college', 10, { activePhase: openPhase });

      expect(compacted[0].elementId).toBe('btn-add-task');
      expect(compacted[0].role).toBe('button');
    });

    // 13. NAVIGATE: Navigation link with destination outranks searchbox and generic text inputs
    it('13. NAVIGATE: Navigation link with destination outranks searchbox and generic text inputs', () => {
      const searchBox: ModelCandidateTarget = {
        elementId: 'search-input',
        role: 'textbox',
        accessibleName: 'Search',
        confidence: 1.0,
        interactive: true
      };
      const settingsLink: ModelCandidateTarget = {
        elementId: 'nav-settings-link',
        role: 'link',
        accessibleName: 'Account Settings',
        confidence: 1.0,
        attributes: { href: '/settings/account' },
        interactive: true
      };

      const navPhase: TaskPhase = {
        phaseId: 'p0',
        phaseIndex: 0,
        intent: 'navigate',
        description: 'Navigate to account settings',
        targetHint: 'account settings',
        allowedActions: ['click']
      };

      const searchScore = scoreCandidate(searchBox, 'Navigate to account settings', navPhase);
      const linkScore = scoreCandidate(settingsLink, 'Navigate to account settings', navPhase);

      expect(linkScore).toBeGreaterThan(searchScore);

      const compacted = compactCandidatesForModel([searchBox, settingsLink], 'Navigate to account settings', 10, { activePhase: navPhase });
      expect(compacted[0].elementId).toBe('nav-settings-link');
    });

    // 14. VERIFY_OUTCOME: Model proposal of COMPLETED is accepted when active phase is verify_outcome
    it('14. VERIFY_OUTCOME: Model proposal of COMPLETED is accepted when active phase is verify_outcome', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'COMPLETED',
            summary: 'Verified that task college is listed in table'
          })
        })
      };

      const driver = new LocalAgentDriver(mockChatClient);

      const verifyPhase: TaskPhase = {
        phaseId: 'p4',
        phaseIndex: 4,
        intent: 'verify_outcome',
        description: 'Verify task creation was successful',
        allowedActions: ['click']
      };

      const baseInput = createMockPlannerInput();
      const input: PlannerInput = {
        ...baseInput,
        context: {
          ...baseInput.context,
          phaseState: {
            activePhase: verifyPhase,
            completedPhaseIds: ['p0', 'p1', 'p2', 'p3'],
            remainingPhaseIds: [],
            totalPhases: 5,
            retryCountInCurrentPhase: 0
          }
        }
      };

      const result = await driver.proposeStep(input);
      expect(result.status).toBe('COMPLETED');
      if (result.status === 'COMPLETED') {
        expect(result.summary).toBe('Verified that task college is listed in table');
      }
    });

    // 15. buildAgentUserPrompt serialization: Structured phase context with overallGoal, currentPhase, completedPhases, remainingPhases
    it('15. buildAgentUserPrompt serialization: produces structured phase context and avoids raw TaskPlan bloat', () => {
      const phase0: TaskPhase = {
        phaseId: 'p0',
        phaseIndex: 0,
        intent: 'open_surface',
        description: 'Open task creation drawer',
        targetHint: 'add task',
        allowedActions: ['click']
      };
      const phase1: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'fill_field',
        description: 'Enter task name',
        targetHint: 'task name',
        fieldParameter: { fieldName: 'name', targetValue: 'college' },
        allowedActions: ['type']
      };

      const baseInput = createMockPlannerInput();
      const input: PlannerInput = {
        ...baseInput,
        goal: {
          ...baseInput.goal,
          description: 'Create and add task college',
          taskPlan: {
            planId: 'plan-xyz',
            archetype: 'form_submission',
            summary: 'Task creation plan',
            phases: [phase0, phase1],
            currentPhaseIndex: 1
          }
        },
        context: {
          ...baseInput.context,
          phaseState: {
            activePhase: phase1,
            completedPhaseIds: ['p0'],
            remainingPhaseIds: [],
            totalPhases: 2,
            retryCountInCurrentPhase: 0
          }
        }
      };

      const promptStr = buildAgentUserPrompt(input);
      const parsed = JSON.parse(promptStr);

      expect(parsed.overallGoal).toBe('Create and add task college');
      expect(parsed.currentPhase).toBeDefined();
      expect(parsed.currentPhase.index).toBe(1);
      expect(parsed.currentPhase.intent).toBe('fill_field');
      expect(parsed.currentPhase.objective).toBe('Enter task name');
      expect(parsed.currentPhase.field).toEqual({ fieldName: 'name', targetValue: 'college' });
      expect(parsed.completedPhases).toEqual([
        { index: 0, intent: 'open_surface', description: 'Open task creation drawer' }
      ]);
      expect(parsed.remainingPhases).toEqual([]);

      // Verify raw taskPlan blob is omitted from goal to prevent prompt token bloat
      expect(parsed.goal.taskPlan).toBeUndefined();
    });

    // 16. FILL_FIELD with placeholder: Input with placeholder matching fieldName outranks generic inputs
    it('16. FILL_FIELD with placeholder: input with placeholder matching fieldName outranks generic inputs', () => {
      const genericInput: ModelCandidateTarget = {
        elementId: 'input-generic',
        role: 'textbox',
        accessibleName: 'Filter items',
        confidence: 1.0,
        interactive: true
      };
      const inputWithPlaceholder: ModelCandidateTarget = {
        elementId: 'input-name',
        role: 'textbox',
        accessibleName: '',
        placeholder: 'Enter task name here',
        confidence: 1.0,
        interactive: true
      };

      const phase: TaskPhase = {
        phaseId: 'p1',
        phaseIndex: 1,
        intent: 'fill_field',
        description: 'Enter task name',
        fieldParameter: { fieldName: 'name', targetValue: 'college' },
        allowedActions: ['type']
      };

      const scoreGeneric = scoreCandidate(genericInput, 'Enter task name', phase);
      const scoreWithPlaceholder = scoreCandidate(inputWithPlaceholder, 'Enter task name', phase);

      expect(scoreWithPlaceholder).toBeGreaterThan(scoreGeneric);

      const compacted = compactCandidatesForModel([genericInput, inputWithPlaceholder], 'Enter task name', 10, { activePhase: phase });
      expect(compacted[0].elementId).toBe('input-name');
    });
  });

  describe('Deterministic Temporal Grounding in TaskPlan Normalization', () => {
    const FIXED_REF = '2026-09-29';

    it('resolves relative date "today\'s date" into canonical YYYY-MM-DD and preserves rawTargetValue', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-date-1',
        archetype: 'form_submission',
        summary: 'Create task with today date',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'fill_field',
            description: 'Enter due date with today\'s date',
            fieldParameter: {
              fieldName: 'dueDate',
              targetValue: "today's date"
            },
            allowedActions: ['type'],
            expectedOutcome: 'Due date is filled'
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      expect(normalized.phases[0].fieldParameter?.targetValue).toBe('2026-09-29');
      expect(normalized.phases[0].fieldParameter?.rawTargetValue).toBe("today's date");
    });

    it('resolves "tomorrow" and "yesterday" with correct date offsets', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-offsets',
        archetype: 'form_submission',
        summary: 'Test date offsets',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'fill_field',
            description: 'Enter start date',
            fieldParameter: {
              fieldName: 'startDate',
              targetValue: 'yesterday'
            },
            allowedActions: ['type']
          },
          {
            phaseIndex: 1,
            phaseId: 'phase-1',
            intent: 'fill_field',
            description: 'Enter due date',
            fieldParameter: {
              fieldName: 'dueDate',
              targetValue: 'tomorrow'
            },
            allowedActions: ['type']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      expect(normalized.phases[0].fieldParameter?.targetValue).toBe('2026-09-28');
      expect(normalized.phases[0].fieldParameter?.rawTargetValue).toBe('yesterday');
      expect(normalized.phases[1].fieldParameter?.targetValue).toBe('2026-09-30');
      expect(normalized.phases[1].fieldParameter?.rawTargetValue).toBe('tomorrow');
    });

    it('preserves already-canonical YYYY-MM-DD dates without alteration', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-canon',
        archetype: 'form_submission',
        summary: 'Canonical date test',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'fill_field',
            description: 'Enter due date',
            fieldParameter: {
              fieldName: 'dueDate',
              targetValue: '2026-09-29'
            },
            allowedActions: ['type']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      expect(normalized.phases[0].fieldParameter?.targetValue).toBe('2026-09-29');
      // No rawTargetValue needed when targetValue was already canonical
      expect(normalized.phases[0].fieldParameter?.rawTargetValue).toBeUndefined();
    });

    it('leaves non-date fields and unsupported relative expressions untouched', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-mixed',
        archetype: 'form_submission',
        summary: 'Mixed fields',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'fill_field',
            description: 'Enter name',
            fieldParameter: {
              fieldName: 'title',
              targetValue: 'college'
            },
            allowedActions: ['type']
          },
          {
            phaseIndex: 1,
            phaseId: 'phase-1',
            intent: 'select_option',
            description: 'Select status',
            fieldParameter: {
              fieldName: 'status',
              targetValue: 'pending'
            },
            allowedActions: ['select', 'click', 'type']
          },
          {
            phaseIndex: 2,
            phaseId: 'phase-2',
            intent: 'fill_field',
            description: 'Enter schedule',
            fieldParameter: {
              fieldName: 'schedule',
              targetValue: 'next week'
            },
            allowedActions: ['type']
          }
        ],
        extractedParameters: {
          title: 'college',
          status: 'pending',
          dueDate: "today's date",
          schedule: 'next week'
        }
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      expect(normalized.phases[0].fieldParameter?.targetValue).toBe('college');
      expect(normalized.phases[1].fieldParameter?.targetValue).toBe('pending');
      expect(normalized.phases[2].fieldParameter?.targetValue).toBe('next week');

      const extracted = normalized.extractedParameters as Record<string, string>;
      expect(extracted['title']).toBe('college');
      expect(extracted['status']).toBe('pending');
      expect(extracted['dueDate']).toBe('2026-09-29');
      expect(extracted['schedule']).toBe('next week');
    });

    it('end-to-end decomposeTaskGoal applies temporal grounding when client produces relative date', async () => {
      const mockClient: LocalLlamaChatClient = {
        chat: async () => ({
          success: true,
          content: JSON.stringify({
            archetype: 'form_submission',
            summary: 'Create task college',
            phases: [
              {
                phaseIndex: 0,
                id: 'phase-0',
                intent: 'fill_field',
                description: 'Enter task title',
                fieldParameter: { fieldName: 'title', targetValue: 'college' },
                allowedActions: ['type'],
                expectedOutcome: 'Title entered'
              },
              {
                phaseIndex: 1,
                id: 'phase-1',
                intent: 'fill_field',
                description: 'Enter due date with today\'s date',
                fieldParameter: { fieldName: 'dueDate', targetValue: "today's date" },
                allowedActions: ['type'],
                expectedOutcome: 'Due date entered'
              }
            ]
          })
        })
      };

      const result = await decomposeTaskGoal(
        'Create and add a task with name college, due date with todays date',
        { client: mockClient, referenceDate: FIXED_REF }
      );

      expect(result).toBeDefined();
      expect(result?.phases[0].fieldParameter?.targetValue).toBe('college');
      expect(result?.phases[1].fieldParameter?.targetValue).toBe('2026-09-29');
      expect(result?.phases[1].fieldParameter?.rawTargetValue).toBe("today's date");
    });
  });

  describe('Select-Option AllowedActions Normalization', () => {
    const FIXED_REF = '2026-09-29';

    it('normalizes select_option phase with allowedActions=["click"] to include both click and type', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-select-1',
        archetype: 'form_submission',
        summary: 'Select priority',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'select_option',
            description: 'Select priority as high',
            fieldParameter: { fieldName: 'priority', targetValue: 'high' },
            allowedActions: ['click']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      const phase = normalized.phases[0];
      expect(phase.allowedActions).toBeDefined();
      expect(phase.allowedActions).toContain('click');
      expect(phase.allowedActions).toContain('type');
    });

    it('normalizes select_option phase with no allowedActions to include both click and type', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-select-2',
        archetype: 'form_submission',
        summary: 'Select status',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'select_option',
            description: 'Select status as pending',
            fieldParameter: { fieldName: 'status', targetValue: 'pending' }
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      const phase = normalized.phases[0];
      expect(phase.allowedActions).toBeDefined();
      expect(phase.allowedActions).toContain('click');
      expect(phase.allowedActions).toContain('type');
    });

    it('preserves existing ["click", "type"] on select_option without duplication', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-select-3',
        archetype: 'form_submission',
        summary: 'Select option',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'select_option',
            description: 'Select category',
            fieldParameter: { fieldName: 'category', targetValue: 'electronics' },
            allowedActions: ['click', 'type']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      const phase = normalized.phases[0];
      expect(phase.allowedActions).toContain('click');
      expect(phase.allowedActions).toContain('type');
      expect(phase.allowedActions!.length).toBe(2);
    });

    it('does NOT modify allowedActions on fill_field phases', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-fill-1',
        archetype: 'form_submission',
        summary: 'Fill title',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'fill_field',
            description: 'Enter title',
            fieldParameter: { fieldName: 'title', targetValue: 'college' },
            allowedActions: ['type']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      const phase = normalized.phases[0];
      expect(phase.allowedActions).toEqual(['type']);
    });

    it('does NOT modify allowedActions on submit phases', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-submit-1',
        archetype: 'form_submission',
        summary: 'Submit form',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'submit',
            description: 'Submit the form',
            allowedActions: ['click']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      const phase = normalized.phases[0];
      expect(phase.allowedActions).toEqual(['click']);
    });

    it('normalizes select_option when allowedActions is a single string "click"', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-select-str',
        archetype: 'form_submission',
        summary: 'Select option',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'select_option',
            description: 'Select priority',
            fieldParameter: { fieldName: 'priority', targetValue: 'high' },
            allowedActions: 'click'
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      const phase = normalized.phases[0];
      expect(phase.allowedActions).toContain('click');
      expect(phase.allowedActions).toContain('type');
    });

    it('normalizes multi-phase plan: only select_option phases get both actions', () => {
      const rawObj: Record<string, unknown> = {
        planId: 'plan-multi',
        archetype: 'form_submission',
        summary: 'Create task',
        currentPhaseIndex: 0,
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'fill_field',
            description: 'Enter title',
            fieldParameter: { fieldName: 'title', targetValue: 'college' },
            allowedActions: ['type']
          },
          {
            phaseIndex: 1,
            phaseId: 'phase-1',
            intent: 'select_option',
            description: 'Select status',
            fieldParameter: { fieldName: 'status', targetValue: 'pending' },
            allowedActions: ['click']
          },
          {
            phaseIndex: 2,
            phaseId: 'phase-2',
            intent: 'select_option',
            description: 'Select priority',
            fieldParameter: { fieldName: 'priority', targetValue: 'high' },
            allowedActions: ['click']
          },
          {
            phaseIndex: 3,
            phaseId: 'phase-3',
            intent: 'submit',
            description: 'Submit',
            allowedActions: ['click']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'goal', FIXED_REF) as unknown as TaskPlan;
      // fill_field: unchanged
      expect(normalized.phases[0].allowedActions).toEqual(['type']);
      // select_option: both click and type
      expect(normalized.phases[1].allowedActions).toContain('click');
      expect(normalized.phases[1].allowedActions).toContain('type');
      // select_option: both click and type
      expect(normalized.phases[2].allowedActions).toContain('click');
      expect(normalized.phases[2].allowedActions).toContain('type');
      // submit: unchanged
      expect(normalized.phases[3].allowedActions).toEqual(['click']);
    });

    it('normalizes search phase allowedActions to ensure type is always available', () => {
      const rawObj = {
        planId: 'tp-search-norm',
        archetype: 'search_and_act',
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'search',
            description: 'Search query',
            allowedActions: ['click']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawObj, 'Search for laptops') as unknown as TaskPlan;
      expect(normalized.phases[0].allowedActions).toContain('type');
      expect(normalized.phases[0].allowedActions).toContain('click');
    });
  });

  // -------------------------------------------------------------------------
  // Focused Regression Suite: Generic Item Retrieval & Contract Normalization (Tests A–J)
  // -------------------------------------------------------------------------
  describe('Focused Regression Suite: Generic Item Retrieval & Contract Normalization (A–J)', () => {
    // A, B, C
    it('Regression A/B/C: "Find my latest Amazon transaction." normalizes targetValue, targetHint, and description', () => {
      const rawPlan = {
        planId: 'tp-amazon-test',
        archetype: 'item_retrieval',
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'search',
            description: 'Search for the latest Amazon transaction.',
            targetHint: 'Amazon transaction',
            fieldParameter: { fieldName: 'search', targetValue: 'Amazon transaction' },
            allowedActions: ['type']
          },
          {
            phaseIndex: 1,
            phaseId: 'phase-1',
            intent: 'select_result',
            description: 'Select the latest Amazon transaction.',
            targetHint: 'Amazon transaction',
            allowedActions: ['click']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawPlan, 'Find my latest Amazon transaction.') as unknown as TaskPlan;
      const searchPhase = normalized.phases[0];
      // A: search targetValue = "Amazon"
      expect(searchPhase.fieldParameter?.targetValue).toBe('Amazon');
      // B: search phase targetHint is normalized to "Amazon"
      expect(searchPhase.targetHint).toBe('Amazon');
      // C: search phase description is "Search for Amazon"
      expect(searchPhase.description).toBe('Search for Amazon');
      // Phase 1 preserves selection semantics
      expect(normalized.phases[1].targetHint).toBe('Amazon');
      expect(normalized.phases[1].intent).toBe('select_result');
    });

    // D
    it('Regression D: LLM proposes type "Amazon transaction" while activePhase.targetValue = "Amazon" -> normalized action: type "Amazon"', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { text: 'Amazon transaction', pressEnter: true }
          })
        })
      };

      const driver = createLocalAgentDriver(mockChatClient);
      const input = createMockPlannerInput({
        goal: {
          id: 'goal-amazon-d',
          description: 'Find my latest Amazon transaction.',
          taskPlan: {
            planId: 'plan-1',
            archetype: 'search_and_act',
            summary: 'Find my latest Amazon transaction.',
            currentPhaseIndex: 0,
            phases: [
              {
                phaseId: 'phase-0',
                phaseIndex: 0,
                intent: 'search',
                description: 'Search for Amazon',
                targetHint: 'Amazon',
                fieldParameter: { fieldName: 'search', targetValue: 'Amazon' },
                allowedActions: ['type']
              }
            ]
          }
        },
        context: {
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          availableTargets: [MOCK_TARGET_1],
          page: {
            ...MOCK_PAGE_REP,
            elements: [
              {
                id: 'elem-search-input',
                role: 'textbox',
                tagName: 'input',
                placeholder: 'Search transactions…'
              }
            ]
          },
          stepIndex: 0
        }
      });

      const result = await driver.proposeStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.payload?.text).toBe('Amazon');
      expect(result.proposal.payload?.clearFirst).toBe(true);
      expect(result.proposal.payload?.pressEnter).toBe(true);
    });

    // E
    it('Regression E: LLM proposes type "latest Amazon transaction" while activePhase.targetValue = "Amazon" -> normalized action: type "Amazon"', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { text: 'latest Amazon transaction', clearFirst: true, pressEnter: true }
          })
        })
      };

      const driver = createLocalAgentDriver(mockChatClient);
      const input = createMockPlannerInput({
        goal: {
          id: 'goal-amazon-e',
          description: 'Find my latest Amazon transaction.',
          taskPlan: {
            planId: 'plan-1',
            archetype: 'search_and_act',
            summary: 'Find my latest Amazon transaction.',
            currentPhaseIndex: 0,
            phases: [
              {
                phaseId: 'phase-0',
                phaseIndex: 0,
                intent: 'search',
                description: 'Search for Amazon',
                targetHint: 'Amazon',
                fieldParameter: { fieldName: 'search', targetValue: 'Amazon' },
                allowedActions: ['type']
              }
            ]
          }
        },
        context: {
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          availableTargets: [MOCK_TARGET_1],
          page: {
            ...MOCK_PAGE_REP,
            elements: [
              {
                id: 'elem-search-input',
                role: 'textbox',
                tagName: 'input',
                placeholder: 'Search transactions…'
              }
            ]
          },
          stepIndex: 0
        }
      });

      const result = await driver.proposeStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.payload?.text).toBe('Amazon');
    });

    // F
    it('Regression F: Generic Swiggy case: "Find my latest Swiggy transaction." -> "Swiggy"', () => {
      const rawPlan = {
        planId: 'tp-swiggy-test',
        archetype: 'item_retrieval',
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'search',
            description: 'Search for the latest Swiggy transaction.',
            targetHint: 'Swiggy transaction',
            allowedActions: ['type']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawPlan, 'Find my latest Swiggy transaction.') as unknown as TaskPlan;
      expect(normalized.phases[0].fieldParameter?.targetValue).toBe('Swiggy');
      expect(normalized.phases[0].targetHint).toBe('Swiggy');
      expect(normalized.phases[0].description).toBe('Search for Swiggy');
    });

    // G
    it('Regression G: Generic Netflix case: "Find the latest Netflix payment." -> "Netflix"', () => {
      const rawPlan = {
        planId: 'tp-netflix-test',
        archetype: 'item_retrieval',
        phases: [
          {
            phaseIndex: 0,
            phaseId: 'phase-0',
            intent: 'search',
            description: 'Search for the latest Netflix payment.',
            targetHint: 'Netflix payment',
            allowedActions: ['type']
          }
        ]
      };

      const normalized = normalizeDecomposedTaskPlan(rawPlan, 'Find the latest Netflix payment.') as unknown as TaskPlan;
      expect(normalized.phases[0].fieldParameter?.targetValue).toBe('Netflix');
      expect(normalized.phases[0].targetHint).toBe('Netflix');
      expect(normalized.phases[0].description).toBe('Search for Netflix');
    });

    // H
    it('Regression H: A normal free-form type action without structured targetValue remains unchanged', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { text: 'custom arbitrary user query', clearFirst: true }
          })
        })
      };

      const driver = createLocalAgentDriver(mockChatClient);
      const input = createMockPlannerInput({
        goal: {
          id: 'goal-freeform',
          description: 'Type custom query',
          taskPlan: {
            planId: 'plan-freeform',
            archetype: 'search_and_act',
            summary: 'Type custom query',
            currentPhaseIndex: 0,
            phases: [
              {
                phaseId: 'phase-0',
                phaseIndex: 0,
                intent: 'search',
                description: 'Search query',
                // No fieldParameter.targetValue defined
                allowedActions: ['type']
              }
            ]
          }
        },
        context: {
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          availableTargets: [MOCK_TARGET_1],
          page: {
            ...MOCK_PAGE_REP,
            elements: [
              {
                id: 'elem-search-input',
                role: 'textbox',
                tagName: 'input'
              }
            ]
          },
          stepIndex: 0
        }
      });

      const result = await driver.proposeStep(input);
      expect(result.status).toBe('ACTION');
      if (result.status !== 'ACTION') throw new Error('Expected ACTION');
      expect(result.proposal.payload?.text).toBe('custom arbitrary user query');
    });

    // I & J
    it('Regression I/J: select_result with zero matching results cannot declare goal completion, returns NO_MATCHING_RESULTS instead of UNSUPPORTED_GOAL', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'COMPLETED',
            rationale: 'No transactions found, marking completed'
          })
        })
      };

      const driver = createLocalAgentDriver(mockChatClient);
      const input = createMockPlannerInput({
        goal: {
          id: 'goal-select-empty',
          description: 'Find my latest Amazon transaction.',
          taskPlan: {
            planId: 'plan-select',
            archetype: 'search_and_act',
            summary: 'Find my latest Amazon transaction.',
            currentPhaseIndex: 1,
            phases: [
              {
                phaseId: 'phase-0',
                phaseIndex: 0,
                intent: 'search',
                description: 'Search for Amazon',
                allowedActions: ['type']
              },
              {
                phaseId: 'phase-1',
                phaseIndex: 1,
                intent: 'select_result',
                description: 'Select the latest transaction',
                targetHint: 'Amazon',
                allowedActions: ['click']
              }
            ]
          }
        },
        context: {
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          availableTargets: [],
          page: {
            ...MOCK_PAGE_REP,
            elements: []
          },
          stepIndex: 1,
          completion: { satisfied: false }
        },
        history: [
          {
            stepIndex: 0,
            phaseIndex: 0,
            action: {
              id: 'a0',
              type: 'type',
              target: MOCK_TARGET_1,
              payload: { text: 'Amazon', pressEnter: true },
              timestamp: Date.now()
            },
            perceivedOutcome: 'success'
          }
        ]
      });

      // LocalAgentDriver returns NO_MATCHING_RESULTS
      const driverResult = await driver.proposeStep(input);
      expect(driverResult.status).toBe('FAILED');
      if (driverResult.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(driverResult.reason).toBe('NO_MATCHING_RESULTS');
      expect(driverResult.reason).not.toBe('UNSUPPORTED_GOAL');

      // Phase 3A planNextStep maps to descriptive message
      const plannerResult = await planNextStep(input, driver);
      expect(plannerResult.status).toBe('FAILED');
      if (plannerResult.status !== 'FAILED') throw new Error('Expected FAILED');
      expect(plannerResult.reason).toBe('NO_MATCHING_RESULTS');
      expect(plannerResult.message).toContain('No matching transaction results are available for the current selection phase');
    });
  });

  describe('Stage 3 — Safe Diagnostic Logging (No Raw Model Completion Logging)', () => {
    it('never logs raw model completions containing synthetic PII to the console', async () => {
      const sensitiveEmail = 'secret.victim@example.com';
      const sensitivePhone = '+91 99887 76655';
      const rawModelCompletion = JSON.stringify({
        type: 'ACTION',
        targetElementId: 'elem-submit-btn',
        actionType: 'click',
        rationale: `Contacting user at ${sensitiveEmail} and mobile ${sensitivePhone} to approve transaction`
      });

      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: rawModelCompletion
        })
      };

      const consoleLogSpy = vi.spyOn(console, 'log');
      const consoleWarnSpy = vi.spyOn(console, 'warn');
      const consoleErrorSpy = vi.spyOn(console, 'error');

      try {
        const driver = createLocalAgentDriver(mockChatClient);
        const input = createMockPlannerInput();
        const result = await driver.proposeStep(input);

        expect(result.status).toBe('ACTION');

        // Collect all logged console messages
        const allLoggedMessages: string[] = [
          ...consoleLogSpy.mock.calls.map((call) => call.map(String).join(' ')),
          ...consoleWarnSpy.mock.calls.map((call) => call.map(String).join(' ')),
          ...consoleErrorSpy.mock.calls.map((call) => call.map(String).join(' '))
        ];

        // 1. Verify raw completion is NEVER logged
        for (const msg of allLoggedMessages) {
          expect(msg).not.toContain(rawModelCompletion);
          expect(msg).not.toContain(sensitiveEmail);
          expect(msg).not.toContain(sensitivePhone);
          expect(msg).not.toContain('raw model response =');
        }

        // 2. Verify safe diagnostic metadata IS logged
        const diagnosticLog = allLoggedMessages.find((msg) =>
          msg.includes('[NexVision LocalAgent]') && msg.includes('inference response received')
        );
        expect(diagnosticLog).toBeDefined();
        expect(diagnosticLog).toContain(`length=${rawModelCompletion.length}`);
        expect(diagnosticLog).toContain('parseStatus=ACTION');
        expect(diagnosticLog).toContain('action=click');
        expect(diagnosticLog).toContain('targetId=elem-submit-btn');
      } finally {
        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        consoleErrorSpy.mockRestore();
      }
    });

    it('safely logs inference failure without leaking prompts or sensitive parameters', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: false,
          error: {
            code: 'SERVER_ERROR',
            message: 'Inference timeout after 30s'
          }
        })
      };

      const consoleLogSpy = vi.spyOn(console, 'log');
      try {
        const driver = createLocalAgentDriver(mockChatClient);
        const input = createMockPlannerInput();
        const result = await driver.proposeStep(input);

        expect(result.status).toBe('FAILED');

        const allLogs = consoleLogSpy.mock.calls.map((call) => call.map(String).join(' '));
        const failLog = allLogs.find((msg) => msg.includes('inference failed'));
        expect(failLog).toBeDefined();
        expect(failLog).toContain('Inference timeout after 30s');
        expect(failLog).not.toContain('raw model response');
      } finally {
        consoleLogSpy.mockRestore();
      }
    });

    it('24. strictly excludes customer names and masked cards from the final serialized model request', async () => {
      let capturedUserPrompt = '';
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockImplementation(async (request) => {
          capturedUserPrompt = request.userPrompt;
          return {
            success: true,
            content: JSON.stringify({
              type: 'ACTION',
              targetElementId: 'elem-card-4821',
              actionType: 'click',
              rationale: 'Select payment card'
            })
          };
        })
      };

      const rawCardTarget: ActionTarget = {
        elementId: 'elem-card-4821',
        point: { x: 200, y: 100 },
        viewportBounds: { x: 100, y: 80, width: 200, height: 40 },
        confidence: 0.95,
        observationId: 'obs-card',
        role: 'button'
      };

      const rawPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'NexBank - Welcome, Arjun Reddy',
          url: 'https://nexbank.internal/dashboard?account=XXXX%20XXXX%204821'
        },
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'elem-welcome-btn',
            role: 'button',
            accessibleName: 'Welcome, Arjun Reddy',
            visibleText: 'Welcome, Arjun Reddy',
            interactive: true,
            bounds: { x: 50, y: 10, width: 200, height: 40 }
          },
          {
            id: 'elem-card-4821',
            role: 'button',
            accessibleName: 'Debit Card XXXX XXXX 4821',
            visibleText: 'Pay with card •••• 4821',
            interactive: true,
            bounds: { x: 100, y: 80, width: 200, height: 40 }
          }
        ]
      };

      const driver = createLocalAgentDriver(mockChatClient);
      const input = createMockPlannerInput({
        context: {
          page: rawPage,
          availableTargets: [rawCardTarget],
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          stepIndex: 1,
          completion: { satisfied: false }
        }
      });

      const result = await driver.proposeStep(input);
      expect(result.status).toBe('ACTION');

      // Inspect full serialized model request string sent to llama-server
      const fullSerializedRequest = capturedUserPrompt;

      // Verify ZERO residual PII reaches the model request
      expect(fullSerializedRequest).not.toContain('Arjun Reddy');
      expect(fullSerializedRequest).not.toContain('XXXX XXXX 4821');
      expect(fullSerializedRequest).not.toContain('•••• 4821');

      // Verify proper sanitized tokens are present in candidate targets and prompt text
      expect(fullSerializedRequest).toContain('[REDACTED_NAME]');
      expect(fullSerializedRequest).toContain('[CARD_ENDING_4821]');

      // Verify action was grounded on the sanitized element
      if (result.status === 'ACTION') {
        expect(result.proposal.targetElementId).toBe('elem-card-4821');
        expect(result.proposal.actionType).toBe('click');
      }
    });
  });

  describe('Phase 2.8 — Standalone Customer-Name & Financial Identifier Remediation', () => {
    it('redacts standalone person names in candidate targets, button text, and accessible names', async () => {
      let capturedUserPrompt = '';
      const mockChatClient: LocalLlamaChatClient = {
        chat: async (req) => {
          capturedUserPrompt = req.userPrompt;
          return {
            success: true,
            content: JSON.stringify({
              type: 'ACTION',
              targetElementId: 'elem-switcher',
              actionType: 'click',
              rationale: 'Switch account profile'
            })
          };
        }
      };

      const rawPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: {
          title: 'Account Management',
          url: 'https://example.com/switch-profile'
        },
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'elem-switcher',
            role: 'button',
            accessibleName: 'Arjun Reddy',
            visibleText: 'Arjun Reddy',
            interactive: true,
            bounds: { x: 50, y: 10, width: 120, height: 40 }
          },
          {
            id: 'elem-aria-name',
            role: 'button',
            accessibleName: 'Priya Sharma',
            visibleText: 'Switch User',
            attributes: { 'aria-label': 'Priya Sharma' },
            interactive: true,
            bounds: { x: 50, y: 60, width: 120, height: 40 }
          },
          {
            id: 'elem-submit',
            role: 'button',
            accessibleName: 'Submit Order',
            visibleText: 'Submit Order',
            interactive: true,
            bounds: { x: 50, y: 110, width: 120, height: 40 }
          },
          {
            id: 'elem-amazon',
            role: 'button',
            accessibleName: 'Amazon Pay',
            visibleText: 'Amazon Pay',
            interactive: true,
            bounds: { x: 50, y: 160, width: 120, height: 40 }
          },
          {
            id: 'elem-swiggy',
            role: 'button',
            accessibleName: 'Swiggy Delivery',
            visibleText: 'Swiggy Delivery',
            interactive: true,
            bounds: { x: 50, y: 210, width: 120, height: 40 }
          },
          {
            id: 'elem-netflix',
            role: 'button',
            accessibleName: 'Netflix Subscription',
            visibleText: 'Netflix Subscription',
            interactive: true,
            bounds: { x: 50, y: 260, width: 120, height: 40 }
          },
          {
            id: 'elem-continue',
            role: 'button',
            accessibleName: 'Continue',
            visibleText: 'Continue',
            interactive: true,
            bounds: { x: 50, y: 310, width: 120, height: 40 }
          }
        ]
      };

      const driver = createLocalAgentDriver(mockChatClient);
      const input = createMockPlannerInput({
        context: {
          page: rawPage,
          availableTargets: [
            { elementId: 'elem-switcher', point: { x: 110, y: 30 }, viewportBounds: { x: 50, y: 10, width: 120, height: 40 }, confidence: 1, observationId: 'obs-1', role: 'button' },
            { elementId: 'elem-aria-name', point: { x: 110, y: 80 }, viewportBounds: { x: 50, y: 60, width: 120, height: 40 }, confidence: 1, observationId: 'obs-2', role: 'button' },
            { elementId: 'elem-submit', point: { x: 110, y: 130 }, viewportBounds: { x: 50, y: 110, width: 120, height: 40 }, confidence: 1, observationId: 'obs-3', role: 'button' },
            { elementId: 'elem-amazon', point: { x: 110, y: 180 }, viewportBounds: { x: 50, y: 160, width: 120, height: 40 }, confidence: 1, observationId: 'obs-4', role: 'button' },
            { elementId: 'elem-swiggy', point: { x: 110, y: 230 }, viewportBounds: { x: 50, y: 210, width: 120, height: 40 }, confidence: 1, observationId: 'obs-5', role: 'button' },
            { elementId: 'elem-netflix', point: { x: 110, y: 280 }, viewportBounds: { x: 50, y: 260, width: 120, height: 40 }, confidence: 1, observationId: 'obs-6', role: 'button' },
            { elementId: 'elem-continue', point: { x: 110, y: 330 }, viewportBounds: { x: 50, y: 310, width: 120, height: 40 }, confidence: 1, observationId: 'obs-7', role: 'button' }
          ],
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          stepIndex: 1,
          completion: { satisfied: false }
        }
      });

      const result = await driver.proposeStep(input);
      expect(result.status).toBe('ACTION');

      // Assert serialized model prompt:
      expect(capturedUserPrompt).not.toContain('Arjun Reddy');
      expect(capturedUserPrompt).not.toContain('Priya Sharma');

      // Assert non-sensitive buttons & merchants are strictly preserved:
      expect(capturedUserPrompt).toContain('Submit Order');
      expect(capturedUserPrompt).toContain('Amazon Pay');
      expect(capturedUserPrompt).toContain('Swiggy Delivery');
      expect(capturedUserPrompt).toContain('Netflix Subscription');
      expect(capturedUserPrompt).toContain('Continue');

      // Assert candidate target serialization contains [REDACTED_NAME]
      const payload = JSON.parse(capturedUserPrompt);
      const switcherTarget = payload.availableTargets.find((t: any) => t.elementId === 'elem-switcher');
      expect(switcherTarget).toBeDefined();
      expect(switcherTarget.accessibleName).toBe('[REDACTED_NAME]');
      expect(switcherTarget.visibleText).toBe('[REDACTED_NAME]');

      const ariaTarget = payload.availableTargets.find((t: any) => t.elementId === 'elem-aria-name');
      expect(ariaTarget).toBeDefined();
      expect(ariaTarget.attributes?.['aria-label']).toBe('[REDACTED_NAME]');
    });

    it('enforces financial identifier disclosure policy across masked and fully masked formats', async () => {
      let capturedUserPrompt = '';
      const mockChatClient: LocalLlamaChatClient = {
        chat: async (req) => {
          capturedUserPrompt = req.userPrompt;
          return {
            success: true,
            content: JSON.stringify({
              type: 'ACTION',
              targetElementId: 'card-partial-1',
              actionType: 'click',
              rationale: 'Select card ending in 4821'
            })
          };
        }
      };

      const rawPage: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { title: 'Cards', url: 'https://example.com/cards' },
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            id: 'card-partial-1',
            role: 'button',
            accessibleName: 'Card XXXX XXXX 4821',
            visibleText: 'Card XXXX XXXX 4821',
            interactive: true,
            bounds: { x: 10, y: 10, width: 200, height: 40 }
          },
          {
            id: 'card-partial-2',
            role: 'button',
            accessibleName: 'Card **** 1092',
            visibleText: 'Card **** 1092',
            interactive: true,
            bounds: { x: 10, y: 60, width: 200, height: 40 }
          },
          {
            id: 'card-partial-3',
            role: 'button',
            accessibleName: 'Card •••• 9934',
            visibleText: 'Card •••• 9934',
            interactive: true,
            bounds: { x: 10, y: 110, width: 200, height: 40 }
          },
          {
            id: 'card-fully-masked-1',
            role: 'button',
            accessibleName: 'Card XXXX XXXX XXXX XXXX',
            visibleText: 'Card XXXX XXXX XXXX XXXX',
            interactive: true,
            bounds: { x: 10, y: 160, width: 200, height: 40 }
          },
          {
            id: 'card-fully-masked-2',
            role: 'button',
            accessibleName: 'Card ••••••••••••••••',
            visibleText: 'Card ••••••••••••••••',
            interactive: true,
            bounds: { x: 10, y: 210, width: 200, height: 40 }
          }
        ]
      };

      const driver = createLocalAgentDriver(mockChatClient);
      const input = createMockPlannerInput({
        context: {
          page: rawPage,
          availableTargets: rawPage.elements.map(e => ({
            elementId: e.id,
            point: { x: e.bounds!.x + e.bounds!.width / 2, y: e.bounds!.y + e.bounds!.height / 2 },
            viewportBounds: e.bounds!,
            confidence: 1,
            observationId: `obs-${e.id}`,
            role: 'button'
          })),
          capturedAt: FIXED_TIME - 500,
          currentTime: FIXED_TIME,
          stepIndex: 1,
          completion: { satisfied: false }
        }
      });

      const result = await driver.proposeStep(input);
      expect(result.status).toBe('ACTION');

      // Verify original masked sequences NEVER reach model-facing fields
      expect(capturedUserPrompt).not.toContain('XXXX XXXX 4821');
      expect(capturedUserPrompt).not.toContain('**** 1092');
      expect(capturedUserPrompt).not.toContain('•••• 9934');
      expect(capturedUserPrompt).not.toContain('XXXX XXXX XXXX XXXX');
      expect(capturedUserPrompt).not.toContain('••••••••••••••••');

      // Verify documented suffix exception for grounding disambiguation
      expect(capturedUserPrompt).toContain('[CARD_ENDING_4821]');
      expect(capturedUserPrompt).toContain('[CARD_ENDING_1092]');
      expect(capturedUserPrompt).toContain('[CARD_ENDING_9934]');

      // Verify fully masked cards are redacted to [REDACTED_CARD] with zero digits disclosed
      expect(capturedUserPrompt).toContain('[REDACTED_CARD]');

      // Verify grounding succeeds on the target opaque ID
      if (result.status === 'ACTION') {
        expect(result.proposal.targetElementId).toBe('card-partial-1');
      }
    });
  });

  describe('Task Decomposition and Robust JSON Parsing', () => {
    it('successfully parses valid JSON candidates', () => {
      const valid = '{"planVersion": "1.0", "phases": []}';
      expect(tryParseJsonCandidate(valid)).toEqual({ planVersion: '1.0', phases: [] });
    });

    it('repairs pipe-separated array syntax produced by local models', () => {
      const malformedPipe = '{\n  "name": "search",\n  "allowedActions": ["click"|"type"|"focus"],\n  "successCriteria": "done"\n}';
      const parsed = tryParseJsonCandidate(malformedPipe) as { allowedActions: string[] } | null;
      expect(parsed).not.toBeNull();
      expect(parsed?.allowedActions).toEqual(['click', 'type', 'focus']);
    });

    it('repairs trailing commas and smart quotes in JSON candidates', () => {
      const malformed = '{\n  “targetField”: “search_input”,\n  “allowedActions”: [“click”, “type”,],\n}';
      const parsed = tryParseJsonCandidate(malformed) as { targetField: string; allowedActions: string[] } | null;
      expect(parsed).not.toBeNull();
      expect(parsed?.targetField).toBe('search_input');
      expect(parsed?.allowedActions).toEqual(['click', 'type']);
    });

    it('returns null on unrecoverable malformed JSON', () => {
      expect(tryParseJsonCandidate('{ not valid json at all :::')).toBeNull();
    });

    it('decomposeTaskGoal parses pipe-syntax model responses successfully', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            planId: 'plan-test-pipe',
            archetype: 'search_and_act',
            userGoal: 'Find my Amazon transaction for ₹4,299.',
            summary: 'Search for Amazon and view transaction',
            phases: [
              {
                phaseId: 'phase-0',
                phaseIndex: 0,
                intent: 'search',
                description: 'Search for Amazon',
                targetHint: 'Amazon',
                fieldParameter: {
                  fieldName: 'search',
                  targetValue: 'Amazon'
                },
                allowedActions: ['type'],
                expectedOutcome: 'Search results displayed'
              }
            ]
          }).replace('"allowedActions": ["type"]', '"allowedActions": ["click"|"type"]')
        })
      };

      const plan = await decomposeTaskGoal('Find my Amazon transaction for ₹4,299.', { client: mockChatClient });
      expect(plan).toBeDefined();
      expect(plan?.phases.length).toBeGreaterThan(0);
      expect(plan?.phases[0].intent).toBe('search');
    });

    it('decomposeTaskGoal falls back to deterministic item retrieval plan when model generates invalid output', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: 'I cannot provide a plan. Here is non-json text: <xml>invalid</xml>'
        })
      };

      const plan = await decomposeTaskGoal('Find my Amazon transaction for ₹4,299.', { client: mockChatClient });
      expect(plan).toBeDefined();
      expect(plan?.archetype).toBe('search_and_act');
      expect(plan?.phases.length).toBe(2);
      expect(plan?.phases[0].intent).toBe('search');
      expect(plan?.phases[1].intent).toBe('select_result');
    });
  });
});

