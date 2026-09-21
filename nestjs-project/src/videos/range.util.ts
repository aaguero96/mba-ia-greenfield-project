export interface ByteRange {
  start: number;
  end: number;
}

export type RangeResult =
  | { kind: 'none' }
  | { kind: 'satisfiable'; range: ByteRange }
  | { kind: 'unsatisfiable' };

const BYTES_UNIT = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a `Range` header against a known object size.
 *
 * Supports the three forms a player actually sends: `bytes=start-end`,
 * `bytes=start-` (open ended) and `bytes=-suffix` (the last N bytes). Anything
 * malformed is treated as "no range" and answered with the full body, which is
 * what RFC 9110 prescribes; a syntactically valid range that falls outside the
 * object is reported as unsatisfiable so the caller can answer 416.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): RangeResult {
  if (!header) {
    return { kind: 'none' };
  }

  const match = BYTES_UNIT.exec(header.trim());
  if (!match) {
    return { kind: 'none' };
  }

  const [, rawStart, rawEnd] = match;

  if (rawStart === '' && rawEnd === '') {
    return { kind: 'none' };
  }

  if (size <= 0) {
    return { kind: 'unsatisfiable' };
  }

  let start: number;
  let end: number;

  if (rawStart === '') {
    // Suffix form: the last N bytes, clamped to the whole object.
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) {
      return { kind: 'unsatisfiable' };
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (start >= size || start > end) {
    return { kind: 'unsatisfiable' };
  }

  // A client may ask beyond the end; the server answers with what exists.
  end = Math.min(end, size - 1);

  return { kind: 'satisfiable', range: { start, end } };
}

export function formatContentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}

export function toRangeHeader(range: ByteRange): string {
  return `bytes=${range.start}-${range.end}`;
}
