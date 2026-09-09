import { describe, it, expect, vi } from 'vitest';
import {
  LlamaServerInference,
  stripMarkdownFences,
  formatImageDataUrl,
  LLAMA_VISION_SYSTEM_PROMPT,
  LLAMA_VISION_USER_PROMPT
} from './llamaInference.js';
import type { VisionImageInput } from './types.js';

const MOCK_IMAGE_INPUT: VisionImageInput = {
  dimensions: { width: 1000, height: 800 },
  data: 'data:image/png;base64,QUJDREVGR0g=',
  format: 'image/png'
};

describe('Phase 2E-2B — LlamaServerInference', () => {
  describe('stripMarkdownFences', () => {
    it('should leave clean JSON untouched', () => {
      const input = '{"detections": []}';
      expect(stripMarkdownFences(input)).toBe(input);
    });

    it('should strip ```json ... ``` fences', () => {
      const input = '```json\n{"detections": []}\n```';
      expect(stripMarkdownFences(input)).toBe('{"detections": []}');
    });

    it('should strip ``` ... ``` fences without json specifier', () => {
      const input = '```\n{"detections": []}\n```';
      expect(stripMarkdownFences(input)).toBe('{"detections": []}');
    });
  });

  describe('formatImageDataUrl', () => {
    it('should preserve existing data URLs', () => {
      expect(formatImageDataUrl(MOCK_IMAGE_INPUT)).toBe(
        'data:image/png;base64,QUJDREVGR0g='
      );
    });

    it('should prepend data: prefix to raw base64 strings', () => {
      const res = formatImageDataUrl({
        dimensions: { width: 100, height: 100 },
        data: 'QUJDREVGR0g=',
        format: 'image/jpeg'
      });
      expect(res).toBe('data:image/jpeg;base64,QUJDREVGR0g=');
    });

    it('should convert Uint8Array bytes to data URL', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const res = formatImageDataUrl({
        dimensions: { width: 100, height: 100 },
        data: bytes,
        format: 'image/png'
      });
      expect(res.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('should throw if image data is missing', () => {
      expect(() =>
        formatImageDataUrl({
          dimensions: { width: 100, height: 100 }
        })
      ).toThrow('Image data is required');
    });
  });

  describe('infer() protocol and strict validation', () => {
    it('1. should successfully parse valid JSON detections and map interaction hints', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: [
                  {
                    label: 'button',
                    text: 'Search',
                    box: { x: 10, y: 20, width: 100, height: 40 },
                    confidence: 0.95
                  },
                  {
                    label: 'textbox',
                    text: 'Query',
                    box: { x: 120, y: 20, width: 200, height: 40 },
                    confidence: 0.88
                  },
                  {
                    label: 'select',
                    box: { x: 340, y: 20, width: 150, height: 40 },
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

      const engine = new LlamaServerInference({
        fetchFn: mockFetch as any,
        timeoutMs: 5000
      });

      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(true);
      if (!res.success) throw new Error('Expected success');

      expect(res.detections).toHaveLength(3);
      expect(res.detections[0]!.label).toBe('button');
      expect(res.detections[0]!.text).toBe('Search');
      expect(res.detections[0]!.box).toEqual({ x: 10, y: 20, width: 100, height: 40 });
      expect(res.detections[0]!.confidence).toBe(0.95);
      expect(res.detections[0]!.interactionHint).toBe('clickable');

      expect(res.detections[1]!.interactionHint).toBe('input');
      expect(res.detections[2]!.interactionHint).toBe('selectable');
    });

    it('2. should strip markdown fences before parsing JSON', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content:
                '```json\n{\n  "detections": [\n    {\n      "label": "button",\n      "box": { "x": 0, "y": 0, "width": 50, "height": 50 },\n      "confidence": 0.8\n    }\n  ]\n}\n```'
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const engine = new LlamaServerInference({
        fetchFn: mockFetch as any
      });

      const res = await engine.infer(MOCK_IMAGE_INPUT);
      expect(res.success).toBe(true);
      if (!res.success) throw new Error('Expected success');
      expect(res.detections).toHaveLength(1);
      expect(res.detections[0]!.label).toBe('button');
    });

    it('3. should reject detections with missing or invalid confidence (NO defaulting to 1.0)', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: [
                  {
                    label: 'button',
                    box: { x: 10, y: 10, width: 50, height: 50 }
                    // confidence missing!
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

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('invalid confidence');
    });

    it('4. should reject detections with confidence outside [0, 1] or non-finite', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: [
                  {
                    label: 'button',
                    box: { x: 10, y: 10, width: 50, height: 50 },
                    confidence: 1.5 // out of bounds!
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

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('invalid confidence');
    });

    it('5. should reject detections with negative bounding box coordinates (NO silent clamping)', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: [
                  {
                    label: 'button',
                    box: { x: -5, y: 10, width: 50, height: 50 },
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

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('negative or non-finite box coordinates');
    });

    it('6. should reject detections whose bounding box exceeds image dimensions (NO silent clamping)', async () => {
      // Image is 1000x800, detection box exceeds 1000
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: [
                  {
                    label: 'button',
                    box: { x: 950, y: 10, width: 100, height: 50 }, // 950 + 100 = 1050 > 1000
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

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('exceeds image dimensions');
    });

    it('7. should reject malformed / non-JSON responses', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: 'I see a button near the top and a search bar.' // prose, not JSON
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('Failed to parse model output as valid JSON');
    });

    it('8. should map network offline / connection failure to UNAVAILABLE_IMPLEMENTATION', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8080'));

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('UNAVAILABLE_IMPLEMENTATION');
      expect(res.error.message).toContain('offline or unreachable');
    });

    it('9. should handle timeout abort and return PERCEPTION_FAILURE', async () => {
      const mockFetch = vi.fn().mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const engine = new LlamaServerInference({
        fetchFn: mockFetch as any,
        timeoutMs: 50 // short timeout for test
      });

      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('timed out after 50ms');
    });

    it('10. should handle HTTP error status from server', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('HTTP 500');
    });

    it('11. should preserve privacy and never include raw dataUrl or screenshot bytes in error messages', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new TypeError('Connection reset'));

      const sensitiveDataUrl =
        'data:image/png;base64,SECRET_PAYLOAD_THAT_MUST_NEVER_LEAK_IN_LOGS';
      const inputWithSecret: VisionImageInput = {
        dimensions: { width: 100, height: 100 },
        data: sensitiveDataUrl,
        format: 'image/png'
      };

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(inputWithSecret);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');

      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain('SECRET_PAYLOAD');
      expect(serialized).not.toContain('data:image');
    });

    it('12. should accept top-level array response (Shape A)', async () => {
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

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(true);
      if (!res.success) throw new Error('Expected success');
      expect(res.detections).toHaveLength(1);
      expect(res.detections[0]!.label).toBe('button');
      expect(res.detections[0]!.text).toBe('Create New Project');
      expect(res.detections[0]!.confidence).toBe(0.92);
      expect(res.detections[0]!.interactionHint).toBe('clickable');
    });

    it('13. should reject malformed object lacking detections field', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                unexpected: 'shape',
                status: 'ok'
              })
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('missing "detections" field');
    });

    it('14. should reject empty object {} lacking detections field', async () => {
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

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('missing "detections" field');
    });

    it('15. should reject object with non-array detections value', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                detections: { item: 'not-an-array' }
              })
            }
          }
        ]
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const engine = new LlamaServerInference({ fetchFn: mockFetch as any });
      const res = await engine.infer(MOCK_IMAGE_INPUT);

      expect(res.success).toBe(false);
      if (res.success) throw new Error('Expected failure');
      expect(res.error.code).toBe('PERCEPTION_FAILURE');
      expect(res.error.message).toContain('is not an array');
    });

    it('16. should accept valid empty detections array in both shapes', async () => {
      // Shape A: []
      const mockFetchA = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify([]) } }]
        })
      });

      const engineA = new LlamaServerInference({ fetchFn: mockFetchA as any });
      const resA = await engineA.infer(MOCK_IMAGE_INPUT);
      expect(resA.success).toBe(true);
      if (!resA.success) throw new Error('Expected success');
      expect(resA.detections).toEqual([]);

      // Shape B: {"detections": []}
      const mockFetchB = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ detections: [] }) } }]
        })
      });

      const engineB = new LlamaServerInference({ fetchFn: mockFetchB as any });
      const resB = await engineB.infer(MOCK_IMAGE_INPUT);
      expect(resB.success).toBe(true);
      if (!resB.success) throw new Error('Expected success');
      expect(resB.detections).toEqual([]);
    });

    it('17. should safely bind default fetch to globalThis to prevent receiver mismatches', async () => {
      const originalFetch = globalThis.fetch;
      try {
        let calledWithCorrectThis = false;
        const fakeFetch = function (this: any, _input: any, _init?: any) {
          if (this !== globalThis) {
            throw new TypeError("Failed to execute 'fetch': Illegal invocation");
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
        globalThis.fetch = fakeFetch as any;

        const engine = new LlamaServerInference();
        const res = await engine.infer(MOCK_IMAGE_INPUT);

        expect(res.success).toBe(true);
        expect(calledWithCorrectThis).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
