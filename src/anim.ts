// The altsvg hero effect, in a terminal: while the model works, the card frame
// fills with shimmering noise and a scan line; when the card is ready, the
// noise dissolves into it, cell by cell. Drawn on stderr, so stdout stays clean.

const RAMP = " .:-=+*#%@";
const GLITCH = "/\\|#%@*+=";

/** A stable pseudo-random number in [0, 1) for a cell, so frames don't flicker randomly. */
export function hash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** What a cell is, for colouring: frame, drawing, clue text, or loading noise. */
export type CellKind = "frame" | "art" | "text" | "noise" | "plain";

export interface Cell {
  ch: string;
  kind: CellKind;
}

/** A framed box of noise with a moving scan line: the "thinking" state. */
export function noiseFrame(cols: number, rows: number, label: string, t: number): Cell[][] {
  const grid: Cell[][] = [];
  const scan = 1 + (Math.floor(t * 9) % Math.max(1, rows - 2));
  const tick = Math.floor(t * 12);
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < cols; c++) {
      const edgeR = r === 0 || r === rows - 1;
      const edgeC = c === 0 || c === cols - 1;
      if (edgeR || edgeC) {
        row.push({ ch: edgeR && edgeC ? "+" : edgeR ? "-" : "|", kind: "frame" });
        continue;
      }
      let v = hash(c * 7 + tick, r * 13) * 0.35 + 0.25 * Math.sin(c * 0.35 + r * 0.9 - t * 3);
      if (r === scan) v += 0.55;
      else if (Math.abs(r - scan) === 1) v += 0.2;
      const ch = RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.floor(v * RAMP.length)))];
      row.push({ ch, kind: "noise" });
    }
    grid.push(row);
  }
  const tag = `[ ${label} ]`;
  if (tag.length + 4 <= cols) [...tag].forEach((ch, i) => (grid[0][i + 2] = { ch, kind: "frame" }));
  return grid;
}

/**
 * Blend from noise to the finished card. `p` runs from 0 (all noise) to 1
 * (the card). Each cell flips at its own random moment, with a short burst of
 * glitch characters on the way, like the hero's transition.
 */
export function dissolveFrame(target: Cell[][], p: number, t: number): Cell[][] {
  const rows = target.length;
  const tick = Math.floor(t * 24);
  return target.map((row, r) =>
    row.map((cell, c) => {
      if (cell.kind === "frame" && (r === 0 || r === rows - 1 || c === 0 || c === row.length - 1)) return cell;
      const h = hash(c * 7 + 3, r * 13 + 1);
      if (h < p - 0.08) return cell;
      if (h < p + 0.08) return { ch: GLITCH[Math.floor(hash(c + tick, r) * GLITCH.length)], kind: "noise" as const };
      const v = hash(c * 7 + tick, r * 13) * 0.5;
      return { ch: RAMP[Math.floor(v * RAMP.length)], kind: "noise" as const };
    })
  );
}

const STYLE: Record<CellKind, string> = {
  frame: "\x1b[90m",
  noise: "\x1b[2m",
  art: "\x1b[36m",
  text: "\x1b[1;94m",
  plain: "",
};

/** Turn a grid into terminal lines, colouring runs of the same kind. */
export function paint(grid: Cell[][], color: boolean): string[] {
  return grid.map((row) => {
    if (!color) return row.map((c) => c.ch).join("");
    let out = "";
    let current: CellKind | null = null;
    for (const cell of row) {
      if (cell.kind !== current) {
        out += "\x1b[0m" + STYLE[cell.kind];
        current = cell.kind;
      }
      out += cell.ch;
    }
    return out + "\x1b[0m";
  });
}

interface Output {
  write(chunk: string): boolean;
}

/**
 * Animates one card at a time in place. Call start() while the model works,
 * status() to change the line under the box, and reveal() when the card is ready.
 */
export class CardAnimator {
  private timer: NodeJS.Timeout | null = null;
  private height = 0; // lines currently drawn by us
  private started = 0;
  private label = "";
  private message = "";
  private spin = 0;

  constructor(
    private out: Output,
    private cols: number,
    private rows: number,
    private color: boolean
  ) {}

  private draw(lines: string[]): void {
    let s = this.height ? `\x1b[${this.height}A` : "";
    for (const line of lines) s += "\r\x1b[2K" + line + "\n";
    // Clear anything left from a taller previous frame.
    for (let i = lines.length; i < this.height; i++) s += "\r\x1b[2K\n";
    if (this.height > lines.length) s += `\x1b[${this.height - lines.length}A`;
    this.out.write(s);
    this.height = lines.length;
  }

  private statusLine(): string {
    const secs = ((Date.now() - this.started) / 1000).toFixed(1);
    const spinner = "|/-\\"[this.spin++ % 4];
    const text = `${spinner} ${this.message} ${secs}s`;
    return this.color ? `\x1b[90m${text}\x1b[0m` : text;
  }

  start(label: string, message: string): void {
    this.label = label;
    this.message = message;
    this.started = Date.now();
    this.out.write("\x1b[?25l"); // hide the cursor while animating
    const tick = () => {
      const t = (Date.now() - this.started) / 1000;
      this.draw([...paint(noiseFrame(this.cols, this.rows, this.label, t), this.color), this.statusLine()]);
    };
    tick();
    this.timer = setInterval(tick, 50);
  }

  status(message: string): void {
    this.message = message;
  }

  /** Dissolve the noise into the finished card, then leave the card on screen. */
  async reveal(card: Cell[][], ms = 900): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Replace the loader box with a box the size of the card, then dissolve.
    const begin = Date.now();
    await new Promise<void>((resolve) => {
      const step = () => {
        const p = Math.min(1, (Date.now() - begin) / ms);
        const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const t = (Date.now() - this.started) / 1000;
        this.draw(paint(p >= 1 ? card : dissolveFrame(card, eased, t), this.color));
        if (p >= 1) resolve();
        else setTimeout(step, 40);
      };
      step();
    });
    this.height = 0; // the card stays; the next animation starts below it
    this.out.write("\x1b[?25h");
  }

  /** Stop without revealing (on errors), clearing the loader. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.height) this.draw([]);
    this.height = 0;
    this.out.write("\x1b[?25h");
  }
}
