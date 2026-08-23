/**
 * Every composited image, as a self-contained HTML page to be screenshotted.
 *
 * ## Why HTML and a browser rather than an image library
 *
 * The alternative was decoding the JPEGs and drawing text by hand, which means a new dependency in
 * `tools/` and hand-rolled line breaking for the one thing these pictures are made of: sentences.
 * A browser already does that, is already in the loop for capturing the app itself, and lets anybody
 * open `build/docs/poster.html` and nudge the layout with devtools before committing to it.
 *
 * The pages are deliberately plain — no framework, no fonts fetched from anywhere, one stylesheet
 * shared by all of them. A render that depended on a webfont would render differently on a machine
 * that was offline, which is a strange property for a build artifact.
 *
 * ## Every page is one viewport, and that is a constraint rather than a taste
 *
 * The browser tool screenshots the **visible viewport**, at {@link CAPTURE}. It cannot capture a
 * full page and it cannot be resized to an arbitrary shape. So nothing here scrolls: each page is
 * composed to fit exactly one screenful, and anything that wants a different aspect ratio — the 2:3
 * short GIF, the 16:9 ad — is drawn *centred inside* that screenful on black and cropped afterwards
 * by ffmpeg. See {@link frameBox}, and `cropFor` in `gif.ts`, which are two halves of one decision
 * and have a test asserting they agree.
 *
 * The visible cost is the poster: it wanted to be tall, and it is landscape.
 *
 * ## The brand is one colour and one rule
 *
 * `#fdba2f` on near-black, and an amber rule above every title. That is the whole visual identity:
 * enough to make a strip of screenshots read as one set, and little enough that it never competes
 * with the screenshot underneath — which is the thing anybody is actually looking at.
 */

import { SHOTS, type Shot, shot, shotsFor } from "./shots.ts";

/** The one colour, and the ground everything sits on. */
export const BRAND = "#fdba2f";
const INK = "#0b0b0d";
const PAPER = "#f4f4f5";
const MUTED = "#a1a1aa";

/**
 * What the browser tool hands back. Measured, not chosen, and **not** the size a page is authored at.
 *
 * The viewport it captures is whatever the operator's window happens to be — 1912x901 on the machine
 * this was built on — and the file comes back scaled uniformly to 1568 wide. So a page authored in
 * *pixels* renders with black around it, which is how the first poster came out. Every page is
 * therefore laid out in `vw`/`vh` and fills whatever it is given.
 *
 * This constant exists only for the crop: because the scale is uniform, a frame that is one third of
 * the viewport is one third of the file, and `cropFor` can work entirely in the file's own numbers.
 */
export const CAPTURE = { width: 1568, height: 738 } as const;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Where a frame of a given aspect ratio sits inside the capture.
 *
 * Full height, centred horizontally. Height is the axis to pin because it is the scarcer one here:
 * the capture is 2.1:1 and every target is narrower than that, so fitting to width would leave the
 * frame short and the crop would have to guess a vertical offset as well.
 */
export function frameBox(aspect: number): { width: number; height: number; left: number } {
  const height = CAPTURE.height;
  // Even, because an odd-width crop is a thing several encoders quietly refuse.
  const width = Math.round((height * aspect) / 2) * 2;
  return { width, height, left: Math.round((CAPTURE.width - width) / 2) };
}

/** 2:3 portrait, for a phone-shaped feed. */
export const SHORT_ASPECT = 2 / 3;
/** 16:9, the shape that embeds without letterboxing in a README, a chat and a timeline. */
export const AD_ASPECT = 16 / 9;

/**
 * The shared stylesheet.
 *
 * `image-rendering: -webkit-optimize-contrast` is not decoration: every source image is a screenshot
 * of text being scaled down, and the default smooth filter turns 12px UI type into grey mush.
 *
 * ## Type is sized against the file, not the page
 *
 * The first pass was drawn at what looked right in a browser and shipped about a third smaller than
 * that: the page is laid out in a 1912px-wide viewport and the capture comes back at 1568, so every
 * number written here is multiplied by 0.82 before anybody reads it. A caption at 15px arrived at
 * 12px, on top of a screenshot whose own UI type is already small. Everything below is sized for the
 * captured file — which, unlike the page, is the only place any of it is ever read.
 */
function styles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    /* Viewport units, not pixels: the capture is whatever window it is taken in. See CAPTURE. */
    html, body { width: 100vw; height: 100vh;
      overflow: hidden; background: ${INK}; color: ${PAPER};
      font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
    .rule { height: 3px; background: ${BRAND}; border-radius: 2px; }
    .mark { font-weight: 700; letter-spacing: -0.02em; color: ${BRAND}; }
    .title { font-weight: 650; letter-spacing: -0.01em; }
    .caption { color: ${MUTED}; line-height: 1.4; }
    /* **Cover, not contain.** Every one of these boxes has a different aspect ratio from the 2.1:1
       screenshot inside it, and fitting the whole shot in leaves a band of dead background that
       reads as a layout bug. Covering crops instead — anchored to the top-left, which is where
       every screen in this app puts the thing it is about, and it keeps the type at a readable
       size rather than shrinking it to fit. */
    .shot { overflow: hidden; border-radius: 10px; border: 1px solid #26262b; background: #111; }
    .shot img { display: block; width: 100%; height: 100%;
      object-fit: cover; object-position: left top; image-rendering: -webkit-optimize-contrast; }
    .unofficial { color: #71717a; }
  `;
}

function page(body: string, extra = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>vrc.zip</title>
<style>${styles()}${extra}</style></head><body>${body}</body></html>`;
}

/**
 * The black surround a cropped frame is centred on.
 *
 * `aspect-ratio` against `100vh` rather than a pixel width, for the same reason everything else here
 * is in viewport units — and it keeps this in exact agreement with {@link frameBox}, which derives
 * the same rectangle in the captured file's numbers.
 */
function centred(aspect: number, inner: string): string {
  return page(
    `<div style="position:absolute; left:50%; top:0; transform:translateX(-50%);
       height:100vh; aspect-ratio:${aspect.toFixed(6)}; overflow:hidden;">${inner}</div>`,
  );
}

/* -------------------------------------------------------------------------------------------- */
/* One captioned screen                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * The render that goes in the README beside each section: amber rule, title, one sentence, the shot.
 *
 * The title is *not* the app's own heading where the two would differ — "Automations" rather than
 * "Graphs" — because the caption is read by somebody who has not opened the app and the heading is
 * read by somebody who has.
 */
export function captionPage(entry: Shot, imageHref: string): string {
  return page(
    `<div style="display:flex; flex-direction:column; height:100%; padding:26px 30px 30px; gap:12px;">
       <div class="rule" style="width:76px;"></div>
       <div class="title" style="font-size:42px;">${escapeHtml(entry.title)}</div>
       <div class="caption" style="font-size:23px; max-width:80ch;">${escapeHtml(entry.caption)}</div>
       <div class="shot" style="flex:1; min-height:0;"><img src="${escapeHtml(imageHref)}" alt=""></div>
     </div>`,
  );
}

/* -------------------------------------------------------------------------------------------- */
/* The poster                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * One image somebody can post on its own: the wordmark and a hero shot on the left, a captioned grid
 * of everything else on the right.
 *
 * Landscape rather than the tall poster it wanted to be — see the note at the top of this file about
 * the capture being one viewport. The compromise is not all loss: this shape is the one that embeds
 * in a README without a scroll, which is where it will mostly be seen.
 */
export function posterPage(hero: string, imageHref: (id: string) => string): string {
  const heroShot = shot(hero);
  const panels = shotsFor("poster")
    .filter((entry) => entry.id !== hero)
    .slice(0, 6)
    .map(
      (entry) => `
      <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
        <div class="shot" style="height:132px;"><img src="${escapeHtml(imageHref(entry.id))}" alt=""></div>
        <div class="title" style="font-size:19px;">${escapeHtml(entry.title)}</div>
        <div class="caption" style="font-size:15.5px;">${escapeHtml(entry.caption)}</div>
      </div>`,
    )
    .join("");

  return page(
    `<div style="display:flex; height:100%; padding:32px; gap:28px;">
       <div style="flex:0 0 46%; display:flex; flex-direction:column; gap:12px; min-width:0;">
         <div class="mark" style="font-size:62px;">vrc.zip</div>
         <div class="caption" style="font-size:21px;">A VRChat companion that runs on your own machine. Several accounts at once, a feed you can search, and automations you draw.</div>
         <div class="rule" style="width:100%;"></div>
         <div class="shot" style="flex:1; min-height:0;"><img src="${escapeHtml(imageHref(hero))}" alt=""></div>
         <div class="caption" style="font-size:18px;">${escapeHtml(heroShot.caption)}</div>
       </div>
       <div style="flex:1; display:flex; flex-direction:column; gap:14px; min-width:0;">
         <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px 16px; flex:1; min-height:0;">${panels}</div>
         <div style="display:flex; justify-content:space-between; align-items:center; gap:14px; border-top:1px solid #26262b; padding-top:12px;">
           <div class="caption" style="font-size:17px;">Local-only · 50-80&nbsp;MB idle · plugins · one file</div>
           <div class="unofficial" style="font-size:15px;">UNOFFICIAL. Not affiliated with VRChat Inc.</div>
         </div>
       </div>
     </div>`,
  );
}

/* -------------------------------------------------------------------------------------------- */
/* GIF frames                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** One frame of the short GIF: a wordmark, a claim, and the screen it is about. */
export function shortFramePage(entry: Shot, imageHref: string): string {
  return centred(
    SHORT_ASPECT,
    `<div style="display:flex; flex-direction:column; height:100%; padding:30px; gap:14px;">
       <div class="mark" style="font-size:34px;">vrc.zip</div>
       <div class="rule" style="width:60px;"></div>
       <div class="title" style="font-size:40px;">${escapeHtml(entry.title)}</div>
       <div class="caption" style="font-size:22px;">${escapeHtml(entry.caption)}</div>
       <div class="shot" style="flex:1; min-height:0;"><img src="${escapeHtml(imageHref)}" alt=""></div>
     </div>`,
  );
}

/** A title card for the ad GIF: wordmark, one line, nothing else. */
export function adTitlePage(headline: string, sub: string): string {
  return centred(
    AD_ASPECT,
    `<div style="display:flex; flex-direction:column; height:100%; padding:70px; justify-content:center; gap:20px;">
       <div class="rule" style="width:92px;"></div>
       <div class="mark" style="font-size:104px;">vrc.zip</div>
       <div class="title" style="font-size:46px; max-width:24ch; line-height:1.2;">${escapeHtml(headline)}</div>
       <div class="caption" style="font-size:27px; max-width:54ch;">${escapeHtml(sub)}</div>
     </div>`,
  );
}

/** A feature frame of the ad GIF: the shot large on the left, the claim on the right. */
export function adFramePage(entry: Shot, imageHref: string): string {
  return centred(
    AD_ASPECT,
    `<div style="display:flex; height:100%; padding:40px; gap:30px; align-items:stretch;">
       <div class="shot" style="flex:1 1 64%; min-width:0;"><img src="${escapeHtml(imageHref)}" alt=""></div>
       <div style="flex:0 0 30%; display:flex; flex-direction:column; gap:12px;">
         <div class="rule" style="width:58px;"></div>
         <div class="title" style="font-size:42px; line-height:1.15;">${escapeHtml(entry.title)}</div>
         <div class="caption" style="font-size:23px;">${escapeHtml(entry.caption)}</div>
         <div class="mark" style="font-size:24px; margin-top:auto;">vrc.zip</div>
       </div>
     </div>`,
  );
}

/** The last frame: what it is and where to get it. A loop needs somewhere to land. */
export function adEndPage(): string {
  return centred(
    AD_ASPECT,
    `<div style="display:flex; flex-direction:column; height:100%; padding:70px; justify-content:center; gap:18px;">
       <div class="rule" style="width:68px;"></div>
       <div class="mark" style="font-size:92px;">vrc.zip</div>
       <div class="title" style="font-size:38px;">One file. Nothing to install.</div>
       <div class="caption" style="font-size:27px;">github.com/TheArmagan/vrc.zip</div>
       <div class="unofficial" style="font-size:18px; margin-top:20px;">UNOFFICIAL. Not affiliated with, endorsed by, or operated by VRChat Inc.</div>
     </div>`,
  );
}

/** Every page the pipeline writes, as `filename -> html`. Pure, so a test can read it. */
export function allPages(imageHref: (id: string) => string): Map<string, string> {
  const pages = new Map<string, string>();
  for (const entry of SHOTS) {
    pages.set(`render-${entry.id}.html`, captionPage(entry, imageHref(entry.id)));
  }
  pages.set("poster.html", posterPage("graph-editor", imageHref));
  return pages;
}
