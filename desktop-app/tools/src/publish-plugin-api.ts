/**
 * Builds the publishable `@vrcz/plugin-api` into `dist/`, ready for `npm publish dist`.
 *
 * ## Why a build at all, when the daemon imports the source
 *
 * Inside this repository every consumer is Bun, which runs TypeScript directly — so `exports` points
 * at `src/*.ts` and there is no build step in the way of development. An npm consumer is not Bun:
 * Node cannot run `.ts`, `tsc` needs declarations, and an editor needs both. So publishing compiles,
 * and it publishes **from a directory** rather than mutating the package in place, which is what
 * keeps the repo's own resolution untouched.
 *
 * ## Why `@vrcz/shared` is inlined rather than depended on
 *
 * `workspace:*` cannot be published — npm has no idea what it means — so the choice is to publish a
 * second package or to inline the one. Inlining wins here because `@vrcz/shared` is deliberately an
 * *internal* leaf: it carries the daemon's wire types and its own release cadence would then be a
 * public contract nobody asked for. A plugin author should install one package, and its version
 * should mean the protocol major and nothing else.
 *
 * The JS half is easy — the bundler inlines it. The **declarations** are the part that needs care:
 * `tsc` emits `.d.ts` files that still say `from "@vrcz/shared"`, which would resolve to nothing on
 * a consumer's machine. So shared's declarations are emitted alongside and those specifiers are
 * rewritten to point at them.
 *
 * ## What is checked before it writes anything
 *
 * That the four entry points exist, and that the built declarations contain no unresolved
 * `@vrcz/` specifier. The second is the failure that would otherwise ship: a package that installs
 * cleanly, imports at runtime, and shows every type as `any` in the author's editor.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const HERE = resolve(import.meta.dir, "..", "..", "packages", "plugin-api");
const DIST = join(HERE, "dist");

/** The four public entry points. Each becomes `<name>.js` plus `<name>.d.ts` in `dist/`. */
const ENTRIES = ["index", "runtime", "ui", "nodes"] as const;

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    console.error(new TextDecoder().decode(result.stderr));
    throw new Error(`${command.join(" ")} failed`);
  }
}

/** Moves every file under `from` into `to`, creating it. Used to flatten what `tsc` emitted. */
function moveTree(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`tsc emitted nothing at ${from}`);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}

/** Every `.d.ts` under `dir`, so the rewrite below cannot miss one. */
function declarations(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...declarations(full));
    else if (entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

function main(): void {
  console.log("Building @vrcz/plugin-api for npm…");
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as {
    name: string;
    version: string;
    description: string;
    license: string;
    dependencies: Record<string, string>;
  };

  // 1. JavaScript. `@vrcz/shared` is inlined by the bundler; zod stays external because a consumer
  //    installs it and two copies of zod in one process is a class of bug nobody enjoys.
  const built = Bun.spawnSync(
    [
      "bun",
      "build",
      ...ENTRIES.map((entry) => `./src/${entry}.ts`),
      "--outdir",
      "./dist",
      "--target",
      "node",
      "--format",
      "esm",
      "--external",
      "zod",
    ],
    { cwd: HERE, stdout: "pipe", stderr: "pipe" },
  );
  if (built.exitCode !== 0) {
    console.error(new TextDecoder().decode(built.stderr));
    throw new Error("bun build failed");
  }

  // 2. Declarations, for this package and for the one it inlines.
  run(["bunx", "tsc", "-p", "tsconfig.build.json"], HERE);

  /*
   * 3. Flatten what `tsc` emitted, then fix the specifiers inside it.
   *
   * `rootDir: ".."` is what lets one compile cover both packages, and its cost is the shape of the
   * output: `dist/plugin-api/src/x.d.ts` and `dist/shared/src/y.d.ts`. The published layout is flat
   * — `x.d.ts` beside `x.js` — with shared's declarations under `_shared/`, underscored to say
   * plainly that it is not part of the API.
   *
   * Two rewrites follow, and both are about specifiers a consumer cannot resolve:
   *
   *  - `@vrcz/shared` means nothing outside this repository, so it becomes a relative path.
   *  - `./manifest.ts` is legal *here* — `allowImportingTsExtensions` is on and Bun runs TypeScript
   *    directly — and is nonsense in a published package, where the file next door is `.js`.
   */
  moveTree(join(DIST, "plugin-api", "src"), DIST);
  moveTree(join(DIST, "shared", "src"), join(DIST, "_shared"));
  rmSync(join(DIST, "plugin-api"), { recursive: true, force: true });
  rmSync(join(DIST, "shared"), { recursive: true, force: true });

  for (const file of declarations(DIST)) {
    // Both separators: `tsc` emits forward slashes and `join` produces backslashes on Windows, and
    // this runs on the paths of both.
    const depth = file.slice(DIST.length + 1).split(/[\\/]/).length - 1;
    const prefix = depth === 0 ? "./" : "../".repeat(depth);
    const source = readFileSync(file, "utf8");
    const rewritten = source
      .replaceAll('"@vrcz/shared"', `"${prefix}_shared/index.js"`)
      // Relative TypeScript specifiers, which only this repository can resolve.
      .replace(/from "(\.[^"]*)\.ts"/g, 'from "$1.js"')
      .replace(/import\("(\.[^"]*)\.ts"\)/g, 'import("$1.js")');
    if (rewritten !== source) writeFileSync(file, rewritten, "utf8");
  }

  // 4. The published manifest. Written rather than edited, so the repo's own `exports` — which
  //    point at TypeScript source and must keep doing so — are never touched by a publish.
  writeFileSync(
    join(DIST, "package.json"),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        license: pkg.license,
        type: "module",
        // Versioned on the protocol major, which is what the docs promise and what an author's
        // `engines.pluginApi` has to agree with.
        exports: Object.fromEntries(
          ENTRIES.map((entry) => [
            entry === "index" ? "." : `./${entry}`,
            { types: `./${entry}.d.ts`, import: `./${entry}.js`, default: `./${entry}.js` },
          ]),
        ),
        types: "./index.d.ts",
        // zod only. `@vrcz/shared` is inlined above and is deliberately not a public package.
        dependencies: { zod: pkg.dependencies.zod },
        sideEffects: false,
        repository: { type: "git", url: "git+https://github.com/thearmagan/vrc.zip.git" },
        homepage: "https://github.com/thearmagan/vrc.zip/tree/main/desktop-app/packages/plugin-api",
        bugs: { url: "https://github.com/thearmagan/vrc.zip/issues" },
        keywords: ["vrchat", "vrc.zip", "plugin", "plugin-api"],
        publishConfig: { access: "public" },
        engines: { node: ">=20" },
      },
      null,
      2,
    )}\n`,
  );

  cpSync(join(HERE, "README.md"), join(DIST, "README.md"));
  cpSync(join(HERE, "docs"), join(DIST, "docs"), { recursive: true });
  if (existsSync(join(HERE, "schema"))) {
    cpSync(join(HERE, "schema"), join(DIST, "schema"), { recursive: true });
  }

  // 5. The checks worth having, in the order they would bite.
  for (const entry of ENTRIES) {
    for (const suffix of [".js", ".d.ts"]) {
      const file = join(DIST, `${entry}${suffix}`);
      if (!existsSync(file) || statSync(file).size === 0) {
        throw new Error(`missing or empty: ${entry}${suffix}`);
      }
    }
  }
  /*
   * Specifiers only.
   *
   * A first cut looked for `@vrcz/` anywhere in the file and failed on every one of them — the doc
   * comments name `@vrcz/plugin-api` constantly, which is exactly what they should do. What must
   * not survive is an *import*.
   */
  const specifier = /(?:from|import\()\s*"@vrcz\//;
  const isComment = (line: string): boolean => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
  };
  const leaked = declarations(DIST).filter((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .some((line) => !isComment(line) && specifier.test(line)),
  );
  if (leaked.length > 0) {
    // The failure this exists for: a package that installs, imports, and silently types as `any`.
    throw new Error(
      `these declarations still reference a workspace package:\n  ${leaked.join("\n  ")}`,
    );
  }

  console.log(`  ${DIST}`);
  console.log("");
  console.log("  npm publish dist --access public");
}

main();
