#!/usr/bin/env node
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseArgs } from "util";
import { describePhoto, GemmaError, DEFAULT_HOST, DEFAULT_MODEL } from "./gemma";
import { renderHTML, renderText, ArtMode, Card, Deck, Mode } from "./cards";
import { photoToArt } from "./art";

const USAGE = `fieldcards: turn your outdoor photos into printable scavenger-hunt cards, offline.

Usage:
  fieldcards <photos or folders...> [options]
  fieldcards --from <deck.json> [options]     Re-print an edited deck without the model

Options:
  -o, --out <dir>        Output folder (default ./fieldcards-out)
  -t, --title <text>     Title printed on the sheet (default "Field Cards")
  -m, --mode <mode>      hunt (clues, answer key) or guide (names and descriptions). Default hunt
      --model <name>     Ollama model (default ${DEFAULT_MODEL})
      --host <url>       Ollama server (default ${DEFAULT_HOST})
      --paper <size>     a4 or letter (default a4)
      --cols <n>         Width of cards.txt in characters (default 48; 32 for a receipt printer)
      --from <file>      Load cards from a deck.json instead of running the model
      --stdout           Also print the text cards to the terminal (pipe to "lp" to print them)
      --art <style>      How to print the photos: full (in characters, default), hint (small
                         and blurry, for a harder hunt) or none
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
    const cards: Card[] = [];

    const toDescribe = photos.length - photos.filter((f) => known.has(crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"))).length;
    if (toDescribe > 0) {
      process.stderr.write(`Describing ${toDescribe} photo${toDescribe === 1 ? "" : "s"} with ${model} on this computer. The first one also loads the model, which can take a minute or two.\n`);
    }

    for (const [i, file] of photos.entries()) {
      const image = fs.readFileSync(file);
      const sha256 = crypto.createHash("sha256").update(image).digest("hex");
      const tag = `[${i + 1}/${photos.length}] ${path.basename(file)}`;
      const cached = known.get(sha256);
      // ASCII art comes from the pixels, not the model, so it's cheap to redo.
      const art = photoToArt(image) ?? undefined;
      if (cached && previous?.model === model) {
        cards.push({ ...cached, file: path.basename(file), art: art ?? cached.art });
        process.stderr.write(`${tag} -> ${cached.subject} (already described)\n`);
        continue;
      }
      const started = Date.now();
      try {
        const sighting = await describePhoto(image, { model, host: values.host });
        cards.push({ ...sighting, file: path.basename(file), sha256, art });
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        process.stderr.write(`${tag} -> ${sighting.subject} (${sighting.confidence}, ${secs}s)\n`);
      } catch (err) {
        if (err instanceof GemmaError) fail(err.message);
        throw err;
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
  const art = (values["no-art"] ? "none" : values["hint-art"] ? "hint" : values.art ?? "full") as ArtMode;
  if (!["full", "hint", "none"].includes(art)) fail("--art must be full, hint or none");
  fs.writeFileSync(path.join(outDir, "index.html"), renderHTML(deck, { paper, art }));
  const text = renderText(deck, cols, art);
  fs.writeFileSync(path.join(outDir, "cards.txt"), text);
  // Progress goes to stderr, so stdout carries only the cards and can be piped.
  if (values.stdout) process.stdout.write(text);

  process.stderr.write(
    `\nWrote ${deck.cards.length} cards to ${outDir}/\n` +
      `  index.html  open it and print\n` +
      `  cards.txt   plain text, ${cols} columns\n` +
      `  deck.json   fix anything Gemma got wrong, then: fieldcards --from ${deckFile}\n`
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
