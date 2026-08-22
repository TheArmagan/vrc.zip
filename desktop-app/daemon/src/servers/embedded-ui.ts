import { EMBEDDED_UI_PREFIX } from "@vrcz/shared";

/**
 * The UI bundle when it is inside the executable rather than on disk. See PLAN.md §Phase 5.
 *
 * `bun build --compile --asset=ui/dist` embeds the built bundle into the binary and exposes every
 * embedded file as a `Blob` on `Bun.embeddedFiles`, keyed by the path it had at build time. That is
 * the whole mechanism: no generated import map, no unpacking to a temp directory on first run, and
 * no writable copy of the UI sitting next to the exe for something else to edit.
 *
 * Two properties of those blobs are worth knowing, because they decide how `ui.ts` uses them:
 *
 * - **The `Content-Type` is already correct.** Bun records it from the file extension at build
 *   time, so `new Response(blob)` sets the header without a mime table of ours.
 * - **`Bun.embeddedFiles` is empty when running from source.** Not an error state — it is how the
 *   dev daemon, every test, and `bun run daemon` behave, and it is exactly the condition that
 *   should hand the request back to the filesystem path.
 */

/** Request path (no leading slash) to the embedded bytes. Empty when running from source. */
export type EmbeddedUi = ReadonlyMap<string, Blob>;

/**
 * Builds the lookup from a list of embedded files.
 *
 * Anything outside {@link EMBEDDED_UI_PREFIX} is dropped rather than served: a compiled binary can
 * carry embedded files that have nothing to do with the UI, and a lookup keyed on the tail of a
 * path would happily hand one of them to a browser.
 */
export function embeddedUiFrom(files: readonly Blob[]): EmbeddedUi {
  const map = new Map<string, Blob>();
  for (const file of files) {
    // `name` is present on embedded files (they are `File`s); a plain `Blob` has none, and one
    // without a usable name cannot be addressed by a request path anyway.
    const name = (file as File).name;
    if (typeof name !== "string") continue;

    // Bun normalises to forward slashes on every platform, but the build script's cwd is ours to
    // get wrong, so accept a Windows separator rather than silently embedding an unreachable UI.
    const normalized = name.replaceAll("\\", "/");
    if (!normalized.startsWith(EMBEDDED_UI_PREFIX)) continue;

    const requestPath = normalized.slice(EMBEDDED_UI_PREFIX.length);
    if (requestPath === "") continue;
    map.set(requestPath, file);
  }
  return map;
}

/** The UI embedded in *this* executable, or an empty map when running from source. */
export function embeddedUi(): EmbeddedUi {
  return embeddedUiFrom(Bun.embeddedFiles);
}

/**
 * Whether this process is a packaged single-file build.
 *
 * Keyed on the embedded UI rather than on `process.execPath`, because that is the property callers
 * actually care about — a binary built without the bundle should behave like a source checkout and
 * say the UI is missing, not claim to be a finished app.
 */
export function isPackaged(): boolean {
  return embeddedUi().size > 0;
}
