/**
 * A self-contained QR encoder, so linking a device needs no dependency.
 *
 * Byte mode only, which is all the pairing payload needs, across all 40
 * versions at error-correction level L. Everything that can be derived is
 * derived; the only hard-coded tables are the ones ISO/IEC 18004 defines by
 * fiat (Reed-Solomon block layout and alignment-pattern centres).
 */

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

/** Reed-Solomon layout per version at level L: [ecPerBlock, n1, d1, n2, d2]. */
const RS_L: readonly (readonly [number, number, number, number, number])[] = [
  [7, 1, 19, 0, 0],
  [10, 1, 34, 0, 0],
  [15, 1, 55, 0, 0],
  [20, 1, 80, 0, 0],
  [26, 1, 108, 0, 0],
  [18, 2, 68, 0, 0],
  [20, 2, 78, 0, 0],
  [24, 2, 97, 0, 0],
  [30, 2, 116, 0, 0],
  [18, 2, 68, 2, 69],
  [20, 4, 81, 0, 0],
  [24, 2, 92, 2, 93],
  [26, 4, 107, 0, 0],
  [30, 3, 115, 1, 116],
  [22, 5, 87, 1, 88],
  [24, 5, 98, 1, 99],
  [28, 1, 107, 5, 108],
  [30, 5, 120, 1, 121],
  [28, 3, 113, 4, 114],
  [28, 3, 107, 5, 108],
  [28, 4, 116, 4, 117],
  [28, 2, 111, 7, 112],
  [30, 4, 121, 5, 122],
  [30, 6, 117, 4, 118],
  [26, 8, 106, 4, 107],
  [28, 10, 114, 2, 115],
  [30, 8, 122, 4, 123],
  [30, 3, 117, 10, 118],
  [30, 7, 116, 7, 117],
  [30, 5, 115, 10, 116],
  [30, 13, 115, 3, 116],
  [30, 17, 115, 0, 0],
  [30, 17, 115, 1, 116],
  [30, 13, 115, 6, 116],
  [30, 12, 121, 7, 122],
  [30, 6, 121, 14, 122],
  [30, 17, 122, 4, 123],
  [30, 4, 122, 18, 123],
  [30, 20, 117, 4, 118],
  [30, 19, 118, 6, 119],
];

/** Alignment-pattern centre coordinates, indexed by version. Version 1 has none. */
const ALIGN: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const EC_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// ── GF(256) ───────────────────────────────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR field polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i] = next[i]! ^ poly[i]!;
      next[i + 1] = next[i + 1]! ^ gfMul(poly[i]!, EXP[d]!);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of `data` divided by the degree-`ec` generator: the EC codewords. */
function rsEncode(data: Uint8Array, ec: number): Uint8Array {
  const gen = rsGenerator(ec);
  const out = new Uint8Array(ec);
  for (const byte of data) {
    const factor = byte ^ out[0]!;
    out.copyWithin(0, 1);
    out[ec - 1] = 0;
    for (let i = 0; i < ec; i++) out[i] = out[i]! ^ gfMul(gen[i + 1]!, factor);
  }
  return out;
}

// ── BCH check bits ────────────────────────────────────────────────────────

function bch(value: number, poly: number, bits: number): number {
  let v = value << bits;
  const polyBits = 32 - Math.clz32(poly);
  while (32 - Math.clz32(v) >= polyBits) v ^= poly << (32 - Math.clz32(v) - polyBits);
  return v;
}

// ── Bit buffer ────────────────────────────────────────────────────────────

class Bits {
  readonly bytes: number[] = [];
  private len = 0;

  get length(): number {
    return this.len;
  }

  put(value: number, width: number): void {
    for (let i = width - 1; i >= 0; i--) this.putBit(((value >>> i) & 1) === 1);
  }

  putBit(on: boolean): void {
    if (this.len % 8 === 0) this.bytes.push(0);
    if (on) this.bytes[this.bytes.length - 1]! |= 0x80 >>> this.len % 8;
    this.len++;
  }
}

// ── Encoding ──────────────────────────────────────────────────────────────

const charCountBits = (version: number): number => (version < 10 ? 8 : 16);

function capacityBytes(version: number): number {
  const [, n1, d1, n2, d2] = RS_L[version - 1]!;
  return n1 * d1 + n2 * d2;
}

function pickVersion(byteLen: number): number {
  for (let v = 1; v <= 40; v++) {
    const needed = 4 + charCountBits(v) + byteLen * 8;
    if (capacityBytes(v) * 8 >= needed) return v;
  }
  throw new Error(`${byteLen} bytes is too long for a QR code`);
}

/** Data codewords plus interleaved Reed-Solomon parity, ready for placement. */
function codewords(data: Uint8Array, version: number): Uint8Array {
  const bits = new Bits();
  bits.put(4, 4); // byte mode
  bits.put(data.length, charCountBits(version));
  for (const b of data) bits.put(b, 8);

  const capacity = capacityBytes(version) * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.putBit(false);
  while (bits.length % 8 !== 0) bits.putBit(false);

  const padded = bits.bytes.slice();
  for (let i = 0; padded.length < capacityBytes(version); i++) padded.push(i % 2 === 0 ? 0xec : 0x11);

  const [ec, n1, d1, n2, d2] = RS_L[version - 1]!;
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let offset = 0;
  for (const [count, size] of [
    [n1, d1],
    [n2, d2],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const chunk = Uint8Array.from(padded.slice(offset, offset + size));
      offset += size;
      blocks.push({ data: chunk, ec: rsEncode(chunk, ec) });
    }
  }

  // Interleave: one codeword from each block in turn, data first then parity.
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  }
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]!);
  return Uint8Array.from(out);
}

// ── Matrix ────────────────────────────────────────────────────────────────

type Cell = boolean | null;

const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function blankMatrix(size: number): Cell[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => null as Cell));
}

/** Finder patterns, separators, timing, alignment and the fixed dark module. */
function drawFunctionPatterns(m: Cell[][], version: number): void {
  const size = m.length;

  const finder = (top: number, left: number): void => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = top + r;
        const x = left + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const ring = r >= 0 && r <= 6 && (c === 0 || c === 6);
        const bar = c >= 0 && c <= 6 && (r === 0 || r === 6);
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[y]![x] = ring || bar || core;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Alignment patterns come before timing: the ones centred on row or column 6
  // sit astride the timing line and take precedence over it.
  for (const row of ALIGN[version]!) {
    for (const col of ALIGN[version]!) {
      if (m[row]![col] !== null) continue; // coincides with a finder
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          m[row + r]![col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    const on = i % 2 === 0;
    if (m[6]![i] === null) m[6]![i] = on;
    if (m[i]![6] === null) m[i]![6] = on;
  }

  m[size - 8]![8] = true;

  // Reserve the format areas so data placement skips them.
  for (let i = 0; i < 9; i++) {
    if (m[8]![i] === null) m[8]![i] = false;
    if (m[i]![8] === null) m[i]![8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8]![size - 1 - i] === null) m[8]![size - 1 - i] = false;
    if (m[size - 1 - i]![8] === null) m[size - 1 - i]![8] = false;
  }

  if (version >= 7) {
    const info = (version << 12) | bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const on = ((info >>> i) & 1) === 1;
      m[Math.floor(i / 3)]![size - 11 + (i % 3)] = on;
      m[size - 11 + (i % 3)]![Math.floor(i / 3)] = on;
    }
  }
}

function drawFormat(m: Cell[][], ec: EcLevel, mask: number): void {
  const size = m.length;
  const raw = (EC_BITS[ec] << 3) | mask;
  const info = ((raw << 10) | bch(raw, 0x537, 10)) ^ 0x5412;
  const bit = (i: number): boolean => ((info >>> i) & 1) === 1;

  // Copy beside the top-left finder: down column 8, then left along row 8.
  for (let i = 0; i < 6; i++) m[i]![8] = bit(i);
  m[7]![8] = bit(6);
  m[8]![8] = bit(7);
  m[8]![7] = bit(8);
  for (let i = 9; i < 15; i++) m[8]![14 - i] = bit(i);

  // Copy split between the other two finders.
  for (let i = 0; i < 8; i++) m[8]![size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i]![8] = bit(i);
}

function placeData(m: Cell[][], data: Uint8Array, maskFn: (r: number, c: number) => boolean): void {
  const size = m.length;
  let bitIndex = 0;
  let upward = true;

  let right = size - 1;
  while (right > 0) {
    if (right === 6) right = 5; // column 6 is the vertical timing pattern
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (m[row]![col] !== null) continue;
        // Past the end of the stream the remainder bits stay light.
        const byte = data[bitIndex >>> 3];
        let dark = byte !== undefined && ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
        if (maskFn(row, col)) dark = !dark;
        m[row]![col] = dark;
        bitIndex++;
      }
    }
    upward = !upward;
    right -= 2;
  }
}

/** ISO/IEC 18004 §8.8.2 mask penalty. Lower is better. */
function penalty(m: Cell[][]): number {
  const size = m.length;
  const at = (r: number, c: number): boolean => m[r]![c] === true;
  let score = 0;

  // Rule 1: runs of five or more identical modules.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = horizontal ? at(i, j) : at(j, i);
        const prev = horizontal ? at(i, j - 1) : at(j - 1, i);
        if (cur === prev) {
          run++;
          continue;
        }
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2×2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (k: number) => boolean, start: number, pat: boolean[]): boolean => {
    for (let k = 0; k < 11; k++) if (get(start + k) !== pat[k]) return false;
    return true;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      const row = (k: number): boolean => at(i, k);
      const col = (k: number): boolean => at(k, i);
      if (matches(row, j, A) || matches(row, j, B)) score += 40;
      if (matches(col, j, A) || matches(col, j, B)) score += 40;
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (at(r, c)) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

/**
 * Encode `text` and return the module matrix, `true` being a dark module.
 * The mask is chosen by the standard penalty score.
 */
export function qrMatrix(text: string, ec: EcLevel = 'L'): boolean[][] {
  const data = new TextEncoder().encode(text);
  const version = pickVersion(data.length);
  const size = version * 4 + 17;
  const stream = codewords(data, version);

  let best: Cell[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = blankMatrix(size);
    drawFunctionPatterns(m, version);
    placeData(m, stream, MASKS[mask]!);
    drawFormat(m, ec, mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return (best!).map((row) => row.map((c) => c === true));
}

/**
 * Render a QR code for a terminal using half-block characters, two module rows
 * per text row.
 *
 * Dark modules are drawn as blank space and light ones as a filled block, which
 * is what makes this scannable on a dark terminal: the block glyph takes the
 * foreground colour and the gaps show the dark background, matching the
 * light-on-dark contrast a scanner expects.
 */
export function renderQr(text: string, ec: EcLevel = 'L'): string {
  const QUIET = 2;
  const qr = qrMatrix(text, ec);
  const size = qr.length + QUIET * 2;
  const dark = (r: number, c: number): boolean => {
    const y = r - QUIET;
    const x = c - QUIET;
    return y >= 0 && y < qr.length && x >= 0 && x < qr.length && qr[y]![x] === true;
  };

  const lines: string[] = [];
  for (let r = 0; r < size; r += 2) {
    let line = '';
    for (let c = 0; c < size; c++) {
      const top = dark(r, c);
      const bottom = r + 1 < size ? dark(r + 1, c) : false;
      if (top && bottom) line += ' ';
      else if (top) line += '▄'; // dark above, light below
      else if (bottom) line += '▀'; // light above, dark below
      else line += '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
