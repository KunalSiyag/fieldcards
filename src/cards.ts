import { generateAltSVG, generateAltASCII, wrapText, measureCells } from "altsvg";
import type { Sighting } from "./gemma";
import { artSVG, fitArt, frameArt, gridSVG } from "./art";
import { rasterize, Shape } from "./draw";
import type { Cell, CellKind } from "./anim";

export type Mode = "hunt" | "guide";

export interface Card extends Sighting {
  /** Photo file name, for the answer key. */
  file: string;
  /** SHA-256 of the photo, so re-runs only describe new photos. */
  sha256: string;
  /** The photo as ASCII art, 96 columns wide. Missing for formats we can't decode. */
  art?: string[];
  /** Gemma's own drawing of the subject, as shapes on a 100 x 60 canvas. */
  drawing?: Shape[];
  /** The model that made the drawing, so a different --draw-model redraws it. */
  drawModel?: string;
}

export interface Deck {
  title: string;
  mode: Mode;
  model: string;
  createdAt: string;
  cards: Card[];
}

/**
 * What each card shows above the text:
 * - "drawing" (default): Gemma's own drawing of what it saw, rendered as ASCII line art
 * - "photo": the photo itself, converted to characters
 * - "hint": a small, blurry version of the photo beside the clue
 * - "none": text cards only
 */
export type ArtMode = "drawing" | "photo" | "hint" | "none";

export interface RenderOptions {
  paper?: "a4" | "letter";
  art?: ArtMode;
}

// Photo art on a printed card: up to 70 columns plus the frame, 22 rows tall.
const ART_COLS = 70;
const ART_ROWS = 22;
const CARD_PX = 330;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (i: number) => `#${String(i + 1).padStart(2, "0")}`;

/** The text inside a card's ASCII frame: the clue in a hunt, the description in a guide. */
export function cardText(card: Card, mode: Mode): string {
  return mode === "hunt" ? card.clue : `${card.subject}. ${card.description}`;
}

/** The ASCII "photo" for one card: the picture is replaced by words you take outside. */
export function cardSVG(card: Card, index: number, mode: Mode, width = 330, height = 118, label?: string): string {
  return generateAltSVG(width, height, cardText(card, mode), {
    style: "ascii",
    label: label ?? `${num(index)} ${card.category}`,
    showSize: false,
    background: "none",
    textColor: "#111111",
    borderColor: "#6b6b6b",
    fontSize: 13,
  });
}

const cellsOf = (line: string, kind: CellKind): Cell[] => [...line].map((ch) => ({ ch, kind }));

/**
 * A hero-style card as a grid of cells: a +-[ #01 bird ]--+ frame holding
 * Gemma's drawing, with the clue (or, in a guide, the name) underneath. The
 * same grid is drawn as SVG on paper, printed in cards.txt, and animated in the
 * terminal, so all three always match.
 */
export function drawingCard(card: Card, index: number, mode: Mode, cols: number): Cell[][] {
  const inner = cols - 2;
  const art = card.drawing?.length ? rasterize(card.drawing, inner - 2, 12) : [];
  const words = wrap(mode === "hunt" ? card.clue : card.subject, inner - 4);

  const tag = `[ ${num(index)} ${card.category} ]`;
  const top = tag.length + 4 <= cols ? "+-" + tag + "-".repeat(cols - tag.length - 3) + "+" : "+" + "-".repeat(inner) + "+";
  const side = (content: Cell[]): Cell[] => [{ ch: "|", kind: "frame" }, ...content, { ch: "|", kind: "frame" }];
  const blank = () => side(cellsOf(" ".repeat(inner), "plain"));
  const centred = (line: string, kind: CellKind) => {
    const left = Math.floor((inner - measureCells(line)) / 2);
    return side(cellsOf(" ".repeat(left) + line + " ".repeat(Math.max(0, inner - left - measureCells(line))), kind));
  };

  const grid: Cell[][] = [cellsOf(top, "frame"), blank()];
  if (art.length) grid.push(...art.map((l) => centred(l, "art")), blank());
  grid.push(...words.map((w) => centred(w, "text")), blank(), cellsOf("+" + "-".repeat(inner) + "+", "frame"));
  return grid;
}

/** Draw a card grid as SVG: frame, drawing and clue each in their own style. */
function gridCardSVG(grid: Cell[][], width: number, label: string): string {
  const layer = (kind: CellKind) => grid.map((row) => row.map((c) => (c.kind === kind ? c.ch : " ")).join(""));
  return gridSVG(
    [
      { lines: layer("frame"), fill: "#8a8a8a" },
      { lines: layer("art"), fill: "#222222", weight: 700 },
      { lines: layer("text"), fill: "#111111", weight: 700 },
    ],
    width,
    label
  );
}

function details(card: Card): string {
  return `
      <dl>
        <dt>Look for</dt>
        <dd><ul>${card.lookFor.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></dd>
        <dt>Where</dt>
        <dd>${esc(card.where)}</dd>
      </dl>`;
}

function cardHTML(card: Card, index: number, mode: Mode, art: ArtMode): string {
  const heading = mode === "hunt" ? `Find ${num(index)}` : esc(card.subject);
  const unsure = card.confidence === "low" ? `<span class="unsure">best guess</span>` : "";
  const label = `${num(index)} ${card.category}`;
  let body: string;

  if (art === "drawing") {
    const grid = drawingCard(card, index, mode, 46);
    body = `
      <div class="art drawing">${gridCardSVG(grid, CARD_PX, mode === "hunt" ? card.clue : card.subject)}</div>${mode === "guide" ? `<p class="desc">${esc(card.description)}</p>` : ""}${details(card)}`;
  } else if (art === "photo" && card.art?.length) {
    // The photo printed in characters. Sized by column count, so portrait
    // photos print narrower rather than with bigger characters.
    const picture = frameArt(fitArt(card.art, ART_COLS, ART_ROWS), label);
    const cols = picture[0].length;
    const share = Math.round((cols / (ART_COLS + 2)) * 1000) / 10;
    const photo = `<div class="art photo" style="width:${share}%">${artSVG(picture, (cols * CARD_PX) / (ART_COLS + 2))}</div>`;
    body =
      mode === "guide"
        ? `${photo}<p class="desc">${esc(card.description)}</p>${details(card)}`
        : `${photo}<div class="art">${cardSVG(card, index, mode, CARD_PX, 96, "clue")}</div>${details(card)}`;
  } else if (art === "hint" && card.art?.length) {
    // A coarse picture beside the clue: enough to hint, too blurry to tell.
    const hint = frameArt(fitArt(card.art, 16, 5), "hint");
    const hintShare = Math.round((hint[0].length / 18) * 1000) / 10;
    body = `
      <div class="with-hint"><div class="hint"><div style="width:${hintShare}%">${artSVG(hint, hint[0].length * 7.33)}</div></div><div class="art">${cardSVG(card, index, mode, 215, 128)}</div></div>${details(card)}`;
  } else {
    body = `
      <div class="art">${cardSVG(card, index, mode)}</div>${details(card)}`;
  }

  return `
    <article class="card">
      <header><h2>${heading}</h2>${unsure}</header>${body}
      <footer><span class="box"></span> Found it <span class="line"></span> time</footer>
    </article>`;
}

function answerKey(deck: Deck): string {
  const rows = deck.cards
    .map(
      (c, i) =>
        `<tr><td>${num(i)}</td><td><b>${esc(c.subject)}</b><br><span>${esc(c.description)}</span></td><td>${c.confidence}</td></tr>`
    )
    .join("");
  return `
  <section class="key">
    <h2>Answer key</h2>
    <p>No peeking until you've looked. Answers are Gemma's best guesses from your photos, so check them against what you see.</p>
    <table><thead><tr><th>Card</th><th>Answer</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

/** A print-first HTML page: six cards to a sheet, and an answer key for hunts. */
export function renderHTML(deck: Deck, options: RenderOptions = {}): string {
  const paper = options.paper === "letter" ? "letter" : "A4";
  const art: ArtMode = options.art ?? "drawing";
  const intro =
    deck.mode === "hunt"
      ? deck.cards.length === 1
        ? "Find the thing on this card. Tick it off when you spot the real thing."
        : `Find all ${deck.cards.length}. Each card has a picture and a clue. Tick each one off when you spot the real thing.`
      : deck.cards.length === 1
        ? "One thing to look for. Tick it off when you spot it."
        : `${deck.cards.length} things to look for. Tick each one off when you spot it.`;
  const date = new Date(deck.createdAt).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(deck.title)}</title>
<style>
  @page { size: ${paper}; margin: 9mm 10mm; }
  * { box-sizing: border-box; }
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 24px 16px 48px;
    background: #ecebe4; color: #111;
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .sheet { max-width: 190mm; margin: 0 auto; background: #fff; padding: 10mm; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 6px; }
  h1 { font: 700 22px/1.2 ui-monospace, Menlo, Consolas, monospace; margin: 0; }
  .meta { font: 12px ui-monospace, Menlo, Consolas, monospace; color: #555; white-space: nowrap; }
  .intro { margin: 6px 0 10px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3.5mm; }
  @media (max-width: 560px) { .grid { grid-template-columns: minmax(0, 1fr); } }
  .card { border: 1px dashed #888; padding: 3mm 4mm; break-inside: avoid; display: grid; gap: 1.5mm; }
  .card header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .card h2 { font: 700 15px/1.2 ui-monospace, Menlo, Consolas, monospace; margin: 0; }
  .unsure { font: 11px ui-monospace, Menlo, Consolas, monospace; color: #555; border: 1px solid #aaa; border-radius: 3px; padding: 0 4px; }
  .art svg { display: block; width: 100%; height: auto; }
  .art.photo { margin: 0 auto; }
  .desc { margin: 0; font-size: 12.5px; }
  .with-hint { display: grid; grid-template-columns: 34% minmax(0, 1fr); gap: 2mm; align-items: center; }
  .hint svg { display: block; width: 100%; height: auto; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0.5mm 3mm; font-size: 12px; line-height: 1.35; }
  dt { font: 700 10.5px/1.6 ui-monospace, Menlo, Consolas, monospace; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  dd { margin: 0; }
  dd ul { margin: 0; padding-left: 1.1em; }
  .card footer { display: flex; align-items: center; gap: 6px; font: 12px ui-monospace, Menlo, Consolas, monospace; margin-top: 1mm; }
  .box { width: 14px; height: 14px; border: 1.5px solid #111; display: inline-block; }
  .line { flex: 1; border-bottom: 1px solid #999; height: 12px; margin-left: 10px; }
  .key { break-before: page; margin-top: 10mm; }
  .key h2 { font: 700 16px ui-monospace, Menlo, Consolas, monospace; margin: 0 0 4px; }
  .key p { margin: 0 0 8px; color: #444; }
  .key table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .key th, .key td { text-align: left; vertical-align: top; padding: 5px 6px; border-bottom: 1px solid #ddd; }
  .key td span { color: #555; }
  .note { margin-top: 8mm; padding-top: 3mm; border-top: 1px solid #ccc; font-size: 11px; color: #555; }
  .actions { max-width: 190mm; margin: 0 auto 12px; display: flex; justify-content: flex-end; }
  .actions button { font: 600 14px ui-monospace, Menlo, Consolas, monospace; padding: 8px 14px; border: 0; background: #111; color: #fff; cursor: pointer; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; max-width: none; padding: 0; }
    .actions { display: none; }
  }
</style>
</head>
<body>
<div class="actions"><button type="button" onclick="window.print()">Print</button></div>
<main class="sheet">
  <div class="top"><h1>${esc(deck.title)}</h1><span class="meta">${esc(date)} · ${deck.mode}</span></div>
  <p class="intro">${intro}</p>
  <div class="grid">${deck.cards.map((c, i) => cardHTML(c, i, deck.mode, art)).join("")}
  </div>
  ${deck.mode === "hunt" ? answerKey(deck) : ""}
  <p class="note">Made offline: ${esc(deck.model)} described the photos on this computer, and drew a picture of each one${art === "photo" ? "; the photos are printed in characters" : ""}. Look, don't pick: never eat or touch anything because a card says what it is.</p>
</main>
</body>
</html>
`;
}

function wrap(text: string, cols: number): string[] {
  return wrapText(text, cols, measureCells);
}

/** Wrap with a hanging indent: "- smooth bark that" / "  peels in strips". */
function hanging(prefix: string, text: string, cols: number): string[] {
  const indent = " ".repeat(measureCells(prefix));
  return wrap(text, cols - indent.length).map((line, i) => (i === 0 ? prefix : indent) + line);
}

/**
 * One card as a block of cells for the terminal and cards.txt: the framed
 * picture and clue, then what to look for and where.
 */
export function cardBlock(card: Card, index: number, mode: Mode, cols: number, art: ArtMode = "drawing"): Cell[][] {
  const width = Math.max(24, cols);
  const label = `${num(index)} ${card.category}`;
  const block: Cell[][] = [];
  const plain = (lines: string[]) => block.push(...lines.map((l) => cellsOf(l, "plain")));

  if (art === "drawing") {
    block.push(...drawingCard(card, index, mode, width));
    if (mode === "guide") plain(wrap(card.description, width));
  } else if (art === "photo" && card.art?.length) {
    block.push(...frameArt(fitArt(card.art, width - 2, 16), label).map((l) => cellsOf(l, "art")));
    if (mode === "guide") plain([...wrap(card.subject.toUpperCase(), width), ...wrap(card.description, width)]);
    else plain(wrap(`> ${card.clue}`, width));
  } else {
    if (art === "hint" && card.art?.length) block.push(...frameArt(fitArt(card.art, Math.min(16, width - 2), 6), "hint").map((l) => cellsOf(l, "art")));
    // generateAltASCII sizes its grid from pixels: 0.6em per column, 1.2em per row at 12px.
    // A fixed font size keeps the frame exactly `width` columns; it grows downwards to fit.
    const text = cardText(card, mode);
    const rows = Math.max(7, wrap(text, width - 6).length + 4);
    plain(generateAltASCII(width * 7.2, rows * 14.4, text, { style: "ascii", label, showSize: false, fontSize: 12, minFontSize: 12 }).split("\n"));
    if (mode === "guide") plain(wrap(card.subject.toUpperCase(), width));
  }
  for (const feature of card.lookFor) plain(hanging("- ", feature, width));
  plain(hanging("Where: ", card.where, width));
  plain(["[ ] found it   time: ______"]);
  return block;
}

/**
 * Plain-text cards, `cols` characters wide. Prints on any printer, including
 * a 58 mm receipt printer at 32 columns.
 */
export function renderText(deck: Deck, cols = 48, art: ArtMode = "drawing"): string {
  const width = Math.max(24, cols);
  const rule = "=".repeat(width);
  const out: string[] = [rule, ...wrap(deck.title.toUpperCase(), width), rule, ""];
  deck.cards.forEach((card, i) => {
    out.push(...cardBlock(card, i, deck.mode, width, art).map((row) => row.map((c) => c.ch).join("").replace(/\s+$/, "")), "");
  });
  if (deck.mode === "hunt") {
    out.push(rule, "ANSWERS (no peeking)", rule);
    deck.cards.forEach((card, i) => out.push(...wrap(`${num(i)}  ${card.subject} (${card.confidence})`, width)));
    out.push("");
  }
  out.push(...wrap(`Made offline with ${deck.model} and altsvg. Look, don't pick.`, width));
  return out.join("\n") + "\n";
}
