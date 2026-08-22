/**
 * Allocates without bound during module evaluation, before the plugin has ever activated.
 *
 * The sibling of `memory-bomb.js`, and the pair exists because **an OS memory cap does not stop the
 * same plugin the same way depending on when it allocates**, which was not obvious and is not what
 * PROGRESS.md §Gotchas records.
 *
 * When the refused allocation happens here, at module scope, the `import()` the prelude performs
 * rejects; the prelude logs the failure and calls `exit(1)`, and the transport reports `crashed`.
 * That is the behaviour the Gotcha describes.
 *
 * When it happens in a timer callback instead — `memory-bomb.js` — the `RangeError: Out of memory`
 * is an *uncaught exception*, and the prelude installs a handler for those on purpose, so that a
 * plugin throwing asynchronously loses that turn rather than the process. The result is that the
 * capped process does not die at all: it sits at the ceiling retrying forever. Both files are here
 * so the suite states both, rather than generalising from whichever one was measured first.
 */

const BLOCK_BYTES = 16 * 1024 * 1024;
const PAGE_BYTES = 4096;

const held = [];

/**
 * 1 GiB, which is not a limit this file believes in — it is a guard on the *test*.
 *
 * Under any cap worth testing the allocation is refused long before this, and the loop ends by
 * throwing. If it ever runs to completion the cap did not work, and the plugin then activates
 * normally and the assertion fails loudly with the machine intact, which is the correct way to find
 * that out.
 */
const GUARD_BLOCKS = 64;

// Synchronously, on the way in. The loop ends when the allocation is refused, and under a cap that
// refusal is a throw out of module evaluation rather than an uncaught exception.
for (let i = 0; i < GUARD_BLOCKS; i += 1) {
  const block = new Uint8Array(BLOCK_BYTES);
  for (let offset = 0; offset < block.length; offset += PAGE_BYTES) block[offset] = 1;
  held.push(block);
}
