// A peer that says hello and then sends a frame only the host is allowed to send.
//
// Direction is part of validation, not documentation: without it a plugin could forge a batch of
// bus events at itself and the host would have no reason to object.
const write = process.stdout.write.bind(process.stdout);
const id = JSON.parse(process.argv[process.argv.length - 1]).pluginId;
write(`${JSON.stringify({ t: "hello", protocol: 0, pluginId: id })}\n`);
write(`${JSON.stringify({ t: "event", sub: "s1", seq: 1, events: [] })}\n`);
const reader = Bun.stdin.stream().getReader();
(async () => {
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
  }
  process.exit(0);
})();
