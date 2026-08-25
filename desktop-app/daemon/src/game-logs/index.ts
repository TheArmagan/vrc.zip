/**
 * VRChat log watcher — Phase 1.7.
 *
 * `discoverLogDirectories()` finds where VRChat writes, `LogWatcher` tails every live
 * `output_log_*.txt` concurrently, and everything it produces leaves through the injected
 * `LogSink`. Nothing in here touches persistence.
 */

export {
  type DiscoverOptions,
  type DiscoveryEnvironment,
  discoverLogDirectories,
  isLogFileName,
  type LogDirCandidate,
  type LogDirRule,
  type LogFileEntry,
  listLogFiles,
  parseLibraryFolders,
  VRCHAT_STEAM_APP_ID,
} from "./discovery.ts";
export {
  type DeviceKind,
  type DownloadKind,
  desanitizeName,
  type InstanceAccess,
  type KnownEvent,
  type LineHeader,
  LogScanner,
  normalizeEndpoint,
  type ParsedEvent,
  type ParsedLocation,
  parseHeader,
  parseLine,
  parseLocation,
  stripRichText,
  type VrMode,
} from "./parser.ts";
export {
  type ExitKind,
  type LogSink,
  type SessionEvent,
  type SessionPatch,
  type SessionSnapshot,
  SessionTracker,
  type SessionTrackerOptions,
} from "./sessions.ts";
export {
  DEFAULT_POLL_SCHEDULE,
  FileTail,
  type FileTailOptions,
  nextPollDelay,
  type PollScheduleOptions,
  type ResolvedPollSchedule,
  resolvePollSchedule,
  type TailRead,
} from "./tail.ts";
export { type LogOffsetStore, LogWatcher, type LogWatcherOptions } from "./watcher.ts";
