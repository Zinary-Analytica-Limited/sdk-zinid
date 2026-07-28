import { describe, expect, it } from 'vitest';
import { SDK_NAME } from './index';

// Placeholder suite — replaced by real emitter/channel tests in Phase 1.
describe('scaffold', () => {
  it('exports the package entry', () => {
    expect(SDK_NAME).toBe('@zinid/sdk-web');
  });
});
