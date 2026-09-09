/**
 * Phase 3B — Browser Action Executor: Comprehensive Test Suite.
 *
 * Covers:
 * 1. valid click
 * 2. valid type
 * 3. valid focus
 * 4. target not found
 * 5. stale target
 * 6. disabled target
 * 7. non-interactive target
 * 8. invalid action
 * 9. malformed target
 * 10. malformed type payload
 * 11. clearFirst behavior
 * 12. pressEnter behavior
 * 13. focus behavior
 * 14. click execution failure propagation
 * 15. DOM execution failure propagation
 * 16. typed text is not exposed in result
 * 17. typed text is not logged
 * 18. password/input values are not exposed
 * 19. no network request is made
 * 20. arbitrary element ID is rejected
 * 21. executor does not silently choose another element
 * 22. deterministic success result
 * 23. deterministic failure result
 * 24. current-page target resolution
 * 25. wrong/missing tab handling
 * 26. End-to-end integration test (IntendedAction -> executor -> content script router -> domExecutor -> ExecutionResult)
 *
 * PRE-COMMIT CORRECTION REGRESSIONS:
 * - CRITICAL ISSUE 1: Target identity safety across DOM mutations (6 regression scenarios).
 * - CRITICAL ISSUE 2: Single click activation (click handler invoked exactly once, never duplicated).
 * - ISSUE 3: Strengthened type execution tests (input, textarea, contenteditable, readonly, disabled, unsupported types).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeDomAction } from '../content/domExecutor.js';
import { executeAction, DEFAULT_EXECUTION_TIMEOUT_MS } from './executor.js';
import { router as contentScriptRouter } from '../content/content-script.js';
import {
  extractPageRepresentationFromDom,
  clearPerceptionElementRegistry,
  registerPerceptionElement
} from '../content/domPerception.js';
import { MessageType, type ExecutionResult, type ExecuteActionRequest } from '../shared/types.js';
import { createIntendedAction, type ActionTarget, type ClickAction, type TypeAction, type FocusAction } from '../shared/actions.js';

// ---------------------------------------------------------------------------
// Helpers and Fixtures
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<ActionTarget> = {}): ActionTarget {
  return {
    elementId: 'elem-1',
    point: { x: 50, y: 25 },
    viewportBounds: { x: 0, y: 0, width: 100, height: 50 },
    confidence: 0.95,
    observationId: 'obs-test-1',
    role: 'button',
    ...overrides
  };
}

function makeClickAction(target: ActionTarget, id = 'action-click-1'): ClickAction {
  const res = createIntendedAction({ id, type: 'click', target });
  if (!res.success) throw new Error(res.message);
  return res.action as ClickAction;
}

function makeTypeAction(
  target: ActionTarget,
  text: string,
  options?: { clearFirst?: boolean; pressEnter?: boolean },
  id = 'action-type-1'
): TypeAction {
  const res = createIntendedAction({
    id,
    type: 'type',
    target,
    payload: { text, ...options }
  });
  if (!res.success) throw new Error(res.message);
  return res.action as TypeAction;
}

function makeFocusAction(target: ActionTarget, id = 'action-focus-1'): FocusAction {
  const res = createIntendedAction({ id, type: 'focus', target });
  if (!res.success) throw new Error(res.message);
  return res.action as FocusAction;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Phase 3B — DOM Action Executor (executeDomAction)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    clearPerceptionElementRegistry();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    clearPerceptionElementRegistry();
    vi.restoreAllMocks();
  });

  it('1. valid click dispatches pointer/mouse event sequence and activates element', () => {
    const button = document.createElement('button');
    button.textContent = 'Submit';
    let clickFired = false;
    const eventLog: string[] = [];

    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((evt) => {
      button.addEventListener(evt, () => eventLog.push(evt));
    });
    button.addEventListener('click', () => {
      clickFired = true;
    });
    document.body.appendChild(button);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'button' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.actionType).toBe('click');
      expect(result.elementId).toBe('elem-1');
      expect(result.actionId).toBe(action.id);
      expect(typeof result.timestamp).toBe('number');
    }
    expect(clickFired).toBe(true);
    expect(eventLog).toContain('mousedown');
    expect(eventLog).toContain('mouseup');
    expect(eventLog).toContain('click');
  });

  it('2. valid type enters text and dispatches input and change events', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const inputEvents: string[] = [];
    input.addEventListener('input', () => inputEvents.push('input'));
    input.addEventListener('change', () => inputEvents.push('change'));
    document.body.appendChild(input);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
    const action = makeTypeAction(target, 'hello world');

    const result = executeDomAction(action);

    expect(result.success).toBe(true);
    expect(input.value).toBe('hello world');
    expect(inputEvents).toEqual(['input', 'change']);
  });

  it('3. valid focus focuses target element and updates activeElement', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
    const action = makeFocusAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('4. target not found returns structured TARGET_NOT_FOUND failure', () => {
    // Empty document
    const target = makeTarget({ elementId: 'elem-999', role: 'button' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('TARGET_NOT_FOUND');
      expect(result.elementId).toBe('elem-999');
      expect(result.message).toContain('not found');
    }
  });

  it('5. stale target with role mismatch returns TARGET_ROLE_MISMATCH', () => {
    const button = document.createElement('button');
    button.textContent = 'Action Button';
    document.body.appendChild(button);
    extractPageRepresentationFromDom();

    // Stale: role changed after perception
    button.setAttribute('role', 'heading');

    const target = makeTarget({ elementId: 'elem-1', role: 'button' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('TARGET_ROLE_MISMATCH');
      expect(result.message).toContain('expected "button"');
    }
  });

  it('6. disabled target returns TARGET_DISABLED', () => {
    const button = document.createElement('button');
    button.disabled = true;
    button.textContent = 'Disabled Button';
    document.body.appendChild(button);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'button' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('TARGET_DISABLED');
      expect(result.message).toContain('disabled');
    }
  });

  it('7. non-interactive target cannot be clicked and returns TARGET_NOT_ACTIONABLE', () => {
    const p = document.createElement('p');
    p.textContent = 'Static paragraph text';
    document.body.appendChild(p);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'generic' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('TARGET_NOT_ACTIONABLE');
      expect(result.message).toContain('non-interactive');
    }
  });

  it('8. invalid action object returns INVALID_ACTION', () => {
    const result = executeDomAction(null as any);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('INVALID_ACTION');
    }
  });

  it('9. malformed target returns INVALID_TARGET', () => {
    const malformed = {
      id: 'act-1',
      type: 'click',
      target: {} // missing elementId
    } as any;

    const result = executeDomAction(malformed);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('INVALID_TARGET');
    }
  });

  it('10. malformed type payload returns INVALID_ACTION', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
    const malformed = {
      id: 'act-1',
      type: 'type',
      target,
      payload: { text: 12345 } // text must be string
    } as any;

    const result = executeDomAction(malformed);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('INVALID_ACTION');
    }
  });

  it('11. clearFirst: true clears existing text before typing', () => {
    const input = document.createElement('input');
    input.value = 'initial-value';
    document.body.appendChild(input);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
    const action = makeTypeAction(target, 'replacement', { clearFirst: true });

    const result = executeDomAction(action);

    expect(result.success).toBe(true);
    expect(input.value).toBe('replacement');
  });

  it('12. pressEnter: true dispatches Enter keyboard events', () => {
    const input = document.createElement('input');
    let enterCaught = false;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.keyCode === 13) {
        enterCaught = true;
      }
    });
    document.body.appendChild(input);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
    const action = makeTypeAction(target, 'search query', { pressEnter: true });

    const result = executeDomAction(action);

    expect(result.success).toBe(true);
    expect(enterCaught).toBe(true);
  });

  it('13. focus behavior ensures element receives focus method invocation', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
    const action = makeFocusAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it('14. click execution failure propagates as EXECUTION_ERROR', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    extractPageRepresentationFromDom();

    // Force click method to throw
    button.click = () => {
      throw new Error('Custom click event failure');
    };

    const target = makeTarget({ elementId: 'elem-1', role: 'button' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('EXECUTION_ERROR');
      expect(result.message).toContain('Custom click event failure');
    }
  });

  it('15. DOM execution failure propagation on unexpected dispatch error', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    extractPageRepresentationFromDom();

    // Force dispatchEvent to throw
    vi.spyOn(button, 'dispatchEvent').mockImplementation(() => {
      throw new Error('Synthetic DOM dispatch crash');
    });

    const target = makeTarget({ elementId: 'elem-1', role: 'button' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('EXECUTION_ERROR');
      expect(result.message).toContain('Synthetic DOM dispatch crash');
    }
  });

  it('16. typed text is strictly NEVER exposed in ExecutionResult', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    extractPageRepresentationFromDom();

    const SECRET_TEXT = 'CLASSIFIED_USER_PASS_987';
    const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
    const action = makeTypeAction(target, SECRET_TEXT);

    const result = executeDomAction(action);

    expect(result.success).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_TEXT);
  });

  it('17. typed text is strictly NEVER logged to console', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    extractPageRepresentationFromDom();

    const SECRET_TEXT = 'HIGHLY_CONFIDENTIAL_TOKEN_XYZ';
    const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
    const action = makeTypeAction(target, SECRET_TEXT);

    const logSpy = vi.spyOn(console, 'log');
    const infoSpy = vi.spyOn(console, 'info');
    const warnSpy = vi.spyOn(console, 'warn');
    const errorSpy = vi.spyOn(console, 'error');

    executeDomAction(action);

    const allConsoleArgs = [
      ...logSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls
    ].flat().map(String).join(' ');

    expect(allConsoleArgs).not.toContain(SECRET_TEXT);
  });

  it('18. password and input field values are not exposed in result', () => {
    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.value = 'EXISTING_SECRET_PIN';
    document.body.appendChild(passwordInput);
    extractPageRepresentationFromDom();

    const NEW_SECRET = 'NEW_PIN_4321';
    const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
    const action = makeTypeAction(target, NEW_SECRET);

    const result = executeDomAction(action);

    expect(result.success).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('EXISTING_SECRET_PIN');
    expect(serialized).not.toContain(NEW_SECRET);
  });

  it('19. no network request is made during action execution', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    extractPageRepresentationFromDom();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const target = makeTarget({ elementId: 'elem-1', role: 'button' });
    const action = makeClickAction(target);

    executeDomAction(action);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('20. arbitrary unknown element ID is rejected', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'arbitrary-hallucinated-id', role: 'button' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('TARGET_NOT_FOUND');
    }
  });

  it('21. executor does not silently choose another element when target does not match', () => {
    const btn1 = document.createElement('button');
    btn1.textContent = 'Btn 1';
    const btn2 = document.createElement('button');
    btn2.textContent = 'Btn 2';
    document.body.appendChild(btn1);
    document.body.appendChild(btn2);
    extractPageRepresentationFromDom();

    let btn1Clicked = false;
    let btn2Clicked = false;
    btn1.addEventListener('click', () => { btn1Clicked = true; });
    btn2.addEventListener('click', () => { btn2Clicked = true; });

    // Target elem-2 (Btn 2)
    const target = makeTarget({ elementId: 'elem-2', role: 'button' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(true);
    expect(btn1Clicked).toBe(false);
    expect(btn2Clicked).toBe(true);
  });

  it('22. deterministic success result contains exact required safe metadata', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    extractPageRepresentationFromDom();

    const target = makeTarget({ elementId: 'elem-1', role: 'button' });
    const action = makeClickAction(target, 'deterministic-click-id');

    const result = executeDomAction(action);

    expect(result).toEqual({
      success: true,
      actionType: 'click',
      elementId: 'elem-1',
      actionId: 'deterministic-click-id',
      timestamp: expect.any(Number)
    });
  });

  it('23. deterministic failure result contains exact required safe metadata', () => {
    const target = makeTarget({ elementId: 'elem-99', role: 'button' });
    const action = makeClickAction(target, 'fail-action-id');

    const result = executeDomAction(action);

    expect(result).toEqual({
      success: false,
      actionType: 'click',
      elementId: 'elem-99',
      actionId: 'fail-action-id',
      reason: 'TARGET_NOT_FOUND',
      message: expect.stringContaining('elem-99'),
      timestamp: expect.any(Number)
    });
  });

  it('24. current-page target resolution handles live DOM state correctly and rejects disconnected elements', () => {
    const detachedButton = document.createElement('button');
    detachedButton.id = 'detached-btn';
    // Not attached to document.body

    const target = makeTarget({ elementId: 'detached-btn', role: 'button' });
    const action = makeClickAction(target);

    const result = executeDomAction(action);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('TARGET_NOT_FOUND');
    }
  });

  // =========================================================================
  // CRITICAL ISSUE 1 REGRESSION TESTS — TARGET IDENTITY SAFETY
  // =========================================================================

  describe('Critical Issue 1: Target Identity Safety across DOM mutations', () => {
    it('R1-1. target remains same -> execute', () => {
      const searchBtn = document.createElement('button');
      searchBtn.textContent = 'Search';
      let clicked = false;
      searchBtn.addEventListener('click', () => { clicked = true; });
      document.body.appendChild(searchBtn);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'button' });
      const action = makeClickAction(target);

      const result = executeDomAction(action);

      expect(result.success).toBe(true);
      expect(clicked).toBe(true);
    });

    it('R1-2. target removed -> TARGET_NOT_FOUND', () => {
      const searchBtn = document.createElement('button');
      searchBtn.textContent = 'Search';
      document.body.appendChild(searchBtn);
      extractPageRepresentationFromDom();

      // Page mutation: target removed from DOM
      searchBtn.remove();

      const target = makeTarget({ elementId: 'elem-1', role: 'button' });
      const action = makeClickAction(target);

      const result = executeDomAction(action);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('TARGET_NOT_FOUND');
        expect(result.message).toContain('elem-1');
      }
    });

    it('R1-3. target shifted to a different role -> TARGET_ROLE_MISMATCH', () => {
      const btn = document.createElement('button');
      btn.textContent = 'Search';
      document.body.appendChild(btn);
      extractPageRepresentationFromDom();

      // Page mutation: role shifted to heading
      btn.setAttribute('role', 'heading');

      const target = makeTarget({ elementId: 'elem-1', role: 'button' });
      const action = makeClickAction(target);

      const result = executeDomAction(action);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('TARGET_ROLE_MISMATCH');
        expect(result.message).toContain('expected "button"');
      }
    });

    it('R1-4. target replaced by another element with the SAME role -> must NOT execute the replacement', () => {
      const searchBtn = document.createElement('button');
      searchBtn.textContent = 'Search';
      document.body.appendChild(searchBtn);
      extractPageRepresentationFromDom();

      // Page mutation: searchBtn replaced by a different button (Wishlist) with SAME role ('button')
      const wishlistBtn = document.createElement('button');
      wishlistBtn.textContent = 'Wishlist';
      let wishlistClicked = false;
      wishlistBtn.addEventListener('click', () => { wishlistClicked = true; });
      searchBtn.replaceWith(wishlistBtn);

      const target = makeTarget({ elementId: 'elem-1', role: 'button' });
      const action = makeClickAction(target);

      const result = executeDomAction(action);

      // Must fail closed; must NOT execute the replacement element
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('TARGET_NOT_FOUND');
      }
      expect(wishlistClicked).toBe(false);
    });

    it('R1-5. unrelated DOM insertion before target -> must not silently execute another element', () => {
      const bannerBtn = document.createElement('button');
      bannerBtn.textContent = 'Banner';
      let bannerClicked = false;
      bannerBtn.addEventListener('click', () => { bannerClicked = true; });

      const searchBtn = document.createElement('button');
      searchBtn.textContent = 'Search';
      let searchClicked = false;
      searchBtn.addEventListener('click', () => { searchClicked = true; });

      document.body.appendChild(bannerBtn);
      document.body.appendChild(searchBtn);
      extractPageRepresentationFromDom();

      // Target was elem-2 (searchBtn) at perception T0
      const target = makeTarget({ elementId: 'elem-2', role: 'button' });
      const action = makeClickAction(target);

      // Page mutation: an unrelated alert button is inserted at the top of the DOM before banner
      const alertBtn = document.createElement('button');
      alertBtn.textContent = 'Alert';
      let alertClicked = false;
      alertBtn.addEventListener('click', () => { alertClicked = true; });
      document.body.prepend(alertBtn);

      // Execute action
      const result = executeDomAction(action);

      // Must execute the original searchBtn, NEVER the newly shifted element at index 2 (bannerBtn)
      expect(result.success).toBe(true);
      expect(searchClicked).toBe(true);
      expect(bannerClicked).toBe(false);
      expect(alertClicked).toBe(false);
    });

    it('R1-6. duplicate/similar buttons -> must not select the wrong one and never fall back if target removed', () => {
      const btn1 = document.createElement('button');
      btn1.textContent = 'Submit';
      let btn1Clicks = 0;
      btn1.addEventListener('click', () => { btn1Clicks++; });

      const btn2 = document.createElement('button');
      btn2.textContent = 'Submit';
      let btn2Clicks = 0;
      btn2.addEventListener('click', () => { btn2Clicks++; });

      document.body.appendChild(btn1);
      document.body.appendChild(btn2);
      extractPageRepresentationFromDom();

      // Target elem-2 specifically
      const target = makeTarget({ elementId: 'elem-2', role: 'button' });
      const action = makeClickAction(target);

      const result = executeDomAction(action);

      expect(result.success).toBe(true);
      expect(btn2Clicks).toBe(1);
      expect(btn1Clicks).toBe(0);

      // Now remove btn2 from DOM: executor must NOT fall back to duplicate btn1
      btn2.remove();

      const secondResult = executeDomAction(action);

      expect(secondResult.success).toBe(false);
      if (!secondResult.success) {
        expect(secondResult.reason).toBe('TARGET_NOT_FOUND');
      }
      expect(btn1Clicks).toBe(0);
    });

    it('R1-7. perception snapshot lifecycle resets registry and rebinds elem-N to T1 without retaining T0 references', () => {
      // 1. Perceive snapshot T0 with two elements (btnT0A, btnT0B)
      const btnT0A = document.createElement('button');
      btnT0A.id = 'btn-t0a';
      btnT0A.textContent = 'Button T0A';
      let btnT0AClicks = 0;
      btnT0A.addEventListener('click', () => { btnT0AClicks++; });

      const btnT0B = document.createElement('button');
      btnT0B.id = 'btn-t0b';
      btnT0B.textContent = 'Button T0B';
      let btnT0BClicks = 0;
      btnT0B.addEventListener('click', () => { btnT0BClicks++; });

      document.body.appendChild(btnT0A);
      document.body.appendChild(btnT0B);

      const representationT0 = extractPageRepresentationFromDom();
      expect(representationT0.elements[0].id).toBe('elem-1');
      expect(representationT0.elements[1].id).toBe('elem-2');

      // 2. Mutate/replace the page with a single new element (btnT1)
      document.body.innerHTML = '';
      const btnT1 = document.createElement('button');
      btnT1.id = 'btn-t1';
      btnT1.textContent = 'Button T1';
      let btnT1Clicks = 0;
      btnT1.addEventListener('click', () => { btnT1Clicks++; });
      document.body.appendChild(btnT1);

      // 3. Perceive snapshot T1
      const representationT1 = extractPageRepresentationFromDom();
      expect(representationT1.elements.length).toBe(1);
      expect(representationT1.elements[0].id).toBe('elem-1');

      // 4. Verify elem-1 now resolves only to the T1 element
      const targetT1 = makeTarget({ elementId: 'elem-1', role: 'button' });
      const actionT1 = makeClickAction(targetT1);

      const result = executeDomAction(actionT1);

      expect(result.success).toBe(true);
      expect(btnT1Clicks).toBe(1);

      // 5. Verify old T0 elements cannot accidentally be executed through the new mapping
      expect(btnT0AClicks).toBe(0);
      expect(btnT0BClicks).toBe(0);

      // Stale higher-index element from T0 (elem-2) no longer exists in T1 -> must return TARGET_NOT_FOUND
      const targetOldElem2 = makeTarget({ elementId: 'elem-2', role: 'button' });
      const actionOldElem2 = makeClickAction(targetOldElem2);
      const staleResult = executeDomAction(actionOldElem2);
      expect(staleResult.success).toBe(false);
      if (!staleResult.success) {
        expect(staleResult.reason).toBe('TARGET_NOT_FOUND');
      }
    });
  });

  // =========================================================================
  // CRITICAL ISSUE 2 REGRESSION TESTS — SINGLE CLICK ACTIVATION
  // =========================================================================

  describe('Critical Issue 2: Click Event Duplication Prevention', () => {
    it('R2-1. ONE click IntendedAction causes EXACTLY ONE click handler activation', () => {
      const button = document.createElement('button');
      button.textContent = 'Activate';
      let clickCount = 0;
      button.addEventListener('click', () => {
        clickCount++;
      });
      document.body.appendChild(button);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'button' });
      const action = makeClickAction(target);

      const result = executeDomAction(action);

      expect(result.success).toBe(true);
      expect(clickCount).toBe(1);
    });

    it('R2-2. onclick attribute handler is activated exactly once', () => {
      const button = document.createElement('button');
      let onclickCount = 0;
      button.onclick = () => {
        onclickCount++;
      };
      document.body.appendChild(button);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'button' });
      const action = makeClickAction(target);

      const result = executeDomAction(action);

      expect(result.success).toBe(true);
      expect(onclickCount).toBe(1);
    });
  });

  // =========================================================================
  // ISSUE 3 REGRESSION TESTS — TYPE EXECUTION STRENGTHENED
  // =========================================================================

  describe('Issue 3: Strengthened Type Execution', () => {
    it('R3-1. types into <input type="text"> successfully', () => {
      const input = document.createElement('input');
      input.type = 'text';
      document.body.appendChild(input);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
      const action = makeTypeAction(target, 'test-input');

      const result = executeDomAction(action);

      expect(result.success).toBe(true);
      expect(input.value).toBe('test-input');
    });

    it('R3-2. types into <textarea> successfully', () => {
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
      const action = makeTypeAction(target, 'multiline\ntext');

      const result = executeDomAction(action);

      expect(result.success).toBe(true);
      expect(textarea.value).toBe('multiline\ntext');
    });

    it('R3-3. types into <div contenteditable="true"> successfully', () => {
      const div = document.createElement('div');
      div.setAttribute('contenteditable', 'true');
      div.setAttribute('role', 'textbox');
      document.body.appendChild(div);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
      const action = makeTypeAction(target, 'rich-content');

      const result = executeDomAction(action);

      expect(result.success).toBe(true);
      expect(div.textContent).toBe('rich-content');
    });

    it('R3-4. rejects readonly input with TARGET_NOT_ACTIONABLE', () => {
      const input = document.createElement('input');
      input.readOnly = true;
      document.body.appendChild(input);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
      const action = makeTypeAction(target, 'attempt');

      const result = executeDomAction(action);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('TARGET_NOT_ACTIONABLE');
        expect(result.message).toContain('read-only');
      }
    });

    it('R3-5. rejects disabled input with TARGET_DISABLED', () => {
      const input = document.createElement('input');
      input.disabled = true;
      document.body.appendChild(input);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
      const action = makeTypeAction(target, 'attempt');

      const result = executeDomAction(action);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('TARGET_DISABLED');
        expect(result.message).toContain('disabled');
      }
    });

    it('R3-6. rejects unsupported input types (checkbox, radio, button, file, range)', () => {
      const unsupportedTypes = ['checkbox', 'radio', 'button', 'file', 'range', 'color'];

      for (const type of unsupportedTypes) {
        document.body.innerHTML = '';
        clearPerceptionElementRegistry();

        const input = document.createElement('input');
        input.type = type;
        document.body.appendChild(input);
        extractPageRepresentationFromDom();

        const target = makeTarget({ elementId: 'elem-1', role: undefined });
        const action = makeTypeAction(target, 'test');

        const result = executeDomAction(action);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.reason).toBe('TARGET_NOT_ACTIONABLE');
          expect(result.message).toContain('not a text entry element');
        }
      }
    });

    it('R3-7. clearFirst: true replaces content while clearFirst: false appends content', () => {
      const input1 = document.createElement('input');
      input1.value = 'initial ';
      document.body.appendChild(input1);
      extractPageRepresentationFromDom();

      const target1 = makeTarget({ elementId: 'elem-1', role: 'textbox' });
      const appendAction = makeTypeAction(target1, 'appended', { clearFirst: false });
      executeDomAction(appendAction);
      expect(input1.value).toBe('initial appended');

      const clearAction = makeTypeAction(target1, 'replaced', { clearFirst: true });
      executeDomAction(clearAction);
      expect(input1.value).toBe('replaced');
    });

    it('R3-8. pressEnter: true dispatches Enter while pressEnter: false does not', () => {
      const input = document.createElement('input');
      let enterDispatched = false;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') enterDispatched = true;
      });
      document.body.appendChild(input);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });

      // pressEnter: false
      const actionNoEnter = makeTypeAction(target, 'first', { pressEnter: false });
      executeDomAction(actionNoEnter);
      expect(enterDispatched).toBe(false);

      // pressEnter: true
      const actionWithEnter = makeTypeAction(target, 'second', { pressEnter: true });
      executeDomAction(actionWithEnter);
      expect(enterDispatched).toBe(true);
    });

    it('R3-9. error messages strictly NEVER contain the typed text payload', () => {
      const button = document.createElement('button');
      document.body.appendChild(button);
      extractPageRepresentationFromDom();

      const SECRET = 'SUPER_SENSITIVE_KEY_ABC_123';
      const target = makeTarget({ elementId: 'elem-1', role: 'button' });
      const action = makeTypeAction(target, SECRET);

      const result = executeDomAction(action);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.message).not.toContain(SECRET);
        expect(JSON.stringify(result)).not.toContain(SECRET);
      }
    });

    it('R3-10. previous input values are never read and returned in ExecutionResult', () => {
      const input = document.createElement('input');
      input.value = 'EXISTING_SECRET_DATA';
      document.body.appendChild(input);
      extractPageRepresentationFromDom();

      const target = makeTarget({ elementId: 'elem-1', role: 'textbox' });
      const action = makeTypeAction(target, 'new-value');

      const result = executeDomAction(action);

      expect(result.success).toBe(true);
      expect(JSON.stringify(result)).not.toContain('EXISTING_SECRET_DATA');
    });
  });
});

// ---------------------------------------------------------------------------
// Background Executor & Tab Safety Tests
// ---------------------------------------------------------------------------

describe('Phase 3B — Background Executor (executeAction)', () => {
  const originalChrome = globalThis.chrome;

  afterEach(() => {
    globalThis.chrome = originalChrome;
    vi.restoreAllMocks();
  });

  it('25. wrong / missing tab handling returns TAB_NOT_FOUND', async () => {
    globalThis.chrome = {
      tabs: {
        get: vi.fn().mockRejectedValue(new Error('Tab not found')),
        query: vi.fn().mockResolvedValue([])
      }
    } as any;

    const target = makeTarget();
    const action = makeClickAction(target);
    const request: ExecuteActionRequest = { action, tabId: 99999 };

    const result = await executeAction(request);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('TAB_NOT_FOUND');
      expect(result.message).toContain('99999');
    }
  });

  it('25b. tab on restricted URL (chrome://settings) is rejected with EXECUTION_ERROR', async () => {
    globalThis.chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'chrome://settings',
          title: 'Settings'
        })
      }
    } as any;

    const target = makeTarget();
    const action = makeClickAction(target);
    const request: ExecuteActionRequest = { action, tabId: 42 };

    const result = await executeAction(request);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('EXECUTION_ERROR');
      expect(result.message).toContain('restricted');
    }
  });

  it('25c. tab on devtools URL is rejected with EXECUTION_ERROR', async () => {
    globalThis.chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 43,
          url: 'devtools://devtools/bundled/inspector.html'
        })
      }
    } as any;

    const target = makeTarget();
    const action = makeClickAction(target);
    const request: ExecuteActionRequest = { action, tabId: 43 };

    const result = await executeAction(request);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('EXECUTION_ERROR');
      expect(result.message).toContain('restricted');
    }
  });

  it('25d. execution timeout returns EXECUTION_ERROR', async () => {
    globalThis.chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 10,
          url: 'https://example.com'
        }),
        // Never resolves to simulate hang
        sendMessage: vi.fn().mockImplementation(() => new Promise(() => {}))
      }
    } as any;

    const target = makeTarget();
    const action = makeClickAction(target);
    const request: ExecuteActionRequest = { action, tabId: 10 };

    const result = await executeAction(request, { timeoutMs: 50 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('EXECUTION_ERROR');
      expect(result.message).toContain('timed out');
    }
  });

  it('26. Integration test: IntendedAction -> executeAction -> content script router -> domExecutor -> ExecutionResult', async () => {
    // Setup happy-dom document with a live clickable button
    document.body.innerHTML = '';
    clearPerceptionElementRegistry();

    const button = document.createElement('button');
    button.textContent = 'Integration Click Me';
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });
    document.body.appendChild(button);
    extractPageRepresentationFromDom();

    // Mock chrome.tabs.sendMessage to route into the real content script router!
    globalThis.chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 1,
          url: 'https://example.com/app'
        }),
        sendMessage: vi.fn().mockImplementation(async (tabId, message) => {
          // Send message directly to contentScriptRouter
          const sender = { id: 'test-extension-id', tab: { id: tabId } } as chrome.runtime.MessageSender;
          const response = await contentScriptRouter.route(message, sender);
          return response;
        })
      }
    } as any;

    const target = makeTarget({ elementId: 'elem-1', role: 'button' });
    const action = makeClickAction(target, 'integration-action-1');
    const request: ExecuteActionRequest = { action, tabId: 1 };

    // Execute via background executor
    const result = await executeAction(request);

    // Verify observable results
    expect(clicked).toBe(true);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.actionType).toBe('click');
      expect(result.elementId).toBe('elem-1');
      expect(result.actionId).toBe('integration-action-1');
    }
  });
});
