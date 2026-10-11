# fieldcards

Turn your outdoor photos into a printable scavenger hunt, with an open-weight model running on your own computer.

Each photo goes to **Gemma 3**, running locally through **Ollama**. Gemma works out what the photo shows and writes a clue for finding it that doesn't name it. **[altsvg](https://www.npmjs.com/package/altsvg)** then replaces every photo with an ASCII card holding that clue, and the photo itself can be printed in characters too. You print the sheet, leave your phone at home, and go find the real things.

```
+-[ #05 other ]----------------+
|                              |
|    Find a dark, weathered    |
|    giant resting beside a    |
|   rushing, silver stream.    |
|                              |
+------------------------------+
- Green moss covering its
  surface
- Dark, grey wood
- A smooth, water-worn edge
Where: Typically found in damp,
       shaded forest streams.
[ ] found it   time: ______
```

That card came from a real `gemma3:4b` run on a photo of a mossy log across a forest waterfall.

In guide mode the photo itself is printed in characters, straight from its pixels:

```
+-[ #01 bird ]----------------------------+
|..          .......:::::--------- .---:..|
|:::.........:..::::::-+===--:::::. ::::::|
|:::::::::::::::::::-*%##@%*+-::::=..::...|
|......:::::::::::-*%%%**#*:::::::===-. ..|
|.::::::::::::::+*####*%##=:::::::::--:-=-|
| .::::::::::.-*@%%#*=+##%+-:..:---::::--+|
|:...:::::::-+%@@%%###**#*-------:::::::::|
|:--::.:::=%%@%@@%@@%###*---::::::::::::::|
|::::-::-=#%@@@@@@@%%#*=-::::::::::::::::.|
|.::::-=#%%#%@%*#%#+-:::::::::::::::::::::|
|....=#%+-:-%#*%%%#-::::::::..............|
|...:=-:::-##-::-*+=--:::::::::...........|
|::::::::-##-:::::-=++-:.:::::::::::::....|
+-----------------------------------------+
A SLEEK, DARK BIRD
A large, glossy black bird perches on a
weathered branch.
- Dark, glossy feathers
- A strong, curved beak
- Alert, watchful posture
Where: Often found near trees and water sources.
[ ] found it   time: ______
```

## Why it runs locally

- **No signal needed.** The model runs on your laptop, so you can make cards at a cabin, a campsite or a field station.
- **Your photos stay yours.** Photos carry faces, home addresses in the background, and GPS in their metadata. Nothing is uploaded; the only request goes to `localhost`.
- **Free to run.** No API key and no per-photo cost, so a teacher can make a sheet for every class.
- **Swappable.** `--model` takes any vision model Ollama can run, and the JSON schema keeps the output in the same shape.

## Quick start

You need Node.js 18.3 or later and [Ollama](https://ollama.com).

```bash
# 1. Get the model (about 3.3 GB, once)
ollama pull gemma3:4b

# 2. Install the fieldcards command
npm install -g github:KunalSiyag/fieldcards

# 3. Point it at a folder of photos
fieldcards ./photos --title "Saturday in the park"
```

Then open `fieldcards-out/index.html` in a browser and press Print.

To see the cards in the terminal instead, add `--stdout`. Progress messages go to stderr, so you can pipe the cards straight to a printer:

```bash
fieldcards ./photos --mode guide --stdout
fieldcards ./photos --stdout --cols 32 | lp     # 58 mm receipt printer
```

Working from a clone instead:

```bash
git clone https://github.com/KunalSiyag/fieldcards && cd fieldcards
npm install            # also builds
node dist/cli.js ./photos
```

## What you get

| File         | What it is                                                                  |
| ------------ | --------------------------------------------------------------------------- |
| `index.html` | A print-ready sheet: six cards per page, with an answer key on its own page |
| `cards.txt`  | The same cards as plain text. Use `--cols 32` for a 58 mm receipt printer   |
| `deck.json`  | Everything Gemma said. Fix any mistakes, then reprint with `--from`         |

Two modes:

- `--mode hunt` (the default) puts a clue on each card and the answers on a separate page. Add `--hint-art` for a small, blurry ASCII version of the photo next to each clue: enough to hint, too coarse to give it away.
- `--mode guide` names each thing and describes it, like a pocket field guide for a walk you've already done. Each card shows the photo printed in characters. Turn that off with `--no-art`.

Photo art works with JPEG and PNG, and follows the camera's rotation tag, so portrait phone photos come out the right way up.

## Options

```
fieldcards <photos or folders...> [options]
fieldcards --from <deck.json> [options]

  -o, --out <dir>      Output folder (default ./fieldcards-out)
  -t, --title <text>   Title printed on the sheet
  -m, --mode <mode>    hunt or guide (default hunt)
      --model <name>   Ollama model (default gemma3:4b)
      --host <url>     Ollama server (default http://localhost:11434)
      --paper <size>   a4 or letter (default a4)
      --cols <n>       Width of cards.txt in characters (default 48)
      --from <file>    Reprint a deck.json without running the model
      --stdout         Also print the text cards to the terminal
      --no-art         Guide mode: don't print the photos as ASCII art
      --hint-art       Hunt mode: add a blurry ASCII hint picture to each card
```

Photos that have already been described are skipped on the next run. They are matched by content hash, so you can add photos to the folder and run it again.

## How it works

1. **Describe.** Each photo is sent to `POST /api/chat` on the local Ollama server, with a JSON schema in `format`. The model must return `subject`, `category`, `description`, `clue`, `look_for`, `where` and `confidence`.
2. **Check.** The answer is validated and trimmed. If a clue contains its own answer, the answer is blanked out, and low-confidence answers are marked "best guess" on the card.
3. **Draw.** altsvg's ASCII style replaces each photo with a monospace card the same size as the picture, in SVG for the printed sheet and as plain text for `cards.txt`.
4. **Print the photo.** The photo is decoded locally, rotated by its EXIF tag, averaged into character cells and contrast-stretched, then mapped onto ` .:-=+*#%@`, so dark areas come out as dense ink. The art is stored in `deck.json` at 64 columns and resized for each layout.

## What a 4B model gets right and wrong

In testing, Gemma 3 4B reliably recognised common things (a dandelion clock, a maple leaf, a waterfall) and wrote clues that don't give the answer away. It was weaker on specifics: a crow came back as "a sleek, dark bird", and a soft pine pollen cone was described as "woody". Its own confidence rating is only a rough signal. That's why every answer lands in `deck.json`, where you can fix it before printing, and why low-confidence cards say "best guess".

## Safety

Model output can be wrong. The cards are for looking, not for picking, touching or eating. Every sheet says so.

## Credits

- [Gemma 3](https://ai.google.dev/gemma) by Google, an open-weight model, run locally with [Ollama](https://ollama.com).
- [altsvg](https://www.npmjs.com/package/altsvg) draws the ASCII cards. It's my earlier open-source project, started in March 2026. Its ASCII style was added this week for fieldcards.

## License

ISC
