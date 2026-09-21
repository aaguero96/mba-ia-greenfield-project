/** DI token for the client whose endpoint is reachable inside the Compose network. */
export const S3_INTERNAL_CLIENT = 'S3_INTERNAL_CLIENT';

/**
 * DI token for the client whose endpoint is reachable by external clients.
 * A SigV4 signature binds the host it was signed for, so URLs handed to a browser
 * must be signed with this one (see TD-10).
 */
export const S3_PUBLIC_CLIENT = 'S3_PUBLIC_CLIENT';

/** Reaps multipart uploads a client started and never completed. */
export const ABORT_INCOMPLETE_MULTIPART_DAYS = 7;

export const ABORT_INCOMPLETE_MULTIPART_RULE_ID =
  'abort-incomplete-multipart-uploads';
