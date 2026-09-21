import { buildAttachmentDisposition } from './content-disposition.util';

describe('buildAttachmentDisposition', () => {
  it('should mark the response as an attachment with the original filename', () => {
    const value = buildAttachmentDisposition('holiday.mp4');

    expect(value).toContain('attachment');
    expect(value).toContain('filename="holiday.mp4"');
  });

  it('should add an RFC 5987 parameter for non-ASCII names', () => {
    const value = buildAttachmentDisposition('férias no verão.mp4');

    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent('férias no verão.mp4'));
  });

  it('should strip quotes so the header cannot be broken out of', () => {
    const value = buildAttachmentDisposition('evil".mp4');

    expect(value).toContain('filename="evil.mp4"');
  });

  it('should strip CR and LF so no header can be injected', () => {
    const value = buildAttachmentDisposition('a\r\nX-Evil: 1.mp4');

    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
  });

  it('should fall back to a generic name when nothing usable remains', () => {
    expect(buildAttachmentDisposition('"""')).toContain('filename="video"');
  });
});
