/**
 * Allocates without bound, as fast as it can while still yielding.
 *
 * Aimed at two defences that fail differently, which is why both exist. The OS-level cap (a Job
 * Object on Windows, `RLIMIT_AS` on Linux) fails the *allocation*, so the process dies at a
 * predictable ceiling. The RSS watchdog only *notices*, on its own schedule — and this file
 * allocates faster than any sane tick interval, so a build where only the watchdog is working shows
 * exactly how much a plugin can take before anyone looks.
 *
 * Typed arrays rather than strings or arrays of objects: they are backed by real pages the moment
 * they are written to, so the growth is genuine rather than a promise the allocator has not kept.
 * Each block is touched for that reason — an untouched `ArrayBuffer` may cost nothing resident.
 *
 * **It yields between rounds, deliberately.** A bomb that also blocked the loop would be caught by
 * the heartbeat first and would never reach the watchdog, and it would stop reporting `rss` on its
 * pongs — which is the very number the watchdog reads when the transport has no OS reader. The
 * module-scope round is small for the same reason: large enough to prove the file misbehaves before
 * the host has decided it is healthy, small enough that `hello` and `activate` still get through.
 *
 * One block per tick rather than a batch, measured: touching four 16 MiB blocks in one callback
 * holds the loop long enough to miss heartbeats, and a bomb that trips the *wedge* detector is a
 * bomb that never reaches the watchdog it was written for. One block is ~16 MiB per millisecond,
 * which outruns any tick interval a supervisor would sanely use while still yielding between rounds.
 */

const BLOCK_BYTES = 16 * 1024 * 1024;
const PAGE_BYTES = 4096;

const held = [];

function grow(blocks) {
  for (let i = 0; i < blocks; i += 1) {
    const block = new Uint8Array(BLOCK_BYTES);
    // Touch one byte per page so the pages are actually resident rather than merely reserved.
    for (let offset = 0; offset < block.length; offset += PAGE_BYTES) block[offset] = 1;
    held.push(block);
  }
}

grow(2);

export function activate() {
  const timer = setInterval(() => {
    grow(1);
  }, 5);
  return { timer: String(timer), heldBlocks: held.length };
}
