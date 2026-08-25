/**
 * Builds the three vrc.zip wall posters as 1024x1536 HTML pages.
 *
 * The graph is redrawn rather than screenshotted so wires and node titles survive being read from
 * across a room.
 *
 * `bun run docs/posters/src/build-posters.ts` writes the HTML next to this file. Each page is
 * exactly 1024x1536 with no scroll, so a headless capture at that viewport is the PNG; the three
 * committed PNGs in the parent directory were made that way.
 *
 * The node titles, port names and config strings are the real ones from the built-in node registry
 * (`daemon/src/graphs/builtins`), and if a node's ports change the drawing goes stale silently.
 * That used to be caught by an inset capture of the same graph in the app, printed beside the
 * sublines; the inset is gone, because at the size these are actually seen - a quad in-world is
 * about 512px tall - it was a grey smudge either way. Nothing checks the drawing now except
 * opening the three graphs in the editor and comparing, so do that when a builtin's ports move.
 * `shots/` is still where `icon.png` lives; the three `app-*.jpg` captures are unreferenced.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

/* ---------- geometry ---------- */

/**
 * The safe area. A poster hung on a quad in-world does not always map the texture 1:1 - the prefab
 * crops, or the quad is not exactly 2:3 - and the first thing to go is whatever sits nearest an
 * edge. So every margin-adjacent element is placed from this one number rather than from a literal,
 * and it is deliberately generous: 100px is about 10% of the width and 6.5% of the height.
 *
 * The graph band is the one thing allowed past it, and only on the right - the dotted canvas runs
 * to the poster edge so it reads as continuing rather than stopping. The cards on it do not: a
 * clipped card is fine as an idea but a clipped card *title* just reads as broken, and at 512px
 * tall a truncated title is not recoverable by leaning in. So cards stay inside 1050, and the
 * leftmost is placed so its title, not its border, lands on the safe area.
 */
const M = 100;

const BAND = { x: -40, y: 638, w: 1104, h: 392 };

/*
 * Node-card metrics.
 *
 * These are sized for the poster being *seen at 512px tall*, not for the 1024x1536 file - a quad
 * in-world, or a preview thumbnail, is a third of the authored size, so everything below about
 * 15px in here turns to mush before anyone gets close enough to read it. So the small type went up
 * by roughly a fifth and the card metrics went with it. The cards did not get correspondingly
 * wider, because the band has a fixed horizontal budget and five of them have to fit; a couple of
 * titles now truncate where they used to fit, which is what the editor does anyway.
 */
const ROW_H = 31;
const PAD = 16;

type Row = {
  /** Left-hand port label, if this row has an input. */
  l?: string;
  /** Right-hand port label, if this row has an output. */
  r?: string;
  /** A hollow dot means "nothing is wired here". */
  lHollow?: boolean;
  rHollow?: boolean;
  /** Filled dots are the ones a wire actually lands on. */
  lOn?: boolean;
  rOn?: boolean;
};

type Node = {
  id: string;
  title: string;
  sub?: string;
  icon: keyof typeof ICONS;
  x: number;
  y: number;
  w: number;
  rows: Row[];
  /** Triggers get the amber strip; everything else gets the muted one. */
  trigger?: boolean;
};

const headerH = (n: Node) => (n.sub ? 75 : 55);
const nodeH = (n: Node) => headerH(n) + n.rows.length * ROW_H + 20;
const rowY = (n: Node, i: number) => n.y + headerH(n) + 15 + i * ROW_H;

/* ---------- icons (Lucide) ---------- */

const ICONS = {
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  type: '<path d="M12 4v16"/><path d="M4 7V4h16v3"/><path d="M9 20h6"/>',
  send: '<path d="m3 11 19-9-9 19-2-8-8-2z"/>',
  split:
    '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.5a4 4 0 0 0-1.17-2.83L3 3"/><path d="m21 3-7.83 7.83A4 4 0 0 0 12 13.66V22"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
} as const;

const icon = (k: keyof typeof ICONS, size = 18, color = "currentColor") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`;

/* ---------- rendering ---------- */

function renderNode(n: Node): string {
  const h = nodeH(n);
  const rows = n.rows
    .map((r) => {
      const left = r.l
        ? `<span class="p"><i class="dot ${r.lHollow ? "hollow" : r.lOn ? "on" : ""}"></i>${r.l}</span>`
        : "<span></span>";
      const right = r.r
        ? `<span class="p right">${r.r}<i class="dot ${r.rHollow ? "hollow" : r.rOn ? "on" : ""}"></i></span>`
        : "<span></span>";
      return `<div class="row">${left}${right}</div>`;
    })
    .join("");
  return `<div class="node ${n.trigger ? "trig" : ""}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${h}px">
    <div class="nstrip"></div>
    <div class="head">${icon(n.icon)}<div class="ht"><b>${n.title}</b>${n.sub ? `<em>${n.sub}</em>` : ""}</div></div>
    <div class="rows">${rows}</div>
  </div>`;
}

type Wire = { from: [string, number]; to: [string, number]; dim?: boolean };

function renderWires(nodes: Node[], wires: Wire[]): string {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const paths = wires
    .map((w) => {
      const a = by.get(w.from[0]);
      const b = by.get(w.to[0]);
      if (!a || !b) return "";
      const x1 = a.x + a.w;
      const y1 = rowY(a, w.from[1]);
      const x2 = b.x;
      const y2 = rowY(b, w.to[1]);
      // Horizontal control arms, the same shape svelte-flow draws for a bezier edge.
      const arm = Math.max(34, Math.abs(x2 - x1) * 0.6);
      return `<path d="M${x1} ${y1} C${x1 + arm} ${y1}, ${x2 - arm} ${y2}, ${x2} ${y2}" class="${w.dim ? "wire dim" : "wire"}"/>`;
    })
    .join("");
  return `<svg class="wires" width="${BAND.w}" height="${BAND.h}">${paths}</svg>`;
}

/* ---------- the three posters ---------- */

/*
 * Cards are laid out left to right along the chain, and a card's `x` must clear the previous card's
 * right edge - a wire that has to run backwards to reach the next input reads as a mistake. That,
 * plus the band's fixed width, is the whole width budget: the leftmost card starts at 95 so its
 * title lands on the 100px safe area, and the chain has to reach the right edge from there.
 */
type Poster = {
  slug: string;
  eyebrow: string;
  lines: string[];
  nodes: Node[];
  wires: Wire[];
};

const posters: Poster[] = [
  {
    slug: "01-discord",
    eyebrow: "NODE GRAPH AUTOMATION FOR VRCHAT",
    lines: [
      "A friend comes online.",
      "Discord gets a line about it.",
      "Four nodes and a webhook URL.",
    ],
    nodes: [
      {
        id: "n1",
        title: "When a friend comes online",
        icon: "zap",
        trigger: true,
        x: 95,
        y: 15,
        w: 304,
        rows: [{ r: "Friend", rOn: true }, { r: "At" }, { r: "Event" }],
      },
      {
        id: "n2",
        title: "Read field",
        sub: ".displayName",
        icon: "database",
        x: 429,
        y: 205,
        w: 182,
        rows: [
          { l: "run after", lHollow: true, r: "Value", rOn: true },
          { l: "From", lOn: true },
        ],
      },
      {
        id: "n3",
        title: "Compose text",
        sub: "{a} is online",
        icon: "type",
        x: 641,
        y: 30,
        w: 175,
        rows: [
          { l: "run after", lHollow: true, r: "Text", rOn: true },
          { l: "A", lOn: true },
        ],
      },
      {
        id: "n4",
        title: "Post to Discord",
        sub: "Discord: text",
        icon: "send",
        x: 846,
        y: 215,
        w: 202,
        rows: [
          { l: "run after", lHollow: true, r: "Status" },
          { l: "Message", lOn: true },
        ],
      },
    ],
    wires: [
      { from: ["n1", 0], to: ["n2", 1] },
      { from: ["n2", 0], to: ["n3", 1] },
      { from: ["n3", 0], to: ["n4", 1] },
    ],
  },

  {
    slug: "02-stranger",
    eyebrow: "NODE GRAPH AUTOMATION FOR VRCHAT",
    lines: [
      "Someone you have never met walks in.",
      "Your desktop says so.",
      "A friend joining stays quiet.",
    ],
    nodes: [
      {
        id: "n1",
        title: "When someone joins",
        icon: "zap",
        trigger: true,
        x: 95,
        y: 10,
        w: 230,
        rows: [
          { r: "Name", rOn: true },
          { r: "User" },
          { r: "Instance" },
          { r: "Is a friend", rOn: true },
        ],
      },
      {
        id: "n2",
        title: "Compare",
        sub: "left eq false",
        icon: "split",
        x: 333,
        y: 15,
        w: 178,
        rows: [
          { l: "run after", lHollow: true, r: "Result", rOn: true },
          { l: "This", lOn: true },
          { l: "That" },
        ],
      },
      {
        id: "n3",
        title: "Only if",
        sub: "only if value",
        icon: "split",
        x: 519,
        y: 200,
        w: 161,
        rows: [
          { l: "run after", lHollow: true, r: "Then", rOn: true },
          { l: "If", lOn: true },
          { l: "Carry", lOn: true },
        ],
      },
      {
        id: "n4",
        title: "Compose text",
        sub: "{a} joined, not a friend",
        icon: "type",
        x: 688,
        y: 30,
        w: 174,
        rows: [
          { l: "run after", lHollow: true, r: "Text", rOn: true },
          { l: "A", lOn: true },
        ],
      },
      {
        id: "n5",
        title: "Notify on this computer",
        sub: "notify: text",
        icon: "bell",
        x: 870,
        y: 225,
        w: 180,
        rows: [
          { l: "run after", lHollow: true, r: "Shown" },
          { l: "Message", lOn: true },
        ],
      },
    ],
    wires: [
      { from: ["n1", 3], to: ["n2", 1] },
      { from: ["n1", 0], to: ["n3", 2], dim: true },
      { from: ["n2", 0], to: ["n3", 1] },
      { from: ["n3", 0], to: ["n4", 1] },
      { from: ["n4", 0], to: ["n5", 1] },
    ],
  },

  {
    slug: "03-phone",
    eyebrow: "NODE GRAPH AUTOMATION FOR VRCHAT",
    lines: [
      "A friend moves to another world.",
      "Your phone buzzes, world name in it.",
      "The game does not have to be open.",
    ],
    nodes: [
      {
        id: "n1",
        title: "When someone goes somewhere",
        icon: "zap",
        trigger: true,
        x: 95,
        y: 10,
        w: 310,
        rows: [
          { r: "Who" },
          { r: "Name", rOn: true },
          { r: "Instance" },
          { r: "World", rOn: true },
          { r: "Travelling to" },
          { r: "At" },
        ],
      },
      {
        id: "n2",
        title: "Read field",
        sub: ".name",
        icon: "database",
        x: 424,
        y: 225,
        w: 172,
        rows: [
          { l: "run after", lHollow: true, r: "Value", rOn: true },
          { l: "From", lOn: true },
        ],
      },
      {
        id: "n3",
        title: "Compose text",
        sub: "{a} went to {b}",
        icon: "type",
        x: 615,
        y: 25,
        w: 190,
        rows: [
          { l: "run after", lHollow: true, r: "Text", rOn: true },
          { l: "A", lOn: true },
          { l: "B", lOn: true },
        ],
      },
      {
        id: "n4",
        title: "Send an ntfy notification",
        sub: "ntfy vrczip-friends",
        icon: "smartphone",
        x: 824,
        y: 230,
        w: 224,
        rows: [
          { l: "run after", lHollow: true, r: "Status" },
          { l: "Message", lOn: true },
        ],
      },
    ],
    wires: [
      { from: ["n1", 1], to: ["n3", 1] },
      { from: ["n1", 3], to: ["n2", 1], dim: true },
      { from: ["n2", 0], to: ["n3", 2] },
      { from: ["n3", 0], to: ["n4", 1] },
    ],
  },
];

/* ---------- page ---------- */

function page(p: Poster): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>vrc.zip poster ${p.slug}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#08080a;
    --panel:#111114;
    --amber:#f2c24e;
    --amber-deep:#e0a336;
    --paper:#ece7dd;
    --muted:#8d877d;
    --line:rgba(242,194,78,.22);
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:#000}
  .poster{
    position:relative;width:1024px;height:1536px;overflow:hidden;
    background:var(--ink);color:var(--paper);
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    -webkit-font-smoothing:antialiased;
  }
  .mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
  .disp{
    font-family:"Archivo","Archivo Narrow",Helvetica,Arial,sans-serif;
    font-variation-settings:"wdth" 62,"wght" 900;
    font-weight:900;letter-spacing:-.02em;
  }

  /* --- top bar --- */
  .top{position:absolute;left:${M}px;right:${M}px;top:${M}px;display:flex;align-items:center;gap:14px}
  .top img{width:38px;height:38px;border-radius:9px;display:block}
  .top .wm{font-size:26px;font-weight:600;letter-spacing:-.01em;color:var(--paper)}
  .top .meta{margin-left:auto;font-size:18px;letter-spacing:.15em;color:var(--muted);text-transform:uppercase}
  .rule{position:absolute;left:${M}px;right:${M}px;height:1px;background:var(--line)}

  /* --- headline --- */
  .eyebrow{position:absolute;left:${M}px;top:194px;font-size:19px;letter-spacing:.2em;color:var(--amber)}
  .strip{position:absolute;left:${M}px;right:${M}px;top:232px;height:4px;background:var(--amber)}
  .outport{position:absolute;right:${M - 6}px;top:228px;width:12px;height:12px;border-radius:50%;background:var(--amber)}
  h1{position:absolute;left:${M - 6}px;top:242px;font-size:216px;line-height:.86;color:var(--amber)}

  /* --- subline --- */
  /*
   * The sublines get the whole width between the band and the footer, and they get it because the
   * app-capture inset used to sit beside them and no longer does. At 512px tall the inset was a
   * grey smudge of a screenshot - it could only work at a size the poster does not have to give -
   * so it went, and the three lines took the room. 32px is the largest that keeps the longest of
   * them (36 monospace characters, 691px) on one line.
   */
  .sub{position:absolute;left:${M}px;top:1086px;width:${1024 - 2 * M}px;font-size:32px;line-height:1.65;color:var(--paper)}
  .sub b{display:block;font-weight:400}
  .sub b + b{color:#b9b3a8}

  /* --- graph band --- */
  .band{
    position:absolute;left:${BAND.x}px;top:${BAND.y}px;width:${BAND.w}px;height:${BAND.h}px;
    overflow:hidden;
    background-image:radial-gradient(circle,rgba(242,194,78,.14) 1px,transparent 1px);
    background-size:23px 23px;
  }
  .band::after{
    content:"";position:absolute;inset:0;pointer-events:none;
    background:linear-gradient(90deg,var(--ink) 0,transparent 18px,transparent calc(100% - 18px),var(--ink) 100%);
  }
  .wires{position:absolute;left:0;top:0;overflow:visible}
  .wire{fill:none;stroke:var(--amber);stroke-width:2.4;opacity:.92}
  .wire.dim{stroke:var(--amber-deep);opacity:.5;stroke-dasharray:7 5}

  .node{position:absolute;background:var(--panel);border:1px solid rgba(236,231,221,.13);border-top:0}
  .nstrip{height:4px;background:rgba(242,194,78,.42)}
  .node.trig .nstrip{background:var(--amber)}
  .head{display:flex;gap:11px;padding:14px ${PAD}px 0;color:#7f7a71;align-items:flex-start}
  .node.trig .head{color:var(--amber)}
  .head svg{flex:none;margin-top:1px}
  /*
   * Titles truncate rather than force the card wider. The editor does exactly this - a narrow card
   * shows "When someone joins your in..." - so an ellipsis here is the app's own behaviour, and it
   * means card widths can be chosen for the composition instead of by the longest title.
   */
  .ht{min-width:0;overflow:hidden}
  .ht b{display:block;font-size:15.5px;font-weight:600;color:var(--paper);letter-spacing:-.01em;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ht em{display:block;font-style:normal;font-size:14px;color:var(--muted);margin-top:2px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rows{margin-top:12px}
  .row{display:flex;justify-content:space-between;align-items:center;height:${ROW_H}px;padding:0 ${PAD}px}
  /*
   * Port labels stop a size short of the titles. Five cards have to fit across the band and the
   * row is the widest thing in most of them, so every point here costs width somewhere else - and
   * a port name is texture at the size the poster is actually seen, where the title is the thing
   * being read. The titles got the width instead.
   */
  .p{display:flex;align-items:center;gap:7px;font-size:13.5px;color:#a8a29a;white-space:nowrap}
  .p.right{justify-content:flex-end}
  .dot{width:9px;height:9px;border-radius:50%;background:#5d5952;flex:none}
  .dot.on{background:var(--amber);box-shadow:0 0 0 4px rgba(242,194,78,.16)}
  .dot.hollow{background:transparent;border:2px solid #4c4842}
  .p .dot{margin-left:-${PAD + 4}px}
  .p.right .dot{margin-left:0;margin-right:-${PAD + 4}px}

  /* --- the wire that runs from the headline down to the wordmark --- */
  .spine{position:absolute;left:0;top:0;width:1024px;height:1536px;pointer-events:none}
  .spine path{fill:none;stroke:var(--amber);stroke-width:2.4}
  .spine circle{fill:var(--amber)}

  /* --- footer --- */
  .foot{position:absolute;left:${M}px;right:${M}px;top:1314px;display:flex;align-items:flex-end}
  .foot .url{font-size:84px;line-height:.9;color:var(--amber)}
  .foot .claims{margin-top:14px;font-size:22px;letter-spacing:.1em;color:var(--paper)}
  .foot .plat{margin-left:auto;text-align:right;font-size:18px;letter-spacing:.15em;color:var(--muted);text-transform:uppercase;line-height:1.8}
</style></head>
<body><div class="poster">

  <div class="top">
    <img src="shots/icon.png" alt="">
    <span class="wm">vrc.zip</span>
    <span class="meta">v0.1.7 &middot; local daemon</span>
  </div>
  <div class="rule" style="top:${M + 58}px"></div>

  <div class="eyebrow">${p.eyebrow}</div>
  <div class="strip"></div>
  <div class="outport"></div>
  <h1 class="disp">WIRE IT<br>YOURSELF</h1>

  <div class="band">
    ${renderWires(p.nodes, p.wires)}
    ${p.nodes.map(renderNode).join("\n")}
  </div>

  <div class="sub">${p.lines.map((l) => `<b>${l}</b>`).join("")}</div>

  <svg class="spine" viewBox="0 0 1024 1536">
    <path d="M${1024 - M} 234 C ${1024 - M + 30} 234, ${1024 - M + 34} 252, ${1024 - M + 34} 282 L ${1024 - M + 34} ${BAND.y - 8}"/>
    <path d="M${1024 - M + 34} ${BAND.y + BAND.h + 8} L ${1024 - M + 34} 1262 C ${1024 - M + 34} 1286, ${1024 - M + 22} 1296, ${1024 - M - 4} 1296 L ${M + 14} 1296 C ${M + 6} 1296, ${M} 1290, ${M} 1282"/>
    <circle cx="${M}" cy="1280" r="6"/>
  </svg>

  <div class="foot">
    <div>
      <div class="url disp">vrc.zip</div>
      <div class="claims">free / local-only / open source</div>
    </div>
    <div class="plat">windows<br>linux</div>
  </div>

</div></body></html>`;
}

for (const p of posters) {
  writeFileSync(`${OUT}/${p.slug}.html`, page(p));
  console.log("wrote", `${p.slug}.html`);
}
