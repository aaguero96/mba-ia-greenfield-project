import { randomBytes } from 'node:crypto';
import { VIDEO_PUBLIC_ID_BYTES } from './videos.constants';

/**
 * The short, opaque identifier that appears in a video's public URL.
 *
 * base64url of 8 random bytes is exactly 11 URL-safe characters carrying 64 bits
 * of entropy — the same shape as nanoid's default, without the dependency.
 * `nanoid@6` is not an option here: it ships ESM-only while this project compiles
 * to CommonJS, so importing it would fail at runtime (see TD-04).
 *
 * Uniqueness is guaranteed by the unique constraint on the column, not by this
 * function; callers retry on a collision.
 */
export function generatePublicId(): string {
  return randomBytes(VIDEO_PUBLIC_ID_BYTES).toString('base64url');
}
