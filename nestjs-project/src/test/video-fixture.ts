import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FIXTURE_DIR = join(tmpdir(), 'streamtube-fixtures');

export interface VideoFixture {
  path: string;
  durationSeconds: number;
  width: number;
  height: number;
}

/**
 * Generates a small, deterministic MP4 with FFmpeg's built-in test source, so
 * the suite never depends on a binary asset committed to the repository. The
 * file is cached under the OS temp directory across runs.
 *
 * Only available where ffmpeg is installed — that is, the worker image.
 */
export async function createVideoFixture(
  durationSeconds = 3,
  width = 320,
  height = 240,
): Promise<VideoFixture> {
  await mkdir(FIXTURE_DIR, { recursive: true });

  const path = join(
    FIXTURE_DIR,
    `testsrc-${durationSeconds}s-${width}x${height}.mp4`,
  );

  try {
    await access(path);
    return { path, durationSeconds, width, height };
  } catch {
    // Not cached yet — generate it below.
  }

  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=10`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      // Puts the moov atom at the front, the common case for web video.
      '-movflags',
      '+faststart',
      '-y',
      path,
    ],
    { timeout: 120_000 },
  );

  return { path, durationSeconds, width, height };
}
