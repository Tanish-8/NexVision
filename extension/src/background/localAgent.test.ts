import { describe, it, expect, vi } from 'vitest';
import type { ActionTarget, ClickAction, TypeAction } from '../shared/actions.js';
import type { PageRepresentation, SanitizedPageRepresentation } from '../shared/types.js';
import {
  LocalAgent,
  createLocalAgent,
  buildModelPromptPayload,
  buildAgentUserPrompt,
  parseAdvisoryResponse,
  validateProposalAndCreateAction,
  LOCAL_AGENT_SYSTEM_PROMPT,
  type PlannerInput,
  type LocalLlamaChatClient,
  type AdvisoryStepProposal
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

function createMockPlannerInput(overrides?: Partial<PlannerInput>): PlannerInput {
  return {
    goal: {
      description: 'Search for laptops under ₹50,000',
      intent: 'product_search',
      parameters: { query: 'laptops' }
    },
    context: {
      page: MOCK_PAGE_REP,
      availableTargets: [MOCK_TARGET_1, MOCK_TARGET_2],
      isCompleted: false
    },
    stepIndex: 1,
    currentTime: 1710000000000,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Test Suite: Phase 5A Local AI Agent Integration
// ---------------------------------------------------------------------------

describe('Phase 5A — Local AI Agent / Task Understanding Integration', () => {
  describe('Required 25 Test Cases', () => {
    // 1. valid ACTION response
    it('1. valid ACTION response: parses model action and returns validated IntendedAction', async () => {
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
      const result = await agent.planNextStep(input);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');

      expect(result.status).toBe('ACTION_PLANNED');
      if (result.status !== 'ACTION_PLANNED') throw new Error('Expected ACTION_PLANNED');
      expect(result.action.type).toBe('type');
      expect(result.action.target.elementId).toBe('elem-search-input');
      expect((result.action as TypeAction).payload.text).toBe('laptop');
      expect(result.rationale).toBe('Enter search term into textbox');
      expect(result.estimatedProgress).toBe(0.3);
      expect(result.action.timestamp).toBe(1710000000000);
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
          isCompleted: true // explicit completion verified
        }
      });
      const result = await agent.planNextStep(input);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');

      expect(result.status).toBe('COMPLETED');
      expect(result.rationale).toBe('Search results displayed and goal satisfied');
    });

    // 3. invalid JSON
    it('3. invalid JSON: rejects unparseable response with MODEL_ERROR', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: 'I decided to click the button. Here is nothing useful.'
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.status).toBe('FAILED');
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('missing required "type" property');
    });

    // 5. unsupported action type
    it('5. unsupported action type: rejects actions outside click/type/focus with INCOMPATIBLE_ACTION', async () => {
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('INCOMPATIBLE_ACTION');
      expect(result.message).toContain('Unsupported actionType "hover"');
    });

    // 6. missing targetElementId
    it('6. missing targetElementId: rejects ACTION proposal with missing targetElementId', async () => {
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('missing required non-empty "targetElementId"');
    });

    // 7. unknown targetElementId
    it('7. unknown targetElementId: fails when targetElementId does not match any available target', async () => {
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('UNKNOWN_TARGET');
      expect(result.message).toContain('Target element "elem-ghost-button" is not in availableTargets');
    });

    // 8. target not in availableTargets
    it('8. target not in availableTargets: strictly requires target membership in availableTargets', () => {
      const proposal: AdvisoryStepProposal = {
        type: 'ACTION',
        targetElementId: 'elem-not-grounded',
        actionType: 'click'
      };
      const input = createMockPlannerInput();

      const result = validateProposalAndCreateAction(proposal, input);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('UNKNOWN_TARGET');
    });

    // 9. malformed payload
    it('9. malformed payload: rejects invalid type action payload structure', async () => {
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('INVALID_ACTION_INTENT');
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('INVALID_INPUT');
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('INVALID_INPUT');
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('INVALID_INPUT');
      expect(result.message).toContain('Invalid estimatedProgress');
    });

    // 13. model timeout/error
    it('13. model timeout/error: cleanly maps client timeout into MODEL_ERROR failure', async () => {
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

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.status).toBe('FAILED');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toBe('Local inference timed out after 120000ms');
    });

    // 14. model returns malformed response
    it('14. model returns malformed response: handles non-object array responses safely', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify(['not', 'an', 'object'])
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('Model output must be a non-null JSON object');
    });

    // 15. model cannot bypass target membership
    it('15. model cannot bypass target membership: rejects fabricated targets', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'synthetic-id-999',
            actionType: 'click'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('UNKNOWN_TARGET');
    });

    // 16. model cannot synthesize coordinates
    it('16. model cannot synthesize coordinates: target point is taken strictly from grounded ActionTarget', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click',
            coordinates: { x: 999, y: 999 } // attempt to inject synthetic coordinates
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');

      expect(result.status).toBe('ACTION_PLANNED');
      if (result.status !== 'ACTION_PLANNED') throw new Error('Expected ACTION_PLANNED');
      // Must ignore injected coordinates and preserve the grounded point (300, 50)
      expect(result.action.target.point).toEqual({ x: 300, y: 50 });
      expect(result.action.target.viewportBounds).toEqual({ x: 260, y: 30, width: 80, height: 40 });
    });

    // 17. model can select a valid grounded target
    it('17. model can select a valid grounded target: resolves element identity and metadata accurately', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click',
            rationale: 'Submit the search form'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput();
      const result = await agent.planNextStep(input);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');
      if (result.status !== 'ACTION_PLANNED') throw new Error('Expected ACTION_PLANNED');

      expect(result.action.target.elementId).toBe('elem-submit-btn');
      expect(result.action.target.observationId).toBe('obs-2');
    });

    // 18. only click/type/focus are accepted
    it('18. only click/type/focus are accepted: verifies all valid actions succeed', async () => {
      for (const validAction of ['click', 'focus'] as const) {
        const mockChatClient: LocalLlamaChatClient = {
          chat: vi.fn().mockResolvedValue({
            success: true,
            content: JSON.stringify({
              type: 'ACTION',
              targetElementId: 'elem-submit-btn',
              actionType: validAction
            })
          })
        };

        const agent = createLocalAgent(mockChatClient);
        const result = await agent.planNextStep(createMockPlannerInput());
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Expected success');
        if (result.status !== 'ACTION_PLANNED') throw new Error('Expected ACTION_PLANNED');
        expect(result.action.type).toBe(validAction);
      }

      // type action with payload
      const mockTypeClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { text: 'test query', pressEnter: true }
          })
        })
      };
      const typeAgent = createLocalAgent(mockTypeClient);
      const typeResult = await typeAgent.planNextStep(createMockPlannerInput());
      expect(typeResult.success).toBe(true);
      if (!typeResult.success) throw new Error('Expected success');
      if (typeResult.status !== 'ACTION_PLANNED') throw new Error('Expected ACTION_PLANNED');
      expect(typeResult.action.type).toBe('type');
      expect((typeResult.action as TypeAction).payload.pressEnter).toBe(true);
    });

    // 19. prompt/model input excludes sensitive fields
    it('19. prompt/model input excludes sensitive fields: excludes passwords, inputs, and attributes', () => {
      const pageWithSensitiveData: PageRepresentation = {
        schemaVersion: '1.0',
        metadata: { title: 'Sensitive Page', url: 'https://example.com/account' },
        viewport: { width: 1000, height: 800 },
        elements: [
          {
            id: 'elem-password',
            role: 'textbox',
            inputType: 'password',
            visibleText: 'super_secret_password_123',
            attributes: {
              value: 'super_secret_password_123',
              cookie: 'session=abc123xyz',
              authToken: 'bearer secret_token'
            },
            interactive: true,
            bounds: { x: 10, y: 10, width: 100, height: 30 }
          }
        ]
      };

      const target: ActionTarget = {
        elementId: 'elem-password',
        point: { x: 60, y: 25 },
        viewportBounds: { x: 10, y: 10, width: 100, height: 30 },
        confidence: 0.9,
        observationId: 'obs-pwd',
        role: 'textbox'
      };

      const input = createMockPlannerInput({
        context: {
          page: pageWithSensitiveData,
          availableTargets: [target]
        }
      });

      const promptPayload = buildModelPromptPayload(input);
      const serializedPrompt = JSON.stringify(promptPayload);

      // Verify no sensitive fields leaked
      expect(serializedPrompt).not.toContain('super_secret_password_123');
      expect(serializedPrompt).not.toContain('session=abc123xyz');
      expect(serializedPrompt).not.toContain('bearer secret_token');
      expect(serializedPrompt).not.toContain('cookie');
      expect(serializedPrompt).not.toContain('authToken');
      expect(serializedPrompt).not.toContain('attributes');
    });

    // 20. raw screenshot/data URL is not forwarded
    it('20. raw screenshot/data URL is not forwarded: model input never includes image data', () => {
      const input = createMockPlannerInput();
      const serialized = buildAgentUserPrompt(input);

      expect(serialized).not.toContain('data:image');
      expect(serialized).not.toContain('base64');
      expect(serialized).not.toContain('screenshot');
    });

    // 21. deterministic serialization of the same PlannerInput
    it('21. deterministic serialization of the same PlannerInput: produces identical JSON strings', () => {
      const input1 = createMockPlannerInput();
      const input2 = createMockPlannerInput();

      const serialized1 = buildAgentUserPrompt(input1);
      const serialized2 = buildAgentUserPrompt(input2);

      expect(serialized1).toBe(serialized2);
    });

    // 22. model response is not logged verbatim
    it('22. model response is not logged verbatim: console spy confirms zero verbatim response leakage', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const secretText = 'CONFIDENTIAL_MODEL_OUTPUT_SECRET_12345';
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-search-input',
            actionType: 'type',
            payload: { text: secretText },
            rationale: 'Typing sensitive item'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const result = await agent.planNextStep(createMockPlannerInput());
      expect(result.success).toBe(true);

      // Check all console calls
      for (const call of [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]) {
        const combined = call.map(String).join(' ');
        expect(combined).not.toContain(secretText);
      }

      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    // 23. one action per cycle
    it('23. one action per cycle: returns exactly one IntendedAction in PlannerResult', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-submit-btn',
            actionType: 'click'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const result = await agent.planNextStep(createMockPlannerInput());

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');

      expect(result.status).toBe('ACTION_PLANNED');
      if (result.status !== 'ACTION_PLANNED') throw new Error('Expected ACTION_PLANNED');
      // Verified single atomic action returned
      expect(result.action).toBeDefined();
      expect(Array.isArray(result.action)).toBe(false);
      expect(result.action.id).toBe('intent_obs-2_click');
    });

    // 24. explicit completion handling
    it('24. explicit completion handling: rejects COMPLETED when context indicates incomplete', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'COMPLETED',
            rationale: 'Premature completion attempt'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      // isCompleted is false in context
      const input = createMockPlannerInput({
        context: {
          page: MOCK_PAGE_REP,
          availableTargets: [MOCK_TARGET_1],
          isCompleted: false
        }
      });
      const result = await agent.planNextStep(input);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('UNSUPPORTED_GOAL');
      expect(result.message).toContain('planner context does not indicate completion is valid');
    });

    // 25. planner validation is still invoked after model proposal
    it('25. planner validation is still invoked after model proposal: fails if target element is disabled', async () => {
      const disabledTarget: ActionTarget = {
        elementId: 'elem-disabled-btn',
        point: { x: 450, y: 50 },
        viewportBounds: { x: 400, y: 30, width: 100, height: 40 },
        confidence: 0.9,
        observationId: 'obs-disabled',
        role: 'button'
      };

      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn().mockResolvedValue({
          success: true,
          content: JSON.stringify({
            type: 'ACTION',
            targetElementId: 'elem-disabled-btn',
            actionType: 'click'
          })
        })
      };

      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput({
        context: {
          page: MOCK_PAGE_REP,
          availableTargets: [disabledTarget]
        }
      });
      const result = await agent.planNextStep(input);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('INCOMPATIBLE_ACTION');
      expect(result.message).toContain('Target element "elem-disabled-btn" is disabled');
    });
  });

  // -------------------------------------------------------------------------
  // Additional Edge Cases & Contract Tests
  // -------------------------------------------------------------------------

  describe('Edge Cases & Defense in Depth', () => {
    it('should strip markdown fences from valid JSON responses', () => {
      const wrapped = '```json\n{"type": "ACTION", "targetElementId": "elem-1", "actionType": "click"}\n```';
      const parsed = parseAdvisoryResponse(wrapped);

      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error('Expected success');
      expect(parsed.proposal.type).toBe('ACTION');
      if (parsed.proposal.type === 'ACTION') {
        expect(parsed.proposal.targetElementId).toBe('elem-1');
      }
    });

    it('should reject typing into non-textual role like button', () => {
      const proposal: AdvisoryStepProposal = {
        type: 'ACTION',
        targetElementId: 'elem-submit-btn',
        actionType: 'type',
        payload: { text: 'cannot type here' }
      };
      const input = createMockPlannerInput();

      const result = validateProposalAndCreateAction(proposal, input);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('INCOMPATIBLE_ACTION');
      expect(result.message).toContain('Action "type" is incompatible with target role "button"');
    });

    it('should reject non-interactive target element', () => {
      const staticTarget: ActionTarget = {
        elementId: 'elem-static-text',
        point: { x: 125, y: 20 },
        viewportBounds: { x: 50, y: 10, width: 150, height: 20 },
        confidence: 0.9,
        observationId: 'obs-static',
        role: 'heading'
      };

      const proposal: AdvisoryStepProposal = {
        type: 'ACTION',
        targetElementId: 'elem-static-text',
        actionType: 'click'
      };
      const input = createMockPlannerInput({
        context: {
          page: MOCK_PAGE_REP,
          availableTargets: [staticTarget]
        }
      });

      const result = validateProposalAndCreateAction(proposal, input);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('INCOMPATIBLE_ACTION');
      expect(result.message).toContain('is marked non-interactive');
    });

    it('should handle SanitizedPageRepresentation unwrapping gracefully', () => {
      const sanitizedPage: SanitizedPageRepresentation = {
        pageRepresentation: MOCK_PAGE_REP,
        findings: [],
        metadata: {
          sanitizedAt: Date.now(),
          totalFindings: 0,
          categoryCounts: {
            email: 0,
            phone: 0,
            card: 0,
            password: 0,
            address: 0,
            name: 0,
            auth_token: 0,
            other: 0
          }
        }
      };

      const input = createMockPlannerInput({
        context: {
          page: sanitizedPage,
          availableTargets: [MOCK_TARGET_1]
        }
      });

      const dto = buildModelPromptPayload(input);
      expect(dto.page.title).toBe('Example Shop');
      expect(dto.availableTargets).toHaveLength(1);
      expect(dto.availableTargets[0]!.elementId).toBe('elem-search-input');
      expect(dto.availableTargets[0]!.accessibleName).toBe('Search products');
    });

    it('should reject empty availableTargets when task is not completed', async () => {
      const mockChatClient: LocalLlamaChatClient = {
        chat: vi.fn()
      };
      const agent = createLocalAgent(mockChatClient);
      const input = createMockPlannerInput({
        context: {
          page: MOCK_PAGE_REP,
          availableTargets: [],
          isCompleted: false
        }
      });

      const result = await agent.planNextStep(input);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('NO_FEASIBLE_TARGET');
      expect(mockChatClient.chat).not.toHaveBeenCalled();
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
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('HTTP 500 Internal Server Error');
    });

    it('DefaultLocalLlamaChatClient handles network error cleanly', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:8080'));

      const agent = createLocalAgent({
        fetchFn: mockFetch as any
      });

      const result = await agent.planNextStep(createMockPlannerInput());
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.reason).toBe('MODEL_ERROR');
      expect(result.message).toContain('offline or unreachable');
    });
  });

  // -------------------------------------------------------------------------
  // Isolated Real Local Model Integration Check
  // -------------------------------------------------------------------------

  describe('Real Local Model Integration (Isolated / Manual)', () => {
    it('probes real llama-server if running without failing offline test suites', async () => {
      let isOnline = false;
      try {
        const res = await fetch('http://127.0.0.1:8080/health', {
          signal: AbortSignal.timeout(1000)
        });
        isOnline = res.ok;
      } catch {
        isOnline = false;
      }

      if (!isOnline) {
        // Offline: passes cleanly without failing the automated suite
        expect(isOnline).toBe(false);
        return;
      }

      const agent = createLocalAgent({
        host: '127.0.0.1',
        port: 8080,
        timeoutMs: 30000
      });
      const result = await agent.planNextStep(createMockPlannerInput());
      expect(result).toBeDefined();
      if (result.success) {
        expect(result.status === 'ACTION_PLANNED' || result.status === 'COMPLETED').toBe(true);
      }
    });
  });
});
