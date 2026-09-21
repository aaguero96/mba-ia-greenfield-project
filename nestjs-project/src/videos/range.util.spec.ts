import {
  formatContentRange,
  parseRangeHeader,
  toRangeHeader,
} from './range.util';

const SIZE = 1000;

describe('parseRangeHeader', () => {
  it('should report no range when the header is absent', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
  });

  it('should parse an explicit start and end', () => {
    expect(parseRangeHeader('bytes=0-499', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 499 },
    });
  });

  it('should parse an open-ended range as running to the last byte', () => {
    expect(parseRangeHeader('bytes=500-', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 500, end: 999 },
    });
  });

  it('should parse a suffix range as the last N bytes', () => {
    expect(parseRangeHeader('bytes=-200', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 800, end: 999 },
    });
  });

  it('should clamp a suffix longer than the object to the whole object', () => {
    expect(parseRangeHeader('bytes=-5000', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 999 },
    });
  });

  it('should clamp an end beyond the object to the last byte', () => {
    expect(parseRangeHeader('bytes=900-5000', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 900, end: 999 },
    });
  });

  it('should report a start beyond the object as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=1000-1010', SIZE)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('should report an inverted range as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=500-100', SIZE)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('should report a zero-length suffix as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('should report any range against an empty object as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=0-10', 0)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('should treat a malformed header as no range', () => {
    for (const header of [
      'bytes=abc',
      'items=0-10',
      'bytes 0-10',
      '',
      'bytes=',
    ]) {
      expect(parseRangeHeader(header, SIZE)).toEqual({ kind: 'none' });
    }
  });

  it('should tolerate surrounding whitespace', () => {
    expect(parseRangeHeader('  bytes=0-9  ', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 9 },
    });
  });

  it('should accept a single-byte range', () => {
    expect(parseRangeHeader('bytes=0-0', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 0 },
    });
  });
});

describe('formatContentRange', () => {
  it('should render the Content-Range header value', () => {
    expect(formatContentRange({ start: 0, end: 499 }, SIZE)).toBe(
      'bytes 0-499/1000',
    );
  });
});

describe('toRangeHeader', () => {
  it('should render a Range header the storage client understands', () => {
    expect(toRangeHeader({ start: 10, end: 19 })).toBe('bytes=10-19');
  });
});
