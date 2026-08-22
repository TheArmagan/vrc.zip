/**
 * VRChat's image-URL grammar, which both sides of the wire have to read the same way.
 *
 * It lives here rather than in the daemon because the UI needs it too, and for the reason this
 * package exists at all: a second copy of a grammar is a second opinion about what a file id is.
 * The daemon uses it to decide what may be sent to avtr.zip; the UI uses it to decide whether a
 * picture is worth asking about. If those two ever disagreed, the UI would offer a lookup the
 * daemon then refused, or hide one it would have answered.
 */

/** A VRChat file id: `file_` plus the uuid. The prefix is part of the id, and part of the path. */
export const FILE_ID_PATTERN = /^file_[0-9A-Za-z-]{1,64}$/;

/** An avatar id, `avtr_` plus the uuid. Checked before an answer from avtr.zip is believed. */
export const AVATAR_ID_PATTERN = /^avtr_[0-9A-Za-z-]{1,64}$/;

/**
 * The `file_…` id inside a VRChat image URL, or null.
 *
 * Both shapes VRChat serves land here — `/api/1/image/file_x/2/256` and `/api/1/file/file_x/1/1024`
 * — so this looks for a path *segment* shaped like a file id rather than matching either template.
 * The segment scan is also what makes it safe: whatever else is in the URL, the only thing that can
 * come out is one id matching {@link FILE_ID_PATTERN}, which is the thing that goes on to leave the
 * machine.
 *
 * Never throws. A string that is not a URL at all is an ordinary input here — VRChat sends `""` for
 * an unset image field — and is simply not a file id.
 */
export function fileIdFromImageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Only http(s). A `data:` or `file:` URL has no meaningful path segments and should never reach
  // a third-party lookup even if one of them happened to spell a file id.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  for (const segment of parsed.pathname.split("/")) {
    // Decoded before it is tested, so a percent-encoded segment cannot smuggle a `/` past the
    // pattern — and the pattern is what the rest of this module trusts.
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      continue;
    }
    if (FILE_ID_PATTERN.test(decoded)) return decoded;
  }
  return null;
}
