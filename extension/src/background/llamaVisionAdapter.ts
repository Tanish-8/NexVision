/**
 * Phase 2E-2B — Real Local Vision Runtime Integration for Chrome Extension.
 *
 * Implements VisualPerceptionAdapter for the background service worker,
 * communicating with a locally running llama-server (127.0.0.1:8080) hosting Qwen2.5-VL-3B.
 *
 * Invariants:
 * - Completely isolated from the vision package to maintain extension/tsconfig.json rootDir: ./src.
 * - Connects strictly to 127.0.0.1:8080 by default.
 * - Strict JSON validation with markdown code fence stripping.
 * - Strict bounding box validation (no silent clamping).
 * - Strict confidence score validation in [0, 1] (no defaulting).
 * - Dedicated 120s timeout decoupled from DOM IPC timeouts.
 * - Privacy-first: screenshot bytes and data URLs are never logged, persisted, or leaked in errors.
 * - Sets provenance strictly to 'vision'.
 */

import type {
  VisualInteractionHint,
  VisualObservation,
  VisualPerceptionAdapter
} from './orchestrator.js';

export interface LlamaVisionAdapterOptions {
  /** Host address. Default: '127.0.0.1' */
  host?: string;
  /** Port number. Default: 8080 */
  port?: number;
  /** Request timeout in milliseconds. Default: 120000 (120s) */
  timeoutMs?: number;
  /** Model identifier. Default: 'qwen2.5-vl-3b' */
  modelId?: string;
  /** Custom base URL override (useful for testing) */
  baseUrl?: string;
  /** Custom fetch implementation (useful for testing) */
  fetchFn?: typeof fetch;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are an on-device visual perception engine for browser agents. Detect visible interactive controls in the screenshot. Return ONLY valid JSON with a "detections" array containing objects with: "label" (string: button, link, textbox, checkbox, select, generic), "text" (string or null), "box" (object with x, y, width, height as pixel numbers relative to top-left 0,0), and "confidence" (number between 0 and 1).';

const DEFAULT_USER_PROMPT =
  'Detect all interactive controls in this screenshot.';

/**
 * Strips surrounding markdown code fences (```json ... ``` or ``` ... ```) if present.
 */
export function stripMarkdownFences(content: string): string {
  let trimmed = content.trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```[a-zA-Z]*\r?\n?/, '');
    trimmed = trimmed.replace(/\r?\n?```$/, '');
  }
  return trimmed.trim();
}

/**
 * Formats image input into an ephemeral data URL.
 */
function toDataUrl(input: {
  dimensions: { width: number; height: number };
  data?: ArrayBuffer | Uint8Array | string;
  format?: string;
}): string {
  if (!input.data) {
    throw new Error('Image data is required for visual perception');
  }

  if (typeof input.data === 'string') {
    if (input.data.startsWith('data:')) {
      return input.data;
    }
    const mime = input.format || 'image/png';
    return `data:${mime};base64,${input.data}`;
  }

  const mime = input.format || 'image/png';
  let bytes: Uint8Array;
  if (input.data instanceof Uint8Array) {
    bytes = input.data;
  } else if (input.data instanceof ArrayBuffer) {
    bytes = new Uint8Array(input.data);
  } else {
    throw new Error('Unsupported image data representation');
  }

  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }

  const base64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');

  return `data:${mime};base64,${base64}`;
}

/**
 * Visual perception adapter communicating with a local llama-server instance.
 */
export class LlamaVisionAdapter implements VisualPerceptionAdapter {
  readonly name: string = 'LlamaVisionAdapter';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly modelId: string;
  private readonly fetchFn: typeof fetch;

  constructor(options?: LlamaVisionAdapterOptions) {
    const host = options?.host?.trim() || '127.0.0.1';
    const port = options?.port ?? 8080;

    this.baseUrl = options?.baseUrl?.trim() || `http://${host}:${port}`;
    this.timeoutMs = options?.timeoutMs ?? 120000;
    this.modelId = options?.modelId?.trim() || 'qwen2.5-vl-3b';
    this.fetchFn =
      options?.fetchFn ||
      (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : globalThis.fetch);

    if (typeof this.fetchFn !== 'function') {
      throw new Error('fetch is not available in the current environment');
    }
  }

  /**
   * Performs visual perception on the provided screenshot input.
   */
  async perceive(input: {
    dimensions: { width: number; height: number };
    data?: ArrayBuffer | Uint8Array | string;
    format?: string;
  }): Promise<
    | { success: true; observations: VisualObservation[] }
    | { success: false; error: { code: string; message: string } }
  > {
    // 1. Prepare ephemeral data URL safely
    let dataUrl: string;
    try {
      dataUrl = toDataUrl(input);
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'INVALID_IMAGE_INPUT',
          message: err instanceof Error ? err.message : 'Invalid image data'
        }
      };
    }

    // 2. Build payload
    const payload = {
      model: this.modelId,
      messages: [
        {
          role: 'system',
          content: DEFAULT_SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: dataUrl
              }
            },
            {
              type: 'text',
              text: DEFAULT_USER_PROMPT
            }
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 512,
      response_format: {
        type: 'json_object'
      }
    };

    // 3. Dispatch HTTP request with dedicated timeout
    const endpoint = `${this.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      if (controller.signal.aborted) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: `Local vision inference timed out after ${this.timeoutMs}ms`
          }
        };
      }

      return {
        success: false,
        error: {
          code: 'UNAVAILABLE_IMPLEMENTATION',
          message: `Local vision server is offline or unreachable on ${this.baseUrl}: ${String(fetchError)}`
        }
      };
    } finally {
      clearTimeout(timeoutId);
    }

    // 4. Verify HTTP status
    if (!response.ok) {
      return {
        success: false,
        error: {
          code: 'PERCEPTION_FAILURE',
          message: `Local vision server returned HTTP ${response.status} ${response.statusText}`
        }
      };
    }

    // 5. Parse outer JSON structure
    let responseBody: any;
    try {
      responseBody = await response.json();
    } catch {
      return {
        success: false,
        error: {
          code: 'PERCEPTION_FAILURE',
          message: 'Local vision server returned invalid JSON response'
        }
      };
    }

    const rawContent = responseBody?.choices?.[0]?.message?.content;
    if (typeof rawContent !== 'string' || rawContent.trim() === '') {
      return {
        success: false,
        error: {
          code: 'PERCEPTION_FAILURE',
          message: 'Local vision server returned response without text content'
        }
      };
    }

    // 6. Strip code fences and parse structured JSON
    const cleanedJson = stripMarkdownFences(rawContent);
    let parsed: any;
    try {
      parsed = JSON.parse(cleanedJson);
    } catch {
      return {
        success: false,
        error: {
          code: 'PERCEPTION_FAILURE',
          message: 'Failed to parse model output as valid JSON'
        }
      };
    }

    // 7. Verify detections array schema: accept top-level array [...] or {"detections": [...]}
    let rawDetections: any[];
    if (Array.isArray(parsed)) {
      rawDetections = parsed;
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!('detections' in parsed)) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: 'Model output JSON missing "detections" field'
          }
        };
      }
      if (!Array.isArray(parsed.detections)) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: 'Model output JSON "detections" field is not an array'
          }
        };
      }
      rawDetections = parsed.detections;
    } else {
      return {
        success: false,
        error: {
          code: 'PERCEPTION_FAILURE',
          message: 'Model output JSON must be an array or an object with a "detections" array'
        }
      };
    }

    // 8. Strictly validate EVERY detection (no silent clamping, no confidence default)
    const observations: VisualObservation[] = [];

    for (let i = 0; i < rawDetections.length; i++) {
      const item = rawDetections[i];
      if (!item || typeof item !== 'object') {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: `Detection at index ${i} is not an object`
          }
        };
      }

      // Validate label
      if (typeof item.label !== 'string' || item.label.trim() === '') {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: `Detection at index ${i} missing valid label`
          }
        };
      }

      // Validate confidence strictly
      if (
        typeof item.confidence !== 'number' ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1
      ) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: `Detection at index ${i} has invalid confidence: must be a finite number in [0, 1]`
          }
        };
      }

      // Validate box
      if (!item.box || typeof item.box !== 'object') {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: `Detection at index ${i} missing box object`
          }
        };
      }

      const { x, y, width, height } = item.box;
      if (
        typeof x !== 'number' ||
        !Number.isFinite(x) ||
        x < 0 ||
        typeof y !== 'number' ||
        !Number.isFinite(y) ||
        y < 0 ||
        typeof width !== 'number' ||
        !Number.isFinite(width) ||
        width < 0 ||
        typeof height !== 'number' ||
        !Number.isFinite(height) ||
        height < 0
      ) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: `Detection at index ${i} contains negative or non-finite box coordinates`
          }
        };
      }

      // Bounds check against image dimensions (no silent clamping)
      if (
        x + width > input.dimensions.width ||
        y + height > input.dimensions.height
      ) {
        return {
          success: false,
          error: {
            code: 'PERCEPTION_FAILURE',
            message: `Detection at index ${i} bounding box (x=${x}, y=${y}, w=${width}, h=${height}) exceeds image dimensions (${input.dimensions.width}x${input.dimensions.height})`
          }
        };
      }

      // Interaction hint
      let interactionHint: VisualInteractionHint = 'unknown';
      const normLabel = item.label.trim().toLowerCase();
      if (normLabel === 'button' || normLabel === 'link' || normLabel === 'checkbox') {
        interactionHint = 'clickable';
      } else if (
        normLabel === 'textbox' ||
        normLabel === 'input' ||
        normLabel === 'searchbox' ||
        normLabel === 'textarea'
      ) {
        interactionHint = 'input';
      } else if (normLabel === 'select' || normLabel === 'combobox') {
        interactionHint = 'selectable';
      }

      observations.push({
        id: `llama-obs-${i + 1}`,
        label: item.label.trim(),
        text:
          typeof item.text === 'string' && item.text.trim() !== ''
            ? item.text.trim()
            : undefined,
        boundingBox: { x, y, width, height },
        confidence: item.confidence,
        interactionHint,
        provenance: 'vision',
        metadata: {
          adapterName: this.name
        }
      });
    }

    return {
      success: true,
      observations
    };
  }
}

/**
 * Factory creating a VisualPerceptionAdapter connected to llama-server.
 */
export function createLlamaVisionAdapter(
  options?: LlamaVisionAdapterOptions
): VisualPerceptionAdapter {
  return new LlamaVisionAdapter(options);
}
