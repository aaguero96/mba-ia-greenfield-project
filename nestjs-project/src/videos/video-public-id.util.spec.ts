import { generatePublicId } from './video-public-id.util';
import { VIDEO_PUBLIC_ID_LENGTH } from './videos.constants';

describe('generatePublicId', () => {
  it('should produce an id of the documented length', () => {
    expect(generatePublicId()).toHaveLength(VIDEO_PUBLIC_ID_LENGTH);
  });

  it('should only use URL-safe characters', () => {
    // base64url: no +, no /, no padding — safe to drop into a path unescaped.
    for (let i = 0; i < 500; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('should not collide across a large sample', () => {
    const sample = new Set<string>();
    const size = 20_000;

    for (let i = 0; i < size; i++) {
      sample.add(generatePublicId());
    }

    expect(sample.size).toBe(size);
  });

  it('should produce a different id on consecutive calls', () => {
    expect(generatePublicId()).not.toBe(generatePublicId());
  });
});
