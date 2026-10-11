import { test, describe } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { photoToArt, readOrientation, orient, resampleArt, fitArt, frameArt, artSVG, RAMP } from "../src/art";
import { renderHTML, renderText, Deck } from "../src/cards";
import { parseSighting } from "../src/gemma";

/** A width × height RGBA image that goes from white on the left to black on the right. */
function gradient(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round(255 * (1 - x / (width - 1)));
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return data;
}

function pngOf(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  gradient(width, height).copy(png.data);
  return PNG.sync.write(png);
}

const density = (ch: string) => RAMP.indexOf(ch);

/** A minimal JPEG header carrying only an EXIF orientation tag. */
function exifJpeg(orientation: number, little = true): Buffer {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) => (little ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const payload = [...Buffer.from("Exif\0\0"), ...tiff];
  const len = payload.length + 2;
  return Buffer.from([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...payload, 0xff, 0xda]);
}

describe("photoToArt", () => {
  test("turns a PNG into ASCII art, dark areas dense", () => {
    const art = photoToArt(pngOf(200, 100), 40)!;
    assert.equal(art[0].length, 40);
    assert.equal(art.length, 10, "rows follow the aspect ratio and the 1:2 cell shape");
    for (const row of art) {
      assert.ok(density(row[0]) < density(row[row.length - 1]), row);
      assert.equal(row[0], " ", "white prints as paper");
      assert.equal(row[row.length - 1], "@", "black prints as the densest character");
    }
  });

  test("decodes JPEG", () => {
    const encoded = jpeg.encode({ width: 120, height: 60, data: gradient(120, 60) }, 90).data;
    const art = photoToArt(Buffer.from(encoded), 24)!;
    assert.equal(art[0].length, 24);
    assert.ok(density(art[2][0]) < density(art[2][23]));
  });

  test("crops tall photos to a square around the middle", () => {
    const art = photoToArt(pngOf(100, 300), 40)!;
    assert.equal(art[0].length, 40);
    assert.equal(art.length, 20, "a square photo is half as many rows as columns");
  });

  test("lifts mostly dark photos so they don't print as solid ink", () => {
    // Dark grey everywhere, with faint darker stripes and one bright spot.
    const w = 120, h = 60;
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = x > 100 && y < 10 ? 240 : x % 12 < 6 ? 40 : 55;
      png.data.set([v, v, v, 255], (y * w + x) * 4);
    }
    const art = photoToArt(PNG.sync.write(png), 40)!;
    const chars = new Set(art.join(""));
    assert.ok(chars.size >= 4, `dark photo uses ${chars.size} characters: ${[...chars].join("")}`);
    const dense = art.join("").split("").filter((c) => c === "@" || c === "%").length / (40 * art.length);
    assert.ok(dense < 0.6, `only ${Math.round(dense * 100)}% of cells are solid ink`);
  });

  test("returns null for formats it can't decode", () => {
    assert.equal(photoToArt(Buffer.from("RIFF....WEBPVP8 ")), null);
    assert.equal(photoToArt(Buffer.alloc(0)), null);
  });
});

describe("EXIF orientation", () => {
  test("reads the orientation tag in both byte orders", () => {
    assert.equal(readOrientation(exifJpeg(6)), 6);
    assert.equal(readOrientation(exifJpeg(8, false)), 8);
    assert.equal(readOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda])), 1);
    assert.equal(readOrientation(pngOf(4, 4)), 1);
  });

  test("survives truncated EXIF data", () => {
    const cut = exifJpeg(6).subarray(0, 20);
    assert.equal(readOrientation(cut), 1);
  });

  test("rotates 90 degrees clockwise for orientation 6", () => {
    // 3 wide, 2 tall:  a b c / d e f  ->  rotated: d a / e b / f c
    const img = { width: 3, height: 2, lum: Float32Array.from([1, 2, 3, 4, 5, 6]) };
    const out = orient(img, 6);
    assert.equal(out.width, 2);
    assert.equal(out.height, 3);
    assert.deepEqual(Array.from(out.lum), [4, 1, 5, 2, 6, 3]);
  });

  test("rotates counter-clockwise for 8 and mirrors for 2", () => {
    const img = { width: 3, height: 2, lum: Float32Array.from([1, 2, 3, 4, 5, 6]) };
    assert.deepEqual(Array.from(orient(img, 8).lum), [3, 6, 2, 5, 1, 4]);
    assert.deepEqual(Array.from(orient(img, 2).lum), [3, 2, 1, 6, 5, 4]);
    assert.deepEqual(Array.from(orient(img, 3).lum), [6, 5, 4, 3, 2, 1]);
  });
});

describe("resampling and framing", () => {
  const art = photoToArt(pngOf(320, 160), 64)!;

  test("resampleArt keeps the proportions and the gradient", () => {
    const small = resampleArt(art, 16);
    assert.equal(small[0].length, 16);
    assert.equal(small.length, Math.round(art.length * (16 / 64)));
    assert.ok(density(small[0][0]) < density(small[0][15]));
  });

  test("fitArt respects both limits", () => {
    for (const [cols, rows] of [[46, 13], [16, 5], [30, 30]]) {
      const fitted = fitArt(art, cols, rows);
      assert.ok(fitted[0].length <= cols && fitted.length <= rows, `${fitted[0].length}x${fitted.length}`);
    }
  });

  test("frameArt draws a closed frame with a label", () => {
    const framed = frameArt(["abc", "def"].map((r) => r.repeat(5)), "hint");
    assert.equal(framed[0], "+-[ hint ]------+");
    assert.ok(framed.every((l) => l.length === framed[0].length));
    assert.equal(framed[framed.length - 1], "+" + "-".repeat(15) + "+");
  });

  test("artSVG pins every row to the same width", () => {
    const svg = artSVG(frameArt(fitArt(art, 20, 8)), 200);
    const lengths = new Set(Array.from(svg.matchAll(/textLength="([\d.]+)"/g), (m) => m[1]));
    assert.equal(lengths.size, 1);
    assert.match(svg, /width="200"/);
  });
});

describe("cards with photo art", () => {
  const art = photoToArt(pngOf(200, 100), 64)!;
  const card = (subject: string) => ({
    ...parseSighting(JSON.stringify({ subject, category: "tree", description: `A ${subject}.`, clue: "Tall and quiet.", look_for: ["bark", "leaves"], where: "Parks", confidence: "high" })),
    file: `${subject}.png`,
    sha256: subject,
    art,
  });
  const deck: Deck = { title: "Art test", mode: "guide", model: "gemma3:4b", createdAt: "2026-10-11T08:00:00.000Z", cards: [card("Oak"), card("Elm")] };

  test("every mode prints the photo by default, and art: none turns it off", () => {
    assert.match(renderHTML(deck), /class="art photo"/);
    const hunt = renderHTML({ ...deck, mode: "hunt" });
    assert.match(hunt, /class="art photo"/);
    assert.match(hunt, /\[ clue \]/, "the hunt clue sits under the photo");
    assert.doesNotMatch(renderHTML(deck, { art: "none" }), /class="art photo"/);
  });

  test("art: hint swaps the photo for a small, blurry hint", () => {
    const html = renderHTML({ ...deck, mode: "hunt" }, { art: "hint" });
    assert.match(html, /\[ hint \]/);
    assert.doesNotMatch(html, /class="art photo"/);
  });

  test("text cards include the art and stay within the column limit", () => {
    for (const cols of [32, 48]) {
      const text = renderText(deck, cols);
      assert.ok(text.includes("+-[ #01 tree ]"), "framed photo art");
      for (const line of text.split("\n")) assert.ok([...line].length <= cols, `${cols}: ${line}`);
      const hunt = renderText({ ...deck, mode: "hunt" }, cols);
      assert.ok(hunt.includes("> Tall and quiet."), "hunt text shows the clue under the photo");
      const hints = renderText({ ...deck, mode: "hunt" }, cols, "hint");
      assert.ok(hints.includes("[ hint ]"));
      for (const line of hints.split("\n")) assert.ok([...line].length <= cols, `${cols}: ${line}`);
    }
  });

  test("cards without art fall back to the text frame", () => {
    const noArt = { ...deck, cards: deck.cards.map(({ art: _art, ...c }) => c) };
    const html = renderHTML(noArt);
    assert.doesNotMatch(renderHTML({ ...noArt, mode: "hunt" }), /class="art photo"/);
    assert.doesNotMatch(html, /class="art photo"/);
    assert.match(html, /A Oak\./);
  });
});
