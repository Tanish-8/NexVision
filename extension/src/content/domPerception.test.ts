/**
 * Tests for DOM perception module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPageRepresentationFromDom } from './domPerception.js';
import type { PageElement, PageRepresentation } from '../shared/types.js';

function setUpHtml(html: string): void {
  document.body.innerHTML = html;
}

function requireElement<T extends Element>(element: T | null): T {
  if (!element) {
    throw new Error('Expected test element to exist');
  }
  return element;
}

function requirePageElement(
  representation: PageRepresentation,
  predicate: (element: PageElement) => boolean
): PageElement {
  const element = representation.elements.find(predicate);
  if (!element) {
    throw new Error('Expected page element to exist');
  }
  return element;
}

type MockRect = {
  x?: number;
  y?: number;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};

function mockBoundingClientRect(element: Element | null, rect: MockRect = {}): void {
  const target = requireElement(element);
  const left = rect.left ?? rect.x ?? 0;
  const top = rect.top ?? rect.y ?? 0;
  const width = rect.width ?? 10;
  const height = rect.height ?? 10;
  const measuredRect = {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({ left, top, width, height })
  } as DOMRect;

  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(measuredRect);
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DOM Perception', () => {
  it('should extract page title and URL', () => {
    document.title = 'Test Page';

    const representation = extractPageRepresentationFromDom();

    expect(representation.metadata.title).toBe('Test Page');
    expect(representation.metadata.url).toBe(window.location.href);
  });

  it('should extract viewport dimensions', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });

    const representation = extractPageRepresentationFromDom();

    expect(representation.viewport.width).toBe(1280);
    expect(representation.viewport.height).toBe(720);
  });

  it('should extract a button element', () => {
    setUpHtml('<button>Click me</button>');
    mockBoundingClientRect(document.querySelector('button'));

    const representation = extractPageRepresentationFromDom();
    const element = requirePageElement(representation, (candidate) => candidate.tagName === 'button');

    expect(representation.elements).toHaveLength(1);
    expect(element.role).toBe('button');
    expect(element.visibleText).toBe('Click me');
    expect(element.accessibleName).toBe('Click me');
    expect(element.interactive).toBe(true);
    expect(element.state?.visible).toBe(true);
    expect(element.state?.enabled).toBe(true);
    expect(element.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(element.provenance).toBe('dom');
  });

  it('should extract a link element', () => {
    setUpHtml('<a href="https://example.com">Go to example</a>');
    mockBoundingClientRect(document.querySelector('a'));

    const representation = extractPageRepresentationFromDom();
    const element = requirePageElement(representation, (candidate) => candidate.tagName === 'a');

    expect(element.role).toBe('link');
    expect(element.visibleText).toBe('Go to example');
    expect(element.accessibleName).toBe('Go to example');
    expect(element.interactive).toBe(true);
    expect(element.attributes?.href).toBe('https://example.com');
  });

  it('should extract a textbox without capturing its value', () => {
    setUpHtml('<input type="text" placeholder="Enter name" value="John" aria-label="Name">');
    mockBoundingClientRect(document.querySelector('input'));

    const representation = extractPageRepresentationFromDom();
    const element = requirePageElement(representation, (candidate) => candidate.tagName === 'input');

    expect(element.role).toBe('textbox');
    expect(element.placeholder).toBe('Enter name');
    expect(element.inputType).toBe('text');
    expect(element.accessibleName).toBe('Name');
    expect(element.visibleText).toBeUndefined();
    expect(element.attributes).not.toHaveProperty('value');
    expect(element.attributes?.placeholder).toBe('Enter name');
    expect(element.attributes?.['aria-label']).toBe('Name');
    expect(element.interactive).toBe(true);
  });

  it('should classify checkbox, radio, select, and image semantics', () => {
    setUpHtml(`
      <label><input type="checkbox" checked> Remember me</label>
      <label><input type="radio" name="plan" checked> Standard</label>
      <select aria-label="Plan">
        <option>Standard</option>
        <option selected>Premium</option>
      </select>
      <img src="logo.png" alt="Company logo">
      <div role="img" aria-label="Chart image"></div>
    `);
    document.querySelectorAll('label, input, select, option, img, [role]').forEach((element) => {
      mockBoundingClientRect(element);
    });

    const representation = extractPageRepresentationFromDom();
    const checkbox = requirePageElement(representation, (element) => element.role === 'checkbox');
    const radio = requirePageElement(representation, (element) => element.role === 'radio');
    const select = requirePageElement(representation, (element) => element.tagName === 'select');
    const image = requirePageElement(representation, (element) => element.tagName === 'img');
    const ariaImage = requirePageElement(representation, (element) => element.accessibleName === 'Chart image');

    expect(checkbox.state?.checked).toBe(true);
    expect(checkbox.accessibleName).toBe('Remember me');
    expect(checkbox.interactive).toBe(true);
    expect(radio.state?.checked).toBe(true);
    expect(radio.accessibleName).toBe('Standard');
    expect(radio.interactive).toBe(true);
    expect(select.role).toBe('combobox');
    expect(select.accessibleName).toBe('Plan');
    expect(select.visibleText).toBe('Premium');
    expect(select.interactive).toBe(true);
    expect(image.role).toBe('image');
    expect(image.accessibleName).toBe('Company logo');
    expect(ariaImage.role).toBe('image');
    expect(ariaImage.interactive).toBe(false);
  });

  it('should extract headings', () => {
    setUpHtml('<h1>Main Title</h1><h2>Subtitle</h2>');
    document.querySelectorAll('h1, h2').forEach((element) => mockBoundingClientRect(element));

    const representation = extractPageRepresentationFromDom();
    const heading1 = requirePageElement(representation, (element) => element.tagName === 'h1');
    const heading2 = requirePageElement(representation, (element) => element.tagName === 'h2');

    expect(heading1.role).toBe('heading');
    expect(heading1.visibleText).toBe('Main Title');
    expect(heading2.role).toBe('heading');
    expect(heading2.visibleText).toBe('Subtitle');
  });

  it('should represent meaningful text content without promoting layout nodes', () => {
    setUpHtml(`
      <main>
        <article><p>  A meaningful   paragraph. </p></article>
        <div>Layout wrapper only</div>
      </main>
    `);
    document.querySelectorAll('main, article, p').forEach((element) => mockBoundingClientRect(element));

    const representation = extractPageRepresentationFromDom();
    const main = requirePageElement(representation, (element) => element.tagName === 'main');
    const article = requirePageElement(representation, (element) => element.tagName === 'article');
    const paragraph = requirePageElement(representation, (element) => element.tagName === 'p');

    expect(main.role).toBe('generic');
    expect(main.visibleText).toBe('A meaningful paragraph. Layout wrapper only');
    expect(article.visibleText).toBe('A meaningful paragraph.');
    expect(paragraph.visibleText).toBe('A meaningful paragraph.');
    expect(representation.elements.some((element) => element.tagName === 'div')).toBe(false);
  });

  it('should normalize visible text', () => {
    setUpHtml('<button>  Hello   World  </button>');
    mockBoundingClientRect(document.querySelector('button'));

    const representation = extractPageRepresentationFromDom();
    const element = requirePageElement(representation, (candidate) => candidate.tagName === 'button');

    expect(element.visibleText).toBe('Hello World');
  });

  it('should compute bounding boxes from getBoundingClientRect', () => {
    setUpHtml('<button>Button</button>');
    mockBoundingClientRect(document.querySelector('button'), {
      left: 10,
      top: 20,
      width: 100,
      height: 30
    });

    const representation = extractPageRepresentationFromDom();
    const element = requirePageElement(representation, (candidate) => candidate.tagName === 'button');

    expect(element.bounds?.x).toBeCloseTo(10);
    expect(element.bounds?.y).toBeCloseTo(20);
    expect(element.bounds?.width).toBeCloseTo(100);
    expect(element.bounds?.height).toBeCloseTo(30);
  });

  it('should set interactive flag appropriately', () => {
    setUpHtml(`
      <button>Button</button>
      <a href="#">Link</a>
      <input type="text">
      <textarea></textarea>
      <select><option>Option</option></select>
      <div role="button">Div button</div>
      <span tabindex="0">Tabspan</span>
      <div>Static div</div>
    `);
    document
      .querySelectorAll('button, a, input, textarea, select, option, div[role], span[tabindex]')
      .forEach((element) => mockBoundingClientRect(element));

    const representation = extractPageRepresentationFromDom();

    // The option is represented, but selection is performed through the select.
    expect(representation.elements.filter((element) => element.interactive)).toHaveLength(7);
    expect(representation.elements.find((element) => element.tagName === 'div' && !element.interactive))
      .toBeUndefined();
  });

  it('should respect disabled state', () => {
    setUpHtml('<button disabled>Disabled button</button>');
    mockBoundingClientRect(document.querySelector('button'));

    const representation = extractPageRepresentationFromDom();
    const element = requirePageElement(representation, (candidate) => candidate.tagName === 'button');

    expect(element.state?.enabled).toBe(false);
    expect(element.state?.disabled).toBe(true);
    expect(element.interactive).toBe(false);
  });

  it('should inherit disabled state from a fieldset', () => {
    setUpHtml(`
      <fieldset disabled>
        <legend><button>Legend action</button></legend>
        <button>Disabled action</button>
      </fieldset>
    `);
    document.querySelectorAll('fieldset, legend, button').forEach((element) => mockBoundingClientRect(element));

    const representation = extractPageRepresentationFromDom();
    const buttons = representation.elements.filter((element) => element.tagName === 'button');

    expect(buttons).toHaveLength(2);
    expect(buttons[0].state?.disabled).toBe(false);
    expect(buttons[0].interactive).toBe(true);
    expect(buttons[1].state?.disabled).toBe(true);
    expect(buttons[1].interactive).toBe(false);
  });

  it('should handle CSS and zero-size visibility', () => {
    setUpHtml(`
      <button style="display: none">Hidden button</button>
      <button style="visibility: hidden">Invisible button</button>
      <button>Zero-size button</button>
      <button>Visible button</button>
    `);
    const buttons = document.querySelectorAll('button');
    mockBoundingClientRect(buttons[2], { width: 0, height: 0 });
    mockBoundingClientRect(buttons[3]);

    const representation = extractPageRepresentationFromDom();

    expect(requirePageElement(representation, (element) => element.visibleText === 'Hidden button').state?.visible)
      .toBe(false);
    expect(requirePageElement(representation, (element) => element.visibleText === 'Invisible button').state?.visible)
      .toBe(false);
    expect(requirePageElement(representation, (element) => element.visibleText === 'Zero-size button').state?.visible)
      .toBe(false);
    expect(requirePageElement(representation, (element) => element.visibleText === 'Visible button').state?.visible)
      .toBe(true);
  });

  it('should extract textarea, select, and option semantics without values', () => {
    setUpHtml(`
      <label for="country">Country</label>
      <select id="country">
        <option value="us">United States</option>
        <option value="ca" selected>Canada</option>
      </select>
      <textarea aria-label="Notes" placeholder="Add notes">Private textarea value</textarea>
    `);
    document.querySelectorAll('label, select, option, textarea').forEach((element) => mockBoundingClientRect(element));

    const representation = extractPageRepresentationFromDom();
    const select = requirePageElement(representation, (element) => element.tagName === 'select');
    const selectedOption = requirePageElement(
      representation,
      (element) => element.tagName === 'option' && element.visibleText === 'Canada'
    );
    const textarea = requirePageElement(representation, (element) => element.tagName === 'textarea');

    expect(select.role).toBe('combobox');
    expect(select.accessibleName).toBe('Country');
    expect(select.visibleText).toBe('Canada');
    expect(select.interactive).toBe(true);
    expect(selectedOption.role).toBe('option');
    expect(selectedOption.state?.selected).toBe(true);
    expect(textarea.role).toBe('textbox');
    expect(textarea.placeholder).toBe('Add notes');
    expect(textarea.accessibleName).toBe('Notes');
    expect(textarea.visibleText).toBeUndefined();
    expect(JSON.stringify(representation)).not.toContain('Private textarea value');
  });

  it('should extract ARIA names and states', () => {
    setUpHtml(`
      <span id="heading-name">Account settings</span>
      <div role="heading" aria-labelledby="heading-name">Ignored fallback</div>
      <div role="button" aria-label="Open menu" aria-expanded="true" tabindex="0">Menu</div>
      <div role="checkbox" aria-label="Remember me" aria-checked="true" tabindex="0"></div>
    `);
    document.querySelectorAll('[role], [tabindex]').forEach((element) => mockBoundingClientRect(element));

    const representation = extractPageRepresentationFromDom();
    const heading = requirePageElement(representation, (element) => element.role === 'heading');
    const menu = requirePageElement(representation, (element) => element.accessibleName === 'Open menu');
    const checkbox = requirePageElement(representation, (element) => element.role === 'checkbox');

    expect(heading.accessibleName).toBe('Account settings');
    expect(menu.state?.expanded).toBe(true);
    expect(menu.interactive).toBe(true);
    expect(checkbox.state?.checked).toBe(true);
    expect(checkbox.interactive).toBe(true);
  });

  it('should keep unsupported and neutral roles from creating arbitrary elements', () => {
    setUpHtml(`
      <div role="made-up">Unsupported role</div>
      <div role="none">Decorative node</div>
      <div role="presentation">Presentation node</div>
      <button role="none">Native action</button>
      <p role="presentation">Presented paragraph</p>
      <img role="presentation" alt="Presented image" src="presentation.png">
      <div tabindex="-1">Programmatic focus target</div>
      <div tabindex="0">Keyboard focus target</div>
    `);
    document.querySelectorAll('[role], [tabindex]').forEach((element) => mockBoundingClientRect(element));

    const representation = extractPageRepresentationFromDom();
    const nativeButton = requirePageElement(representation, (element) => element.tagName === 'button');
    const negativeTabindex = requirePageElement(
      representation,
      (element) => element.visibleText === 'Programmatic focus target'
    );
    const positiveTabindex = requirePageElement(
      representation,
      (element) => element.visibleText === 'Keyboard focus target'
    );

    expect(representation.elements.some((element) => element.visibleText === 'Unsupported role')).toBe(false);
    expect(representation.elements.some((element) => element.visibleText === 'Decorative node')).toBe(false);
    expect(representation.elements.some((element) => element.visibleText === 'Presentation node')).toBe(false);
    expect(representation.elements.some((element) => element.visibleText === 'Presented paragraph')).toBe(false);
    expect(representation.elements.some((element) => element.accessibleName === 'Presented image')).toBe(false);
    expect(nativeButton.role).toBe('button');
    expect(nativeButton.interactive).toBe(true);
    expect(negativeTabindex.role).toBe('generic');
    expect(negativeTabindex.interactive).toBe(false);
    expect(positiveTabindex.role).toBe('generic');
    expect(positiveTabindex.interactive).toBe(true);
  });

  it('should preserve form relationships and direct child IDs', () => {
    setUpHtml(`
      <form id="my-form">
        <label for="name">Name:</label>
        <input type="text" id="name">
        <button type="submit">Submit</button>
      </form>
    `);
    document.querySelectorAll('form, label, input, button').forEach((element) => mockBoundingClientRect(element));

    const representation = extractPageRepresentationFromDom();
    const form = requirePageElement(representation, (element) => element.tagName === 'form');
    const input = requirePageElement(representation, (element) => element.tagName === 'input');
    const button = requirePageElement(representation, (element) => element.tagName === 'button');
    const label = requirePageElement(representation, (element) => element.tagName === 'label');

    expect(form.role).toBe('form');
    expect(form.childIds).toEqual(expect.arrayContaining([label.id, input.id, button.id]));
    expect(input.parentId).toBe(form.id);
    expect(button.parentId).toBe(form.id);
    expect(label.parentId).toBe(form.id);
  });

  it('should keep sensitive control values out of classified elements', () => {
    setUpHtml(`
      <form>
        <input type="text" value="visible text">
        <input type="password" value="secret password">
        <input type="hidden" value="hidden data">
        <textarea>Private text</textarea>
      </form>
    `);
    document.querySelectorAll('form, input, textarea').forEach((element) => mockBoundingClientRect(element));

    const representation = extractPageRepresentationFromDom();
    const textInput = requirePageElement(
      representation,
      (element) => element.tagName === 'input' && element.inputType === 'text'
    );
    const passwordInput = requirePageElement(
      representation,
      (element) => element.tagName === 'input' && element.inputType === 'password'
    );
    const hiddenInput = requirePageElement(
      representation,
      (element) => element.tagName === 'input' && element.inputType === 'hidden'
    );
    const textarea = requirePageElement(representation, (element) => element.tagName === 'textarea');

    expect(textInput.attributes ?? {}).not.toHaveProperty('value');
    expect(passwordInput.attributes ?? {}).not.toHaveProperty('value');
    expect(hiddenInput.attributes ?? {}).not.toHaveProperty('value');
    expect(textarea.attributes ?? {}).not.toHaveProperty('value');
    expect(textInput.placeholder).toBeUndefined();
    expect(passwordInput.inputType).toBe('password');
    expect(hiddenInput.inputType).toBe('hidden');
    expect(hiddenInput.state?.visible).toBe(false);
    expect(textarea.visibleText).toBeUndefined();

    const serialized = JSON.stringify(representation);
    expect(serialized).not.toContain('visible text');
    expect(serialized).not.toContain('secret password');
    expect(serialized).not.toContain('hidden data');
    expect(serialized).not.toContain('Private text');
  });

  it('should assign deterministic IDs in document order', () => {
    setUpHtml('<h1>First</h1><button>Second</button>');
    document.querySelectorAll('h1, button').forEach((element) => mockBoundingClientRect(element));

    const firstRepresentation = extractPageRepresentationFromDom();
    const secondRepresentation = extractPageRepresentationFromDom();

    expect(firstRepresentation.elements.map((element) => [element.id, element.tagName])).toEqual([
      ['elem-1', 'h1'],
      ['elem-2', 'button']
    ]);
    expect(secondRepresentation.elements.map((element) => element.id)).toEqual(
      firstRepresentation.elements.map((element) => element.id)
    );
    expect(firstRepresentation.elements.map((element) => element.id)).not.toContain('First');
    expect(firstRepresentation.elements.map((element) => element.id)).not.toContain('Second');
  });

  describe('Phase 1C-2: Visibility detection', () => {
    it('should detect [hidden] elements as invisible and non-interactive', () => {
      setUpHtml('<button hidden>Hidden button</button>');
      mockBoundingClientRect(document.querySelector('button'));

      const representation = extractPageRepresentationFromDom();
      const btn = requirePageElement(representation, (el) => el.tagName === 'button');

      expect(btn.state?.visible).toBe(false);
      expect(btn.interactive).toBe(false);
    });

    it('should detect display:none elements as invisible and non-interactive', () => {
      setUpHtml('<button style="display: none">Display none</button>');
      mockBoundingClientRect(document.querySelector('button'));

      const representation = extractPageRepresentationFromDom();
      const btn = requirePageElement(representation, (el) => el.tagName === 'button');

      expect(btn.state?.visible).toBe(false);
      expect(btn.interactive).toBe(false);
    });

    it('should detect visibility:hidden and visibility:collapse elements as invisible', () => {
      setUpHtml(`
        <button style="visibility: hidden">Visibility hidden</button>
        <button style="visibility: collapse">Visibility collapse</button>
      `);
      document.querySelectorAll('button').forEach((b) => mockBoundingClientRect(b));

      const representation = extractPageRepresentationFromDom();
      const hiddenBtn = requirePageElement(representation, (el) => el.visibleText === 'Visibility hidden');
      const collapseBtn = requirePageElement(representation, (el) => el.visibleText === 'Visibility collapse');

      expect(hiddenBtn.state?.visible).toBe(false);
      expect(hiddenBtn.interactive).toBe(false);
      expect(collapseBtn.state?.visible).toBe(false);
      expect(collapseBtn.interactive).toBe(false);
    });

    it('should detect elements within hidden ancestors as invisible', () => {
      setUpHtml(`
        <div style="display: none">
          <button id="in-display-none">Inside display none</button>
        </div>
        <div hidden>
          <button id="in-hidden-attr">Inside hidden attr</button>
        </div>
      `);
      document.querySelectorAll('button').forEach((b) => mockBoundingClientRect(b));

      const representation = extractPageRepresentationFromDom();
      const btn1 = requirePageElement(representation, (el) => el.visibleText === 'Inside display none');
      const btn2 = requirePageElement(representation, (el) => el.visibleText === 'Inside hidden attr');

      expect(btn1.state?.visible).toBe(false);
      expect(btn1.interactive).toBe(false);
      expect(btn2.state?.visible).toBe(false);
      expect(btn2.interactive).toBe(false);
    });

    it('should detect zero-width or zero-height elements as invisible', () => {
      setUpHtml(`
        <button id="zero-w">Zero Width</button>
        <button id="zero-h">Zero Height</button>
      `);
      const zeroW = document.querySelector('#zero-w');
      const zeroH = document.querySelector('#zero-h');
      mockBoundingClientRect(zeroW, { width: 0, height: 30 });
      mockBoundingClientRect(zeroH, { width: 30, height: 0 });

      const representation = extractPageRepresentationFromDom();
      const btnW = requirePageElement(representation, (el) => el.visibleText === 'Zero Width');
      const btnH = requirePageElement(representation, (el) => el.visibleText === 'Zero Height');

      expect(btnW.state?.visible).toBe(false);
      expect(btnW.interactive).toBe(false);
      expect(btnH.state?.visible).toBe(false);
      expect(btnH.interactive).toBe(false);
    });

    it('should NOT consider off-screen rendered elements invisible if rendered', () => {
      setUpHtml(`
        <button id="below-viewport">Far Below Viewport</button>
        <button id="left-of-viewport">Far Left Viewport</button>
      `);
      const below = document.querySelector('#below-viewport');
      const left = document.querySelector('#left-of-viewport');
      mockBoundingClientRect(below, { left: 0, top: 4000, width: 120, height: 40 });
      mockBoundingClientRect(left, { left: -3000, top: 0, width: 120, height: 40 });

      const representation = extractPageRepresentationFromDom();
      const belowBtn = requirePageElement(representation, (el) => el.visibleText === 'Far Below Viewport');
      const leftBtn = requirePageElement(representation, (el) => el.visibleText === 'Far Left Viewport');

      expect(belowBtn.state?.visible).toBe(true);
      expect(belowBtn.interactive).toBe(true);
      expect(leftBtn.state?.visible).toBe(true);
      expect(leftBtn.interactive).toBe(true);
    });

    it('should treat inert elements and their descendants as disabled and non-interactive', () => {
      setUpHtml(`
        <div inert>
          <button id="inert-btn">Inert action</button>
        </div>
      `);
      mockBoundingClientRect(document.querySelector('#inert-btn'), { width: 100, height: 30 });

      const representation = extractPageRepresentationFromDom();
      const btn = requirePageElement(representation, (el) => el.visibleText === 'Inert action');

      expect(btn.state?.visible).toBe(true);
      expect(btn.state?.disabled).toBe(true);
      expect(btn.state?.enabled).toBe(false);
      expect(btn.interactive).toBe(false);
    });

    it('should keep aria-hidden elements visually visible when rendered, preserving aria-hidden as an attribute', () => {
      setUpHtml('<button aria-hidden="true">Visible but aria-hidden</button>');
      mockBoundingClientRect(document.querySelector('button'), { width: 100, height: 40 });

      const representation = extractPageRepresentationFromDom();
      const btn = requirePageElement(representation, (el) => el.tagName === 'button');

      expect(btn.state?.visible).toBe(true);
      expect(btn.interactive).toBe(true);
      expect(btn.attributes?.['aria-hidden']).toBe('true');
    });
  });

  describe('Phase 1C-2: Text normalization and extraction', () => {
    it('should normalize irregular whitespace, newlines, and tabs', () => {
      setUpHtml('<p>   First \n\n  word \t\t and \r\n second   word.  </p>');
      mockBoundingClientRect(document.querySelector('p'));

      const representation = extractPageRepresentationFromDom();
      const p = requirePageElement(representation, (el) => el.tagName === 'p');

      expect(p.visibleText).toBe('First word and second word.');
    });

    it('should exclude hidden descendants from visible text', () => {
      setUpHtml(`
        <article>
          <p>Visible start <span style="display: none">hidden css</span> and <span hidden>hidden attr</span> visible end.</p>
        </article>
      `);
      document.querySelectorAll('article, p').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const p = requirePageElement(representation, (el) => el.tagName === 'p');

      expect(p.visibleText).toBe('Visible start and visible end.');
      expect(p.visibleText).not.toContain('hidden css');
      expect(p.visibleText).not.toContain('hidden attr');
    });

    it('should ignore script, style, noscript, and template content', () => {
      setUpHtml(`
        <main>
          <h1>Real Heading</h1>
          <script>var leak = "token_script_content";</script>
          <style>body { font-size: 14px; }</style>
          <noscript>Please enable scripts</noscript>
          <template><p>Invisible template body</p></template>
          <p>Real paragraph content.</p>
        </main>
      `);
      document.querySelectorAll('main, h1, p').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const main = requirePageElement(representation, (el) => el.tagName === 'main');

      expect(main.visibleText).toBe('Real Heading Real paragraph content.');
      expect(main.visibleText).not.toContain('token_script_content');
      expect(main.visibleText).not.toContain('font-size');
      expect(main.visibleText).not.toContain('enable scripts');
      expect(main.visibleText).not.toContain('template body');
    });

    it('should properly collect nested text across inline elements', () => {
      setUpHtml('<p>Text with <strong>bold</strong>, <em>italic</em>, and <code>code</code> snippets.</p>');
      mockBoundingClientRect(document.querySelector('p'));

      const representation = extractPageRepresentationFromDom();
      const p = requirePageElement(representation, (el) => el.tagName === 'p');

      expect(p.visibleText).toBe('Text with bold, italic, and code snippets.');
    });

    it('should never leak form control values into ancestor text', () => {
      setUpHtml(`
        <form>
          <label for="u">Username</label>
          <input type="text" id="u" value="super_secret_username_123">
          <label for="b">Bio</label>
          <textarea id="b">secret_user_bio_text</textarea>
          <button type="submit">Submit</button>
        </form>
      `);
      document.querySelectorAll('form, label, input, textarea, button').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const form = requirePageElement(representation, (el) => el.tagName === 'form');

      expect(form.visibleText).toBe('Username Bio Submit');
      expect(form.visibleText).not.toContain('super_secret_username_123');
      expect(form.visibleText).not.toContain('secret_user_bio_text');
    });
  });

  describe('Phase 1C-2: Accessibility & label relationships', () => {
    it('should prioritize aria-labelledby over aria-label and visible text', () => {
      setUpHtml(`
        <div id="lbl">Referenced Label</div>
        <button aria-labelledby="lbl" aria-label="Aria Label">Visible Button Text</button>
      `);
      document.querySelectorAll('div, button').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const btn = requirePageElement(representation, (el) => el.tagName === 'button');

      expect(btn.accessibleName).toBe('Referenced Label');
    });

    it('should prioritize aria-label over visible text and placeholders', () => {
      setUpHtml('<input type="text" aria-label="Search Catalog" placeholder="Type here..." value="shoes">');
      mockBoundingClientRect(document.querySelector('input'));

      const representation = extractPageRepresentationFromDom();
      const input = requirePageElement(representation, (el) => el.tagName === 'input');

      expect(input.accessibleName).toBe('Search Catalog');
    });

    it('should associate label[for] with form control and populate labelIds', () => {
      setUpHtml(`
        <label for="email-field">Your Email Address</label>
        <input type="email" id="email-field">
      `);
      document.querySelectorAll('label, input').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const label = requirePageElement(representation, (el) => el.tagName === 'label');
      const input = requirePageElement(representation, (el) => el.tagName === 'input');

      expect(input.accessibleName).toBe('Your Email Address');
      expect(input.labelIds).toEqual([label.id]);
    });

    it('should associate wrapping label with form control and populate labelIds', () => {
      setUpHtml(`
        <label>
          Subscribe to Newsletter
          <input type="checkbox">
        </label>
      `);
      document.querySelectorAll('label, input').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const label = requirePageElement(representation, (el) => el.tagName === 'label');
      const checkbox = requirePageElement(representation, (el) => el.tagName === 'input');

      expect(checkbox.accessibleName).toBe('Subscribe to Newsletter');
      expect(checkbox.labelIds).toEqual([label.id]);
    });

    it('should extract button/link accessible names from text or child img alt', () => {
      setUpHtml(`
        <button id="text-btn">Send Message</button>
        <button id="img-btn"><img src="send.png" alt="Send Message Icon"></button>
        <a href="/home" id="img-link"><img src="logo.png" alt="Home Dashboard"></a>
      `);
      document.querySelectorAll('button, a, img').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const textBtn = requirePageElement(representation, (el) => el.id === 'elem-1');
      const imgBtn = requirePageElement(representation, (el) => el.id === 'elem-2');
      const imgLink = requirePageElement(representation, (el) => el.id === 'elem-4');

      expect(textBtn.accessibleName).toBe('Send Message');
      expect(imgBtn.accessibleName).toBe('Send Message Icon');
      expect(imgLink.accessibleName).toBe('Home Dashboard');
    });

    it('should fallback to placeholder when no label or aria-label exists', () => {
      setUpHtml(`
        <input type="text" placeholder="Search keywords...">
        <textarea placeholder="Write your review here..."></textarea>
      `);
      document.querySelectorAll('input, textarea').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const input = requirePageElement(representation, (el) => el.tagName === 'input');
      const textarea = requirePageElement(representation, (el) => el.tagName === 'textarea');

      expect(input.accessibleName).toBe('Search keywords...');
      expect(textarea.accessibleName).toBe('Write your review here...');
    });

    it('should NOT use placeholder as accessible name if a label exists', () => {
      setUpHtml(`
        <label for="search-box">Search Store</label>
        <input type="text" id="search-box" placeholder="e.g. laptop">
      `);
      document.querySelectorAll('label, input').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const input = requirePageElement(representation, (el) => el.tagName === 'input');

      expect(input.accessibleName).toBe('Search Store');
    });
  });

  describe('Phase 1C-2: Privacy regression tests', () => {
    it('should never contain input values, passwords, textarea values, tokens, cookies, or web storage', () => {
      if (typeof document !== 'undefined') {
        document.cookie = 'session_id=secret_cookie_token_999888';
      }
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('auth_jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret_token');
      }
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem('temp_secret', 'transient_secret_value_123');
      }

      setUpHtml(`
        <form id="login-form">
          <label for="email">User Email</label>
          <input type="email" id="email" value="fake.user@confidential-domain.example">
          <label for="pwd">User Password</label>
          <input type="password" id="pwd" value="VerySecretPassword!#2026">
          <label for="tok">API Token</label>
          <input type="text" id="tok" value="ghp_1234567890abcdefghijklmnopqrstuvwxyz">
          <label for="notes">Private Notes</label>
          <textarea id="notes">Client SSN: 000-12-3456 and token sk-live-987654321</textarea>
          <input type="hidden" id="csrf" value="csrf_token_secret_abcdef">
          <button type="submit">Log In</button>
        </form>
      `);
      document.querySelectorAll('form, label, input, textarea, button').forEach((el) => mockBoundingClientRect(el));

      const representation = extractPageRepresentationFromDom();
      const serialized = JSON.stringify(representation);

      expect(serialized).not.toContain('fake.user@confidential-domain.example');
      expect(serialized).not.toContain('VerySecretPassword!#2026');
      expect(serialized).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
      expect(serialized).not.toContain('Client SSN: 000-12-3456');
      expect(serialized).not.toContain('sk-live-987654321');
      expect(serialized).not.toContain('csrf_token_secret_abcdef');
      expect(serialized).not.toContain('secret_cookie_token_999888');
      expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(serialized).not.toContain('transient_secret_value_123');

      representation.elements.forEach((elem) => {
        expect(elem.attributes).not.toHaveProperty('value');
      });

      const emailInput = requirePageElement(representation, (el) => el.inputType === 'email');
      const passwordInput = requirePageElement(representation, (el) => el.inputType === 'password');
      const notesTextarea = requirePageElement(representation, (el) => el.tagName === 'textarea');

      expect(emailInput.accessibleName).toBe('User Email');
      expect(passwordInput.accessibleName).toBe('User Password');
      expect(notesTextarea.accessibleName).toBe('Private Notes');
      expect(emailInput.visibleText).toBeUndefined();
      expect(passwordInput.visibleText).toBeUndefined();
      expect(notesTextarea.visibleText).toBeUndefined();
    });
  });
});
