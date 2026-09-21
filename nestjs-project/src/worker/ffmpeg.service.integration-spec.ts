import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import videoConfig from '../config/video.config';
import { createVideoFixture } from '../test/video-fixture';
import type { VideoFixture } from '../test/video-fixture';
import { FfmpegService } from './ffmpeg.service';

/**
 * Runs the real ffprobe/ffmpeg binaries against a generated fixture. Mocking
 * them would test the argument arrays (which the unit spec already does) and
 * nothing about whether FFmpeg actually produces what the phase needs.
 */
describe('FfmpegService (integration)', () => {
  let service: FfmpegService;
  let fixture: VideoFixture;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        FfmpegService,
        { provide: videoConfig.KEY, useValue: videoConfig() },
      ],
    }).compile();

    service = moduleRef.get(FfmpegService);
    fixture = await createVideoFixture(3, 320, 240);
  }, 120_000);

  describe('probe', () => {
    it('should read the real duration within a tenth of a second', async () => {
      const result = await service.probe(fixture.path);

      expect(result.durationSeconds).toBeCloseTo(fixture.durationSeconds, 1);
    }, 60_000);

    it('should read the real resolution and codec', async () => {
      const result = await service.probe(fixture.path);

      expect(result.width).toBe(fixture.width);
      expect(result.height).toBe(fixture.height);
      expect(result.codec).toBe('h264');
      expect(result.formatName).toContain('mp4');
    }, 60_000);

    it('should report a bitrate', async () => {
      const result = await service.probe(fixture.path);

      expect(result.bitrate).toBeGreaterThan(0);
    }, 60_000);

    it('should fail on a file that is not a video', async () => {
      await expect(service.probe('/etc/hostname')).rejects.toThrow();
    }, 60_000);
  });

  describe('extractThumbnail', () => {
    it('should produce a real JPEG', async () => {
      const buffer = await service.extractThumbnail(fixture.path, 1);

      expect(buffer.length).toBeGreaterThan(0);
      // JPEG magic number.
      expect(buffer[0]).toBe(0xff);
      expect(buffer[1]).toBe(0xd8);
    }, 60_000);

    it('should scale the frame to a width of 1280', async () => {
      const buffer = await service.extractThumbnail(fixture.path, 1);

      // Read the dimensions back out of the produced JPEG with ffprobe itself.
      const path = join(tmpdir(), `assert-${randomUUID()}.jpg`);
      await writeFile(path, buffer);

      try {
        const probed = await service.probe(path);
        expect(probed.width).toBe(1280);
        // 320x240 scaled to width 1280 gives height 960, and -2 keeps it even.
        expect(probed.height).toBe(960);
        expect((probed.height as number) % 2).toBe(0);
      } finally {
        await rm(path, { force: true });
      }
    }, 60_000);

    it('should produce the same bytes for the same offset, so a retry overwrites', async () => {
      const first = await service.extractThumbnail(fixture.path, 1);
      const second = await service.extractThumbnail(fixture.path, 1);

      expect(first.equals(second)).toBe(true);
    }, 60_000);

    it('should produce a different frame for a different offset', async () => {
      const early = await service.extractThumbnail(fixture.path, 0.5);
      const late = await service.extractThumbnail(fixture.path, 2.5);

      expect(early.equals(late)).toBe(false);
    }, 60_000);

    it('should fail on a source that is not decodable', async () => {
      await expect(
        service.extractThumbnail('/etc/hostname', 1),
      ).rejects.toThrow();
    }, 60_000);
  });
});
