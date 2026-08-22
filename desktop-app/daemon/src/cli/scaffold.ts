/**
 * `vrc.zip create-plugin <dir>` — the scaffolder.
 *
 * A mode of the shipped executable rather than an npm package (decision 182). An author needs the
 * app before they can run a plugin against it anyway, and a separate CLI would be a third artifact
 * to version against the protocol major.
 *
 * ## What it writes, and why each file is there
 *
 * The template is deliberately the *smallest thing that runs*, not a showcase — `examples/plugins/`
 * is where the showcase lives, and a scaffold full of commented-out features is one an author
 * deletes before reading. Five files:
 *
 *  - `vrcz-plugin.json` — asking for nothing. Adding a scope is a decision, and a template that
 *    pre-asks for `friends:read` teaches that scopes are boilerplate.
 *  - `src/index.ts` — one panel and one handler, with the import path that actually works.
 *  - `package.json` — so `bun add` and an editor's resolution both behave.
 *  - `tsconfig.json` — strict, matching the host, so an author's types mean what ours do.
 *  - `README.md` — the install command, with the consent step spelled out.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PLUGIN_API_PROTOCOL_MAJOR } from "@vrcz/shared";

/**
 * Where an editor fetches the manifest schema.
 *
 * Pinned to `main` rather than a tag: a plugin being written now wants the schema the app it is
 * being written against actually enforces, and a tag would freeze completion at the last release.
 */
const PLUGIN_SCHEMA_URL =
  "https://raw.githubusercontent.com/thearmagan/vrc.zip/main/desktop-app/packages/plugin-api/schema/plugin.json";

export interface ScaffoldResult {
  readonly ok: boolean;
  readonly message: string;
}

/** `My Plugin Folder` → `my-plugin-folder`, which is what the id pattern accepts. */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "my-plugin" : slug;
}

export function scaffoldPlugin(
  targetDir: string,
  options: { publisher?: string } = {},
): ScaffoldResult {
  const root = resolve(targetDir);
  const name = basename(root);
  const slug = slugify(name);
  const publisher = slugify(options.publisher ?? "me");
  const id = `${publisher}.${slug}`;

  if (existsSync(root) && readdirSync(root).length > 0) {
    // Refused rather than merged. Writing a manifest into somebody's existing project and leaving
    // them to work out which files are new is the kind of help nobody asks for twice.
    return {
      ok: false,
      message: `${root} already exists and is not empty. Point me at a new folder.`,
    };
  }

  mkdirSync(join(root, "src"), { recursive: true });

  writeFileSync(
    join(root, "vrcz-plugin.json"),
    `${JSON.stringify(
      {
        // Raw GitHub rather than a vrc.zip URL: there is no web service to host one, and a
        // schema URL that 404s is worse than none — an editor silently stops offering completion
        // and the author never learns why. This path is the file the docs generator writes.
        $schema: PLUGIN_SCHEMA_URL,
        id,
        name,
        version: "0.1.0",
        publisher,
        description: "A new vrc.zip plugin.",
        main: "src/index.ts",
        engines: { pluginApi: PLUGIN_API_PROTOCOL_MAJOR },
        permissions: {
          // Nothing by default. Every entry here is a line on a consent sheet somebody reads.
          scopes: [],
          accounts: { mode: "one", optional: true, reason: "It does not act as any account yet." },
          capabilities: [],
          events: [],
          fetch: { domains: [], reason: "It makes no requests." },
        },
        contributes: {
          panels: [{ id: "main", title: name, placement: "sidebar" }],
          commands: [],
          nodes: [],
        },
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    join(root, "src", "index.ts"),
    `import { definePlugin } from "@vrcz/plugin-api/runtime";

/**
 * Import from "@vrcz/plugin-api/runtime", never from "@vrcz/plugin-api".
 *
 * The package root carries the manifest schema, which pulls in zod, which uses eval — and the
 * install pipeline refuses that in a bundled plugin. Type-only imports from the root are fine.
 */

let clicks = 0;

function panel() {
  return {
    type: "card",
    title: ${JSON.stringify(name)},
    children: [
      { type: "text", key: "count", value: \`clicked \${clicks} times\` },
      { type: "button", label: "Click me", onClick: { name: "click" } },
    ],
  };
}

definePlugin({
  async activate(ctx) {
    await ctx.ui.setPanel("main", panel());
  },

  async onIntent(dispatch, ctx) {
    if (dispatch.intent.name !== "click") return;
    clicks += 1;
    // A keyed patch: only this node is replaced, so everything around it keeps its scroll,
    // focus and open dialogs.
    await ctx.ui.patchPanel("main", "count", {
      type: "text",
      key: "count",
      value: \`clicked \${clicks} times\`,
    });
  },
});
`,
  );

  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: slug,
        version: "0.1.0",
        private: true,
        type: "module",
        dependencies: { "@vrcz/plugin-api": "*" },
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    join(root, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    join(root, "README.md"),
    `# ${name}

A vrc.zip plugin.

\`\`\`bash
bun install
vrc.zip dev .
\`\`\`

\`dev\` installs this folder into a running vrc.zip and reinstalls it whenever a file changes.

**The first install waits for you to approve it.** Open vrc.zip, go to Plugins, and hold the
confirm button — nothing is granted until you do. Later reinstalls do not ask again unless what the
plugin is *asking for* changes, because the grant is keyed by exactly that.

Your plugin runs with your account's privileges. See the security model in the vrc.zip docs.
`,
  );

  return {
    ok: true,
    message: [
      `Created ${id} in ${root}`,
      "",
      `  cd ${root}`,
      "  bun install",
      "  vrc.zip dev .",
    ].join("\n"),
  };
}
