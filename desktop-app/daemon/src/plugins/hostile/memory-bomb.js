/**
 * Allocates without bound, as fast as it can.
 *
 * Aimed at two defences that fail differently, which is why both exist. The OS-level cap (a Job
 * Object on Windows, `RLIMIT_AS` on Linux) fails the *allocation*, so the process dies at a
 * predictable ceiling. The RSS watchdog only *notices*, on its own schedule — and this file is
 * written to allocate faster than any sane tick interval, so a build where only the watchdog is
 * working shows exactly how much a plugin can take before anyone looks.
 *
 * Typed arrays rather than strings or arrays of objects: they are backed by real pages the moment
 * they are written to, so the growth is genuine rather than a promise the allocator has not kept.
 * Each block is touched for that reason — an untouched `ArrayBuffer` may cost nothing resident.
 */
const held = [];

function grow() {
  for (let i = 0; i < 64; i += 1) {
    const block = new Uint8Array(16 * 1024 * 1024);
    // Touch one byte per page so the pages are actually resident rather than merely reserved.
    for (let offset = 0; offset < block.length; offset += 4096) block[offset] = 1;
    held.push(block);
  }
}

grow();

export function activate() {
  // Yields between rounds, so this one is *not* also a spin loop. The watchdog must catch a plugin
  // that is behaving perfectly well by every other measure and simply eating the machine.
  const timer = setInterval(grow, 1);
  return { timer: String(timer) };
}
