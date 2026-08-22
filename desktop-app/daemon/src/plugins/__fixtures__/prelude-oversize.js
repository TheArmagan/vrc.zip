// A peer that writes far more than one frame's worth of bytes with no newline in sight, then
// finishes the line and sends a perfectly good frame.
//
// Two properties under test: the host must not buffer the flood, and it must resynchronise on the
// next newline rather than treating one bad line as the end of the conversation.
const write = process.stdout.write.bind(process.stdout);
const id = JSON.parse(process.argv[process.argv.length - 1]).pluginId;
write(`${JSON.stringify({ t: "hello", protocol: 0, pluginId: id })}\n`);
const chunk = "x".repeat(256 * 1024);
for (let i = 0; i < 16; i++) write(chunk);
write("\n");
write(`${JSON.stringify({ t: "credit", sub: "s1", credits: 7 })}\n`);
const reader = Bun.stdin.stream().getReader();
(async () => {
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
  }
  process.exit(0);
})();
