import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../config/video.config';

const execFileAsync = promisify(execFile);

/** ffprobe's JSON output, narrowed to the fields this phase reads. */
interface FfprobeOutput {
  format?: {
    duration?: string;
    bit_rate?: string;
    format_name?: string;
  };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }[];
}

export interface VideoProbeResult {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
  formatName: string | null;
}

/**
 * Wraps the ffprobe/ffmpeg binaries.
 *
 * Both are invoked through `execFile` with an argument **array**, so no shell is
 * spawned and a pre-signed URL can never be interpreted as shell syntax. The
 * source is read over HTTP, which makes FFmpeg issue range requests and fetch
 * only the container header and the frames around the seek offset — a 10GB file
 * costs a few MB of transfer and no local disk (see TD-06).
 */
@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  constructor(
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async probe(url: string): Promise<VideoProbeResult> {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ],
      { timeout: this.config.ffmpegTimeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );

    return this.mapProbeOutput(JSON.parse(stdout) as FfprobeOutput);
  }

  private mapProbeOutput(output: FfprobeOutput): VideoProbeResult {
    const videoStream = (output.streams ?? []).find(
      (stream) => stream.codec_type === 'video',
    );

    const duration = Number(output.format?.duration);
    const bitrate = Number(output.format?.bit_rate);

    return {
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      codec: videoStream?.codec_name ?? null,
      bitrate: Number.isFinite(bitrate) ? bitrate : null,
      formatName: output.format?.format_name ?? null,
    };
  }

  /**
   * Cuts a single frame into a JPEG.
   *
   * `-ss` is placed **before** `-i` so FFmpeg seeks by keyframe before decoding
   * rather than decoding forward from the start — on a multi-GB source that is
   * the difference between a sub-second operation and minutes.
   */
  async extractThumbnail(url: string, offsetSeconds: number): Promise<Buffer> {
    const outputPath = join(tmpdir(), `thumb-${randomUUID()}.jpg`);

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          offsetSeconds.toFixed(3),
          '-i',
          url,
          '-frames:v',
          '1',
          '-vf',
          // -2 keeps the height even, which the JPEG encoder requires, while
          // preserving the aspect ratio.
          'scale=1280:-2',
          '-q:v',
          '3',
          '-f',
          'image2',
          '-y',
          outputPath,
        ],
        { timeout: this.config.ffmpegTimeoutMs },
      );

      return await readFile(outputPath);
    } finally {
      await rm(outputPath, { force: true }).catch(() => {
        this.logger.warn(`Failed to remove temporary file ${outputPath}`);
      });
    }
  }
}
