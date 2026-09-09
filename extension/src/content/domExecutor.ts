/**
 * Phase 3B — DOM Action Executor.
 *
 * Executes IntendedActions directly against the live DOM within a content script.
 * Resolves targets dynamically against the current page to prevent stale actions.
 *
 * Privacy Invariants:
 * - Never logs payload.text or input values.
 * - Never returns entered text, passwords, or input values in ExecutionResult.
 * - Never exposes existing field contents.
 *
 * Target Safety:
 * - Never blindly trusts stale coordinates or previous snapshots.
 * - Verifies current element existence, connection, visibility, disabled state, and role.
 * - Never silently falls back to arbitrary elements.
 */

import type {
  ExecutionFailureReason,
  ExecutionFailureResult,
  ExecutionResult,
  ExecutionSuccessResult
} from '../shared/types.js';
import type { IntendedAction, TypeActionPayload } from '../shared/actions.js';
import {
  getElementRole,
  isElementDisabled,
  isInteractive,
  isInert,
  resolveElementFromDom
} from './domPerception.js';

/** Tags that natively accept textual user input. */
const TEXT_INPUT_TAGS = new Set(['input', 'textarea']);

/** Input types that do NOT accept text entry. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'image',
  'file',
  'hidden',
  'range',
  'color'
]);

/**
 * Checks whether an element is contenteditable.
 */
function isContentEditableElement(element: Element): boolean {
  if ((element as HTMLElement).isContentEditable) {
    return true;
  }
  const attr = element.getAttribute('contenteditable');
  return attr === 'true' || attr === '' || attr === 'plaintext-only';
}

/**
 * Checks whether an element is suitable for text input.
 * Must match actual writable capability: native text input, textarea, or contenteditable.
 * A role="textbox"/"searchbox" element that is not actually editable must not pass.
 */
function isTextEntryElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();

  if (tagName === 'textarea') {
    return true;
  }

  if (tagName === 'input') {
    const inputType = ((element as HTMLInputElement).type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(inputType);
  }

  if (isContentEditableElement(element)) {
    return true;
  }

  return false;
}

/**
 * Checks whether an element is visibly rendered and actionable.
 */
function isElementActionable(element: Element): boolean {
  if (element.hasAttribute('hidden')) {
    return false;
  }

  if (isInert(element)) {
    return false;
  }

  if (element instanceof HTMLElement) {
    const inlineDisplay = element.style?.display;
    if (inlineDisplay === 'none') {
      return false;
    }
    const inlineVisibility = element.style?.visibility;
    if (inlineVisibility === 'hidden' || inlineVisibility === 'collapse') {
      return false;
    }
  }

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const style = window.getComputedStyle(element);
      if (style) {
        if (style.display === 'none') {
          return false;
        }
        if (style.visibility === 'hidden' || style.visibility === 'collapse') {
          return false;
        }
      }
    } catch {
      // Mock environment fallback
    }
  }

  return true;
}

/**
 * Checks whether an element can be clicked.
 */
function isClickableElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  const role = getElementRole(element);

  // Native interactive tags are always clickable candidates
  if (
    tagName === 'button' ||
    tagName === 'summary' ||
    (tagName === 'a' && element.hasAttribute('href')) ||
    tagName === 'input' ||
    tagName === 'select' ||
    tagName === 'option'
  ) {
    return true;
  }

  // Interactive roles
  const clickableRoles = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'option'
  ]);
  if (clickableRoles.has(role)) {
    return true;
  }

  // Focusable elements with non-negative tabindex
  if (element.hasAttribute('tabindex')) {
    const tabIndex = Number.parseInt(element.getAttribute('tabindex') || '', 10);
    if (Number.isFinite(tabIndex) && tabIndex >= 0) {
      return true;
    }
  }

  // Explicit onclick handler
  if (
    element.hasAttribute('onclick') ||
    Boolean((element as unknown as Record<string, unknown>).onclick)
  ) {
    return true;
  }

  // General perception interactivity check
  return isInteractive(element, role);
}

/**
 * Checks whether an element is focusable.
 */
function isFocusableElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();

  if (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    tagName === 'button' ||
    (tagName === 'a' && element.hasAttribute('href')) ||
    tagName === 'summary'
  ) {
    return true;
  }

  if (
    (element as HTMLElement).isContentEditable ||
    element.getAttribute('contenteditable') === 'true'
  ) {
    return true;
  }

  if (element.hasAttribute('tabindex')) {
    const tabIndex = Number.parseInt(element.getAttribute('tabindex') || '', 10);
    return Number.isFinite(tabIndex);
  }

  return false;
}

/**
 * Helper to construct a structured failure result.
 */
function makeFailureResult(
  reason: ExecutionFailureReason,
  message: string,
  action?: Partial<IntendedAction>
): ExecutionFailureResult {
  return {
    success: false,
    ...(action?.type ? { actionType: action.type } : {}),
    ...(action?.target?.elementId ? { elementId: action.target.elementId } : {}),
    ...(action?.id ? { actionId: action.id } : {}),
    reason,
    message,
    timestamp: Date.now()
  };
}

/**
 * Executes a single IntendedAction against the current live DOM.
 *
 * @param action  The IntendedAction to execute.
 * @param doc     The Document instance (defaults to global document).
 */
export function executeDomAction(
  action: IntendedAction,
  doc: Document = document
): ExecutionResult {
  try {
    if (!action || typeof action !== 'object') {
      return makeFailureResult('INVALID_ACTION', 'Action must be a valid object');
    }

    const { type, target, id: actionId } = action;

    if (!target || typeof target !== 'object' || !target.elementId) {
      return makeFailureResult('INVALID_TARGET', 'Action target elementId is missing or invalid', action);
    }

    // 1. Current-page target resolution
    const element = resolveElementFromDom(target.elementId, doc);
    if (!element) {
      return makeFailureResult(
        'TARGET_NOT_FOUND',
        `Target element "${target.elementId}" not found in current DOM`,
        action
      );
    }

    // 2. DOM Connection check
    if (!element.isConnected) {
      return makeFailureResult(
        'TARGET_NOT_FOUND',
        `Target element "${target.elementId}" is disconnected from DOM`,
        action
      );
    }

    // 3. Visibility and inert check
    if (!isElementActionable(element)) {
      return makeFailureResult(
        'TARGET_NOT_ACTIONABLE',
        `Target element "${target.elementId}" is not visible or is inert`,
        action
      );
    }

    // 4. Disabled check
    if (isElementDisabled(element)) {
      return makeFailureResult(
        'TARGET_DISABLED',
        `Target element "${target.elementId}" is disabled`,
        action
      );
    }

    // 5. Target Role verification (detect stale targets from earlier perception)
    if (target.role && target.role !== 'unknown' && target.role !== 'generic') {
      const currentRole = getElementRole(element);
      const isCompatibleTextbox =
        (target.role === 'textbox' && currentRole === 'searchbox') ||
        (target.role === 'searchbox' && currentRole === 'textbox');

      if (currentRole !== target.role && !isCompatibleTextbox) {
        return makeFailureResult(
          'TARGET_ROLE_MISMATCH',
          `Target role mismatch: expected "${target.role}", found "${currentRole}"`,
          action
        );
      }
    }

    // 6. Action-specific verification and execution
    switch (type) {
      case 'click': {
        if (!isClickableElement(element)) {
          return makeFailureResult(
            'TARGET_NOT_ACTIONABLE',
            `Target element "${target.elementId}" is non-interactive and cannot be clicked`,
            action
          );
        }

        // Scroll into view if available
        if (typeof (element as HTMLElement).scrollIntoView === 'function') {
          try {
            (element as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
          } catch {
            // Non-critical in test / mock environments
          }
        }

        // Dispatch pointer and mouse event sequence
        const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
        const eventInit: MouseEventInit = {
          bubbles: true,
          cancelable: true,
          view: win
        };

        try {
          element.dispatchEvent(new MouseEvent('pointerdown', eventInit));
        } catch {
          // Pointer events may not be registered in all environments
        }
        element.dispatchEvent(new MouseEvent('mousedown', eventInit));
        try {
          element.dispatchEvent(new MouseEvent('pointerup', eventInit));
        } catch {
          // Fallback
        }
        element.dispatchEvent(new MouseEvent('mouseup', eventInit));

        // Exactly ONE logical click activation:
        // Prefer native .click() which performs full activation (events + default actions).
        // Fall back to dispatching a synthetic click event if .click is not a function.
        // Never dispatch both, which would cause duplicate click handler invocations.
        if (typeof (element as HTMLElement).click === 'function') {
          (element as HTMLElement).click();
        } else {
          element.dispatchEvent(new MouseEvent('click', eventInit));
        }

        const successResult: ExecutionSuccessResult = {
          success: true,
          actionType: 'click',
          elementId: target.elementId,
          actionId,
          timestamp: Date.now()
        };
        return successResult;
      }

      case 'type': {
        if (!isTextEntryElement(element)) {
          return makeFailureResult(
            'TARGET_NOT_ACTIONABLE',
            `Target element "${target.elementId}" is not a text entry element`,
            action
          );
        }

        // Check readonly state
        if (
          element.hasAttribute('readonly') ||
          Boolean((element as HTMLInputElement).readOnly)
        ) {
          return makeFailureResult(
            'TARGET_NOT_ACTIONABLE',
            `Target element "${target.elementId}" is read-only`,
            action
          );
        }

        const payload: TypeActionPayload = action.payload;
        if (!payload || typeof payload.text !== 'string') {
          return makeFailureResult(
            'INVALID_ACTION',
            'Type action requires a valid string in payload.text',
            action
          );
        }

        // Focus element
        if (typeof (element as HTMLElement).focus === 'function') {
          (element as HTMLElement).focus();
        }

        // Clear existing value if requested
        if (payload.clearFirst) {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            element.value = '';
            element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          } else if (isContentEditableElement(element)) {
            element.textContent = '';
            element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          }
        }

        // Insert typed text (NOTE: Strictly local execution, NEVER logged or returned)
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const currentVal = element.value || '';
          element.value = currentVal + payload.text;

          try {
            element.dispatchEvent(
              new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                data: payload.text,
                inputType: 'insertText'
              })
            );
          } catch {
            // Non-critical fallback
          }

          element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        } else if (isContentEditableElement(element)) {
          const currentText = element.textContent || '';
          element.textContent = currentText + payload.text;

          try {
            element.dispatchEvent(
              new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                data: payload.text,
                inputType: 'insertText'
              })
            );
          } catch {
            // Non-critical fallback
          }

          element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        } else {
          return makeFailureResult(
            'TARGET_NOT_ACTIONABLE',
            `Target element "${target.elementId}" is not writable`,
            action
          );
        }

        // Press enter if requested
        if (payload.pressEnter) {
          const enterInit: KeyboardEventInit = {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          };
          element.dispatchEvent(new KeyboardEvent('keydown', enterInit));
          element.dispatchEvent(new KeyboardEvent('keypress', enterInit));
          element.dispatchEvent(new KeyboardEvent('keyup', enterInit));
        }

        const successResult: ExecutionSuccessResult = {
          success: true,
          actionType: 'type',
          elementId: target.elementId,
          actionId,
          timestamp: Date.now()
        };
        return successResult;
      }

      case 'focus': {
        if (!isFocusableElement(element)) {
          return makeFailureResult(
            'TARGET_NOT_ACTIONABLE',
            `Target element "${target.elementId}" is not focusable`,
            action
          );
        }

        // Exactly ONE logical focus operation:
        // Native .focus() performs element focus and dispatches native focus events.
        // Fall back to synthetic FocusEvent only if native focus is unavailable.
        if (typeof (element as HTMLElement).focus === 'function') {
          (element as HTMLElement).focus();
        } else {
          element.dispatchEvent(new FocusEvent('focus', { bubbles: false, cancelable: false }));
        }

        const successResult: ExecutionSuccessResult = {
          success: true,
          actionType: 'focus',
          elementId: target.elementId,
          actionId,
          timestamp: Date.now()
        };
        return successResult;
      }

      default: {
        return makeFailureResult(
          'INVALID_ACTION',
          `Unsupported action type "${String(type)}"`,
          action
        );
      }
    }
  } catch (error) {
    return makeFailureResult(
      'EXECUTION_ERROR',
      error instanceof Error ? error.message : 'Unknown DOM execution error',
      action
    );
  }
}
