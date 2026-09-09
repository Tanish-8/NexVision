/**
 * Tests for the Unified Perception Orchestrator (Phase 2C).
 *
 * These tests use deterministic mocks for all three providers.
 * They do NOT duplicate the screenshot test suite or vision test suite.
 * They verify orchestration logic, error routing, and privacy properties.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  perceivePage
} from './orchestrator.js';
import type {
  DomPerceptionProvider,
  ScreenshotProvider,
  VisualPerceptionAdapter,
  UnifiedPerceptionResult,
  VisualObservation,
  ScreenshotReference,
  VisualInteractionHint,
  VisualObservationMetadata
} from './orchestrator.js';
import type { PageRepresentation } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const MOCK_DOM: PageRepresentation = {
  schemaVersion: '1.0',
  metadata: { title: 'Test Page', url: 'https://example.com' },
  viewport: { width: 1280, height: 720 },
  elements: [
    {
      id: 'elem-1',
      tagName: 'button',
      role: 'button',
      visibleText: 'Submit',
      interactive: true,
      provenance: 'dom'
    }
  ]
};

const MOCK_SCREENSHOT_REF: ScreenshotReference = {
  format: 'png',
  timestamp: 1_000_000,
  dataUrl: 'data:image/png;base64,SYNTHETIC'
};

const MOCK_OBSERVATION: VisualObservation = {
  id: 'mock-obs-1',
  label: 'button',
  text: 'Submit [SYNTHETIC]',
  boundingBox: { x: 10, y: 20, width: 100, height: 40 },
  confidence: 0.95
};

/** Creates a DOM provider that returns a fixed PageRepresentation (async, Phase 2D contract). */
function makeDomProvider(dom: PageRepresentation = MOCK_DOM): DomPerceptionProvider {
  return () => Promise.resolve(dom);
}

/** Creates a DOM provider that rejects with an error (async, Phase 2D contract). */
function makeFailingDomProvider(message = 'DOM failure'): DomPerceptionProvider {
  return async () => { throw new Error(message); };
}

/** Creates a screenshot provider that returns a fixed reference. */
function makeScreenshotProvider(ref: ScreenshotReference = MOCK_SCREENSHOT_REF): ScreenshotProvider {
  return async () => ref;
}

/** Creates a screenshot provider that throws. */
function makeFailingScreenshotProvider(message = 'Screenshot failed'): ScreenshotProvider {
  return async () => { throw new Error(message); };
}

/** Creates a vision adapter returning a fixed list of observations. */
function makeVisionAdapter(observations: VisualObservation[] = [MOCK_OBSERVATION]): VisualPerceptionAdapter {
  return {
    name: 'MockAdapter',
    perceive: async (_input) => ({ success: true, observations })
  };
}

/** Creates a vision adapter that returns a typed failure result. */
function makeFailingVisionAdapter(code = 'PERCEPTION_FAILURE', message = 'Vision failed'): VisualPerceptionAdapter {
  return {
    name: 'FailingAdapter',
    perceive: async (_input) => ({
      success: false,
      error: { code, message }
    })
  };
}

/** Creates a vision adapter that throws (unexpected error). */
function makeThrowingVisionAdapter(message = 'Vision threw'): VisualPerceptionAdapter {
  return {
    name: 'ThrowingAdapter',
    perceive: async (_input) => { throw new Error(message); }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 2C — Unified Perception Orchestrator', () => {

  // 1. Successful orchestration
  it('1. should return a unified success result when all three providers succeed', async () => {
    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeVisionAdapter()
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    // DOM representation is preserved unchanged
    expect(result.domRepresentation).toEqual(MOCK_DOM);

    // Screenshot reference has format and timestamp but NO dataUrl (not forwarded)
    expect(result.screenshotRef.format).toBe('png');
    expect(result.screenshotRef.timestamp).toBe(1_000_000);
    expect(result.screenshotRef).not.toHaveProperty('dataUrl');

    // Visual observations are present
    expect(result.visualObservations).toHaveLength(1);
    expect(result.visualObservations[0]!.id).toBe('mock-obs-1');
    expect(result.visualObservations[0]!.label).toBe('button');
    expect(result.visualObservations[0]!.confidence).toBe(0.95);

    // Metadata is populated
    expect(result.metadata.visionAdapterName).toBe('MockAdapter');
    expect(result.metadata.orchestratedAt).toBeTypeOf('number');
    expect(result.metadata.orchestratedAt).toBeGreaterThan(0);
  });

  // 2. DOM failure
  it('2. should return a dom-origin failure when the DOM provider throws', async () => {
    const result = await perceivePage(
      makeFailingDomProvider('DOM perception exploded'),
      makeScreenshotProvider(),
      makeVisionAdapter()
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.origin).toBe('dom');
    expect(result.error.message).toContain('DOM perception exploded');
  });

  // 3. Screenshot failure
  it('3. should return a screenshot-origin failure when the screenshot provider throws', async () => {
    const result = await perceivePage(
      makeDomProvider(),
      makeFailingScreenshotProvider('Chrome tab unavailable'),
      makeVisionAdapter()
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.origin).toBe('screenshot');
    expect(result.error.message).toContain('Chrome tab unavailable');
  });

  // 4. Vision failure (discriminated result, not throw)
  it('4. should return a vision-origin failure when the vision adapter returns failure', async () => {
    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeFailingVisionAdapter('UNAVAILABLE_IMPLEMENTATION', 'No model loaded')
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.origin).toBe('vision');
    expect(result.error.message).toBe('No model loaded');
    expect(result.error.code).toBe('UNAVAILABLE_IMPLEMENTATION');
  });

  // 4b. Vision failure (unexpected throw)
  it('4b. should return a vision-origin failure when the vision adapter throws unexpectedly', async () => {
    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeThrowingVisionAdapter('Model crashed')
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.origin).toBe('vision');
    expect(result.error.message).toContain('Model crashed');
  });

  // 5. Successful empty vision result
  it('5. should succeed with an empty observation list when the vision adapter returns zero results', async () => {
    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeVisionAdapter([])  // zero observations
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.visualObservations).toEqual([]);
    // DOM representation is still present
    expect(result.domRepresentation.elements).toHaveLength(1);
  });

  // 6. Injected mock VisionPerception adapter is used
  it('6. should use the injected vision adapter and reflect its name in metadata', async () => {
    const customAdapter: VisualPerceptionAdapter = {
      name: 'InjectedTestAdapter',
      perceive: async (_input) => ({
        success: true,
        observations: [
          { id: 'custom-1', label: 'link', boundingBox: { x: 0, y: 0, width: 50, height: 20 }, confidence: 0.7 }
        ]
      })
    };

    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      customAdapter
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.metadata.visionAdapterName).toBe('InjectedTestAdapter');
    expect(result.visualObservations[0]!.id).toBe('custom-1');
  });

  // 7. No network calls
  it('7. should not make any network calls during orchestration', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeVisionAdapter()
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // 8. Screenshot dataUrl is NOT forwarded in the result (no persistence path)
  it('8. should not forward screenshot dataUrl in the success result', async () => {
    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider({
        format: 'png',
        timestamp: 999,
        dataUrl: 'data:image/png;base64,SENSITIVE_BYTES'
      }),
      makeVisionAdapter()
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    // dataUrl must not appear in the returned screenshotRef
    expect(result.screenshotRef).not.toHaveProperty('dataUrl');

    // dataUrl must not appear anywhere in the result top-level keys
    const topLevelKeys = Object.keys(result);
    expect(topLevelKeys).not.toContain('dataUrl');
    expect(topLevelKeys).not.toContain('imageBytes');
    expect(topLevelKeys).not.toContain('screenshot');
  });

  // 9. DOM PageRepresentation remains separate from visual observations
  it('9. should keep DOM elements and visual observations in separate fields', async () => {
    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeVisionAdapter([MOCK_OBSERVATION])
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    // DOM elements and visual observations are separate arrays
    const domIds = result.domRepresentation.elements.map(e => e.id);
    const visionIds = result.visualObservations.map(o => o.id);

    // No ID collision between the two lists
    const intersection = domIds.filter(id => visionIds.includes(id));
    expect(intersection).toHaveLength(0);

    // Each lives in its own field — no merging has occurred
    expect(result.domRepresentation.elements).toBeDefined();
    expect(result.visualObservations).toBeDefined();
    expect(result).not.toHaveProperty('mergedElements');
  });

  // 10. Privacy: result contains no form values, passwords, cookies
  it('10. should not expose form values, passwords, or cookies in the result', async () => {
    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeVisionAdapter()
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    const resultStr = JSON.stringify(result);

    // Sanity-check that no known sensitive key names appear in the serialized output
    expect(resultStr).not.toContain('"password"');
    expect(resultStr).not.toContain('"cookie"');
    expect(resultStr).not.toContain('"localStorage"');
    expect(resultStr).not.toContain('"sessionStorage"');
    expect(resultStr).not.toContain('"credentials"');

    // DOM element values (form inputs) are not forwarded — the mock DOM has no
    // inputType or value fields, matching the existing privacy boundary.
    for (const el of result.domRepresentation.elements) {
      expect(el).not.toHaveProperty('value');
    }
  });

  // 11. vision input passes viewport dimensions from DOM representation
  it('11. should pass the viewport dimensions from the DOM representation to the vision adapter', async () => {
    const perceiveSpy = vi.fn().mockResolvedValue({ success: true, observations: [] });
    const adapter: VisualPerceptionAdapter = {
      name: 'SpyAdapter',
      perceive: perceiveSpy
    };

    const customDom: PageRepresentation = {
      ...MOCK_DOM,
      viewport: { width: 1920, height: 1080 }
    };

    await perceivePage(
      makeDomProvider(customDom),
      makeScreenshotProvider(),
      adapter
    );

    expect(perceiveSpy).toHaveBeenCalledOnce();
    const calledWith = perceiveSpy.mock.calls[0]![0];
    expect(calledWith.dimensions.width).toBe(1920);
    expect(calledWith.dimensions.height).toBe(1080);
  });

  // 12. Provenance is preserved on visual observations
  it('12. should preserve provenance on visual observations', async () => {
    const observationWithProvenance: VisualObservation = {
      ...MOCK_OBSERVATION,
      id: 'obs-provenance-1',
      provenance: 'vision'
    };

    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeVisionAdapter([observationWithProvenance])
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.visualObservations).toHaveLength(1);
    expect(result.visualObservations[0]!.provenance).toBe('vision');
  });

  // 13. InteractionHint is preserved on visual observations
  it('13. should preserve interactionHint on visual observations', async () => {
    const observationWithHint: VisualObservation = {
      ...MOCK_OBSERVATION,
      id: 'obs-hint-1',
      interactionHint: 'clickable'
    };

    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeVisionAdapter([observationWithHint])
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.visualObservations).toHaveLength(1);
    expect(result.visualObservations[0]!.interactionHint).toBe('clickable');
  });

  // 14. Metadata is preserved on visual observations
  it('14. should preserve metadata on visual observations', async () => {
    const observationWithMetadata: VisualObservation = {
      ...MOCK_OBSERVATION,
      id: 'obs-metadata-1',
      metadata: {
        synthetic: true,
        adapterName: 'MockPerceptionEngine',
        testLabel: 'dialog-confirm'
      }
    };

    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeVisionAdapter([observationWithMetadata])
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.visualObservations).toHaveLength(1);
    expect(result.visualObservations[0]!.metadata).toEqual({
      synthetic: true,
      adapterName: 'MockPerceptionEngine',
      testLabel: 'dialog-confirm'
    });
  });

  // 15. All rich fields preserved simultaneously while existing observations without optional fields still work
  it('15. should preserve all rich fields simultaneously while observations without optional fields continue to work', async () => {
    const minimalObservation: VisualObservation = {
      id: 'obs-minimal',
      label: 'static-text',
      boundingBox: { x: 0, y: 0, width: 200, height: 20 },
      confidence: 0.88
      // provenance, interactionHint, metadata omitted
    };

    const fullySpecifiedObservation: VisualObservation = {
      id: 'obs-rich',
      label: 'input',
      text: 'Search...',
      boundingBox: { x: 50, y: 100, width: 300, height: 40 },
      confidence: 0.99,
      provenance: 'vision',
      interactionHint: 'input',
      metadata: {
        synthetic: true,
        adapterName: 'RichAdapter',
        testLabel: 'search-input'
      }
    };

    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider(),
      makeVisionAdapter([minimalObservation, fullySpecifiedObservation])
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.visualObservations).toHaveLength(2);

    // Minimal observation works without error and optional fields are undefined
    expect(result.visualObservations[0]!.id).toBe('obs-minimal');
    expect(result.visualObservations[0]!.provenance).toBeUndefined();
    expect(result.visualObservations[0]!.interactionHint).toBeUndefined();
    expect(result.visualObservations[0]!.metadata).toBeUndefined();

    // Rich observation has all fields intact
    expect(result.visualObservations[1]!.id).toBe('obs-rich');
    expect(result.visualObservations[1]!.provenance).toBe('vision');
    expect(result.visualObservations[1]!.interactionHint).toBe('input');
    expect(result.visualObservations[1]!.metadata).toEqual({
      synthetic: true,
      adapterName: 'RichAdapter',
      testLabel: 'search-input'
    });
  });

  // 16. Screenshot dataUrl privacy invariant remains intact when rich observations are processed
  it('16. should maintain screenshot dataUrl privacy invariant when rich observations are processed', async () => {
    const richObservation: VisualObservation = {
      id: 'obs-rich-privacy',
      label: 'button',
      boundingBox: { x: 10, y: 20, width: 100, height: 40 },
      confidence: 0.95,
      provenance: 'vision',
      interactionHint: 'clickable',
      metadata: { synthetic: true, adapterName: 'PrivacyCheckAdapter' }
    };

    const result = await perceivePage(
      makeDomProvider(),
      makeScreenshotProvider({
        format: 'png',
        timestamp: 123456,
        dataUrl: 'data:image/png;base64,SECRET_CANVAS_PIXELS_NEVER_LEAK'
      }),
      makeVisionAdapter([richObservation])
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    // ScreenshotRef must not contain dataUrl
    expect(result.screenshotRef).not.toHaveProperty('dataUrl');
    expect(result.screenshotRef.format).toBe('png');
    expect(result.screenshotRef.timestamp).toBe(123456);

    // The raw secret image data must never appear anywhere in the serialized perception result
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET_CANVAS_PIXELS_NEVER_LEAK');
    expect(Object.keys(result)).not.toContain('dataUrl');
  });
});
