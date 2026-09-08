/**
 * Popup UI logic for SIH26171 extension.
 * Displays page information and triggers inspection.
 */

import { MessageType } from '../shared/types.js';
import { sendToBackground } from '../shared/messaging.js';
import type { PageSnapshot, PageRepresentation, ExtensionResponse } from '../shared/types.js';

// DOM elements
const pageTitleEl = document.getElementById('page-title') as HTMLElement;
const pageUrlEl = document.getElementById('page-url') as HTMLElement;
const headingCountEl = document.getElementById('heading-count') as HTMLElement;
const errorMessageEl = document.getElementById('error-message') as HTMLElement;
const successMessageEl = document.getElementById('success-message') as HTMLElement;
const inspectBtn = document.getElementById('inspect-btn') as HTMLButtonElement;

/**
 * Format URL for display (strip protocol, truncate)
 */
function formatUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path.length > 40 ? path.substring(0, 37) + '...' : path || u.hostname;
  } catch {
    return url;
  }
}

/**
 * Display a page representation in the UI
 */
function displaySnapshot(snapshot: PageRepresentation): void {
  pageTitleEl.textContent = snapshot.metadata.title || '—';
  pageUrlEl.textContent = formatUrl(snapshot.metadata.url || '');

  // Count headings from elements with role 'heading'
  const headingCount = snapshot.elements.filter(el => el.role === 'heading').length;
  headingCountEl.textContent = String(headingCount);

  // Show inspection time (time of receiving the data)
  const inspectionTime = new Date().toLocaleTimeString();
  successMessageEl.textContent = `Inspected at ${inspectionTime}`;
  successMessageEl.classList.remove('hidden');
  errorMessageEl.classList.add('hidden');
}

/**
 * Display an error message
 */
function displayError(message: string): void {
  errorMessageEl.textContent = message;
  errorMessageEl.classList.remove('hidden');
  successMessageEl.classList.add('hidden');
}

/**
 * Request a page inspection from the background service worker
 */
async function inspectPage(): Promise<void> {
  inspectBtn.disabled = true;
  inspectBtn.textContent = 'Inspecting...';

  try {
    const response: ExtensionResponse<PageRepresentation> = await sendToBackground<PageRepresentation>(
      MessageType.INSPECT_PAGE_REQUEST,
      {}
    );

    if (response.success && response.data) {
      displaySnapshot(response.data);
    } else {
      displayError(response.error || 'Inspection failed');
    }
  } catch {
    displayError('Failed to communicate with background service');
  } finally {
    inspectBtn.disabled = false;
    inspectBtn.textContent = 'Inspect Page';
  }
}

/**
 * Initialize the popup
 */
function init(): void {
  inspectBtn.addEventListener('click', inspectPage);
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}