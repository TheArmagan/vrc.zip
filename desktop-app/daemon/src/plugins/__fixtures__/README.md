# Plugin transport fixtures

Real scripts, spawned by a real `Bun.spawn` from `process-transport.test.ts`. This layer's bugs are
at the process boundary (framing across chunk edges, stream close ordering, what a kill actually
does on Windows), and a stubbed child process hides every one of them. Same reasoning as the
recorded-fixture VRChat server: see CLAUDE.md.

Two kinds of file, and the difference is which side they stand in for:

- **`prelude-*.js`** replace the injected prelude (`ProcessTransportDeps.preludeSource`). They exist
  to be peers the real prelude never would be: one that never says `hello`, one that sends a
  host-only frame, one that will not stop. The real prelude cannot misbehave that way, which is the
  point of it, so testing the host's response to misbehaviour needs a stand-in.
- **`plugin-*.js`** are ordinary plugin bundles imported *by* the real prelude. They test the pair
  working together.

Neither kind is the deliberately hostile plugin from PLAN.md's threat model. That is its own step
and lives under `hostile/`.
