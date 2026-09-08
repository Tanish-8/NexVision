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
});
