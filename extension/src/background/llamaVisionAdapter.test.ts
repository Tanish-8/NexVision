import { describe, it, expect, vi } from 'vitest';
import {
  LlamaVisionAdapter,
  createLlamaVisionAdapter,
  stripMarkdownFences
} from './llamaVisionAdapter.js';

const MOCK_INPUT = {
  dimensions: { width: 1000, height: 800 },
  data: 'data:image/png;base64,QUJDREVGR0g=',
  format: 'image/png'
};

describe('Phase 2E-2B — LlamaVisionAdapter (Extension)', () => {
  describe('stripMarkdownFences', () => {
    it('should strip markdown code fences', () => {
      const wrapped = '```json\n{"detections": []}\n```';
      expect(stripMarkdownFences(wrapped)).toBe('{"detections": []}');
    });
  });

  describe('perceive()', () => {
    it('1. should successfully parse detections and return VisualObservation array with provenance vision', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: [
                  {
                    label: 'button',
                    text: 'Submit',
                    box: { x: 50, y: 100, width: 120, height: 40 },
                    confidence: 0.94
                  },
                  {
                    label: 'textbox',
                    text: 'Email',
                    box: { x: 50, y: 50, width: 250, height: 35 },
                    confidence: 0.89
                  }
                ]
              })
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = createLlamaVisionAdapter({
        fetchFn: mockFetch as any
      });

      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');

      expect(result.observations).toHaveLength(2);

      const obs1 = result.observations[0]!;
      expect(obs1.id).toBe('llama-obs-1');
      expect(obs1.label).toBe('button');
      expect(obs1.text).toBe('Submit');
      expect(obs1.boundingBox).toEqual({ x: 50, y: 100, width: 120, height: 40 });
      expect(obs1.confidence).toBe(0.94);
      expect(obs1.interactionHint).toBe('clickable');
      expect(obs1.provenance).toBe('vision');
      expect(obs1.metadata?.adapterName).toBe('LlamaVisionAdapter');

      const obs2 = result.observations[1]!;
      expect(obs2.interactionHint).toBe('input');
      expect(obs2.provenance).toBe('vision');
    });

    it('2. should strip markdown code fences from response', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content:
                '```json\n{"detections": [{"label": "button", "box": {"x": 10, "y": 10, "width": 50, "height": 30}, "confidence": 0.85}]}\n```'
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');
      expect(result.observations).toHaveLength(1);
    });

    it('3. should reject detections with missing or non-finite confidence (NO defaulting)', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: [
                  {
                    label: 'button',
                    box: { x: 10, y: 10, width: 50, height: 30 }
                    // confidence missing
                  }
                ]
              })
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('PERCEPTION_FAILURE');
      expect(result.error.message).toContain('invalid confidence');
    });

    it('4. should reject detections with negative bounding box coordinates (NO silent clamping)', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: [
                  {
                    label: 'button',
                    box: { x: -10, y: 20, width: 50, height: 30 },
                    confidence: 0.9
                  }
                ]
              })
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('PERCEPTION_FAILURE');
      expect(result.error.message).toContain('negative or non-finite box coordinates');
    });

    it('5. should reject detections whose bounding box exceeds image dimensions (NO silent clamping)', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: [
                  {
                    label: 'button',
                    box: { x: 900, y: 10, width: 150, height: 30 }, // 900 + 150 = 1050 > 1000
                    confidence: 0.9
                  }
                ]
              })
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('PERCEPTION_FAILURE');
      expect(result.error.message).toContain('exceeds image dimensions');
    });

    it('6. should reject malformed / non-JSON responses', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: 'I observed a search box and buttons.'
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('PERCEPTION_FAILURE');
      expect(result.error.message).toContain('Failed to parse model output as valid JSON');
    });

    it('7. should map offline server error to UNAVAILABLE_IMPLEMENTATION', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new TypeError('Failed to fetch: connection refused'));

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('UNAVAILABLE_IMPLEMENTATION');
      expect(result.error.message).toContain('offline or unreachable');
    });

    it('8. should map timeout abort to PERCEPTION_FAILURE', async () => {
      const mockFetch = vi.fn().mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const adapter = new LlamaVisionAdapter({
        fetchFn: mockFetch as any,
        timeoutMs: 40
      });

      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('PERCEPTION_FAILURE');
      expect(result.error.message).toContain('timed out after 40ms');
    });

    it('9. should ensure error messages never leak sensitive screenshot bytes or data URLs', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Internal network error'));

      const sensitiveDataUrl =
        'data:image/png;base64,HIGHLY_SENSITIVE_SCREENSHOT_BYTES_DO_NOT_LEAK';

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive({
        dimensions: { width: 100, height: 100 },
        data: sensitiveDataUrl,
        format: 'image/png'
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('HIGHLY_SENSITIVE_SCREENSHOT_BYTES');
      expect(serialized).not.toContain('data:image');
    });

    it('10. should accept top-level array response (Shape A)', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  label: 'button',
                  text: 'Create New Project',
                  box: { x: 30, y: 50, width: 150, height: 35 },
                  confidence: 0.92
                }
              ])
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]!.label).toBe('button');
      expect(result.observations[0]!.text).toBe('Create New Project');
      expect(result.observations[0]!.confidence).toBe(0.92);
      expect(result.observations[0]!.interactionHint).toBe('clickable');
    });

    it('11. should reject malformed object lacking detections field', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                foo: 'bar',
                unexpected: 123
              })
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('PERCEPTION_FAILURE');
      expect(result.error.message).toContain('missing "detections" field');
    });

    it('12. should reject empty object {} with missing detections field', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({})
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('PERCEPTION_FAILURE');
      expect(result.error.message).toContain('missing "detections" field');
    });

    it('13. should reject object with non-array detections value', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: 'not-an-array'
              })
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const adapter = new LlamaVisionAdapter({ fetchFn: mockFetch as any });
      const result = await adapter.perceive(MOCK_INPUT);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error.code).toBe('PERCEPTION_FAILURE');
      expect(result.error.message).toContain('is not an array');
    });

    it('14. should accept valid empty detections array in both shapes', async () => {
      // Shape A: []
      const mockFetchA = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify([]) } }]
        })
      });

      const adapterA = new LlamaVisionAdapter({ fetchFn: mockFetchA as any });
      const resA = await adapterA.perceive(MOCK_INPUT);
      expect(resA.success).toBe(true);
      if (!resA.success) throw new Error('Expected success');
      expect(resA.observations).toEqual([]);

      // Shape B: {"detections": []}
      const mockFetchB = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ detections: [] }) } }]
        })
      });

      const adapterB = new LlamaVisionAdapter({ fetchFn: mockFetchB as any });
      const resB = await adapterB.perceive(MOCK_INPUT);
      expect(resB.success).toBe(true);
      if (!resB.success) throw new Error('Expected success');
      expect(resB.observations).toEqual([]);
    });

    it('15. should safely bind default fetch to globalThis to prevent Illegal invocation in Service Worker', async () => {
      const originalFetch = globalThis.fetch;
      try {
        let calledWithCorrectThis = false;
        const fakeWorkerFetch = function (this: any, _input: any, _init?: any) {
          if (this !== globalThis) {
            throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
          }
          calledWithCorrectThis = true;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({ detections: [] })
                    }
                  }
                ]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          );
        };
        globalThis.fetch = fakeWorkerFetch as any;

        // Instantiate without passing fetchFn option to exercise default production path
        const adapter = new LlamaVisionAdapter();
        const res = await adapter.perceive(MOCK_INPUT);

        expect(res.success).toBe(true);
        expect(calledWithCorrectThis).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
