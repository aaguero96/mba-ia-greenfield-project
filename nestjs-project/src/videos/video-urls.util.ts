export interface VideoUrls {
  url: string;
  streamUrl: string;
  downloadUrl: string;
  thumbnailUrl: string | null;
}

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * The phase's deliverable is "URLs únicas geradas", so the API returns ready-made
 * absolute URLs rather than a fragment each client has to assemble (TD-15).
 * `hasThumbnail` is false until the worker has produced one.
 */
export function buildVideoUrls(
  baseUrl: string,
  publicId: string,
  hasThumbnail: boolean,
): VideoUrls {
  const url = join(baseUrl, `videos/${publicId}`);

  return {
    url,
    streamUrl: `${url}/stream`,
    downloadUrl: `${url}/download`,
    thumbnailUrl: hasThumbnail ? `${url}/thumbnail` : null,
  };
}
