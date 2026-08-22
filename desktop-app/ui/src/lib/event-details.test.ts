/**
 * `describeEvent` reads payloads that VRChat and the log parser own, so the interesting cases are
 * the ones where the field is not where you would first look: a game log's location is nested
 * inside a parsed object rather than on the event, and a portal's spawner has a key of its own.
 *
 * The other half is the promise that nothing is invented. A payload with the field missing must
 * produce no fact at all, not an empty one — an "Reason:" with nothing after it is worse than
 * silence, because it reads as data that failed to load.
 */

import { describe, expect, it } from "vitest";
import type { EventKind } from "./api.ts";
import { describeEvent } from "./event-details.ts";
import type { LiveEvent } from "./events.ts";

const T0 = 1_700_000_000_000;

function event(
  kind: EventKind,
  payload: LiveEvent["payload"],
  extra: Partial<LiveEvent> = {},
): LiveEvent {
  return {
    id: 1,
    accountId: "acct_1",
    sessionId: 1,
    ts: T0,
    kind,
    subjectId: null,
    location: null,
    payload,
    live: false,
    ...extra,
  };
}

describe("describeEvent", () => {
  it("names the player and what they did", () => {
    const details = describeEvent(
      event("gamelog.player_join", { displayName: "Ada", userId: "usr_a" }),
    );

    expect(details.subject).toBe("Ada");
    expect(details.action).toBe("joined the instance");
  });

  it("reads a game log's location out of the nested parsed object", () => {
    // The log bridge never sets the event's own `location` column, so a describer that read only
    // `event.location` would render every world change with no world in it.
    const details = describeEvent(
      event("gamelog.location_join", {
        location: { location: "wrld_abc:123~region(eu)", worldId: "wrld_abc", region: "eu" },
      }),
    );

    expect(details.location).toBe("wrld_abc:123~region(eu)");
    expect(details.facts).toEqual([{ label: "Region", value: "EU" }]);
  });

  it("takes a portal's spawner from its own key", () => {
    const details = describeEvent(
      event("gamelog.portal_spawn", {
        spawnerDisplayName: "Grace",
        target: { location: "wrld_xyz:9" },
      }),
    );

    expect(details.subject).toBe("Grace");
    expect(details.location).toBe("wrld_xyz:9");
  });

  it("shows only the file name of a screenshot, not the whole path", () => {
    const details = describeEvent(
      event("gamelog.screenshot", {
        path: "C:\\Users\\a\\Pictures\\VRChat\\2024-03\\VRChat_1920x1080_2024-03-09.png",
      }),
    );

    expect(details.facts).toEqual([
      { label: "File", value: "VRChat_1920x1080_2024-03-09.png", mono: true },
    ]);
  });

  it("says what kind of notification arrived, rather than only that one did", () => {
    const details = describeEvent(
      event("notification.received", { type: "requestInvite", senderUsername: "Ada" }),
    );

    expect(details.subject).toBe("Ada");
    expect(details.action).toBe("sent an invite request");
  });

  it("names a notification type it has never heard of instead of guessing", () => {
    const details = describeEvent(event("notification.received", { type: "somethingNew" }));
    expect(details.action).toBe('sent a "somethingNew" notification');
  });

  it("invents nothing when the payload is empty", () => {
    const details = describeEvent(event("gamelog.join_failed", {}));

    expect(details.facts).toEqual([]);
    expect(details.action).toBe("Could not join an instance");
  });

  it("survives a payload that is not an object at all", () => {
    // Payloads are VRChat's shapes forwarded verbatim. A null one is normal — several kinds carry
    // no data — and a row that throws takes the whole list down with it.
    expect(() => describeEvent(event("gamelog.app_quit", null))).not.toThrow();
    expect(describeEvent(event("gamelog.app_quit", null)).action).toBe("VRChat closed");
  });

  it("falls back to the app's own label for a kind from a newer daemon", () => {
    const details = describeEvent(event("gamelog.invented_later", { displayName: "Ada" }));

    expect(details.action).toBe("Gamelog invented later");
    expect(details.subject).toBe("Ada");
  });

  it("distinguishes a clean client exit from one that stopped without quitting", () => {
    expect(describeEvent(event("session.end", { exitKind: "clean" })).tone).toBe("system");
    expect(describeEvent(event("session.end", { exitKind: "crash" })).tone).toBe("alert");
  });
});
