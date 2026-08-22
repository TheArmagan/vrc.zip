/**
 * Dies during module evaluation, every single time.
 *
 * The adversary for the *breaker* rather than for any one watchdog. A plugin that cannot start is
 * not by itself interesting — it is a bad build, and the restart ladder exists precisely so a plugin
 * waiting on something that recovers comes back on its own. What has to hold is that a plugin which
 * will *never* recover stops costing a process spawn forever, and that the decision to stop
 * **survives the daemon restarting**: an auto-disable that did not would be a crash loop with extra
 * steps, one per boot, for as long as anybody restarts the app.
 *
 * It throws at module scope rather than from `activate`, because that is the failure the prelude
 * turns into an exit: the bundle's `import()` rejects, the prelude logs it and calls `exit(1)`, and
 * the transport reports `crashed`. A throw from `activate` is a different path — an `err` frame and
 * `activate-failed` — and conflating the two would test one of them twice.
 */

throw new Error("this plugin cannot start, and will not be able to next time either");
