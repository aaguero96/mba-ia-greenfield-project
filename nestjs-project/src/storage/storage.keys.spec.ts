import {
  safeExtension,
  videoSourceKey,
  videoThumbnailKey,
} from './storage.keys';

describe('storage keys', () => {
  const channelId = '11111111-1111-1111-1111-111111111111';
  const videoId = '22222222-2222-2222-2222-222222222222';

  describe('safeExtension', () => {
    it('should keep a normal video extension, lowercased', () => {
      expect(safeExtension('holiday.MP4')).toBe('.mp4');
    });

    it('should return an empty string when there is no extension', () => {
      expect(safeExtension('holiday')).toBe('');
    });

    it('should drop an extension containing non-alphanumeric characters', () => {
      expect(safeExtension('holiday.mp4;rm -rf')).toBe('');
    });

    it('should drop an absurdly long extension', () => {
      expect(safeExtension(`video.${'a'.repeat(50)}`)).toBe('');
    });

    it('should ignore directory components in the filename', () => {
      expect(safeExtension('../../etc/passwd.mkv')).toBe('.mkv');
    });
  });

  describe('videoSourceKey', () => {
    it('should place the object under the channel and video identifiers', () => {
      expect(videoSourceKey(channelId, videoId, 'holiday.mp4')).toBe(
        `videos/${channelId}/${videoId}/source.mp4`,
      );
    });

    it('should not let a traversal filename escape the prefix', () => {
      const key = videoSourceKey(channelId, videoId, '../../../evil.mp4');
      expect(key).toBe(`videos/${channelId}/${videoId}/source.mp4`);
      expect(key).not.toContain('..');
    });

    it('should produce a key without an extension when the filename has none', () => {
      expect(videoSourceKey(channelId, videoId, 'holiday')).toBe(
        `videos/${channelId}/${videoId}/source`,
      );
    });

    it('should give different videos different keys', () => {
      const other = '33333333-3333-3333-3333-333333333333';
      expect(videoSourceKey(channelId, videoId, 'a.mp4')).not.toBe(
        videoSourceKey(channelId, other, 'a.mp4'),
      );
    });
  });

  describe('videoThumbnailKey', () => {
    it('should be deterministic for the same video', () => {
      expect(videoThumbnailKey(channelId, videoId)).toBe(
        videoThumbnailKey(channelId, videoId),
      );
    });

    it('should place the thumbnail under the thumbnails prefix', () => {
      expect(videoThumbnailKey(channelId, videoId)).toBe(
        `thumbnails/${channelId}/${videoId}/thumb.jpg`,
      );
    });
  });
});
