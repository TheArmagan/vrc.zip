/**
 * The install pipeline: a directory on disk in, a verified content-addressed artifact out.
 *
 * Five steps, in this order, and the order is the design:
 *
 *  1. **Read and parse `vrcz-plugin.json`** through the Zod schema in `@vrcz/plugin-api`. Not a
 *     second copy of it — the schema is the single source of truth and the consent screen, the docs
 *     and this file all read the same one.
 *  2. **Compile** with `Bun.build`, `target: "browser"`, `external: []`, plus a resolver that turns a
 *     host-builtin import into a hard error (see `bundle.ts` for why Bun does not do that itself).
 *  3. **Deny-scan the bundled output** — the artifact, not the sources, because the artifact is the
 *     only place the whole program is visible at once.
 *  4. **Content-address** it at `plugins/<id>/<sha256>.js`.
 *  5. **Verify it back off disk** before declaring success, through the same `loadArtifact` the
 *     spawn path uses. Re-reading a file we just wrote looks redundant and is not: it means the
 *     install path and the load path agree by construction rather than by two people remembering to
 *     keep them in step, and the failure it catches — a filesystem that did not store what we handed
 *     it — is one nobody would otherwise find until the plugin refused to start.
 *
 * **This pipeline does not write to the store and does not decide trust.** It returns what it built;
 * the consent flow (step 3.8) is what asks the user, records the grant and writes the `plugins` row,
 * because "we compiled it" and "you agreed to run it" are two different facts and only one of them
 * is this file's to assert. Signature verification belongs to that step too.
 *
 * ## Install source
 *
 * **Local directory only in this pass**, per the user's explicit deferral of decision 107's second
 * source. A pinned git URL is a *fetch step in front of an otherwise identical pipeline*: clone at
 * the pinned commit into a temp directory, hand the path to {@link installPluginFromDirectory}, and
 * record `source_kind: "git"` with the commit as `source_ref`. Nothing below step 1 needs to know
 * where the directory came from, and keeping it that way is the point of stating it here.
 */

import { join } from "node:path";
import {
  formatManifestIssues,
  type ManifestIssue,
  type PluginManifest,
  parseManifest,
} from "@vrcz/plugin-api";
import { loadArtifact, writeArtifact } from "./artifact.ts";
import { type BuildDiagnostic, bundlePlugin, formatDiagnostics } from "./bundle.ts";
import { type DenyFinding, denyScan, formatDenyFindings } from "./deny-scan.ts";

/** The manifest's fixed filename. Not configurable — an install source that hides it is not one. */
export const MANIFEST_FILENAME = "vrcz-plugin.json";

/**
 * Largest plugin source file the pipeline will read, and largest bundle it will keep.
 *
 * 8 MiB of *compiled JavaScript* is enormous for a plugin — the whole daemon is smaller — and the
 * cap exists because everything downstream of the bundle is a whole-file operation: the deny-scan
 * parses it, the hash reads it, and the spawn path re-reads it before every start.
 */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** Which step said no. Lets the UI show the right thing without parsing prose. */
export type InstallFailureStage =
  | "source"
  | "manifest"
  | "compile"
  | "deny-scan"
  | "size"
  | "write"
  | "verify";

export interface InstallSuccess {
  readonly ok: true;
  readonly manifest: PluginManifest;
  /** Lowercase hex SHA-256 of the artifact. This is what `plugins.bundle_hash` stores. */
  readonly bundleHash: string;
  /** Absolute path to `plugins/<id>/<sha256>.js`. */
  readonly bundlePath: string;
  readonly bundleBytes: number;
  /** False when an artifact with this hash was already installed — identical source, reinstalled. */
  readonly written: boolean;
  /** `"local"` for now; the seam for decision 107's git source. */
  readonly sourceKind: "local";
  /** The directory the plugin was installed from, as given. */
  readonly sourceRef: string;
}

export interface InstallFailure {
  readonly ok: false;
  readonly stage: InstallFailureStage;
  /** Ready to put in front of a person unchanged. Every stage writes complete sentences. */
  readonly message: string;
  /** Populated when the manifest was the problem. */
  readonly manifestIssues?: readonly ManifestIssue[];
  /** Populated when compilation was. */
  readonly diagnostics?: readonly BuildDiagnostic[];
  /** Populated when the deny-scan was — each with the construct and its line and column. */
  readonly findings?: readonly DenyFinding[];
}

export type InstallResult = InstallSuccess | InstallFailure;

export interface InstallOptions {
  /** Redirects the state tree. Every path below is derived from it. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Runs the pipeline against a local plugin directory.
 *
 * Never throws for anything a plugin can cause. A failure is a value with a stage and a sentence,
 * because "this plugin would not install and here is why" is the entire user-facing point of doing
 * the work at install time.
 */
export async function installPluginFromDirectory(
  rootDir: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  // --- 1. manifest -----------------------------------------------------------------------------
  const manifestPath = join(rootDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await Bun.file(manifestPath).text();
  } catch {
    return {
      ok: false,
      stage: "source",
      message: `There is no ${MANIFEST_FILENAME} in ${rootDir}. A plugin folder has to contain one — it is what says which file to run and what the plugin is asking for.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      stage: "manifest",
      message: `${MANIFEST_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const manifestResult = parseManifest(parsed);
  if (!manifestResult.ok) {
    return {
      ok: false,
      stage: "manifest",
      message: manifestResult.message,
      manifestIssues: manifestResult.issues,
    };
  }
  const manifest = manifestResult.manifest;

  // The schema already refuses absolute paths, backslashes and `..`, so this is only asking whether
  // the file the author named is actually there — the common mistake, and worth its own sentence.
  const entrypoint = join(rootDir, manifest.main);
  if (!(await Bun.file(entrypoint).exists())) {
    return {
      ok: false,
      stage: "source",
      message: `${MANIFEST_FILENAME} says the plugin starts at "${manifest.main}", but there is no such file in ${rootDir}.`,
    };
  }

  // --- 2. compile ------------------------------------------------------------------------------
  const bundled = await bundlePlugin({ rootDir, main: manifest.main });
  if (!bundled.ok) {
    return {
      ok: false,
      stage: "compile",
      message: `${manifest.name} could not be compiled:\n${formatDiagnostics(bundled.diagnostics)}`,
      diagnostics: bundled.diagnostics,
    };
  }

  if (bundled.bytes.byteLength > MAX_BUNDLE_BYTES) {
    return {
      ok: false,
      stage: "size",
      message: `${manifest.name} compiles to ${String(Math.round(bundled.bytes.byteLength / 1024))} KB, which is over the ${String(MAX_BUNDLE_BYTES / 1024 / 1024)} MB limit for a plugin.`,
    };
  }

  // --- 3. deny-scan ----------------------------------------------------------------------------
  const scan = denyScan(bundled.code, `${manifest.id}.js`);
  if (!scan.ok) {
    return {
      ok: false,
      stage: "deny-scan",
      message: `${manifest.name} was not installed. Its compiled code does things a plugin is not allowed to do:\n${formatDenyFindings(scan.findings)}`,
      findings: scan.findings,
    };
  }

  // --- 4. content-address ----------------------------------------------------------------------
  let written: ReturnType<typeof writeArtifact>;
  try {
    written = writeArtifact(manifest.id, bundled.bytes, options.env);
  } catch (error) {
    return {
      ok: false,
      stage: "write",
      message: `${manifest.name} compiled, but its files could not be written: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // --- 5. verify it back -----------------------------------------------------------------------
  const verified = loadArtifact(manifest.id, written.hash, options.env);
  if (!verified.ok) {
    return { ok: false, stage: "verify", message: verified.detail };
  }

  return {
    ok: true,
    manifest,
    bundleHash: written.hash,
    bundlePath: written.path,
    bundleBytes: bundled.bytes.byteLength,
    written: written.written,
    sourceKind: "local",
    sourceRef: rootDir,
  };
}

/** Every failure renders the same way, so a caller never has to branch on the stage to show one. */
export function formatInstallFailure(failure: InstallFailure): string {
  if (failure.manifestIssues !== undefined && failure.manifestIssues.length > 0) {
    return formatManifestIssues(failure.manifestIssues);
  }
  return failure.message;
}
