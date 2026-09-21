import { buildVideoUrls } from './video-urls.util';

describe('buildVideoUrls', () => {
  const publicId = 'AbCdEfGhIjK';

  it('should derive all four URLs from the base URL and the public id', () => {
    const urls = buildVideoUrls('http://localhost:3000', publicId, true);

    expect(urls).toEqual({
      url: `http://localhost:3000/videos/${publicId}`,
      streamUrl: `http://localhost:3000/videos/${publicId}/stream`,
      downloadUrl: `http://localhost:3000/videos/${publicId}/download`,
      thumbnailUrl: `http://localhost:3000/videos/${publicId}/thumbnail`,
    });
  });

  it('should not produce a double slash when the base URL has a trailing one', () => {
    const urls = buildVideoUrls('http://localhost:3000/', publicId, true);

    expect(urls.url).toBe(`http://localhost:3000/videos/${publicId}`);
    expect(urls.streamUrl).not.toContain('//videos');
  });

  it('should return a null thumbnail URL until one has been generated', () => {
    const urls = buildVideoUrls('http://localhost:3000', publicId, false);

    expect(urls.thumbnailUrl).toBeNull();
    // The other three are always available, even for a draft.
    expect(urls.url).toBeTruthy();
    expect(urls.streamUrl).toBeTruthy();
    expect(urls.downloadUrl).toBeTruthy();
  });

  it('should honour a base URL with a path prefix', () => {
    const urls = buildVideoUrls('https://cdn.example.com/api', publicId, false);

    expect(urls.url).toBe(`https://cdn.example.com/api/videos/${publicId}`);
  });

  it('should give different videos different URLs', () => {
    const a = buildVideoUrls('http://localhost:3000', 'aaaaaaaaaaa', false);
    const b = buildVideoUrls('http://localhost:3000', 'bbbbbbbbbbb', false);

    expect(a.url).not.toBe(b.url);
  });
});
