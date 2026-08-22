// A peer that says hello and then ignores the graceful stop entirely: it never reads stdin, so the
// EOF the host sends means nothing to it, and a timer keeps the process alive indefinitely.
//
// Unlike prelude-spin it yields the loop, so it would answer a heartbeat. Being responsive and
// being willing to stop are different things, and `stop()` has to survive the second without the
// first.
const write = process.stdout.write.bind(process.stdout);
const id = JSON.parse(process.argv[process.argv.length - 1]).pluginId;
write(`${JSON.stringify({ t: "hello", protocol: 0, pluginId: id })}\n`);
setInterval(() => {}, 1000);
