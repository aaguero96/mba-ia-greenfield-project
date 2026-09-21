import { registerAs } from '@nestjs/config';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  VIDEO_MAX_PARTS,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_PART_SIZE_BYTES,
} from '../videos/videos.constants';

export default registerAs('video', () => ({
  partSizeBytes: VIDEO_PART_SIZE_BYTES,
  maxSizeBytes: VIDEO_MAX_SIZE_BYTES,
  maxParts: VIDEO_MAX_PARTS,
  allowedContentTypes: [...ALLOWED_VIDEO_CONTENT_TYPES],
  // Pre-signed URL lifetimes, in seconds (see TD-14). SigV4 caps these at 604800.
  uploadUrlTtl: parseInt(process.env.VIDEO_UPLOAD_URL_TTL || '21600', 10),
  probeUrlTtl: parseInt(process.env.VIDEO_PROBE_URL_TTL || '3600', 10),
  downloadUrlTtl: parseInt(process.env.VIDEO_DOWNLOAD_URL_TTL || '900', 10),
  // Thumbnail frame position as a fraction of the video duration (see TD-12).
  thumbnailPercent: parseFloat(process.env.VIDEO_THUMBNAIL_PERCENT || '0.1'),
  // Hard timeout for a single ffprobe/ffmpeg invocation, in milliseconds.
  ffmpegTimeoutMs: parseInt(
    process.env.VIDEO_FFMPEG_TIMEOUT_MS || '120000',
    10,
  ),
}));
