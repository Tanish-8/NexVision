/**
 * Basic tests for messaging utilities
 */

import { describe, it, expect } from 'vitest';
import { generateMessageId } from './messaging.js';

describe('generateMessageId', () => {
  it('should generate unique IDs', () => {
    const id1 = generateMessageId();
    const id2 = generateMessageId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^msg-\d+-\d+$/);
    expect(id2).toMatch(/^msg-\d+-\d+$/);
  });
});