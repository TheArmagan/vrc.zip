// An ordinary plugin bundle, imported by the real prelude. Answers a `req` on the same id.
const host = globalThis.__vrczHost;
host.onFrame((frame) => {
  if (frame.t === "req") {
    host.send({
      t: "res",
      id: frame.id,
      result: { method: frame.method, params: frame.params ?? null },
    });
  }
});
