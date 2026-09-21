import { execFile } from 'node:child_process';
import { Test } from '@nestjs/testing';
import videoConfig from '../config/video.config';
import { FfmpegService } from './ffmpeg.service';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

const execFileMock = execFile as unknown as jest.Mock;

/** `promisify(execFile)` calls the callback with (error, { stdout, stderr }). */
function resolveWith(stdout: string): void {
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (
        error: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      callback(null, { stdout, stderr: '' });
    },
  );
}

const PROBE_OUTPUT = JSON.stringify({
  format: {
    duration: '128.432000',
    bit_rate: '4500000',
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  },
  streams: [
    { codec_type: 'audio', codec_name: 'aac' },
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
  ],
});

describe('FfmpegService', () => {
  let service: FfmpegService;

  beforeEach(async () => {
    execFileMock.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        FfmpegService,
        { provide: videoConfig.KEY, useValue: videoConfig() },
      ],
    }).compile();

    service = moduleRef.get(FfmpegService);
  });

  describe('probe', () => {
    it('should ask ffprobe for JSON with format and streams', async () => {
      resolveWith(PROBE_OUTPUT);

      await service.probe('https://storage.test/video.mp4');

      const [command, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(command).toBe('ffprobe');
      expect(args).toEqual([
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        'https://storage.test/video.mp4',
      ]);
    });

    it('should pass arguments as an array so no shell is involved', async () => {
      resolveWith(PROBE_OUTPUT);

      // A URL containing shell metacharacters must be inert.
      await service.probe('https://storage.test/v.mp4?x=1&y=2;rm -rf /');

      const [, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(Array.isArray(args)).toBe(true);
      expect(args.at(-1)).toBe('https://storage.test/v.mp4?x=1&y=2;rm -rf /');
    });

    it('should map the ffprobe output onto the metadata the phase stores', async () => {
      resolveWith(PROBE_OUTPUT);

      const result = await service.probe('https://storage.test/video.mp4');

      expect(result).toEqual({
        durationSeconds: 128.432,
        width: 1920,
        height: 1080,
        codec: 'h264',
        bitrate: 4_500_000,
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      });
    });

    it('should pick the video stream, not the first stream', async () => {
      resolveWith(PROBE_OUTPUT);

      const result = await service.probe('https://storage.test/video.mp4');

      expect(result.codec).toBe('h264');
    });

    it('should tolerate a file with no video stream', async () => {
      resolveWith(
        JSON.stringify({
          format: { duration: '10.0' },
          streams: [{ codec_type: 'audio', codec_name: 'aac' }],
        }),
      );

      const result = await service.probe('https://storage.test/audio.m4a');

      expect(result.durationSeconds).toBe(10);
      expect(result.width).toBeNull();
      expect(result.codec).toBeNull();
    });

    it('should fall back to zero when the duration is unreadable', async () => {
      resolveWith(JSON.stringify({ format: {}, streams: [] }));

      const result = await service.probe('https://storage.test/weird.mp4');

      expect(result.durationSeconds).toBe(0);
      expect(result.bitrate).toBeNull();
    });

    it('should surface a non-zero exit as an error', async () => {
      execFileMock.mockImplementation(
        (
          _command: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error) => void,
        ) => {
          callback(new Error('ffprobe exited with code 1'));
        },
      );

      await expect(service.probe('https://storage.test/x')).rejects.toThrow(
        'ffprobe exited with code 1',
      );
    });
  });

  describe('extractThumbnail', () => {
    it('should place -ss before -i so the seek happens before decoding', async () => {
      execFileMock.mockImplementation(
        (
          _command: string,
          _args: string[],
          _options: unknown,
          callback: (
            error: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: '', stderr: '' });
        },
      );

      // readFile will fail since no file was really written; the argument order
      // is what this test is about.
      await service
        .extractThumbnail('https://storage.test/video.mp4', 12.5)
        .catch(() => undefined);

      const [command, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(command).toBe('ffmpeg');

      const ssIndex = args.indexOf('-ss');
      const inputIndex = args.indexOf('-i');
      expect(ssIndex).toBeGreaterThanOrEqual(0);
      expect(ssIndex).toBeLessThan(inputIndex);
      expect(args[ssIndex + 1]).toBe('12.500');
    });

    it('should request a single frame scaled to 1280 with an even height', async () => {
      execFileMock.mockImplementation(
        (
          _command: string,
          _args: string[],
          _options: unknown,
          callback: (
            error: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: '', stderr: '' });
        },
      );

      await service
        .extractThumbnail('https://storage.test/video.mp4', 1)
        .catch(() => undefined);

      const [, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(args).toEqual(expect.arrayContaining(['-frames:v', '1']));
      expect(args).toEqual(expect.arrayContaining(['-vf', 'scale=1280:-2']));
      expect(args).toEqual(expect.arrayContaining(['-q:v', '3']));
    });
  });
});
