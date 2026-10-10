// Talks to a local Ollama server. Nothing here leaves the machine: photos are
// read from disk, sent to localhost, and the answer comes back as JSON.

export const CATEGORIES = [
  "tree",
  "plant",
  "flower",
  "fungus",
  "bird",
  "insect",
  "animal",
  "rock",
  "water",
  "sky",
  "landmark",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface Sighting {
  /** What to find, by its common name: "Red maple leaf", "Moss on a north-facing log". */
  subject: string;
  category: Category;
  /** One-sentence alt text for the photo. */
  description: string;
  /** A hint for finding it outdoors that does not name the subject. */
  clue: string;
  /** Two or three short identifying features. */
  lookFor: string[];
  /** Where you are likely to find it. */
  where: string;
  confidence: "low" | "medium" | "high";
}

export interface GemmaOptions {
  host?: string;
  model?: string;
  temperature?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export const DEFAULT_HOST = "http://localhost:11434";
export const DEFAULT_MODEL = "gemma3:4b";

const SYSTEM_PROMPT = `You are a field naturalist making printable cards for an outdoor scavenger hunt.
You look at one photo taken outside and describe the single most findable thing in it.
Write for someone standing outdoors with a printed card and no phone.
Be concrete and visual. Prefer common names. If you are unsure of the exact species, say what kind of thing it is ("a small brown songbird") and set confidence to "low".
The clue must help someone find the thing without naming it or its species. Do not start the clue with "Seek".
Never suggest eating, picking or touching anything.`;

const USER_PROMPT = `Make a scavenger-hunt card from this photo. Reply with JSON only:
- subject: common name of the main thing to find (max 6 words)
- category: one of ${CATEGORIES.join(", ")}
- description: alt text for the photo, one sentence, max 20 words
- clue: a hint to find it outdoors without naming it, max 18 words
- look_for: 2 or 3 identifying features, max 6 words each
- where: where it is usually found, max 8 words
- confidence: low, medium or high`;

// Ollama structured outputs: the model is constrained to this JSON schema.
const SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    description: { type: "string" },
    clue: { type: "string" },
    look_for: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 },
    where: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["subject", "category", "description", "clue", "look_for", "where", "confidence"],
};

export class GemmaError extends Error {}

function clean(value: unknown, maxWords: number, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return fallback;
  const words = text.split(" ");
  return words.length > maxWords ? words.slice(0, maxWords).join(" ") + "…" : text;
}

/** "Dandelion Seed Heads" -> "Dandelion seed heads". Leaves single words and acronyms alone. */
export function sentenceCase(text: string): string {
  const words = text.split(" ");
  const titleCased = words.length > 1 && words.every((w) => /^[A-Z][a-z'’]*(-[A-Za-z][a-z'’]*)*[,.]?$/.test(w));
  return titleCased ? words.map((w, i) => (i === 0 ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase())).join(" ") : text;
}

/** Validate and tidy the model's JSON so a sloppy answer can't break a card. */
export function parseSighting(raw: string): Sighting {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new GemmaError(`Model did not return JSON: ${raw.slice(0, 120)}`);
  }

  const category = CATEGORIES.includes(data.category as Category) ? (data.category as Category) : "other";
  const confidence = ["low", "medium", "high"].includes(data.confidence as string)
    ? (data.confidence as Sighting["confidence"])
    : "low";
  const lookFor = (Array.isArray(data.look_for) ? data.look_for : [])
    .map((f) => clean(f, 8, ""))
    .filter(Boolean)
    .slice(0, 3);

  const subject = sentenceCase(clean(data.subject, 8, "Something worth a closer look"));
  let clue = clean(data.clue, 24, "Look closely around you.");
  // The whole game breaks if the clue gives the answer away.
  if (subject.length > 3 && clue.toLowerCase().includes(subject.toLowerCase())) {
    clue = clue.replace(new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "it");
  }

  return {
    subject,
    category,
    description: clean(data.description, 28, subject),
    clue,
    lookFor,
    where: clean(data.where, 12, "Anywhere outdoors"),
    confidence,
  };
}

/** Ask the local model to turn one photo into a card. */
export async function describePhoto(image: Buffer, options: GemmaOptions = {}): Promise<Sighting> {
  const host = (options.host ?? DEFAULT_HOST).replace(/\/$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = options.fetch ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: SCHEMA,
        options: { temperature: options.temperature ?? 0.3 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: USER_PROMPT, images: [image.toString("base64")] },
        ],
      }),
    });
  } catch {
    throw new GemmaError(`Can't reach Ollama at ${host}. Start it with "ollama serve".`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 404 || /not found/i.test(body)) {
      throw new GemmaError(`Model "${model}" isn't installed. Run "ollama pull ${model}".`);
    }
    throw new GemmaError(`Ollama returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { message?: { content?: string } };
  return parseSighting(json.message?.content ?? "");
}
