import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SKETCHES, SKETCH_IDS, pickSketch } from "../src/sketches";
import { sketchCard, renderHTML, renderText, Deck, Card } from "../src/cards";
import { parseSighting } from "../src/gemma";

const card = (over: Partial<Card> = {}): Card => ({
  ...parseSighting(
    JSON.stringify({
      subject: "Dark, watchful bird",
      category: "bird",
      description: "A glossy black bird perches on a branch.",
      clue: "Look for a bird with a sharp, pointed beak and dark plumage.",
      look_for: ["glossy feathers", "curved beak"],
      where: "Near trees",
      confidence: "medium",
      sketch: "bird",
    })
  ),
  file: "crow.jpg",
  sha256: "x",
  ...over,
});

describe("SKETCHES", () => {
  test("every drawing is plain ASCII and fits a 32-column receipt card", () => {
    for (const id of SKETCH_IDS) {
      const art = SKETCHES[id];
      assert.ok(art.length >= 4 && art.length <= 10, `${id}: ${art.length} rows`);
      for (const line of art) {
        assert.ok(line.length <= 26, `${id}: ${line}`);
        assert.match(line, /^[\x20-\x7e]*$/, `${id} is plain ASCII`);
      }
    }
  });
});

describe("pickSketch", () => {
  test("uses Gemma's choice when its words back it up", () => {
    assert.equal(pickSketch(card()), "bird");
  });

  test("lets the category back Gemma's choice", () => {
    assert.equal(pickSketch(card({ subject: "Attached tree growth", category: "fungus", description: "A white growth.", sketch: "mushroom" })), "mushroom");
  });

  test("overrides Gemma when the subject clearly names something else", () => {
    assert.equal(pickSketch(card({ subject: "A fallen log", category: "other", description: "Moss over a waterfall.", sketch: "cone" })), "tree");
  });

  test("falls back to keywords, then the category, then the magnifying glass", () => {
    assert.equal(pickSketch(card({ sketch: undefined, subject: "Lotus pond", description: "Leaves on still water." })), "flower");
    assert.equal(pickSketch(card({ sketch: undefined, subject: "Something odd", description: "Hard to say.", category: "rock" })), "rock");
    assert.equal(pickSketch(card({ sketch: undefined, subject: "Something odd", description: "Hard to say.", category: "other" })), "other");
  });

  test("parseSighting drops sketches that aren't in the library", () => {
    const s = parseSighting(JSON.stringify({ subject: "x", category: "bird", clue: "y", sketch: "dragon" }));
    assert.equal(s.sketch, undefined);
  });
});

describe("sketchCard", () => {
  test("frame and text layers are the same width on every row", () => {
    for (const cols of [32, 46]) {
      const { frame, text } = sketchCard(card(), 0, "hunt", cols);
      assert.equal(frame.length, text.length);
      for (const line of [...frame, ...text]) assert.equal(line.length, cols, JSON.stringify(line));
      assert.ok(frame[0].startsWith("+-[ #01 bird ]"));
      assert.ok(frame.some((l) => l.includes("( o>")), "the bird drawing is inside the frame");
    }
  });

  test("hunts show the clue; guides show the name", () => {
    const hunt = sketchCard(card(), 0, "hunt", 46).text.join(" ");
    assert.match(hunt, /sharp, pointed/);
    assert.doesNotMatch(hunt, /watchful bird/);
    assert.match(sketchCard(card(), 0, "guide", 46).text.join(" "), /Dark, watchful bird/);
  });
});

describe("sketch cards in the output", () => {
  const deck: Deck = { title: "Sketch test", mode: "hunt", model: "gemma3:4b", createdAt: "2026-10-11T08:00:00.000Z", cards: [card(), card({ sketch: "flower", subject: "Dandelion clock", category: "flower" })] };

  test("are the default on the printed sheet and keep answers hidden", () => {
    const html = renderHTML(deck);
    assert.match(html, /class="art sketch"/);
    const cardsPart = html.slice(0, html.indexOf('class="key"'));
    assert.doesNotMatch(cardsPart, /Dandelion clock/);
  });

  test("text cards merge both layers and stay within the column limit", () => {
    for (const cols of [32, 40, 48]) {
      const text = renderText(deck, cols);
      assert.ok(text.includes("( o>"));
      assert.ok(text.includes("pointed"));
      for (const line of text.split("\n")) assert.ok([...line].length <= cols, `${cols}: ${line}`);
    }
  });
});
