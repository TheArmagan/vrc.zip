/**
 * `@vrcz/plugin-api` — the public, published plugin surface.
 *
 * Versioned on the **protocol major**, not the app version. The daemon imports these same
 * definitions, so `PortType`, `Scope`, `Envelope`, `UINode` and the manifest type have exactly one
 * declaration site and cannot drift between what a plugin is compiled against and what the host
 * enforces. See PLAN.md §Phase 3.
 *
 * Four modules, and the dependency direction between them is deliberate and one-way:
 *
 *  - `manifest.ts` — what a plugin *asks for*. A Zod schema is the single source of truth; the
 *    published JSON Schema, the consent UI and the docs reference are all generated from it, and
 *    every type here is inferred rather than written twice.
 *  - `protocol.ts` — the wire between the host and the plugin process. Explicit and enumerable
 *    rather than a transparent proxy, because a boundary you cannot enumerate is a boundary you
 *    cannot schema-validate, scope-check, or put a deadline on.
 *  - `ui.ts` — the `UINode` tree the host renders with its own components. The plugin never touches
 *    a DOM node, and there is no escape hatch.
 *  - `nodes.ts` — one `NodeDefinition` feeding the graph editor, the graph runtime and the type
 *    checker, so those three cannot disagree.
 *  - `capabilities.ts` — the host-power vocabulary, in a leaf of its own precisely *because* of the
 *    rule below: a capability is checked on the call path, so `protocol.ts` must be able to read it
 *    without reaching into `manifest.ts`.
 *  - `storage.ts` — the per-plugin database's shapes and limits.
 *
 * `protocol.ts` and `ui.ts` and `nodes.ts` do **not** import from `manifest.ts`, and that is a
 * safety property rather than tidiness: the manifest is what an author *requested*, a grant is what
 * a user *approved*, and nothing on the call path may consult the former. The dispatcher takes a
 * `PluginGrant`; it has no way to reach a manifest even by accident.
 */

export { PLUGIN_API_PROTOCOL_MAJOR } from "@vrcz/shared";

// ---------------------------------------------------------------------------
// Manifest — what a plugin asks for
// ---------------------------------------------------------------------------

export {
  ALL_PLUGIN_CAPABILITIES,
  type EventPattern,
  formatManifestIssues,
  GRANT_HASH_VERSION,
  grantHash,
  isPluginCapability,
  type ManifestIssue,
  type ManifestParseResult,
  PLUGIN_CAPABILITIES,
  type PluginAccountMode,
  type PluginCapability,
  type PluginCapabilityDefinition,
  type PluginCommandContribution,
  type PluginContributes,
  type PluginManifest,
  type PluginManifestInput,
  type PluginNodeContribution,
  type PluginPanelContribution,
  type PluginPerformanceMode,
  type PluginPermissions,
  type PluginSettingContribution,
  parseManifest,
  pluginManifestSchema,
} from "./manifest.ts";

// ---------------------------------------------------------------------------
// Storage — the plugin's own database
// ---------------------------------------------------------------------------

export {
  DEFAULT_PLUGIN_QUOTA_BYTES,
  DEFAULT_RECORDS_PAGE,
  MAX_KV_KEYS_PAGE,
  MAX_RECORDS_PAGE,
  MAX_STORAGE_KEY_LENGTH,
  MAX_STORAGE_VALUE_BYTES,
  type StorageRecord,
  type StorageUsage,
} from "./storage.ts";

// ---------------------------------------------------------------------------
// The plugin-side runtime — `definePlugin` and the `ctx` it hands you
// ---------------------------------------------------------------------------

export {
  definePlugin,
  type EventsApi,
  getContext,
  type NodesApi,
  PluginCallError,
  type PluginContext,
  type PluginHooks,
  type StorageApi,
  type SubscribeOptions,
  type Subscription,
  type UiApi,
  type VrchatApi,
} from "./runtime.ts";

// ---------------------------------------------------------------------------
// Protocol — the wire between host and plugin process
// ---------------------------------------------------------------------------

export {
  applyOverflow,
  authorizeCall,
  type CompiledFilter,
  type CreditFrame,
  coalesceByKey,
  compileFilter,
  type Deadline,
  type DeliveryPolicy,
  type DispatchContext,
  DROP_REASONS,
  type DroppedFrame,
  type DropReason,
  deadlineIn,
  decodeEnvelope,
  defineMethod,
  type Envelope,
  type ErasedMethod,
  type ErrorFrame,
  type ErrorPayload,
  type EventFilter,
  type EventFrame,
  encodeEnvelope,
  exceedsFrameCap,
  FRAME_SENDERS,
  FRAME_TAGS,
  type FrameTag,
  type HelloFrame,
  isExpired,
  isFrameAllowedFrom,
  isFrameTag,
  isOverflowPolicy,
  isProtocolErrorCode,
  LIFECYCLE_PHASES,
  type LifecycleFrame,
  type LifecyclePhase,
  MAX_BATCH_EVENTS,
  MAX_CREDITS,
  MAX_DEADLINE_HORIZON_MS,
  MAX_FILTER_KINDS,
  MAX_FILTER_VALUES,
  MAX_FRAME_BYTES,
  MAX_ID_LENGTH,
  MAX_JSON_DEPTH,
  MAX_KEY_PATH_SEGMENTS,
  MAX_KIND_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_METHOD_LENGTH,
  type MethodDefinition,
  type MethodTable,
  OVERFLOW_POLICIES,
  type OverflowPolicy,
  type ParseOptions,
  type ParseResult,
  type PeerRole,
  type PingFrame,
  type PluginEvent,
  type PluginGrant,
  type PongFrame,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_ERRORS,
  type ProtocolErrorCode,
  type ProtocolErrorDefinition,
  parseEnvelope,
  type RequestFrame,
  type ResponseFrame,
  readKeyPath,
  type SubscribeFrame,
  type UnsubscribeFrame,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// UI — the declarative tree the host renders
// ---------------------------------------------------------------------------

export {
  type AlertNode,
  type AvatarRefNode,
  type BadgeNode,
  type ButtonNode,
  type CardNode,
  type DialogNode,
  type EmptyNode,
  type FieldNode,
  type FormNode,
  type GridNode,
  type GroupRefNode,
  type IconNode,
  type InputNode,
  type InstanceRefNode,
  type Intent,
  type IntentPayloadValue,
  type ListItem,
  type ListNode,
  MAX_TABLE_ROWS,
  MAX_UI_DEPTH,
  MAX_UI_ISSUES,
  MAX_UI_NODES,
  MAX_UI_STRING,
  type MenuItem,
  type MenuNode,
  type RefNodeBase,
  type ScrollNode,
  type SelectNode,
  type SelectOption,
  type SeparatorNode,
  type SkeletonNode,
  type StackNode,
  type SwitchNode,
  type TabItem,
  type TableCellKind,
  type TableColumn,
  type TableNode,
  type TableRow,
  type TabsNode,
  type TextareaNode,
  type TextNode,
  type Tone,
  UI_NODE_TYPES,
  type UINode,
  type UINodeType,
  type UiCommon,
  type UiIntentDispatch,
  type UiIssue,
  type UiValidation,
  type UserRefNode,
  validateUINode,
  type WorldRefNode,
} from "./ui.ts";

// ---------------------------------------------------------------------------
// Nodes — one definition, three consumers
// ---------------------------------------------------------------------------

export {
  AFTER_PORT,
  assignable,
  BASE_PORT_TYPES,
  type BasePortType,
  type ButtonRow,
  canonicalNodeDefinition,
  ERROR_PORT,
  type ExecutableNodeDefinition,
  type ExecutableRegistration,
  evaluateNodeBody,
  isPortType,
  isTriggerDefinition,
  keyRowLabel,
  LIST_PORT_TYPES,
  type ListPortType,
  listElement,
  MAX_NODE_CONFIG_FIELDS,
  MAX_NODE_PORTS,
  type NodeBodySegment,
  type NodeBodyTemplate,
  type NodeConfigField,
  type NodeConfigValues,
  type NodeDefinition,
  type NodeIssue,
  type NodeRegistration,
  type NodeValidation,
  nodeDefinitionHash,
  type OptionRow,
  PORT_TYPES,
  type PortDefinition,
  type PortType,
  type PortValues,
  parseButtonRows,
  parseOptionRows,
  parseSlotRows,
  portTypeLabel,
  RESERVED_NODE_NAMESPACE,
  type SlotRow,
  slotRowLabel,
  type TriggerArmContext,
  type TriggerNodeDefinition,
  type TriggerRegistration,
  validateNodeDefinition,
  visibleInputCount,
  visibleInputs,
  visibleOutputs,
  type WiredInputs,
} from "./nodes.ts";
