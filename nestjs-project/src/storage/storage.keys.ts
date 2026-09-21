import { extname } from 'node:path';

/**
 * Only a short alphanumeric extension is carried over from the client-supplied
 * filename. Everything else about the key is derived from identifiers the server
 * owns, so a malicious filename cannot influence the object key.
 */
const SAFE_EXTENSION = /^\.[a-z0-9]{1,10}$/;

export function safeExtension(originalFilename: string): string {
  const extension = extname(originalFilename).toLowerCase();
  return SAFE_EXTENSION.test(extension) ? extension : '';
}

export function videoSourceKey(
  channelId: string,
  videoId: string,
  originalFilename: string,
): string {
  return `videos/${channelId}/${videoId}/source${safeExtension(originalFilename)}`;
}

/**
 * Deterministic: re-processing a video overwrites its thumbnail instead of
 * accumulating objects (see TD-09).
 */
export function videoThumbnailKey(channelId: string, videoId: string): string {
  return `thumbnails/${channelId}/${videoId}/thumb.jpg`;
}
