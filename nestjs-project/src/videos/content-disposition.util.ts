/**
 * Builds a `Content-Disposition: attachment` value for a user-supplied filename.
 *
 * The quoted form cannot contain a quote or a backslash, and a header cannot
 * contain a newline, so those are stripped rather than escaped; a `filename*`
 * parameter carries the original name for clients that understand RFC 5987.
 */
export function buildAttachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[\\"\r\n]/g, '').trim() || 'video';
  const encoded = encodeURIComponent(filename.replace(/[\r\n]/g, ''));

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
