import { generateAltSVG, generateAltASCII, wrapText, measureCells } from "altsvg";
import type { Sighting } from "./gemma";

export type Mode = "hunt" | "guide";

export interface Card extends Sighting {
  /** Photo file name, for the answer key. */
  file: string;
  /** SHA-256 of the photo, so re-runs only describe new photos. */
  sha256: string;
}

export interface Deck {
  title: string;
  mode: Mode;
  model: string;
  createdAt: string;
  cards: Card[];
}

export interface RenderOptions {
  paper?: "a4" | "letter";
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (i: number) => `#${String(i + 1).padStart(2, "0")}`;

/** The text inside a card's ASCII frame: the clue in a hunt, the description in a guide. */
export function cardText(card: Card, mode: Mode): string {
  return mode === "hunt" ? card.clue : `${card.subject}. ${card.description}`;
}

/** The ASCII "photo" for one card: the picture is replaced by words you take outside. */
export function cardSVG(card: Card, index: number, mode: Mode): string {
  return generateAltSVG(330, 118, cardText(card, mode), {
    style: "ascii",
    label: `${num(index)} ${card.category}`,
    showSize: false,
    background: "none",
    textColor: "#111111",
    borderColor: "#6b6b6b",
    fontSize: 13,
  });
}

function cardHTML(card: Card, index: number, mode: Mode): string {
  const heading = mode === "hunt" ? `Find ${num(index)}` : esc(card.subject);
  const unsure = card.confidence === "low" ? `<span class="unsure">best guess</span>` : "";
  return `
    <article class="card">
      <header><h2>${heading}</h2>${unsure}</header>
      <div class="art">${cardSVG(card, index, mode)}</div>
      <dl>
        <dt>Look for</dt>
        <dd><ul>${card.lookFor.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></dd>
        <dt>Where</dt>
        <dd>${esc(card.where)}</dd>
      </dl>
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
  const intro =
    deck.mode === "hunt"
      ? `Find all ${deck.cards.length}. Each card hides a photo behind a clue. Tick it off when you spot the real thing.`
      : `${deck.cards.length} things to look for. Tick each one off when you spot it.`;
  const date = new Date(deck.createdAt).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(deck.title)}</title>
<style>
  @page { size: ${paper}; margin: 11mm; }
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
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4mm; }
  @media (max-width: 560px) { .grid { grid-template-columns: minmax(0, 1fr); } }
  .card { border: 1px dashed #888; padding: 3mm 4mm; break-inside: avoid; display: grid; gap: 1.5mm; }
  .card header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .card h2 { font: 700 15px/1.2 ui-monospace, Menlo, Consolas, monospace; margin: 0; }
  .unsure { font: 11px ui-monospace, Menlo, Consolas, monospace; color: #555; border: 1px solid #aaa; border-radius: 3px; padding: 0 4px; }
  .art svg { display: block; width: 100%; height: auto; }
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
  <div class="grid">${deck.cards.map((c, i) => cardHTML(c, i, deck.mode)).join("")}
  </div>
  ${deck.mode === "hunt" ? answerKey(deck) : ""}
  <p class="note">Made offline: ${esc(deck.model)} described the photos on this computer, and altsvg drew the cards. Look, don't pick: never eat or touch anything because a card says what it is.</p>
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
 * Plain-text cards, `cols` characters wide. Prints on any printer, including
 * a 58 mm receipt printer at 32 columns.
 */
export function renderText(deck: Deck, cols = 48): string {
  const width = Math.max(24, cols);
  // generateAltASCII sizes the grid from pixels: 0.6em per column, 1.2em per row at 12px.
  const px = width * 0.6 * 12;
  const rule = "=".repeat(width);
  const out: string[] = [rule, ...wrap(deck.title.toUpperCase(), width), rule, ""];

  deck.cards.forEach((card, i) => {
    out.push(
      generateAltASCII(px, 7 * 14.4, cardText(card, deck.mode), {
        style: "ascii",
        label: `${num(i)} ${card.category}`,
        showSize: false,
        fontSize: 12,
      })
    );
    if (deck.mode === "guide") out.push(...wrap(card.subject.toUpperCase(), width));
    for (const feature of card.lookFor) out.push(...hanging("- ", feature, width));
    out.push(...hanging("Where: ", card.where, width));
    out.push("[ ] found it   time: ______", "");
  });

  if (deck.mode === "hunt") {
    out.push(rule, "ANSWERS (no peeking)", rule);
    deck.cards.forEach((card, i) => out.push(...wrap(`${num(i)}  ${card.subject} (${card.confidence})`, width)));
    out.push("");
  }
  out.push(...wrap(`Made offline with ${deck.model} and altsvg. Look, don't pick.`, width));
  return out.join("\n") + "\n";
}
