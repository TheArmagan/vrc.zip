/**
 * The install pipeline's public surface. See `pipeline.ts` for the five steps and their order.
 *
 * Composition (`app.ts`) needs exactly two things from here: {@link installPluginFromDirectory} to
 * install one, and {@link createSpawnResolver} to build the `spawnFor` that `PluginRegistry` runs on
 * every start — which is where the hash is verified.
 */

export {
  type ArtifactLoad,
  artifactPath,
  hashBundle,
  loadArtifact,
  pruneArtifacts,
  removeArtifacts,
  type WrittenArtifact,
  writeArtifact,
} from "./artifact.ts";
export {
  type BuildDiagnostic,
  type BundleOptions,
  type BundleResult,
  bundlePlugin,
  formatDiagnostics,
} from "./bundle.ts";
export {
  type DenyFinding,
  type DenyRule,
  type DenyScanResult,
  denyScan,
  formatDenyFindings,
  isBuiltinSpecifier,
} from "./deny-scan.ts";
export {
  formatInstallFailure,
  type InstallFailure,
  type InstallFailureStage,
  type InstallOptions,
  type InstallResult,
  type InstallSuccess,
  installPluginFromDirectory,
  MANIFEST_FILENAME,
  MAX_BUNDLE_BYTES,
} from "./pipeline.ts";
export {
  createSpawnResolver,
  SMOL_MEMORY_LIMIT_BYTES,
  type SpawnFor,
  type SpawnResolverOptions,
  THROUGHPUT_MEMORY_LIMIT_BYTES,
} from "./spawn-resolver.ts";
