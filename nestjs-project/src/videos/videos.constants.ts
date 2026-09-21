/** Multipart part size. 64MiB keeps a 10GiB upload at 160 parts (S3 caps at 10,000). */
export const VIDEO_PART_SIZE_BYTES = 64 * 1024 * 1024;

/** Hard ceiling from the phase requirement: 10GiB. */
export const VIDEO_MAX_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

/** S3 multipart limit: part numbers run from 1 to 10,000. */
export const VIDEO_MAX_PARTS = 10_000;

/** Upper bound on how many part URLs may be signed in one request. */
export const VIDEO_MAX_PARTS_PER_SIGN_REQUEST = 1000;

export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
] as const;

export type AllowedVideoContentType =
  (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number];

export const VIDEO_PUBLIC_ID_BYTES = 8;

/** base64url of 8 bytes is always 11 characters. */
export const VIDEO_PUBLIC_ID_LENGTH = 11;

/** Bounded retry when a generated public_id collides with an existing row. */
export const VIDEO_PUBLIC_ID_MAX_ATTEMPTS = 5;
