// Gemma draws each card's picture itself: given the subject it saw, it returns
// a handful of named shapes on a 100 x 60 canvas, and this module renders them
// as ASCII line art. Nothing is pre-drawn.

import { GemmaError, DEFAULT_HOST, DEFAULT_MODEL } from "./gemma";

export const CANVAS_W = 100;
export const CANVAS_H = 60;

export type ShapeKind = "circle" | "ellipse" | "rect" | "line" | "polyline" | "polygon";

export interface Shape {
  /** What the shape is: "head", "beak", "branch". Naming parts makes the model compose better. */
  part: string;
  kind: ShapeKind;
  points: number[];
  fill: boolean;
}

const KINDS: ShapeKind[] = ["circle", "ellipse", "rect", "line", "polyline", "polygon"];

const SYSTEM_PROMPT = `You draw simple, recognisable line drawings, like an icon or a child's sketch, using a few large shapes.
The canvas is ${CANVAS_W} units wide and ${CANVAS_H} units tall. x goes right, y goes down. Keep everything inside the canvas and use most of it.
Shapes and their points:
- circle: [cx, cy, r]
- ellipse: [cx, cy, rx, ry]
- rect: [x, y, width, height]
- line: [x1, y1, x2, y2]
- polyline: [x1, y1, x2, y2, x3, y3, ...] (open)
- polygon: [x1, y1, x2, y2, x3, y3, ...] (closed)
Think about the 3 to 8 main parts that make the subject recognisable from the side or the front, and draw each part as one shape, naming it in "part".
Parts must touch or overlap where they connect. Set fill to true only for small solid details like an eye; everything else is an outline. No text.`;

const SCHEMA = {
  type: "object",
  properties: {
    shapes: {
      type: "array",
      minItems: 1,
      maxItems: 14,
      items: {
        type: "object",
        properties: {
          part: { type: "string" },
          kind: { type: "string", enum: KINDS },
          points: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 24 },
          fill: { type: "boolean" },
        },
        required: ["part", "kind", "points", "fill"],
      },
    },
  },
  required: ["shapes"],
};

/** How many numbers each kind needs: exact for fixed shapes, a minimum for paths. */
function validPoints(kind: ShapeKind, n: number): boolean {
  switch (kind) {
    case "circle":
      return n === 3;
    case "ellipse":
    case "rect":
    case "line":
      return n === 4;
    case "polyline":
      return n >= 4 && n % 2 === 0;
    case "polygon":
      return n >= 6 && n % 2 === 0;
  }
}

/** Keep only well-formed shapes, so a sloppy answer can't break the card. */
export function parseDrawing(raw: string): Shape[] {
  let data: { shapes?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new GemmaError(`Drawing was not JSON: ${raw.slice(0, 120)}`);
  }
  const shapes = Array.isArray(data.shapes) ? data.shapes : [];
  const out: Shape[] = [];
  for (const s of shapes.slice(0, 14)) {
    if (typeof s !== "object" || s === null) continue;
    const { part, kind, points, fill } = s as Record<string, unknown>;
    if (!KINDS.includes(kind as ShapeKind) || !Array.isArray(points)) continue;
    const nums = points.map(Number);
    if (!nums.every(Number.isFinite) || !validPoints(kind as ShapeKind, nums.length)) continue;
    out.push({
      part: typeof part === "string" ? part.slice(0, 40) : "",
      kind: kind as ShapeKind,
      points: nums.map((v) => Math.max(-50, Math.min(150, v))),
      fill: fill === true,
    });
  }
  return out;
}

/** Ask the model to draw a subject. Text only, so it's quick on any model. */
export async function drawSubject(
  subject: string,
  description: string,
  options: { host?: string; model?: string; fetch?: typeof fetch } = {}
): Promise<Shape[]> {
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
        options: { temperature: 0.3 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Draw: ${subject}. ${description}` },
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
  return parseDrawing(json.message?.content ?? "");
}

type Segment = [number, number, number, number];

/** Turn a shape into outline segments, plus a fill polygon for small filled details. */
function toGeometry(s: Shape): { segs: Segment[]; fill: number[] | null } {
  const p = s.points;
  const ring = (pts: number[], closed: boolean): Segment[] => {
    const segs: Segment[] = [];
    const n = pts.length / 2;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      segs.push([pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]]);
    }
    return segs;
  };
  switch (s.kind) {
    case "circle":
    case "ellipse": {
      const [cx, cy, rx] = p;
      const ry = s.kind === "circle" ? p[2] : p[3];
      const pts: number[] = [];
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2;
        pts.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
      }
      return { segs: ring(pts, true), fill: s.fill && Math.abs(rx * ry) < 60 ? pts : null };
    }
    case "rect": {
      const [x, y, w, h] = p;
      const pts = [x, y, x + w, y, x + w, y + h, x, y + h];
      return { segs: ring(pts, true), fill: s.fill && Math.abs(w * h) < 120 ? pts : null };
    }
    case "line":
      return { segs: [[p[0], p[1], p[2], p[3]]], fill: null };
    case "polyline":
      return { segs: ring(p, false), fill: null };
    case "polygon":
      return { segs: ring(p, true), fill: null };
  }
}

function insidePolygon(poly: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [poly[i], poly[i + 1], poly[j], poly[j + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Render shapes as ASCII line art at most `maxCols` wide and `maxRows` tall.
 * The drawing's own bounding box is scaled to fit, keeping its proportions. Each outline cell gets the
 * character that matches the stroke direction: - / | \. Small filled details
 * become @. Returns equal-width lines, or [] when there is nothing to draw.
 */
export function rasterize(shapes: Shape[], maxCols: number, maxRows: number): string[] {
  const geometry = shapes.map(toGeometry);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { segs } of geometry) {
    for (const [a, b, c, d] of segs) {
      x0 = Math.min(x0, a, c);
      x1 = Math.max(x1, a, c);
      y0 = Math.min(y0, b, d);
      y1 = Math.max(y1, b, d);
    }
  }
  if (!Number.isFinite(x0) || maxCols < 4 || maxRows < 2) return [];

  // Map the drawing's bounding box onto character-cell centres, keeping its
  // proportions (a cell is half as wide as it is tall). Mapping to centres means
  // a perfectly flat or thin drawing still lands on a row instead of between two.
  const bw = Math.max(x1 - x0, 1e-4);
  const bh = Math.max(y1 - y0, 1e-4);
  const scale = Math.min((maxCols - 1) / bw, (maxRows - 1) / (bh * 0.5)); // columns per unit
  const cols = Math.min(maxCols, Math.floor(bw * scale) + 1);
  const rows = Math.min(maxRows, Math.floor(bh * scale * 0.5) + 1);
  const X = (x: number) => 0.5 + (x - x0) * scale;
  const Y = (y: number) => 0.5 + (y - y0) * scale * 0.5; // in rows

  // Work in screen units where a row is two columns tall, so angles look right.
  const segs = geometry.flatMap((g) => g.segs.map(([a, b, c, d]) => [X(a), Y(b) * 2, X(c), Y(d) * 2]));
  const fills = geometry.filter((g) => g.fill).map((g) => g.fill!.map((v, i) => (i % 2 ? Y(v) : X(v))));

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const px = c + 0.5;
      const py = (r + 0.5) * 2;
      let best = 0.6;
      let ch = " ";
      for (const [ax, ay, bx, by] of segs) {
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (d < best) {
          best = d;
          const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180;
          ch = angle < 22.5 || angle >= 157.5 ? "-" : angle < 67.5 ? "\\" : angle < 112.5 ? "|" : "/";
        }
      }
      // Small filled details (an eye, a berry) read better solid than outlined.
      if (fills.some((poly) => insidePolygon(poly, px, r + 0.5))) ch = "@";
      line += ch;
    }
    lines.push(line);
  }
  // Drop blank rows at the top and bottom.
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}
