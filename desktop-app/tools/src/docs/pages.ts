/**
 * Every composited image, as a self-contained HTML page to be screenshotted.
 *
 * ## Why HTML and a browser rather than an image library
 *
 * The alternative was decoding the JPEGs and drawing text by hand, which means a new dependency in
 * `tools/` and hand-rolled line breaking for the one thing these pictures are made of: sentences.
 * A browser already does that, is already in the loop for capturing the app itself, and lets anybody
 * open `build/docs/feed.html` and nudge the layout with devtools before committing to it.
 *
 * The pages are deliberately plain — no framework, no fonts fetched from anywhere, one stylesheet
 * shared by all of them. A render that depended on a webfont would render differently on a machine
 * that was offline, which is a strange property for a build artifact.
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

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The shared stylesheet.
 *
 * `image-rendering: -webkit-optimize-contrast` is not decoration: every source image is a screenshot
 * of text being scaled down, and the default smooth filter turns 12px UI type into grey mush. The
 * `letter-spacing` on the wordmark is the same trade in the other direction.
 */
function styles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: ${INK}; color: ${PAPER};
      font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
    .frame { display: flex; flex-direction: column; overflow: hidden; background: ${INK}; }
    .rule { height: 3px; background: ${BRAND}; border-radius: 2px; }
    .mark { font-weight: 700; letter-spacing: -0.02em; color: ${BRAND}; }
    .title { font-weight: 650; letter-spacing: -0.01em; }
    .caption { color: ${MUTED}; line-height: 1.4; }
    .shot { display: block; width: 100%; height: auto; border-radius: 10px;
      border: 1px solid #26262b; image-rendering: -webkit-optimize-contrast; }
    .fill { flex: 1; min-height: 0; overflow: hidden; border-radius: 10px; border: 1px solid #26262b; }
    .fill img { display: block; width: 100%; image-rendering: -webkit-optimize-contrast; }
    .unofficial { color: #71717a; font-size: 13px; }
  `;
}

function page(title: string, width: number, body: string, extra = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${styles()}${extra}
  body { width: ${String(width)}px; }
</style></head><body>${body}</body></html>`;
}

/* -------------------------------------------------------------------------------------------- */
/* One captioned screen                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * The render that goes in the README beside each section: amber rule, title, one sentence, the shot.
 *
 * The title is *not* the app's own heading for that screen where the two would differ — "Automations"
 * rather than "Graphs" — because the caption is read by somebody who has not opened the app and the
 * heading is read by somebody who has.
 */
export function captionPage(entry: Shot, imageHref: string, width = 1280): string {
  return page(
    `${entry.title} — vrc.zip`,
    width,
    `<div class="frame" style="padding:28px 28px 30px; gap:14px;">
       <div class="rule" style="width:56px;"></div>
       <div>
         <div class="title" style="font-size:26px;">${escapeHtml(entry.title)}</div>
         <div class="caption" style="font-size:15px; margin-top:6px; max-width:78ch;">${escapeHtml(entry.caption)}</div>
       </div>
       <img class="shot" src="${escapeHtml(imageHref)}" alt="">
     </div>`,
  );
}

/* -------------------------------------------------------------------------------------------- */
/* The poster                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * One tall image somebody can post on its own: a hero shot under the wordmark, then everything else
 * as a captioned grid.
 *
 * Two columns rather than three. A screenshot of a desktop app shrunk into a third of 1200px is a
 * grey rectangle with a suggestion of text in it, and a grid of those says less than the four words
 * under each one.
 */
export function posterPage(hero: string, imageHref: (id: string) => string): string {
  const heroShot = shot(hero);
  const panels = shotsFor("poster")
    .filter((entry) => entry.id !== hero)
    .map(
      (entry) => `
      <div style="display:flex; flex-direction:column; gap:8px;">
        <img class="shot" src="${escapeHtml(imageHref(entry.id))}" alt="">
        <div class="rule" style="width:34px;"></div>
        <div class="title" style="font-size:17px;">${escapeHtml(entry.title)}</div>
        <div class="caption" style="font-size:13.5px;">${escapeHtml(entry.caption)}</div>
      </div>`,
    )
    .join("");

  return page(
    "vrc.zip",
    1240,
    `<div class="frame" style="padding:40px 40px 44px; gap:26px;">
       <div style="display:flex; align-items:baseline; gap:14px;">
         <div class="mark" style="font-size:40px;">vrc.zip</div>
         <div class="caption" style="font-size:16px;">A VRChat companion that runs on your own machine.</div>
       </div>
       <div class="rule" style="width:100%;"></div>
       <div style="display:flex; flex-direction:column; gap:10px;">
         <img class="shot" src="${escapeHtml(imageHref(hero))}" alt="">
         <div class="caption" style="font-size:14px;">${escapeHtml(heroShot.caption)}</div>
       </div>
       <div style="display:grid; grid-template-columns:1fr 1fr; gap:26px 24px;">${panels}</div>
       <div style="display:flex; justify-content:space-between; align-items:center; gap:16px; border-top:1px solid #26262b; padding-top:18px;">
         <div class="caption" style="font-size:14px;">Multi-account · local-only · extensible · 50–80&nbsp;MB idle</div>
         <div class="unofficial">UNOFFICIAL — not affiliated with VRChat Inc.</div>
       </div>
     </div>`,
  );
}

/* -------------------------------------------------------------------------------------------- */
/* GIF frames                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** 2:3 portrait, one screen per frame, three frames. Sized for a phone-shaped feed. */
export const SHORT_SIZE = { width: 800, height: 1200 } as const;
/** 16:9, the shape that embeds without letterboxing in a README, a chat and a timeline. */
export const AD_SIZE = { width: 1280, height: 720 } as const;

/**
 * One frame of the short GIF.
 *
 * The shot is anchored to the *top* and allowed to overflow rather than being fitted whole. A
 * desktop screen letterboxed into portrait is 60% background; cropping keeps the type legible, which
 * is the only thing three frames at one second each can communicate.
 */
export function shortFramePage(entry: Shot, imageHref: string): string {
  return page(
    entry.title,
    SHORT_SIZE.width,
    `<div class="frame" style="height:${String(SHORT_SIZE.height)}px; padding:34px; gap:18px;">
       <div style="display:flex; align-items:baseline; gap:10px;">
         <div class="mark" style="font-size:26px;">vrc.zip</div>
       </div>
       <div class="rule" style="width:48px;"></div>
       <div class="title" style="font-size:30px;">${escapeHtml(entry.title)}</div>
       <div class="caption" style="font-size:17px;">${escapeHtml(entry.caption)}</div>
       <div class="fill"><img src="${escapeHtml(imageHref)}" alt=""></div>
     </div>`,
    `body { height: ${String(SHORT_SIZE.height)}px; }`,
  );
}

/** A title card for the ad GIF: wordmark, one line, nothing else. */
export function adTitlePage(headline: string, sub: string): string {
  return page(
    headline,
    AD_SIZE.width,
    `<div class="frame" style="height:${String(AD_SIZE.height)}px; padding:64px; justify-content:center; gap:22px;">
       <div class="rule" style="width:72px;"></div>
       <div class="mark" style="font-size:76px;">vrc.zip</div>
       <div class="title" style="font-size:34px; max-width:22ch; line-height:1.2;">${escapeHtml(headline)}</div>
       <div class="caption" style="font-size:20px; max-width:52ch;">${escapeHtml(sub)}</div>
     </div>`,
    `body { height: ${String(AD_SIZE.height)}px; }`,
  );
}

/** A feature frame of the ad GIF: the shot large on the left, the claim on the right. */
export function adFramePage(entry: Shot, imageHref: string): string {
  return page(
    entry.title,
    AD_SIZE.width,
    `<div style="display:flex; height:${String(AD_SIZE.height)}px; padding:44px; gap:34px; align-items:center;">
       <div style="flex:1 1 62%; min-width:0;" class="fill"><img src="${escapeHtml(imageHref)}" alt=""></div>
       <div style="flex:0 0 30%; display:flex; flex-direction:column; gap:14px;">
         <div class="rule" style="width:44px;"></div>
         <div class="title" style="font-size:32px; line-height:1.15;">${escapeHtml(entry.title)}</div>
         <div class="caption" style="font-size:17px;">${escapeHtml(entry.caption)}</div>
         <div class="mark" style="font-size:18px; margin-top:auto;">vrc.zip</div>
       </div>
     </div>`,
    `body { height: ${String(AD_SIZE.height)}px; }`,
  );
}

/** The last frame: what it is and where to get it. A loop needs somewhere to land. */
export function adEndPage(): string {
  return page(
    "vrc.zip",
    AD_SIZE.width,
    `<div class="frame" style="height:${String(AD_SIZE.height)}px; padding:64px; justify-content:center; gap:20px;">
       <div class="rule" style="width:72px;"></div>
       <div class="mark" style="font-size:68px;">vrc.zip</div>
       <div class="title" style="font-size:28px;">One file. Nothing to install.</div>
       <div class="caption" style="font-size:20px;">github.com/TheArmagan/vrc.zip</div>
       <div class="unofficial" style="margin-top:18px;">UNOFFICIAL — not affiliated with, endorsed by, or operated by VRChat Inc.</div>
     </div>`,
    `body { height: ${String(AD_SIZE.height)}px; }`,
  );
}

/** Every page the pipeline writes, as `filename -> html`. Pure, so a test can read it. */
export function allPages(imageHref: (id: string) => string): Map<string, string> {
  const pages = new Map<string, string>();
  for (const entry of SHOTS)
    pages.set(`render-${entry.id}.html`, captionPage(entry, imageHref(entry.id)));
  pages.set("poster.html", posterPage("graph-editor", imageHref));
  return pages;
}
