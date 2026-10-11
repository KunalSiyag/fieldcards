#!/usr/bin/env node
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseArgs } from "util";
import { describePhoto, GemmaError, DEFAULT_HOST, DEFAULT_MODEL } from "./gemma";
import { renderHTML, renderText, cardBlock, ArtMode, Card, Deck, Mode } from "./cards";
import { photoToArt } from "./art";
import { drawSubject } from "./draw";
import { CardAnimator } from "./anim";

const USAGE = `fieldcards: turn your outdoor photos into printable scavenger-hunt cards, offline.

Usage:
  fieldcards <photos or folders...> [options]
  fieldcards --from <deck.json> [options]     Re-print an edited deck without the model

Options:
  -o, --out <dir>        Output folder (default ./fieldcards-out)
  -t, --title <text>     Title printed on the sheet (default "Field Cards")
  -m, --mode <mode>      hunt (clues, answer key) or guide (names and descriptions). Default hunt
      --model <name>     Ollama model that reads the photos (default ${DEFAULT_MODEL})
      --draw-model <name>  Ollama model that draws each card's picture (default: --model)
      --host <url>       Ollama server (default ${DEFAULT_HOST})
      --paper <size>     a4 or letter (default a4)
      --cols <n>         Width of cards.txt in characters (default 48; 32 for a receipt printer)
      --from <file>      Load cards from a deck.json instead of running the model
      --stdout           Also print the text cards to the terminal (pipe to "lp" to print them)
      --art <style>      What each card shows: drawing (Gemma draws what it saw, default),
                         photo (the photo in characters), hint (a small, blurry photo) or none
      --no-anim          Plain progress lines instead of the animated cards
      --no-art           Same as --art none
      --hint-art         Same as --art hint
  -h, --help             Show this help

Writes index.html (print it), cards.txt (plain text) and deck.json (edit it, then use --from).`;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function fail(message: string): never {
  process.stderr.write(`fieldcards: ${message}\n`);
  process.exit(1);
}

function collectPhotos(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) fail(`no such file or folder: ${input}`);
    if (fs.statSync(input).isDirectory()) {
      for (const name of fs.readdirSync(input).sort()) {
        if (IMAGE_EXT.has(path.extname(name).toLowerCase())) files.push(path.join(input, name));
      }
    } else if (IMAGE_EXT.has(path.extname(input).toLowerCase())) {
      files.push(input);
    } else {
      process.stderr.write(`skipping ${input}: use JPEG, PNG or WebP (convert HEIC photos first)\n`);
    }
  }
  return files;
}

function loadDeck(file: string): Deck | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Deck;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        title: { type: "string", short: "t" },
        mode: { type: "string", short: "m" },
        model: { type: "string" },
        "draw-model": { type: "string" },
        "no-anim": { type: "boolean" },
        host: { type: "string" },
        paper: { type: "string" },
        cols: { type: "string" },
        from: { type: "string" },
        art: { type: "string" },
        "no-art": { type: "boolean" },
        stdout: { type: "boolean" },
        "hint-art": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help || (!positionals.length && !values.from)) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const mode = (values.mode ?? "hunt") as Mode;
  if (mode !== "hunt" && mode !== "guide") fail(`--mode must be hunt or guide`);
  const paper = values.paper === "letter" ? "letter" : "a4";
  const cols = values.cols ? Number(values.cols) : 48;
  if (!Number.isInteger(cols) || cols < 24) fail("--cols must be a whole number of at least 24");

  const outDir = values.out ?? "fieldcards-out";
  fs.mkdirSync(outDir, { recursive: true });
  const deckFile = path.join(outDir, "deck.json");

  let art = (values["no-art"] ? "none" : values["hint-art"] ? "hint" : values.art ?? "drawing") as string;
  if (art === "full") art = "photo";
  if (art === "sketch") art = "drawing";
  if (!["drawing", "photo", "hint", "none"].includes(art)) fail("--art must be drawing, photo, hint or none");
  const artMode = art as ArtMode;

  // Animated cards in an interactive terminal; plain lines anywhere else.
  const animate = !!process.stderr.isTTY && !values["no-anim"] && !process.env.CI;
  const termCols = Math.max(24, Math.min(cols, (process.stderr.columns ?? 80) - 1));
  const anim = animate ? new CardAnimator(process.stderr, termCols, 14, !process.env.NO_COLOR) : null;
  process.on("SIGINT", () => {
    anim?.stop();
    process.exit(130);
  });

  let deck: Deck;
  if (values.from) {
    const loaded = loadDeck(values.from);
    if (!loaded) fail(`can't read ${values.from}`);
    deck = { ...loaded, mode: values.mode ? mode : loaded.mode, title: values.title ?? loaded.title };
  } else {
    const photos = collectPhotos(positionals);
    if (!photos.length) fail("no photos found (JPEG, PNG or WebP)");

    // Reuse earlier answers for photos we've already described.
    const previous = loadDeck(deckFile);
    const known = new Map((previous?.cards ?? []).map((c) => [c.sha256, c]));
    const model = values.model ?? DEFAULT_MODEL;
    const drawModel = values["draw-model"] ?? model;
    const cards: Card[] = [];

    const toDescribe = photos.length - photos.filter((f) => known.has(crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"))).length;
    if (toDescribe > 0) {
      process.stderr.write(
        `Describing ${toDescribe} photo${toDescribe === 1 ? "" : "s"} with ${model}${artMode === "drawing" ? `, drawn by ${drawModel}` : ""}, on this computer. The first one also loads the model, which can take a minute or two.\n\n`
      );
    }

    for (const [i, file] of photos.entries()) {
      const name = path.basename(file);
      const image = fs.readFileSync(file);
      const sha256 = crypto.createHash("sha256").update(image).digest("hex");
      const tag = `[${i + 1}/${photos.length}] ${name}`;
      const label = `#${String(i + 1).padStart(2, "0")} ${name}`;
      // ASCII art comes from the pixels, not the model, so it's cheap to redo.
      const photoArt = photoToArt(image) ?? undefined;
      const cached = known.get(sha256);
      let card: Card;
      const timings: string[] = [];

      try {
        if (cached && previous?.model === model) {
          card = { ...cached, file: name, art: photoArt ?? cached.art };
        } else {
          anim?.start(label, "Gemma is reading the photo");
          const started = Date.now();
          const sighting = await describePhoto(image, { model, host: values.host });
          timings.push(`read ${((Date.now() - started) / 1000).toFixed(1)}s`);
          card = { ...sighting, file: name, sha256, art: photoArt };
        }

        if (artMode === "drawing" && (!card.drawing?.length || card.drawModel !== drawModel)) {
          if (anim) {
            if (!timings.length) anim.start(label, `drawing: ${card.subject}`);
            else anim.status(`drawing: ${card.subject}`);
          }
          const started = Date.now();
          try {
            card.drawing = await drawSubject(card.subject, card.description, { model: drawModel, host: values.host });
            card.drawModel = drawModel;
          } catch (err) {
            // A failed drawing shouldn't lose the card: it prints with the clue only.
            if (!(err instanceof GemmaError) || /isn't installed|Can't reach/.test(err.message)) throw err;
            card.drawing = [];
          }
          timings.push(`drew ${((Date.now() - started) / 1000).toFixed(1)}s`);
        }
      } catch (err) {
        anim?.stop();
        if (err instanceof GemmaError) fail(err.message);
        throw err;
      }

      cards.push(card);
      const note = timings.length ? `${card.confidence}, ${timings.join(", ")}` : "already described";
      if (anim) {
        if (!timings.length) anim.start(label, "from deck.json");
        await anim.reveal(cardBlock(card, i, mode, termCols, artMode), timings.length ? 900 : 350);
        process.stderr.write((process.env.NO_COLOR ? "" : "\x1b[90m") + `${tag} -> ${card.subject} (${note})` + (process.env.NO_COLOR ? "" : "\x1b[0m") + "\n\n");
      } else {
        process.stderr.write(`${tag} -> ${card.subject} (${note})\n`);
      }
    }

    deck = {
      title: values.title ?? previous?.title ?? "Field Cards",
      mode,
      model,
      createdAt: new Date().toISOString(),
      cards,
    };
  }

  fs.writeFileSync(deckFile, JSON.stringify(deck, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "index.html"), renderHTML(deck, { paper, art: artMode }));
  const text = renderText(deck, cols, artMode);
  fs.writeFileSync(path.join(outDir, "cards.txt"), text);
  // Progress goes to stderr, so stdout carries only the cards and can be piped.
  // When the cards were just animated onto this same terminal, don't print them twice.
  const alreadyShown = !!anim && !values.from && !!process.stdout.isTTY;
  if (values.stdout && !alreadyShown) process.stdout.write(text);

  process.stderr.write(
    `\nWrote ${deck.cards.length} card${deck.cards.length === 1 ? "" : "s"} to ${outDir}/\n` +
      `  index.html  open it and print\n` +
      `  cards.txt   plain text, ${cols} columns\n` +
      `  deck.json   fix anything Gemma got wrong, then: fieldcards --from ${deckFile}\n`
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
