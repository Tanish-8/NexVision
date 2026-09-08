/**
 * Tests for shared types and message constants
 */

import { describe, it, expect } from 'vitest';
import {
  MessageType,
  PAGE_REPRESENTATION_SCHEMA_VERSION
} from './types.js';
import type { PageRepresentation } from './types.js';

describe('MessageType', () => {
  it('should contain inspect page request', () => {
    expect(MessageType.INSPECT_PAGE_REQUEST).toBe('inspect-page-request');
  });

  it('should contain inspect page response', () => {
    expect(MessageType.INSPECT_PAGE_RESPONSE).toBe('inspect-page-response');
  });

  it('should contain page snapshot', () => {
    expect(MessageType.PAGE_SNAPSHOT).toBe('page-snapshot');
  });

  it('should contain extension ready', () => {
    expect(MessageType.EXTENSION_READY).toBe('extension-ready');
  });

  it('should have unique values', () => {
    const values = Object.values(MessageType);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe('PageRepresentation', () => {
  it('should be JSON serializable', () => {
    const representation: PageRepresentation = {
      schemaVersion: PAGE_REPRESENTATION_SCHEMA_VERSION,
      metadata: {
        title: 'Example page',
        url: 'https://example.com/'
      },
      viewport: {
        width: 1280,
        height: 720
      },
      elements: [
        {
          id: 'element-1',
          tagName: 'button',
          role: 'button',
          visibleText: 'Continue',
          accessibleName: 'Continue to checkout',
          bounds: {
            x: 24,
            y: 96,
            width: 160,
            height: 40
          },
          state: {
            visible: true,
            enabled: true,
            focused: false
          },
          interactive: true,
          attributes: {
            type: 'submit'
          },
          parentId: 'form-1',
          provenance: 'both'
        },
        {
          id: 'element-2',
          role: 'image',
          bounds: {
            x: 240,
            y: 96,
            width: 320,
            height: 180
          },
          state: {
            visible: true
          },
          provenance: 'vision'
        }
      ]
    };

    const serialized = JSON.stringify(representation);
    expect(serialized).toBeTypeOf('string');
    if (serialized === undefined) {
      throw new Error('Expected page representation to serialize');
    }

    expect(JSON.parse(serialized)).toEqual(representation);
  });
});