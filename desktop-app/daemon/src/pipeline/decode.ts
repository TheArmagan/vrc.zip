/**
 * Defensive decoding of VRChat pipeline frames.
 *
 * The outer frame is `{ "type": "...", "content": "..." }` where `content` is *usually* a JSON
 * **string** that must be parsed a second time. It is not always:
 *
 * | event                                  | `content`                       |
 * | -------------------------------------- | ------------------------------- |
 * | `see-notification`, `hide-notification` | a **bare notification id**, not JSON |
 * | `clear-notification`                    | **absent** — no key at all      |
 * | everything else                         | a JSON string encoding an object |
 *
 * An unconditional `JSON.parse(frame.content)` throws on all three and, wrapped in the usual
 * swallow-everything try/catch, drops them without a trace. Notifications then stop clearing and
 * nobody finds out for weeks. That is the specific bug this module exists to prevent, so the content
 * contract is a table ({@link PIPELINE_CONTENT_KIND}) and the decoder branches on it.
 *
 * Nothing here throws. Every input — truncated JSON, an event type invented last Tuesday, a payload
 * missing its id — produces a typed result the caller can branch on and log.
 */

import {
  isPipelineEventType,
  type JsonObject,
  type JsonValue,
  PIPELINE_CONTENT_KIND,
  type PipelineEventMap,
  type PipelineEventType,
} from "./events.ts";

/** Reason a frame could not be turned into a typed event. */
export type PipelineMalformedReason =
  /** The frame itself was not valid JSON. */
  | "frame-not-json"
  /** The frame parsed but was not a JSON object (e.g. an array or a bare number). */
  | "frame-not-object"
  /** The frame had no usable `type` string and no `err`. */
  | "missing-type"
  /** `content` was a string but not valid JSON, for an event whose content must be JSON. */
  | "content-not-json"
  /** `content` parsed but was not an object, for an event whose content must be an object. */
  | "content-not-object"
  /** `content` was absent for an event that requires it. */
  | "content-missing"
  /** `content` was not usable as a bare id string. */
  | "content-not-id-string"
  /** A required field of the payload was missing. */
  | "field-missing"
  /** A field of the payload had the wrong JSON type. */
  | "field-wrong-type";

/**
 * A successfully decoded event, discriminated on `type` so `switch (result.type)` narrows `data`.
 */
export type DecodedPipelineEvent = {
  [K in PipelineEventType]: {
    readonly kind: "event";
    readonly type: K;
    readonly data: PipelineEventMap[K];
    /**
     * The parsed `content` exactly as it arrived, before shape-checking. VRChat adds fields without
     * notice; this is where they survive.
     */
    readonly raw: JsonValue;
    /** Integer unix ms at which the frame was received. */
    readonly receivedAt: number;
  };
}[PipelineEventType];

/**
 * The server rejected our auth token.
 *
 * `"authToken doesn't correspond with an active session"` means the cookie is dead: **re-auth, do
 * not retry**. Reconnecting with the same token loops forever and looks, from VRChat's side, like a
 * credential-stuffing client. This is a distinct outcome precisely so the caller cannot accidentally
 * treat it as a transport hiccup.
 */
export interface PipelineReauthRequired {
  readonly kind: "reauth-required";
  readonly message: string;
  readonly receivedAt: number;
}

/** An `{"err": …}` frame that is *not* about the auth token. Usually transient; retrying is fine. */
export interface PipelineServerError {
  readonly kind: "server-error";
  readonly message: string;
  readonly receivedAt: number;
}

/** A well-formed frame whose `type` we do not model. Forward-compatibility, not an error. */
export interface PipelineUnknownEvent {
  readonly kind: "unknown-event";
  readonly type: string;
  /** Raw `content` as it appeared on the frame — unparsed, since we do not know its contract. */
  readonly content: JsonValue | undefined;
  readonly receivedAt: number;
}

/** A frame we could not decode. Always reported, never thrown. */
export interface PipelineMalformedMessage {
  readonly kind: "malformed";
  readonly reason: PipelineMalformedReason;
  /** Event type if we got far enough to read one. */
  readonly type?: string;
  /** Human-readable detail — which field, which parse failed. Safe to log. */
  readonly detail: string;
  /** The frame text, truncated. Never contains the auth token (that lives in the URL). */
  readonly raw: string;
  readonly receivedAt: number;
}

/** Every possible outcome of {@link decodePipelineMessage}. */
export type PipelineDecodeResult =
  | DecodedPipelineEvent
  | PipelineReauthRequired
  | PipelineServerError
  | PipelineUnknownEvent
  | PipelineMalformedMessage;

/** How much of an undecodable frame is kept for logging. */
const RAW_SNIPPET_LIMIT = 512;

/** The exact string VRChat sends when the auth cookie is no longer backed by a session. */
export const DEAD_SESSION_ERROR = "authToken doesn't correspond with an active session";

/**
 * Whether an `err` frame means "re-authenticate", as opposed to "retry later".
 *
 * Matched loosely on purpose: the canonical string above is the one seen in the wild, but VRChat has
 * shipped variants ("missing authToken", "invalid authToken") and all of them are equally fatal to
 * the current cookie.
 */
export function isReauthError(message: string): boolean {
  const normalised = message.toLowerCase();
  if (!normalised.includes("authtoken")) {
    return false;
  }
  return (
    normalised.includes("active session") ||
    normalised.includes("invalid") ||
    normalised.includes("missing") ||
    normalised.includes("expired")
  );
}

type FieldType = "string" | "number" | "boolean" | "object" | "array";

/**
 * The per-event payload contract.
 *
 * Required fields are the ones consumers key off; a payload missing them is useless and is reported
 * `malformed` rather than passed on half-built. Optional fields are type-checked *only when present*
 * — an unexpected `null` in a field we do not read must not discard an otherwise good event.
 * Unmodelled fields are never rejected: they are simply carried through in `raw`.
 */
interface ShapeSpec {
  readonly required?: Readonly<Record<string, FieldType>>;
  readonly optional?: Readonly<Record<string, FieldType>>;
  /** At least one of these keys must be present. Used where VRChat sends either of two spellings. */
  readonly anyOf?: readonly string[];
  /** Derives extra fields (e.g. the `userid` → `userId` alias). Runs after validation. */
  readonly normalise?: (content: JsonObject) => JsonObject;
}

const FRIEND_PRESENCE: ShapeSpec = {
  required: { userId: "string" },
  optional: {
    user: "object",
    platform: "string",
    location: "string",
    travelingToLocation: "string",
    // `"private"` when hidden — a valid string, never an id. See PipelineWorldId.
    worldId: "string",
    // `{}` for ask-me/DND. Still an object, so this check passes, as it must.
    world: "object",
    canRequestInvite: "boolean",
  },
};

const USER_WITH_ID: ShapeSpec = {
  required: { userId: "string", user: "object" },
  optional: { platform: "string" },
};

/** Shape specs for every event whose `content` is a JSON object. */
const SHAPE_SPECS: { readonly [K in PipelineEventType]: ShapeSpec } = {
  notification: {
    required: { id: "string", type: "string" },
    optional: {
      senderUserId: "string",
      senderUsername: "string",
      receiverUserId: "string",
      message: "string",
      // Nested JSON *string*, sometimes the literal "{}". Left unparsed on purpose.
      details: "string",
      created_at: "string",
      seen: "boolean",
    },
  },
  "notification-v2": {
    required: { id: "string" },
    optional: {
      version: "number",
      type: "string",
      category: "string",
      title: "string",
      message: "string",
      senderUserId: "string",
      receiverUserId: "string",
      createdAt: "string",
      isRead: "boolean",
    },
  },
  "notification-v2-update": {
    required: { id: "string" },
    optional: { version: "number", updates: "object" },
  },
  "notification-v2-delete": {
    required: { ids: "array" },
    optional: { version: "number" },
  },
  "response-notification": {
    required: { notificationId: "string" },
    optional: { receiverId: "string", responseId: "string" },
  },
  // The three below never reach a shape spec: their content kind is not "json-object".
  "see-notification": {},
  "hide-notification": {},
  "clear-notification": {},
  "friend-add": USER_WITH_ID,
  "friend-delete": { required: { userId: "string" }, optional: { user: "object" } },
  "friend-online": FRIEND_PRESENCE,
  "friend-active": {
    // Upstream typo: lowercase `i`. Required under the wire spelling, because that is what arrives.
    required: { userid: "string" },
    optional: { user: "object", platform: "string" },
    normalise: (content) => ({ ...content, userId: content.userid as string }),
  },
  "friend-offline": {
    required: { userId: "string" },
    optional: { user: "object", platform: "string" },
  },
  "friend-update": USER_WITH_ID,
  "friend-location": FRIEND_PRESENCE,
  "user-update": USER_WITH_ID,
  "user-location": {
    required: { userId: "string" },
    optional: {
      user: "object",
      location: "string",
      travelingToLocation: "string",
      instance: "string",
      worldId: "string",
      world: "object",
    },
  },
  "user-badge-assigned": { required: { badge: "object" } },
  "user-badge-unassigned": {
    optional: { badgeId: "string", badge: "object" },
    anyOf: ["badgeId", "badge"],
  },
  "content-refresh": {
    optional: { contentType: "string", fileType: "string", actionType: "string" },
  },
  "economy-update": {
    optional: { userId: "string", balance: "number", isVRChatPlus: "boolean" },
  },
  "modified-image-update": {
    optional: { fileId: "string", imageUrl: "string", ownerId: "string" },
  },
  "instance-queue-joined": {
    required: { instanceLocation: "string" },
    optional: {
      position: "number",
      queueSize: "number",
      estimatedTotalWaitTime: "number",
      estimatedServeTime: "number",
    },
  },
  "instance-queue-ready": {
    required: { instanceLocation: "string" },
    optional: { expiryTime: "string" },
  },
  "group-joined": { required: { groupId: "string" } },
  "group-left": { required: { groupId: "string" } },
  "group-member-updated": { required: { member: "object" } },
  "group-role-updated": { required: { role: "object" } },
};

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesFieldType(value: JsonValue, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isJsonObject(value);
  }
}

interface ShapeFailure {
  readonly reason: "field-missing" | "field-wrong-type";
  readonly detail: string;
}

/** Validates `content` against `spec`, returning the normalised object or a failure description. */
function applyShape(content: JsonObject, spec: ShapeSpec): JsonObject | ShapeFailure {
  for (const [key, type] of Object.entries(spec.required ?? {})) {
    const value = content[key];
    if (value === undefined || value === null) {
      return { reason: "field-missing", detail: `required field "${key}" is absent` };
    }
    if (!matchesFieldType(value, type)) {
      return {
        reason: "field-wrong-type",
        detail: `field "${key}" should be ${type}, got ${describe(value)}`,
      };
    }
  }
  for (const [key, type] of Object.entries(spec.optional ?? {})) {
    const value = content[key];
    // `null` is how VRChat spells "not applicable" for optional fields. Not an error.
    if (value === undefined || value === null) {
      continue;
    }
    if (!matchesFieldType(value, type)) {
      return {
        reason: "field-wrong-type",
        detail: `field "${key}" should be ${type}, got ${describe(value)}`,
      };
    }
  }
  if (spec.anyOf !== undefined && !spec.anyOf.some((key) => content[key] !== undefined)) {
    return {
      reason: "field-missing",
      detail: `expected at least one of ${spec.anyOf.join(", ")}`,
    };
  }
  return spec.normalise === undefined ? content : spec.normalise(content);
}

function describe(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function isShapeFailure(value: JsonObject | ShapeFailure): value is ShapeFailure {
  return typeof (value as ShapeFailure).reason === "string" && "detail" in value;
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function snippet(raw: string): string {
  return raw.length > RAW_SNIPPET_LIMIT ? `${raw.slice(0, RAW_SNIPPET_LIMIT)}…` : raw;
}

function malformed(
  reason: PipelineMalformedReason,
  detail: string,
  raw: string,
  receivedAt: number,
  type?: string,
): PipelineMalformedMessage {
  return {
    kind: "malformed",
    reason,
    ...(type === undefined ? {} : { type }),
    detail,
    raw: snippet(raw),
    receivedAt,
  };
}

/**
 * Extracts the bare notification id from `see-notification` / `hide-notification`.
 *
 * The wire form is an unquoted id (`not_00000000-0000-0000-0000-000000000000`). Two tolerated
 * variants: a JSON-quoted string, and an object carrying `notificationId`/`id` — both have been
 * reported and both are unambiguous, so accepting them costs nothing.
 */
function extractNotificationId(content: JsonValue | undefined): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      const unquoted = parseJson(trimmed);
      return typeof unquoted === "string" && unquoted.length > 0 ? unquoted : trimmed;
    }
    return trimmed;
  }
  if (isJsonObject(content)) {
    const id = content.notificationId ?? content.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
  return undefined;
}

/**
 * Decodes one pipeline frame.
 *
 * @param raw   the frame text exactly as received
 * @param receivedAt integer unix ms; injectable so tests and replays are deterministic
 */
export function decodePipelineMessage(
  raw: string,
  receivedAt: number = Date.now(),
): PipelineDecodeResult {
  const frame = parseJson(raw);
  if (frame === undefined) {
    return malformed("frame-not-json", "frame is not valid JSON", raw, receivedAt);
  }
  if (!isJsonObject(frame)) {
    return malformed(
      "frame-not-object",
      `frame is ${describe(frame)}, not an object`,
      raw,
      receivedAt,
    );
  }

  // Error frames carry no `type`, so they must be handled before the type lookup.
  const err = frame.err;
  if (typeof err === "string") {
    return isReauthError(err)
      ? { kind: "reauth-required", message: err, receivedAt }
      : { kind: "server-error", message: err, receivedAt };
  }

  const type = frame.type;
  if (typeof type !== "string" || type.length === 0) {
    return malformed("missing-type", "frame has neither a type nor an err", raw, receivedAt);
  }

  const content = frame.content ?? undefined;

  if (!isPipelineEventType(type)) {
    // Not an error: VRChat ships new event types without warning and we must not drop the socket.
    return { kind: "unknown-event", type, content, receivedAt };
  }

  switch (PIPELINE_CONTENT_KIND[type]) {
    case "absent": {
      // `clear-notification`. There is nothing to parse; a stray content field is ignored, not
      // rejected, because the event's meaning does not depend on it.
      return finish(type, {}, content ?? null, receivedAt);
    }
    case "bare-string": {
      const notificationId = extractNotificationId(content);
      if (notificationId === undefined) {
        return malformed(
          "content-not-id-string",
          `${type} content is not a usable notification id`,
          raw,
          receivedAt,
          type,
        );
      }
      return finish(type, { notificationId }, content ?? null, receivedAt);
    }
    case "json-object": {
      if (content === undefined) {
        return malformed("content-missing", `${type} has no content`, raw, receivedAt, type);
      }
      // Usually a JSON string needing a second parse; occasionally already an object. Both accepted.
      const parsed = typeof content === "string" ? parseJson(content) : content;
      if (parsed === undefined) {
        return malformed(
          "content-not-json",
          `${type} content string is not valid JSON`,
          raw,
          receivedAt,
          type,
        );
      }
      if (!isJsonObject(parsed)) {
        return malformed(
          "content-not-object",
          `${type} content is ${describe(parsed)}, not an object`,
          raw,
          receivedAt,
          type,
        );
      }
      const shaped = applyShape(parsed, SHAPE_SPECS[type]);
      if (isShapeFailure(shaped)) {
        return malformed(shaped.reason, `${type}: ${shaped.detail}`, raw, receivedAt, type);
      }
      return finish(type, shaped, parsed, receivedAt);
    }
  }
}

/**
 * Builds the success result.
 *
 * The single cast in this module. `applyShape` has already proved the required fields, but TypeScript
 * cannot connect a runtime-selected `type` to its slot in {@link PipelineEventMap}; keeping the cast
 * in one four-line function is the cheapest honest way to say so.
 */
function finish(
  type: PipelineEventType,
  data: JsonObject,
  raw: JsonValue,
  receivedAt: number,
): DecodedPipelineEvent {
  return { kind: "event", type, data, raw, receivedAt } as unknown as DecodedPipelineEvent;
}
