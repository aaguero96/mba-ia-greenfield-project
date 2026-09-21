/** Minimum offset, so the thumbnail is not the very first (often black) frame. */
const MIN_OFFSET_SECONDS = 1;

/** Keeps the offset strictly inside the video. */
const END_MARGIN_SECONDS = 0.1;

/**
 * Picks the timestamp the thumbnail is cut from (see TD-12).
 *
 * A percentage of the duration scales with the content — a ten-second clip and a
 * two-hour film both get a frame from a representative point — while a fixed
 * offset is a well-known way to ship black thumbnails. The clamp makes the rule
 * total: every duration, including degenerate ones, maps to a valid offset, and
 * the result is deterministic so a retry reproduces the same frame.
 */
export function computeThumbnailOffset(
  durationSeconds: number,
  percent: number,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }

  if (durationSeconds < MIN_OFFSET_SECONDS) {
    return 0;
  }

  const proportional = durationSeconds * percent;
  const latest = durationSeconds - END_MARGIN_SECONDS;

  return Math.min(Math.max(proportional, MIN_OFFSET_SECONDS), latest);
}
