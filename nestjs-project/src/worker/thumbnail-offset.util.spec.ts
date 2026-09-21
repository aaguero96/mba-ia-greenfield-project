import { computeThumbnailOffset } from './thumbnail-offset.util';

const PERCENT = 0.1;

describe('computeThumbnailOffset', () => {
  it('should take the frame at the configured percentage for a long video', () => {
    expect(computeThumbnailOffset(600, PERCENT)).toBe(60);
  });

  it('should never go below one second, even when the percentage would', () => {
    // 10% of 5s is 0.5s, which risks landing on the opening fade.
    expect(computeThumbnailOffset(5, PERCENT)).toBe(1);
  });

  it('should stay strictly inside the video near its end', () => {
    expect(computeThumbnailOffset(1.05, PERCENT)).toBeCloseTo(0.95, 5);
    expect(computeThumbnailOffset(1.05, PERCENT)).toBeLessThan(1.05);
  });

  it('should fall back to the first frame for a sub-second video', () => {
    expect(computeThumbnailOffset(0.4, PERCENT)).toBe(0);
  });

  it('should return zero for a zero or negative duration', () => {
    expect(computeThumbnailOffset(0, PERCENT)).toBe(0);
    expect(computeThumbnailOffset(-3, PERCENT)).toBe(0);
  });

  it('should return zero when the duration is not a finite number', () => {
    expect(computeThumbnailOffset(Number.NaN, PERCENT)).toBe(0);
    expect(computeThumbnailOffset(Number.POSITIVE_INFINITY, PERCENT)).toBe(0);
  });

  it('should be deterministic, so a retry reproduces the same frame', () => {
    expect(computeThumbnailOffset(123.456, PERCENT)).toBe(
      computeThumbnailOffset(123.456, PERCENT),
    );
  });

  it('should honour a different percentage', () => {
    expect(computeThumbnailOffset(600, 0.5)).toBe(300);
  });

  it('should always produce an offset that is inside the video', () => {
    for (const duration of [1, 2, 10, 60, 3600, 1.001]) {
      const offset = computeThumbnailOffset(duration, PERCENT);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(duration);
    }
  });
});
