// Turns a photo into ASCII art for printing: the same idea as the hero on the
// altsvg landing page, but from real pixels. Dark areas become dense
// characters, so the picture comes out right in black ink on white paper.

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

/** Lightest (paper) to darkest (ink). The same ramp as the altsvg hero. */
export const RAMP = " .:-=+*#%@";

/** A monospace cell is about half as wide as it is tall (0.6em by 1.2em). */
const CELL_ASPECT = 0.5;

/** Columns stored in deck.json; every other size is resampled down from this. */
export const STORED_COLS = 96;

interface Gray {
  width: number;
  height: number;
  /** Luminance per pixel, 0 (black) to 1 (white). */
  lum: Float32Array;
}

/** Read the EXIF orientation (1-8) from a JPEG, so phone photos aren't sideways. */
export function readOrientation(buf: Buffer): number {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return 1;
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) return 1; // image data starts: no EXIF
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && off + 10 <= buf.length && buf.toString("ascii", off + 4, off + 8) === "Exif") {
      const tiff = off + 10;
      if (tiff + 8 > buf.length) return 1;
      const little = buf.toString("ascii", tiff, tiff + 2) === "II";
      const u16 = (at: number) => (little ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
      const u32 = (at: number) => (little ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > buf.length) return 1;
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 10 > buf.length) return 1;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    off += 2 + len;
  }
  return 1;
}

/** Apply an EXIF orientation to a grayscale image. */
export function orient(img: Gray, orientation: number): Gray {
  if (orientation <= 1 || orientation > 8) return img;
  const { width: w, height: h, lum } = img;
  const swap = orientation >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sx: number, sy: number;
      switch (orientation) {
        case 2: sx = w - 1 - x; sy = y; break; // mirror
        case 3: sx = w - 1 - x; sy = h - 1 - y; break; // rotate 180
        case 4: sx = x; sy = h - 1 - y; break; // flip
        case 5: sx = y; sy = x; break; // transpose
        case 6: sx = y; sy = h - 1 - x; break; // rotate 90 clockwise
        case 7: sx = w - 1 - y; sy = h - 1 - x; break; // transverse
        default: sx = w - 1 - y; sy = x; break; // 8: rotate 90 counter-clockwise
      }
      out[y * W + x] = lum[sy * w + sx];
    }
  }
  return { width: W, height: H, lum: out };
}

/** Decode a JPEG or PNG to luminance. Returns null for other formats. */
export function decodeGray(buf: Buffer): Gray | null {
  let width: number, height: number, rgba: Uint8Array;
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    ({ width, height } = img);
    rgba = img.data;
  } else if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    const img = PNG.sync.read(buf);
    ({ width, height } = img);
    rgba = img.data;
  } else {
    return null;
  }

  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const l = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) / 255;
    lum[i] = l * a + (1 - a); // transparent areas print as paper
  }
  return orient({ width, height, lum }, readOrientation(buf));
}

/** Area-average a grid of values down (or up) to tw × th. */
function areaAverage(src: ArrayLike<number>, sw: number, sh: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  const fx = sw / tw;
  const fy = sh / th;
  for (let ty = 0; ty < th; ty++) {
    const y0 = ty * fy;
    const y1 = y0 + fy;
    for (let tx = 0; tx < tw; tx++) {
      const x0 = tx * fx;
      const x1 = x0 + fx;
      let sum = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const wgt = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          sum += src[sy * sw + sx] * wgt;
          weight += wgt;
        }
      }
      out[ty * tw + tx] = weight > 0 ? sum / weight : 0;
    }
  }
  return out;
}

function toLines(darkness: Float32Array, cols: number, rows: number): string[] {
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const d = Math.min(1, Math.max(0, darkness[r * cols + c]));
      line += RAMP[Math.round(d * (RAMP.length - 1))];
    }
    lines.push(line);
  }
  return lines;
}

function rowsFor(cols: number, width: number, height: number): number {
  return Math.max(1, Math.round(cols * (height / width) * CELL_ASPECT));
}

/**
 * Render a photo as ASCII art `cols` characters wide. Contrast is stretched
 * between the 2nd and 98th percentile so dull photos still read clearly.
 * Returns null when the format isn't JPEG or PNG.
 */
export function photoToArt(buf: Buffer, cols = STORED_COLS): string[] | null {
  const img = decodeGray(buf);
  if (!img || img.width < 2 || img.height < 2) return null;
  const rows = rowsFor(cols, img.width, img.height);
  const cells = areaAverage(img.lum, img.width, img.height, cols, rows);

  const sorted = Array.from(cells).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))];
  const span = hi - lo;

  const darkness = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const v = span > 0.05 ? (cells[i] - lo) / span : cells[i];
    darkness[i] = 1 - v;
  }
  return toLines(darkness, cols, rows);
}

/** Resample stored art to `cols` columns, keeping its proportions. */
export function resampleArt(lines: string[], cols: number): string[] {
  const sh = lines.length;
  const sw = sh ? lines[0].length : 0;
  if (!sw || cols === sw) return lines.slice();
  const density = new Float32Array(sw * sh);
  lines.forEach((line, r) => {
    for (let c = 0; c < sw; c++) density[r * sw + c] = Math.max(0, RAMP.indexOf(line[c] ?? " ")) / (RAMP.length - 1);
  });
  const rows = Math.max(1, Math.round(sh * (cols / sw)));
  return toLines(areaAverage(density, sw, sh, cols, rows), cols, rows);
}

/** Resample art to fit within maxCols × maxRows. */
export function fitArt(lines: string[], maxCols: number, maxRows: number): string[] {
  const sh = lines.length;
  const sw = sh ? lines[0].length : 0;
  if (!sw) return [];
  const cols = Math.max(4, Math.min(maxCols, Math.floor((maxRows * sw) / sh)));
  return resampleArt(lines, cols);
}

/** Put art inside an ASCII frame: +-[ label ]---+ / |art| / +----+. */
export function frameArt(lines: string[], label?: string): string[] {
  const cols = lines[0]?.length ?? 0;
  let top = "+" + "-".repeat(cols) + "+";
  if (label) {
    const tag = `[ ${label} ]`;
    if (tag.length + 3 <= cols) top = "+-" + tag + "-".repeat(cols - tag.length - 1) + "+";
  }
  return [top, ...lines.map((l) => `|${l}|`), "+" + "-".repeat(cols) + "+"];
}

const escapeXML = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Draw ASCII lines as an SVG `width` px wide. Each row is pinned with
 * textLength, so columns line up in whatever monospace font prints it.
 */
export function artSVG(lines: string[], width: number, color = "#111111", weight = 700): string {
  const cols = Math.max(...lines.map((l) => l.length), 1);
  const cw = width / cols;
  const size = cw / 0.6;
  const lh = size * 1.2;
  const height = Math.ceil(lines.length * lh);
  const r = (n: number) => Math.round(n * 100) / 100;
  const rows = lines
    .map(
      (line, i) =>
        `<text x="0" y="${r(i * lh + lh * 0.8)}" textLength="${r(line.length * cw)}" lengthAdjust="spacingAndGlyphs">${escapeXML(line)}</text>`
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r(width)}" height="${height}" viewBox="0 0 ${r(width)} ${height}" aria-hidden="true">` +
    `<g font-family="ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${r(size)}" font-weight="${weight}" fill="${color}" xml:space="preserve" style="white-space:pre">${rows}</g></svg>`
  );
}
