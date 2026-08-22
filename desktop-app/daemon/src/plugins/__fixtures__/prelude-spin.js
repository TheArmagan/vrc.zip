// A peer that says hello and then never yields the event loop again. Only `kill()` ends this.
const write = process.stdout.write.bind(process.stdout);
const id = JSON.parse(process.argv[process.argv.length - 1]).pluginId;
write(`${JSON.stringify({ t: "hello", protocol: 0, pluginId: id })}\n`);
for (;;) {
  // Deliberately empty: a spin loop is the failure mode the heartbeat exists to catch.
}
