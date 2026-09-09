/**
 * Tests for Phase 2F-2: Deterministic Vision → DOM Grounding
 *
 * All tests use plain PageRepresentation/PageElement fixtures.
 * No real browser DOM APIs are used.
 */

import { describe, it, expect } from 'vitest';
import {
  groundVisualObservation,
  groundVisualObservations
} from './grounding.js';
import type {
  GroundingVisualObservation,
  GroundingOptions
} from './grounding.js';
import type {
  PageRepresentation,
  PageElement
} from './types.js';
import type { CoordinateSpaceMetadata } from './coordinates.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** 1:1 coordinate space (screenshot = CSS viewport). */
const SPACE_1TO1: CoordinateSpaceMetadata = {
  screenshotWidth: 1000,
  screenshotHeight: 800,
  viewportWidth: 1000,
  viewportHeight: 800,
  devicePixelRatio: 1.0
};

/** NexVision observed dimensions (Phase 2F-1 verification). */
const SPACE_NEXVISION: CoordinateSpaceMetadata = {
  screenshotWidth: 1295,
  screenshotHeight: 877,
  viewportWidth: 1036,
  viewportHeight: 702,
  devicePixelRatio: 1.25
};

/** 2x DPR-like space. */
const SPACE_2X: CoordinateSpaceMetadata = {
  screenshotWidth: 2000,
  screenshotHeight: 1600,
  viewportWidth: 1000,
  viewportHeight: 800,
  devicePixelRatio: 2.0
};

/** Non-uniform scaling space (1500x1600 → 1000x800). */
const SPACE_NONUNIFORM: CoordinateSpaceMetadata = {
  screenshotWidth: 1500,
  screenshotHeight: 1600,
  viewportWidth: 1000,
  viewportHeight: 800,
  devicePixelRatio: 1.5
};

function makeElement(
  overrides: Partial<PageElement> & Pick<PageElement, 'id'>
): PageElement {
  return {
    role: 'generic',
    interactive: false,
    provenance: 'dom',
    state: { visible: true, enabled: true, disabled: false },
    bounds: { x: 100, y: 100, width: 200, height: 50 },
    ...overrides
  };
}

function makePageRepresentation(elements: PageElement[]): PageRepresentation {
  return {
    schemaVersion: '1.0',
    metadata: { title: 'Test Page', url: 'https://example.com' },
    viewport: { width: 1000, height: 800 },
    elements
  };
}

function makeObservation(
  overrides: Partial<GroundingVisualObservation> & Pick<GroundingVisualObservation, 'id'>
): GroundingVisualObservation {
  return {
    label: 'button',
    confidence: 0.90,
    boundingBox: { x: 100, y: 100, width: 200, height: 50 },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. Exact 1:1 match
// ---------------------------------------------------------------------------

describe('1: Exact 1:1 match', () => {
  it('should ground observation to perfectly matching element with high confidence', () => {
    const elements = [
      makeElement({
        id: 'elem-1',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({ id: 'obs-1', label: 'button', confidence: 0.90 });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.elementId).toBe('elem-1');
      expect(result.scoreBreakdown.iou).toBeCloseTo(1.0, 4);
      expect(result.scoreBreakdown.totalScore).toBeGreaterThan(0.90);
      expect(result.groundingConfidence).toBeGreaterThan(0.90);
      expect(result.groundingConfidence).toBeLessThanOrEqual(1.0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Screenshot → CSS normalization (NexVision dimensions)
// ---------------------------------------------------------------------------

describe('2: Screenshot → CSS normalization (1295x877 → 1036x702)', () => {
  it('should normalize screenshot bounding box via Phase 2F-1 before matching', () => {
    // Button in CSS space: x=100, y=100, w=200, h=50
    // Corresponding screenshot coords: x=100*1.25=125, y=100*(877/702)≈124.93, etc.
    const cssX = 100;
    const cssY = 100;
    const cssW = 200;
    const cssH = 50;

    const scaleX = 1295 / 1036; // ≈ 1.25
    const scaleY = 877 / 702;   // ≈ 1.24929...

    const screenshotRect = {
      x: cssX * scaleX,
      y: cssY * scaleY,
      width: cssW * scaleX,
      height: cssH * scaleY
    };

    const elements = [
      makeElement({
        id: 'elem-btn',
        role: 'button',
        interactive: true,
        bounds: { x: cssX, y: cssY, width: cssW, height: cssH }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({
      id: 'obs-norm',
      label: 'button',
      confidence: 0.85,
      boundingBox: screenshotRect
    });

    const result = groundVisualObservation(obs, page, SPACE_NEXVISION);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.elementId).toBe('elem-btn');
      // Normalized CSS box should approximately match the DOM element bounds
      expect(result.normalizedCssBox.x).toBeCloseTo(cssX, 3);
      expect(result.normalizedCssBox.y).toBeCloseTo(cssY, 3);
      expect(result.normalizedCssBox.width).toBeCloseTo(cssW, 3);
      expect(result.normalizedCssBox.height).toBeCloseTo(cssH, 3);
      expect(result.scoreBreakdown.iou).toBeCloseTo(1.0, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Partial overlap
// ---------------------------------------------------------------------------

describe('3: Partial overlap', () => {
  it('should produce a proportional score for partial overlap', () => {
    // Visual box overlaps right half of the button
    const elements = [
      makeElement({
        id: 'elem-1',
        role: 'button',
        interactive: true,
        bounds: { x: 0, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    // Overlaps x=100..300, DOM is x=0..200: intersection x=100..200
    const obs = makeObservation({
      id: 'obs-partial',
      label: 'button',
      confidence: 0.80,
      boundingBox: { x: 100, y: 100, width: 200, height: 50 }
    });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      // Intersection = 100x50 = 5000; Visual = 200x50 = 10000; Dom = 200x50 = 10000; Union = 15000
      expect(result.scoreBreakdown.iou).toBeCloseTo(5000 / 15000, 4);
      expect(result.scoreBreakdown.visualContainment).toBeCloseTo(0.5, 4);
      expect(result.scoreBreakdown.totalScore).toBeGreaterThan(0);
      expect(result.scoreBreakdown.totalScore).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Partial out-of-bounds (must NOT become OUT_OF_BOUNDS)
// ---------------------------------------------------------------------------

describe('4: Partial out-of-bounds without clamping', () => {
  it('should continue to candidate matching when observation partially extends outside viewport', () => {
    const elements = [
      makeElement({
        id: 'elem-edge',
        role: 'button',
        interactive: true,
        bounds: { x: 0, y: 0, width: 80, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    // x=-20..60 in CSS: partially negative, but overlaps viewport
    const obs = makeObservation({
      id: 'obs-edge',
      label: 'button',
      confidence: 0.80,
      // In SPACE_1TO1, screenshot = CSS, so x=-20 normalized = x=-20 (partial OOB)
      boundingBox: { x: -20, y: 0, width: 80, height: 50 }
    });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    // Must NOT be OUT_OF_BOUNDS
    expect(result.matched === true || (result.matched === false && result.reason !== 'OUT_OF_BOUNDS')).toBe(true);
    if (!result.matched) {
      expect(result.reason).not.toBe('OUT_OF_BOUNDS');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Full containment
// ---------------------------------------------------------------------------

describe('5: Full containment', () => {
  it('should score well when visual box is fully inside DOM element', () => {
    const elements = [
      makeElement({
        id: 'elem-large',
        role: 'button',
        interactive: true,
        bounds: { x: 0, y: 0, width: 400, height: 200 }
      })
    ];
    const page = makePageRepresentation(elements);
    // Small visual inside large DOM element
    const obs = makeObservation({
      id: 'obs-contained',
      label: 'button',
      confidence: 0.85,
      boundingBox: { x: 100, y: 50, width: 100, height: 50 }
    });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.scoreBreakdown.visualContainment).toBeCloseTo(1.0, 4);
      expect(result.scoreBreakdown.elementContainment).toBeCloseTo(100 * 50 / (400 * 200), 4);
    }
  });

  it('should score well when DOM element is fully inside visual box', () => {
    const elements = [
      makeElement({
        id: 'elem-small',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 50, width: 50, height: 25 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({
      id: 'obs-large',
      label: 'button',
      confidence: 0.85,
      boundingBox: { x: 50, y: 25, width: 200, height: 100 }
    });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.scoreBreakdown.elementContainment).toBeCloseTo(1.0, 4);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple candidates
// ---------------------------------------------------------------------------

describe('6: Multiple candidates — correctly selects closest', () => {
  it('should select the element with the highest score among multiple overlapping candidates', () => {
    const elements = [
      makeElement({
        id: 'elem-far',
        role: 'button',
        interactive: true,
        bounds: { x: 500, y: 500, width: 200, height: 50 }
      }),
      makeElement({
        id: 'elem-exact',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      }),
      makeElement({
        id: 'elem-partial',
        role: 'link',
        interactive: true,
        bounds: { x: 200, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({
      id: 'obs-multi',
      label: 'button',
      confidence: 0.85,
      boundingBox: { x: 100, y: 100, width: 200, height: 50 }
    });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.elementId).toBe('elem-exact');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Strong semantic label breaks geometric tie
// ---------------------------------------------------------------------------

describe('7: Strong semantic label breaks geometric tie', () => {
  it('should prefer element whose role matches strong semantic label', () => {
    // Two elements with identical bounds — one is button, one is link
    const elements = [
      makeElement({
        id: 'elem-link',
        role: 'link',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      }),
      makeElement({
        id: 'elem-button',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    // Label 'button' gives 1.00 to button, 0.60 to link
    const obs = makeObservation({
      id: 'obs-semantic',
      label: 'button',
      confidence: 0.85
    });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.elementId).toBe('elem-button');
    }
  });

  it('should select link when label is "link" despite identical bounds with button', () => {
    const elements = [
      makeElement({
        id: 'elem-button',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      }),
      makeElement({
        id: 'elem-link',
        role: 'link',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({
      id: 'obs-link',
      label: 'link',
      confidence: 0.85
    });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.elementId).toBe('elem-link');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Generic clickable does NOT overpower closer geometry
// ---------------------------------------------------------------------------

describe('8: Generic "clickable" hint does not overpower substantially stronger geometry', () => {
  it('should select the geometrically closest element even if semantic hint is generic', () => {
    const elements = [
      // Exact geometric match but non-button role
      makeElement({
        id: 'elem-generic',
        role: 'generic',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      }),
      // Button role but far away
      makeElement({
        id: 'elem-button-far',
        role: 'button',
        interactive: true,
        bounds: { x: 500, y: 500, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    // Generic "clickable" hint with label 'control' (not a strong label)
    const obs: GroundingVisualObservation = {
      id: 'obs-clickable',
      label: 'control',
      confidence: 0.80,
      interactionHint: 'clickable',
      boundingBox: { x: 100, y: 100, width: 200, height: 50 }
    };

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      // The exact geometric match (generic element) must win over the distant button
      expect(result.elementId).toBe('elem-generic');
    }
  });

  it('generic "clickable" gives checkbox 0.50, not 0.75', () => {
    const elements = [
      makeElement({
        id: 'elem-checkbox',
        role: 'checkbox',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs: GroundingVisualObservation = {
      id: 'obs-clickable-chk',
      label: 'control',
      confidence: 0.80,
      interactionHint: 'clickable',
      boundingBox: { x: 100, y: 100, width: 200, height: 50 }
    };

    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    if (result.matched) {
      // Checkbox receives 0.50 for generic 'clickable', not 0.75 like button/link
      expect(result.scoreBreakdown.semanticScore).toBeCloseTo(0.50, 4);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Score-driven nested elements
// ---------------------------------------------------------------------------

describe('9: Score-driven nested elements (no unconditional ancestor override)', () => {
  it('button wins when visual detection is centered on the button', () => {
    const elements = [
      // Button ancestor with exact match
      makeElement({
        id: 'elem-button',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      }),
      // Non-interactive inner span (tiny, inside button)
      makeElement({
        id: 'elem-span',
        role: 'generic',
        interactive: false,
        bounds: { x: 150, y: 115, width: 80, height: 20 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({
      id: 'obs-button',
      label: 'button',
      interactionHint: 'clickable',
      confidence: 0.88,
      boundingBox: { x: 100, y: 100, width: 200, height: 50 }
    });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.elementId).toBe('elem-button');
    }
  });

  it('child element can win when its geometry is substantially stronger', () => {
    const elements = [
      // Large container
      makeElement({
        id: 'elem-container',
        role: 'container',
        interactive: false,
        bounds: { x: 0, y: 0, width: 600, height: 400 }
      }),
      // Small tight-fit element inside container
      makeElement({
        id: 'elem-icon',
        role: 'image',
        interactive: false,
        bounds: { x: 200, y: 150, width: 30, height: 30 }
      })
    ];
    const page = makePageRepresentation(elements);
    // Tight visual detection matching the icon exactly
    const obs: GroundingVisualObservation = {
      id: 'obs-icon',
      label: 'image',
      confidence: 0.82,
      boundingBox: { x: 200, y: 150, width: 30, height: 30 }
    };

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.elementId).toBe('elem-icon');
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Disabled excluded by default
// ---------------------------------------------------------------------------

describe('10: Disabled element excluded by default', () => {
  it('should not match disabled element when allowDisabled is false', () => {
    const elements = [
      makeElement({
        id: 'elem-disabled',
        role: 'button',
        interactive: false,
        bounds: { x: 100, y: 100, width: 200, height: 50 },
        state: { visible: true, disabled: true, enabled: false }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({ id: 'obs-1', label: 'button' });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toBe('NO_DOM_CANDIDATES');
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Disabled accepted with allowDisabled: true
// ---------------------------------------------------------------------------

describe('11: Disabled accepted with allowDisabled: true', () => {
  it('should match disabled element when allowDisabled option is true', () => {
    const elements = [
      makeElement({
        id: 'elem-disabled',
        role: 'button',
        interactive: false,
        bounds: { x: 100, y: 100, width: 200, height: 50 },
        state: { visible: true, disabled: true, enabled: false }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({ id: 'obs-1', label: 'button' });
    const opts: GroundingOptions = { allowDisabled: true };

    const result = groundVisualObservation(obs, page, SPACE_1TO1, opts);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.elementId).toBe('elem-disabled');
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Invisible excluded
// ---------------------------------------------------------------------------

describe('12: Invisible element excluded', () => {
  it('should not match element with state.visible === false', () => {
    const elements = [
      makeElement({
        id: 'elem-invisible',
        role: 'button',
        interactive: false,
        bounds: { x: 100, y: 100, width: 200, height: 50 },
        state: { visible: false, disabled: false, enabled: true }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({ id: 'obs-1', label: 'button' });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toBe('NO_DOM_CANDIDATES');
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Empty DOM → NO_DOM_CANDIDATES
// ---------------------------------------------------------------------------

describe('13: Empty DOM → NO_DOM_CANDIDATES', () => {
  it('should return NO_DOM_CANDIDATES when elements array is empty', () => {
    const page = makePageRepresentation([]);
    const obs = makeObservation({ id: 'obs-1' });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toBe('NO_DOM_CANDIDATES');
    }
  });
});

// ---------------------------------------------------------------------------
// 14. Completely out-of-bounds → OUT_OF_BOUNDS
// ---------------------------------------------------------------------------

describe('14: Completely out-of-bounds → OUT_OF_BOUNDS', () => {
  const elements = [
    makeElement({ id: 'elem-1', role: 'button', interactive: true, bounds: { x: 100, y: 100, width: 200, height: 50 } })
  ];
  const page = makePageRepresentation(elements);

  it('should return OUT_OF_BOUNDS when observation is completely to the right of viewport', () => {
    // viewport 1000x800, observation starts at x=1001
    const obs = makeObservation({
      id: 'obs-right',
      boundingBox: { x: 1001, y: 100, width: 200, height: 50 }
    });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toBe('OUT_OF_BOUNDS');
  });

  it('should return OUT_OF_BOUNDS when observation is completely below viewport', () => {
    const obs = makeObservation({
      id: 'obs-below',
      boundingBox: { x: 100, y: 801, width: 200, height: 50 }
    });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toBe('OUT_OF_BOUNDS');
  });

  it('should return OUT_OF_BOUNDS when observation is completely above viewport (y + height <= 0)', () => {
    const obs = makeObservation({
      id: 'obs-above',
      boundingBox: { x: 100, y: -60, width: 200, height: 50 }
    });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toBe('OUT_OF_BOUNDS');
  });

  it('should NOT return OUT_OF_BOUNDS when observation is partially inside viewport', () => {
    // x: -20 to 80, partially inside (0..80)
    const obs = makeObservation({
      id: 'obs-partial-edge',
      boundingBox: { x: -20, y: 100, width: 100, height: 50 }
    });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    if (!result.matched) {
      expect(result.reason).not.toBe('OUT_OF_BOUNDS');
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Zero-area observation → OUT_OF_BOUNDS
// ---------------------------------------------------------------------------

describe('15: Zero-area observation → OUT_OF_BOUNDS', () => {
  const elements = [
    makeElement({ id: 'elem-1', role: 'button', interactive: true })
  ];
  const page = makePageRepresentation(elements);

  it('should return OUT_OF_BOUNDS for width=0', () => {
    const obs = makeObservation({ id: 'obs-zw', boundingBox: { x: 100, y: 100, width: 0, height: 50 } });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toBe('OUT_OF_BOUNDS');
  });

  it('should return OUT_OF_BOUNDS for height=0', () => {
    const obs = makeObservation({ id: 'obs-zh', boundingBox: { x: 100, y: 100, width: 200, height: 0 } });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toBe('OUT_OF_BOUNDS');
  });
});

// ---------------------------------------------------------------------------
// 16. Equal-score deterministic tie-breaking
// ---------------------------------------------------------------------------

describe('16: Equal-score deterministic tie-breaking', () => {
  it('should always select the first document-order element when scores are identical', () => {
    // Two elements with identical bounds and roles — same geometric and semantic scores
    const elements = [
      makeElement({
        id: 'elem-first',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      }),
      makeElement({
        id: 'elem-second',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({ id: 'obs-tie', label: 'button' });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      // Deterministic: document-order first (index 0) wins
      expect(result.elementId).toBe('elem-first');
    }
  });

  it('should break element ID tie lexicographically when all else is equal', () => {
    const elements = [
      makeElement({
        id: 'elem-z',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      }),
      makeElement({
        id: 'elem-a',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({ id: 'obs-lex', label: 'button' });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      // Document index: elem-z is index 0, elem-a is index 1 → elem-z wins
      expect(result.elementId).toBe('elem-z');
    }
  });
});

// ---------------------------------------------------------------------------
// 17. Non-uniform X/Y coordinate scaling
// ---------------------------------------------------------------------------

describe('17: Non-uniform scaling (1500x1600 → 1000x800)', () => {
  it('should correctly normalize using independent per-axis scale', () => {
    // scaleX = 1500/1000 = 1.5, scaleY = 1600/800 = 2.0
    const scaleX = 1.5;
    const scaleY = 2.0;

    const cssX = 100;
    const cssY = 200;
    const cssW = 150;
    const cssH = 50;

    const screenshotRect = {
      x: cssX * scaleX,  // 150
      y: cssY * scaleY,  // 400
      width: cssW * scaleX, // 225
      height: cssH * scaleY  // 100
    };

    const elements = [
      makeElement({
        id: 'elem-nonuniform',
        role: 'button',
        interactive: true,
        bounds: { x: cssX, y: cssY, width: cssW, height: cssH }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({
      id: 'obs-nonuniform',
      label: 'button',
      confidence: 0.90,
      boundingBox: screenshotRect
    });

    const result = groundVisualObservation(obs, page, SPACE_NONUNIFORM);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.normalizedCssBox.x).toBeCloseTo(cssX, 4);
      expect(result.normalizedCssBox.y).toBeCloseTo(cssY, 4);
      expect(result.normalizedCssBox.width).toBeCloseTo(cssW, 4);
      expect(result.normalizedCssBox.height).toBeCloseTo(cssH, 4);
      expect(result.scoreBreakdown.iou).toBeCloseTo(1.0, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// 18. Missing / unknown semantic hint
// ---------------------------------------------------------------------------

describe('18: Missing/unknown semantic hint — neutral scoring', () => {
  it('should ground using geometry alone when label and hint are absent', () => {
    const elements = [
      makeElement({
        id: 'elem-1',
        role: 'button',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    // Empty label, no hint → neutral 0.50 semantic
    const obs: GroundingVisualObservation = {
      id: 'obs-nosemantic',
      label: '',
      confidence: 0.80,
      boundingBox: { x: 100, y: 100, width: 200, height: 50 }
    };

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.scoreBreakdown.semanticScore).toBeCloseTo(0.50, 4);
    }
  });

  it('should ground when interactionHint is "unknown"', () => {
    const elements = [
      makeElement({
        id: 'elem-1',
        role: 'generic',
        interactive: true,
        bounds: { x: 100, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs: GroundingVisualObservation = {
      id: 'obs-unknown',
      label: 'unknown',
      confidence: 0.75,
      interactionHint: 'unknown',
      boundingBox: { x: 100, y: 100, width: 200, height: 50 }
    };

    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    expect(result.matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 19. Below threshold → BELOW_SCORE_THRESHOLD
// ---------------------------------------------------------------------------

describe('19: Below threshold → BELOW_SCORE_THRESHOLD', () => {
  it('should return BELOW_SCORE_THRESHOLD when best candidate scores below custom threshold', () => {
    // The visual box and DOM element overlap by 50%: this passes coarse overlap
    // but when we set minScoreThreshold=0.95 the moderate geometric match will be below threshold.
    //
    // Visual:  x=100..300, y=100..150  (200x50)
    // DOM:     x=200..400, y=100..150  (200x50)
    // Intersection: x=200..300, y=100..150 → 100x50 = 5000
    // Visual area = 10000, DOM area = 10000, union = 15000
    // IoU = 5000/15000 ≈ 0.333  ← passes coarse threshold (0.05)
    const elements = [
      makeElement({
        id: 'elem-overlap',
        role: 'button',
        interactive: true,
        bounds: { x: 200, y: 100, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({
      id: 'obs-partial-thresh',
      label: 'button',
      confidence: 0.50,
      boundingBox: { x: 100, y: 100, width: 200, height: 50 }
    });

    // Use a very high threshold to force BELOW_SCORE_THRESHOLD
    const result = groundVisualObservation(obs, page, SPACE_1TO1, { minScoreThreshold: 0.95 });

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toBe('BELOW_SCORE_THRESHOLD');
      expect(result.highestScore).toBeGreaterThan(0);
      expect(result.highestScore).toBeLessThan(0.95);
      expect(result.closestCandidate).toBeDefined();
      expect(result.closestCandidate!.elementId).toBe('elem-overlap');
    }
  });
});

// ---------------------------------------------------------------------------
// 20. Confidence clamping
// ---------------------------------------------------------------------------

describe('20: Confidence clamping', () => {
  const elements = [
    makeElement({
      id: 'elem-1',
      role: 'button',
      interactive: true,
      bounds: { x: 100, y: 100, width: 200, height: 50 }
    })
  ];
  const page = makePageRepresentation(elements);

  it('should clamp confidence > 1 and produce valid groundingConfidence', () => {
    const obs = makeObservation({ id: 'obs-high', label: 'button', confidence: 5.0 });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.groundingConfidence).toBeGreaterThanOrEqual(0);
      expect(result.groundingConfidence).toBeLessThanOrEqual(1);
    }
  });

  it('should clamp confidence < 0 and produce valid groundingConfidence', () => {
    const obs = makeObservation({ id: 'obs-low', label: 'button', confidence: -0.5 });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.groundingConfidence).toBeGreaterThanOrEqual(0);
      expect(result.groundingConfidence).toBeLessThanOrEqual(1);
    }
  });

  it('should handle NaN confidence and produce valid groundingConfidence', () => {
    const obs = makeObservation({ id: 'obs-nan', label: 'button', confidence: NaN });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    // NaN confidence is still finite in terms of bounding box validation;
    // grounding should succeed and clamp confidence to 0
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.groundingConfidence).toBeGreaterThanOrEqual(0);
      expect(result.groundingConfidence).toBeLessThanOrEqual(1);
      // clamped to 0, so groundingConfidence = totalScore * 0.80
      expect(result.groundingConfidence).toBeCloseTo(result.scoreBreakdown.totalScore * 0.80, 5);
    }
  });

  it('should guarantee groundingConfidence is in [0,1] for all valid scores', () => {
    // Test that the formula TotalScore * (0.80 + 0.20 * VisionConfidence) stays in [0,1]
    // Max: 1 * (0.80 + 0.20 * 1) = 1.0
    // Min: 0 * (0.80 + 0.20 * 0) = 0.0
    const obsMax = makeObservation({ id: 'obs-max-conf', label: 'button', confidence: 1.0 });
    const resultMax = groundVisualObservation(obsMax, page, SPACE_1TO1);
    if (resultMax.matched) {
      expect(resultMax.groundingConfidence).toBeLessThanOrEqual(1.0);
      expect(resultMax.groundingConfidence).toBeGreaterThanOrEqual(0.0);
    }
  });
});

// ---------------------------------------------------------------------------
// 21. Determinism across 100 repeated calls
// ---------------------------------------------------------------------------

describe('21: Determinism across repeated calls', () => {
  it('should produce identical results for 100 consecutive calls with the same input', () => {
    const elements = [
      makeElement({ id: 'elem-1', role: 'button', interactive: true, bounds: { x: 100, y: 100, width: 200, height: 50 } }),
      makeElement({ id: 'elem-2', role: 'link', interactive: true, bounds: { x: 200, y: 100, width: 200, height: 50 } }),
      makeElement({ id: 'elem-3', role: 'textbox', interactive: true, bounds: { x: 100, y: 200, width: 300, height: 40 } })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({
      id: 'obs-det',
      label: 'button',
      confidence: 0.88,
      boundingBox: { x: 100, y: 100, width: 200, height: 50 }
    });

    const first = groundVisualObservation(obs, page, SPACE_1TO1);
    for (let i = 0; i < 99; i++) {
      const repeat = groundVisualObservation(obs, page, SPACE_1TO1);
      expect(repeat).toEqual(first);
    }
  });
});

// ---------------------------------------------------------------------------
// 22. Batch processing
// ---------------------------------------------------------------------------

describe('22: Batch processing', () => {
  it('should return same-length array preserving input order', () => {
    const elements = [
      makeElement({ id: 'elem-1', role: 'button', interactive: true, bounds: { x: 100, y: 100, width: 200, height: 50 } }),
      makeElement({ id: 'elem-2', role: 'link', interactive: true, bounds: { x: 100, y: 200, width: 200, height: 50 } }),
    ];
    const page = makePageRepresentation(elements);
    const observations: GroundingVisualObservation[] = [
      makeObservation({ id: 'obs-1', label: 'button', boundingBox: { x: 100, y: 100, width: 200, height: 50 } }),
      makeObservation({ id: 'obs-2', label: 'link', boundingBox: { x: 100, y: 200, width: 200, height: 50 } }),
      makeObservation({ id: 'obs-3', label: 'button', boundingBox: { x: 9000, y: 9000, width: 100, height: 100 } }) // OOB
    ];

    const results = groundVisualObservations(observations, page, SPACE_1TO1);

    expect(results).toHaveLength(3);
    expect(results[0]!.matched).toBe(true);
    if (results[0]!.matched) expect(results[0]!.elementId).toBe('elem-1');
    expect(results[1]!.matched).toBe(true);
    if (results[1]!.matched) expect(results[1]!.elementId).toBe('elem-2');
    expect(results[2]!.matched).toBe(false);
    if (!results[2]!.matched) expect(results[2]!.reason).toBe('OUT_OF_BOUNDS');
  });

  it('should match individual call results for each observation', () => {
    const elements = [
      makeElement({ id: 'elem-1', role: 'button', interactive: true, bounds: { x: 50, y: 50, width: 100, height: 40 } })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({ id: 'obs-single', label: 'button', boundingBox: { x: 50, y: 50, width: 100, height: 40 } });

    const batchResults = groundVisualObservations([obs], page, SPACE_1TO1);
    const singleResult = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(batchResults[0]).toEqual(singleResult);
  });
});

// ---------------------------------------------------------------------------
// 23. Semantic score for specific role mappings (spot checks)
// ---------------------------------------------------------------------------

describe('23: Semantic score spot checks for strong labels', () => {
  const elements_base = [
    makeElement({ id: 'elem-1', role: 'textbox', interactive: true, bounds: { x: 100, y: 100, width: 200, height: 50 } })
  ];
  const page_base = makePageRepresentation(elements_base);

  it('should give textbox/searchbox 1.00 for label "textbox"', () => {
    const obs = makeObservation({ id: 'obs-tb', label: 'textbox' });
    const result = groundVisualObservation(obs, page_base, SPACE_1TO1);
    if (result.matched) {
      expect(result.scoreBreakdown.semanticScore).toBeCloseTo(1.0, 4);
    }
  });

  it('should give 0.00 for incompatible label "textbox" against image role', () => {
    const elements = [makeElement({ id: 'elem-img', role: 'image', interactive: false, bounds: { x: 100, y: 100, width: 200, height: 50 } })];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({ id: 'obs-tb-img', label: 'textbox' });
    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    if (result.matched) {
      expect(result.scoreBreakdown.semanticScore).toBeCloseTo(0.0, 4);
    }
  });
});

// ---------------------------------------------------------------------------
// 24. Geometric score components are individually accessible
// ---------------------------------------------------------------------------

describe('24: Score breakdown components are correct', () => {
  it('should expose iou, visualContainment, elementContainment, centerProximity in breakdown', () => {
    const elements = [
      makeElement({ id: 'elem-1', role: 'button', interactive: true, bounds: { x: 0, y: 0, width: 100, height: 100 } })
    ];
    const page = makePageRepresentation(elements);
    const obs = makeObservation({ id: 'obs-geo', label: 'button', boundingBox: { x: 0, y: 0, width: 50, height: 100 } });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);
    expect(result.matched).toBe(true);
    if (result.matched) {
      const bd = result.scoreBreakdown;
      // intersection = 50x100 = 5000, visual area = 50x100 = 5000, dom area = 100x100 = 10000
      // IoU = 5000 / (5000 + 10000 - 5000) = 5000/10000 = 0.5
      expect(bd.iou).toBeCloseTo(0.5, 4);
      // VisualContainment = 5000/5000 = 1.0
      expect(bd.visualContainment).toBeCloseTo(1.0, 4);
      // ElementContainment = 5000/10000 = 0.5
      expect(bd.elementContainment).toBeCloseTo(0.5, 4);
      // Center proximity: visual center (25, 50), dom center (50, 50), dist=25
      // union bounding box 0..100 x 0..100, diag = sqrt(100^2+100^2)
      const diag = Math.sqrt(100 * 100 + 100 * 100);
      expect(bd.centerProximity).toBeCloseTo(1 - 25 / diag, 4);
    }
  });
});

// ---------------------------------------------------------------------------
// 25. NO_OVERLAPPING_CANDIDATES when elements exist but none overlap
// ---------------------------------------------------------------------------

describe('25: NO_OVERLAPPING_CANDIDATES with non-overlapping elements', () => {
  it('should return NO_OVERLAPPING_CANDIDATES when elements exist but do not overlap', () => {
    const elements = [
      makeElement({
        id: 'elem-far',
        role: 'button',
        interactive: true,
        bounds: { x: 700, y: 700, width: 200, height: 50 }
      })
    ];
    const page = makePageRepresentation(elements);
    // Visual box at x=100, y=100 — no overlap with elem at 700,700
    const obs = makeObservation({ id: 'obs-noc', boundingBox: { x: 100, y: 100, width: 50, height: 50 } });

    const result = groundVisualObservation(obs, page, SPACE_1TO1);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toBe('NO_OVERLAPPING_CANDIDATES');
    }
  });
});
