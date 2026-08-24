# @vrcz/plugin-api

The public plugin surface for [vrc.zip](https://github.com/TheArmagan/vrc.zip): the manifest schema,
the host/plugin wire protocol, the declarative UI vocabulary, and the graph node model.

Versioned on the **protocol major**, not the app version. A plugin declares `engines.pluginApi`
against this number, because the application and the plugin protocol version independently and
conflating them would force an ecosystem break on every app release.

> [!IMPORTANT]
> **You cannot install or run a plugin from the app yet.** The types in this package are settled and
> tested, the daemon can spawn and supervise a plugin process, and the install pipeline, the scope
> gate and the reads-only `ctx.vrchat` surface are all built and tested. What is missing is the last
> mile: there is no consent screen, and nothing in the daemon's composition root constructs the
> plugin subsystem, so none of it is reachable. See [docs/status.md](./docs/status.md) for the
> step-by-step breakdown before building anything you are relying on.

## Documentation

Start at **[docs/](./docs/README.md)**. If you read only two pages, read
[docs/status.md](./docs/status.md) for what actually runs and
[docs/security-model.md](./docs/security-model.md) for what a plugin can do to the person who
installs it.

## What is in here

```ts
import {
  parseManifest,       // validate a vrcz-plugin.json, with readable errors
  grantHash,           // the stable digest that decides when consent is re-asked
  parseEnvelope,       // parse an untrusted wire frame without throwing
  validateUINode,      // validate a UI tree, with depth and size caps
  assignable,          // the port-type lattice's four widening rules
} from "@vrcz/plugin-api";
```

Four modules, and the dependency direction between them is one-way on purpose. `protocol.ts`,
`ui.ts` and `nodes.ts` do **not** import `manifest.ts`: the manifest is what an author *requested*, a
grant is what the user *approved*, and nothing on the call path may consult the former. The
dispatcher takes a grant and has no way to reach a manifest even by accident.

## The one-paragraph model

A plugin is a separate process with no shared memory, no DOM access, and no VRChat credential. It
describes UI as JSON that the host renders with its own components; it calls a semantic API rather
than the byte-faithful VRChat mirror; anything expensive or dangerous is executed by the host on its
behalf; and everything it can do is a scope a human approved by name, for the accounts they chose.

## Security

Read [docs/security-model.md](./docs/security-model.md) before publishing or installing anything. The
summary that page exists to justify:

**Plugins run with your account's privileges. Only install plugins you trust.**

That is the accurate description today, and it will not be softened until process plus OS-level
sandboxing makes it false.

## License

MIT.
