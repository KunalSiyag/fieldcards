import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseSighting, describePhoto, GemmaError, sentenceCase } from "../src/gemma";
import { renderHTML, renderText, Deck } from "../src/cards";

const good = {
  subject: "Red maple leaf",
  category: "tree",
  description: "A bright red maple leaf with five pointed lobes on wet grass.",
  clue: "In autumn I blush before I fall; count my five points.",
  look_for: ["five pointed lobes", "bright red colour", "toothed edges"],
  where: "Under broad trees in parks",
  confidence: "high",
};

describe("parseSighting", () => {
  test("maps the model's JSON to a card", () => {
    const s = parseSighting(JSON.stringify(good));
    assert.equal(s.subject, "Red maple leaf");
    assert.equal(s.category, "tree");
    assert.deepEqual(s.lookFor, good.look_for);
    assert.equal(s.confidence, "high");
  });

  test("never lets the clue give the answer away", () => {
    const s = parseSighting(JSON.stringify({ ...good, clue: "Find a red maple leaf under a tree." }));
    assert.ok(!s.clue.toLowerCase().includes("red maple leaf"), s.clue);
  });

  test("repairs bad categories, confidence, long text and missing fields", () => {
    const s = parseSighting(
      JSON.stringify({ subject: "", category: "spaceship", confidence: "certain", clue: "word ".repeat(60), look_for: "nope" })
    );
    assert.equal(s.category, "other");
    assert.equal(s.confidence, "low");
    assert.ok(s.clue.split(" ").length <= 25);
    assert.ok(s.subject.length > 0);
    assert.deepEqual(s.lookFor, []);
  });

  test("turns Title Case names into sentence case", () => {
    assert.equal(sentenceCase("Dandelion Seed Heads"), "Dandelion seed heads");
    assert.equal(sentenceCase("A sleek, dark bird"), "A sleek, dark bird");
    assert.equal(sentenceCase("Moss"), "Moss");
    assert.equal(sentenceCase("Tree-Clinging White Fungus"), "Tree-clinging white fungus");
  });

  test("rejects output that is not JSON", () => {
    assert.throws(() => parseSighting("Sure! Here is your card"), GemmaError);
  });
});

describe("describePhoto", () => {
  test("sends the image to the local model with a JSON schema", async () => {
    let sent: any;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ message: { content: JSON.stringify(good) } }));
    }) as unknown as typeof fetch;

    const s = await describePhoto(Buffer.from("fake-image"), { fetch: fakeFetch, model: "gemma3:4b" });
    assert.equal(s.subject, "Red maple leaf");
    assert.equal(sent.url, "http://localhost:11434/api/chat");
    assert.equal(sent.body.model, "gemma3:4b");
    assert.equal(sent.body.stream, false);
    assert.equal(sent.body.format.type, "object");
    assert.equal(sent.body.messages[1].images[0], Buffer.from("fake-image").toString("base64"));
  });

  test("explains how to fix a missing model or a stopped server", async () => {
    const missing = (async () => new Response('{"error":"model not found"}', { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(describePhoto(Buffer.from("x"), { fetch: missing }), /ollama pull gemma3:4b/);

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(describePhoto(Buffer.from("x"), { fetch: down }), /ollama serve/);
  });
});

const deck: Deck = {
  title: "Saturday in the park",
  mode: "hunt",
  model: "gemma3:4b",
  createdAt: "2026-10-11T08:00:00.000Z",
  cards: [
    { ...parseSighting(JSON.stringify(good)), file: "leaf.jpg", sha256: "a" },
    {
      ...parseSighting(JSON.stringify({ ...good, subject: "Common <b>& crow", category: "bird", clue: "Black, clever & loud.", confidence: "low" })),
      file: "crow.jpg",
      sha256: "b",
    },
  ],
};

describe("renderHTML", () => {
  test("hunt mode hides answers on the cards and lists them in the key", () => {
    const html = renderHTML(deck);
    const cardsPart = html.slice(0, html.indexOf('class="key"'));
    assert.ok(!cardsPart.includes("Red maple leaf"));
    assert.ok(cardsPart.includes("Find #01"));
    assert.ok(html.includes("Answer key"));
    assert.ok(html.includes("Red maple leaf"));
    assert.ok(html.includes("best guess"), "low confidence is flagged");
  });

  test("guide mode names things and has no answer key", () => {
    const html = renderHTML({ ...deck, mode: "guide" });
    assert.ok(html.includes("<h2>Red maple leaf</h2>"));
    assert.ok(!html.includes("Answer key"));
  });

  test("escapes model output", () => {
    const html = renderHTML(deck);
    assert.ok(!html.includes("<b>&"));
    assert.ok(html.includes("Common &lt;b&gt;&amp; crow"));
  });

  test("sets the paper size", () => {
    assert.match(renderHTML(deck, { paper: "letter" }), /@page \{ size: letter/);
    assert.match(renderHTML(deck), /@page \{ size: A4/);
  });
});

describe("renderText", () => {
  test("keeps every line within the column limit", () => {
    for (const cols of [32, 48]) {
      const text = renderText(deck, cols);
      for (const line of text.split("\n")) assert.ok([...line].length <= cols, `${cols}: ${JSON.stringify(line)}`);
      assert.ok(text.includes("[ ] found it"));
      assert.ok(text.includes("ANSWERS"));
    }
  });

  test("guide cards with long descriptions stay within the column limit", () => {
    const long = { ...deck, mode: "guide" as const, cards: deck.cards.map((c) => ({ ...c, description: "A long description of a bar top with many reflective surfaces, including a large circular table under a chandelier." })) };
    for (const cols of [32, 40, 48]) {
      for (const line of renderText(long, cols).split("\n")) assert.ok([...line].length <= cols, `${cols}: ${JSON.stringify(line)}`);
    }
  });
});
