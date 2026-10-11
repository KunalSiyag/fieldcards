// Hand-drawn ASCII illustrations, one per kind of thing you might hunt for.
// Gemma picks which one fits a photo (the `sketch` field), the same way the
// altsvg hero draws a scene that matches its alt text.

const draw = (art: string): string[] => {
  const lines = art.split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(indent).replace(/\s+$/, ""));
};

export const SKETCHES = {
  bird: draw(String.raw`
          __
      ___( o>
      \ <_. )
       '---'
  ======|==|=======
        '  '
`),
  tree: draw(String.raw`
       .-~~~-.
   .-~~ .  .  ~~-.
  (  .   ~   .   . )
   ( .  ~  .   ~  )
    '-._.  _._.-'
        |  |
        |  |
    ____|__|____
`),
  leaf: draw(String.raw`
      .-'''''-.
    .'  \ | /  '.
   /  \  \|/  /  \
  | ---\--|--/--- |
   \    \ | /    /
    '.   \|/   .'
      '-._|_.-'
          |
          |
`),
  flower: draw(String.raw`
        .-.
     .-(   )-.
    (   '-'   )
     '-(   )-'
        '-'
         |
     \   |   /
  ____\__|__/____
`),
  mushroom: draw(String.raw`
     .-'''''''-.
   .'  o    o   '.
  /   o   .   o   \
  '-----.____.----'
         |  |
         |  |
   ______|__|______
`),
  water: draw(String.raw`
  ~~~~      ~~~~      ~~
~~    ~~  ~~    ~~  ~~
       ~~~~      ~~~~
  ~~~~      ~~~~      ~~
~~    ~~  ~~    ~~  ~~
       ~~~~      ~~~~
`),
  mountain: draw(String.raw`
            /\
           /  \    /\
      /\  /    \  /  \
     /  \/  /\  \/    \
    /    \_/  \_/      \
   /                    \
`),
  rock: draw(String.raw`
        ___________
     .-'  .     '  '-.
   .'  '      .   .   '.
  /  .    '     .   '   \
 (_______________________)
`),
  insect: draw(String.raw`
   .-.   \ /   .-.
  (   '-._Y_.-'   )
   '-.   (_)   .-'
   .-'   (_)   '-.
  (   _.-'Y'-._   )
   '-'         '-'
`),
  animal: draw(String.raw`
     o o           o o
    o   o         o   o
     (_)           (_)
           o o
          o   o
           (_)
`),
  sky: draw(String.raw`
     \   |   /
      .-'''-.
  -- (       ) --     .--.
      '-...-'     .-(    ).
     /   |   \   (___.__)__)
`),
  building: draw(String.raw`
          /\
         /  \
        / [] \
       /______\
       | []   |
       |   _  |
       |  | | |
   ____|__|_|_|____
`),
  cone: draw(String.raw`
       |
      /^\
     /^^^\
    /^^^^^\
    \^^^^^/
     \^^^/
      \^/
`),
  other: draw(String.raw`
     .--.
   .'    '.
  |        |
  |        |
   '.    .'
     '--'\\
          \\
           \\
`),
};

export type SketchId = keyof typeof SKETCHES;
export const SKETCH_IDS = Object.keys(SKETCHES) as SketchId[];

// When the model's choice is missing or invalid, guess from the words it used.
const KEYWORDS: Array<[SketchId, RegExp]> = [
  ["bird", /\b(bird|crow|raven|sparrow|pigeon|kite|hawk|eagle|owl|duck|gull|robin|parrot|myna|feather)/i],
  ["insect", /\b(butterfl|moth|bee|insect|beetle|ant|dragonfl|ladybird|ladybug|spider)/i],
  ["mushroom", /\b(mushroom|fung|toadstool|bracket)/i],
  ["cone", /\b(cone|pinecone)/i],
  ["flower", /\b(flower|blossom|petal|dandelion|daisy|rose|tulip|lotus|bloom)/i],
  ["leaf", /\b(leaf|leaves|fern|maple)/i],
  ["tree", /\b(tree|trunk|bark|forest|branch|pine|oak|palm|bamboo|log)/i],
  ["water", /\b(water|river|stream|lake|pond|waterfall|sea|wave|creek|fountain)/i],
  ["mountain", /\b(mountain|hill|peak|cliff|valley)/i],
  ["rock", /\b(rock|stone|boulder|pebble|granite)/i],
  ["sky", /\b(sky|cloud|sun|sunset|sunrise|moon|star|rainbow)/i],
  ["animal", /\b(dog|cat|squirrel|deer|cow|goat|monkey|animal|paw|rabbit|horse)/i],
  ["building", /\b(building|house|bridge|temple|church|tower|bench|bar|counter|statue|landmark|wall|gate)/i],
];

const BY_CATEGORY: Record<string, SketchId> = {
  tree: "tree",
  plant: "leaf",
  flower: "flower",
  fungus: "mushroom",
  bird: "bird",
  insect: "insect",
  animal: "animal",
  rock: "rock",
  water: "water",
  sky: "sky",
  landmark: "building",
};

/**
 * The drawing for a card. Gemma's choice wins when its own words or category back it up,
 * or when the subject names nothing we recognise. If the subject clearly names
 * something else (Gemma once drew a pine cone for "A fallen log"), the subject
 * wins. Without a usable choice, fall back to keywords, then the category.
 */
export function pickSketch(card: { sketch?: string; subject: string; description: string; category: string }): SketchId {
  const words = `${card.subject} ${card.description}`;
  const match = (text: string) => KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0];
  const supported = (id: string) =>
    BY_CATEGORY[card.category] === id || KEYWORDS.some(([k, pattern]) => k === id && pattern.test(words));
  const fromSubject = match(card.subject);

  const chosen = card.sketch && card.sketch in SKETCHES && card.sketch !== "other" ? (card.sketch as SketchId) : undefined;
  if (chosen && (!fromSubject || fromSubject === chosen || supported(chosen))) return chosen;
  if (fromSubject) return fromSubject;
  return match(words) ?? BY_CATEGORY[card.category] ?? "other";
}
