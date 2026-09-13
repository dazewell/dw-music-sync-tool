import { describe, it, expect } from 'vitest';
import { config } from './config/index.js';

describe('Config module', () => {
  it('should load default configuration values', () => {
    expect(config.soundiizApiUrl).toBe('https://api.soundiiz.com/v1');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
  });
});
