import { describe, expect, it } from 'vitest';
import * as sdk from './index';

describe('public entry point', () => {
  it('exports the flow factory', () => {
    expect(typeof sdk.createFlow).toBe('function');
  });

  it('exports nothing else at runtime, keeping the surface deliberate', () => {
    // Everything besides the factory is types, which erase at runtime.
    expect(Object.keys(sdk)).toEqual(['createFlow']);
  });

  it('validates its options without needing a DOM', () => {
    // Importing and calling the entry point must not depend on a browser, so a
    // server render that touches the module never crashes.
    expect(() => sdk.createFlow({ url: 'javascript:alert(1)' })).toThrow(/http/i);
  });
});
