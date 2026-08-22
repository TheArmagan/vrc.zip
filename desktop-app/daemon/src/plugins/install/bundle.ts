/**
 * Install-time compilation: one plugin source tree in, one JavaScript file out.
 *
 * PLAN.md §"Install-time compilation, not runtime resolution" prescribes `Bun.build` with
 * `target: "browser"` and `external: []`, on the argument that a plugin's whole module graph should
 * be resolved once, at install, by the host — not at 3 AM by whatever the plugin asks for.
 *
 * ## The plan's one factual error, and what replaces it
 *
 * PLAN.md says, parenthetically, that under those settings "node builtins become hard build errors".
 * **Measured on Bun 1.4.0, they do not.** `target: "browser"` *stubs* them: an
 * `import { readFileSync } from "node:fs"` compiles, silently, to
 *
 * ```js
 * var { readFileSync } = (() => ({}));
 * ```
 *
 * which is worse than either alternative. The import is gone, so the deny-scan over the output has
 * nothing to find; and the plugin gets `undefined` where it expected a function, so it fails at run
 * time with a `TypeError` that names neither the cause nor the plugin's mistake. The bare spelling
 * (`from "fs"`) behaves identically. Only `import { sql } from "bun"` is a native build error.
 *
 * So the hard error is made real here, with a resolver plugin that refuses any bare specifier naming
 * a host builtin. It runs *before* Bun's stubbing, sees the specifier as written, and turns it into
 * the install failure PLAN.md describes. The deny-scan still checks the output for the same thing —
 * two checks, because they fail differently: this one names the source file the author wrote, and
 * the scan catches anything that reached the bundle by a route the resolver never saw.
 *
 * ## Install source
 *
 * **A local directory, and only a local directory, for this pass.** Decision 107 also allows a git
 * URL pinned to a commit; that is deliberately not built yet. The seam for it is a single step in
 * front of everything here: fetch the pinned commit into a temp directory, then run this pipeline
 * against that directory unchanged. Nothing below needs to know which of the two it got, which is
 * the property to preserve when the git source lands.
 */

import { builtinModules } from "node:module";
import { join } from "node:path";

/** Where a build failure happened, when Bun could tell us. */
export interface BuildDiagnostic {
  readonly message: string;
  /** Absolute path of the source file, when the log carried one. */
  readonly file: string | null;
  /** 1-based; 0 when Bun reported no position (a resolver rejection has none). */
  readonly line: number;
}

export type BundleResult =
  | { readonly ok: true; readonly code: string; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly diagnostics: readonly BuildDiagnostic[];
      readonly message: string;
    };

/**
 * The bare specifiers a plugin may not import.
 *
 * `node:` and `bun:` prefixes plus every unprefixed builtin name, because `"fs"` and `"node:fs"` are
 * the same module and only one of them looks like a violation. Sourced from `node:module` so the set
 * cannot drift away from the runtime that would have served them.
 */
const HOST_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

function isHostBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier === "bun" ||
    HOST_BUILTINS.has(specifier)
  );
}

/** Written for the author, since a build failure is nearly always their bug rather than an attack. */
function builtinRefusal(specifier: string): string {
  return `"${specifier}" is part of the host runtime and is not available to plugins. A plugin reaches storage, the network and VRChat through the vrc.zip plugin API, which is what makes those uses visible on the consent screen.`;
}

export interface BundleOptions {
  /** The plugin's root directory — the one holding `vrcz-plugin.json`. */
  readonly rootDir: string;
  /** `manifest.main`, already validated as a relative path inside the root. */
  readonly main: string;
}

/**
 * Compiles a plugin to a single ESM file.
 *
 * Returns a result rather than throwing: a plugin that does not compile is an ordinary outcome of
 * installing one, and every caller wants the diagnostics to show rather than a stack trace.
 */
export async function bundlePlugin(options: BundleOptions): Promise<BundleResult> {
  const entrypoint = join(options.rootDir, options.main);

  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [entrypoint],
      // Both of these are the plan's, and both matter. `browser` denies the plugin Bun's own globals
      // by construction; `external: []` means every import is resolved now, by us, rather than at
      // run time by the plugin's process.
      target: "browser",
      external: [],
      format: "esm",
      // One file. A code-split bundle would be several artifacts and therefore several hashes, and
      // "the artifact is named by its own hash" only means something when there is one artifact.
      splitting: false,
      sourcemap: "none",
      // A plugin is not built in a mode. Leaving `process.env.NODE_ENV` unreplaced also keeps the
      // deny-scan looking at the code the author wrote rather than at a dead branch we folded.
      minify: false,
      throw: false,
      plugins: [
        {
          name: "vrczip-deny-builtins",
          setup(build) {
            // Bare specifiers only. Relative and absolute paths fall through to Bun's resolver
            // untouched, and so does every real dependency in the plugin's `node_modules`.
            build.onResolve({ filter: /^[^./]/ }, (args) => {
              if (isHostBuiltin(args.path)) throw new Error(builtinRefusal(args.path));
              return undefined;
            });
          },
        },
      ],
    });
  } catch (error) {
    return failure([
      { message: error instanceof Error ? error.message : String(error), file: null, line: 0 },
    ]);
  }

  const diagnostics = built.logs
    .filter((log) => log.level === "error")
    .map((log) => toDiagnostic(log));

  if (!built.success) {
    return failure(
      diagnostics.length > 0
        ? diagnostics
        : [{ message: "The plugin could not be compiled.", file: null, line: 0 }],
    );
  }

  const output = built.outputs[0];
  if (output === undefined) {
    return failure([
      {
        message: `Compiling "${options.main}" produced no output. Check that it exports an activate function.`,
        file: entrypoint,
        line: 0,
      },
    ]);
  }

  const bytes = new Uint8Array(await output.arrayBuffer());
  return { ok: true, code: new TextDecoder().decode(bytes), bytes };
}

function toDiagnostic(log: { message: string; position?: unknown }): BuildDiagnostic {
  const position = log.position;
  if (position === null || typeof position !== "object") {
    return { message: log.message, file: null, line: 0 };
  }
  const record = position as { file?: unknown; line?: unknown };
  const file = typeof record.file === "string" && record.file.length > 0 ? record.file : null;
  const line = typeof record.line === "number" && record.line > 0 ? record.line : 0;
  return { message: log.message, file, line };
}

function failure(diagnostics: readonly BuildDiagnostic[]): BundleResult {
  return { ok: false, diagnostics, message: formatDiagnostics(diagnostics) };
}

export function formatDiagnostics(diagnostics: readonly BuildDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const where =
        diagnostic.file === null
          ? ""
          : diagnostic.line > 0
            ? `${diagnostic.file}:${String(diagnostic.line)}: `
            : `${diagnostic.file}: `;
      return `${where}${diagnostic.message}`;
    })
    .join("\n");
}
