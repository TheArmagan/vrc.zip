// A plugin that throws at load. The prelude reports it and exits non-zero, which the supervisor
// reads as a crash rather than as a shutdown.
throw new Error("this plugin is broken on purpose");
