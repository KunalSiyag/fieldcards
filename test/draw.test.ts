import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseDrawing, rasterize, drawSubject, Shape } from "../src/draw";
import { noiseFrame, dissolveFrame, paint, Cell } from "../src/anim";
import { drawingCard, cardBlock, renderHTML, renderText, Card, Deck } from "../src/cards";
import { parseSighting } from "../src/gemma";

const shape = (kind: Shape["kind"], points: number[], fill = false): Shape => ({ part: kind, kind, points, fill });

describe("parseDrawing", () => {
  test("keeps well-formed shapes and drops broken ones", () => {
    const shapes = parseDrawing(
      JSON.stringify({
        shapes: [
          { part: "body", kind: "ellipse", points: [50, 30, 20, 10], fill: false },
          { part: "bad", kind: "circle", points: [1, 2], fill: false }, // too few numbers
          { part: "bad", kind: "star", points: [1, 2, 3], fill: false }, // unknown kind
          { part: "bad", kind: "polyline", points: [1, 2, 3], fill: false }, // odd count
          { part: "beak", kind: "polygon", points: [70, 28, 80, 30, 70, 32], fill: true },
          { part: "nan", kind: "line", points: [0, 0, "x", 4], fill: false },
        ],
      })
    );
    assert.deepEqual(shapes.map((s) => s.part), ["body", "beak"]);
    assert.equal(shapes[1].fill, true);
  });

  test("clamps wild coordinates", () => {
    const [s] = parseDrawing(JSON.stringify({ shapes: [{ part: "x", kind: "line", points: [-999, 0, 999, 0], fill: false }] }));
    assert.deepEqual(s.points, [-50, 0, 150, 0]);
  });
});

describe("rasterize", () => {
  test("a horizontal line draws dashes, a vertical one draws bars", () => {
    const flat = rasterize([shape("line", [0, 30, 100, 30])], 20, 6).join("");
    assert.match(flat, /^-+$/);
    const tall = rasterize([shape("line", [50, 0, 50, 60])], 20, 6);
    assert.ok(tall.length > 1 && tall.every((l) => l.trim() === "|"), tall.join("\n"));
  });

  test("diagonals use / and \\", () => {
    assert.match(rasterize([shape("line", [0, 60, 60, 0])], 20, 10).join(""), /\//);
    assert.match(rasterize([shape("line", [0, 0, 60, 60])], 20, 10).join(""), /\\/);
  });

  test("fits the drawing to the space and keeps every line the same width", () => {
    const art = rasterize([shape("circle", [50, 30, 25]), shape("circle", [50, 30, 3], true)], 30, 12);
    assert.ok(art.length <= 12 && art.length >= 6);
    assert.ok(art.every((l) => l.length === art[0].length && l.length <= 30));
    assert.ok(art.join("").includes("@"), "small filled details are solid");
  });

  test("big filled shapes stay outlines", () => {
    const art = rasterize([shape("rect", [0, 0, 100, 60], true)], 30, 12).join("");
    assert.ok(!art.includes("@"));
  });

  test("returns nothing for nothing", () => {
    assert.deepEqual(rasterize([], 30, 12), []);
  });
});

describe("drawSubject", () => {
  test("asks the draw model for shapes, text only", async () => {
    let body: any;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ shapes: [{ part: "body", kind: "circle", points: [50, 30, 10], fill: false }] }) } }));
    }) as unknown as typeof fetch;
    const shapes = await drawSubject("A crow", "A black bird on a branch.", { model: "gemma3:12b", fetch: fakeFetch });
    assert.equal(shapes.length, 1);
    assert.equal(body.model, "gemma3:12b");
    assert.equal(body.messages[1].content, "Draw: A crow. A black bird on a branch.");
    assert.equal(body.messages[1].images, undefined);
  });
});

const card = (drawing?: Shape[]): Card => ({
  ...parseSighting(JSON.stringify({ subject: "A crow", category: "bird", description: "A black bird.", clue: "Look up at the dark one with the sharp beak.", look_for: ["glossy feathers"], where: "Trees", confidence: "high" })),
  file: "crow.jpg",
  sha256: "x",
  drawing,
});

describe("drawing cards", () => {
  const drawing = [shape("ellipse", [50, 30, 20, 12]), shape("circle", [70, 22, 6]), shape("line", [10, 45, 90, 45])];

  test("frame, drawing and clue line up, all one width", () => {
    const grid = drawingCard(card(drawing), 0, "hunt", 40);
    assert.ok(grid.every((row) => row.length === 40));
    assert.ok(grid.some((row) => row.some((c) => c.kind === "art")), "has the drawing");
    assert.ok(grid.some((row) => row.some((c) => c.kind === "text")), "has the clue");
    assert.equal(grid[0].map((c) => c.ch).join("").slice(0, 14), "+-[ #01 bird ]");
  });

  test("a card without a drawing still shows the clue", () => {
    const grid = drawingCard(card([]), 0, "hunt", 40);
    assert.ok(!grid.some((row) => row.some((c) => c.kind === "art")));
    assert.match(grid.map((r) => r.map((c) => c.ch).join("")).join("\n"), /sharp beak/);
  });

  test("the clue card is the default; doodles are opt-in", () => {
    const deck: Deck = { title: "T", mode: "hunt", model: "gemma3:4b", createdAt: "2026-10-11T08:00:00.000Z", cards: [card(drawing)] };
    const clueOnly = cardBlock(card(drawing), 0, "hunt", 40);
    assert.ok(!clueOnly.some((row) => row.some((c) => c.kind === "art")), "no doodle by default");
    assert.ok(clueOnly.some((row) => row.some((c) => c.kind === "text")));
    assert.ok(cardBlock(card(drawing), 0, "hunt", 40, "drawing").some((row) => row.some((c) => c.kind === "art")));
    assert.match(renderHTML(deck), /class="art drawing"/);
    for (const art of ["clue", "drawing"] as const) {
      for (const cols of [32, 48]) {
        for (const line of renderText(deck, cols, art).split("\n")) assert.ok([...line].length <= cols, line);
      }
    }
  });
});

describe("terminal animation frames", () => {
  test("the noise frame is a closed, labelled box", () => {
    const grid = noiseFrame(30, 10, "#01 crow.jpg", 1.5);
    const lines = paint(grid, false);
    assert.equal(lines.length, 10);
    assert.ok(lines.every((l) => l.length === 30));
    assert.ok(lines[0].startsWith("+-[ #01 crow.jpg ]"));
    assert.ok(lines.slice(1, -1).every((l) => l.startsWith("|") && l.endsWith("|")));
  });

  test("the dissolve starts as noise and ends as the card", () => {
    const target: Cell[][] = paint(noiseFrame(20, 6, "x", 0), false).map((l) => [...l].map((ch) => ({ ch: ch === " " ? "A" : "A", kind: "text" as const })));
    const start = dissolveFrame(target, 0, 0);
    const end = dissolveFrame(target, 1.2, 0);
    assert.ok(start.flat().some((c) => c.ch !== "A"));
    assert.ok(end.flat().every((c) => c.ch === "A"));
  });

  test("colour can be turned off", () => {
    const plain = paint(noiseFrame(20, 5, "x", 0), false).join("");
    assert.ok(!plain.includes("\x1b"));
    assert.ok(paint(noiseFrame(20, 5, "x", 0), true).join("").includes("\x1b["));
  });
});
