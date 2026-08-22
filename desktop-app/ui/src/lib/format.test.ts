/**
 * `format.ts` is the app's whole vocabulary, and two of its functions are load-bearing in a way a
 * display helper usually is not:
 *
 *  - `eventLabel` runs on every feed row, including rows written by a *newer daemon* than this
 *    bundle. A blank label there is an unreadable feed, not a cosmetic miss.
 *  - `parseLocation` is total by contract. Every caller destructures its result without a null
 *    check, so a `null` return would be a thrown render on a friend list.
 */

import { describe, expect, it } from "vitest";
import type { EventKind } from "./api.ts";
import { eventLabel, parseLocation } from "./format.ts";

/**
 * `EventKind` is deliberately widened (`KnownEventKind | (string & {})`) so a kind this build has
 * never heard of still typechecks its way to `eventLabel`. Naming that here keeps the tests below
 * free of casts, which Biome would reject anyway.
 */
function futureKind(kind: string): EventKind {
  return kind;
}

describe("eventLabel", () => {
  it("uses the app's own words for a kind that has a label", () => {
    expect(eventLabel("friend.online")).toBe("Friend came online");
    expect(eventLabel("gamelog.portal_spawn")).toBe("Portal dropped");
  });

  it("humanises a known kind that was deliberately left out of the label table", () => {
    // `friend.list_refreshed` is bookkeeping no feed row shows, so `EVENT_LABELS` is `Partial` and
    // has no entry for it. The fallback must still produce a sentence rather than an empty cell.
    expect(eventLabel("friend.list_refreshed")).toBe("Friend list refreshed");
    expect(eventLabel("notification.synced")).toBe("Notification synced");
  });

  it("still reads for a kind invented by a newer daemon than this bundle", () => {
    expect(eventLabel(futureKind("avatar.wardrobe_changed"))).toBe("Avatar wardrobe changed");
    expect(eventLabel(futureKind("moderation.warned"))).toBe("Moderation warned");
  });

  it("never returns a blank label, whatever the kind looks like", () => {
    // A separator-only kind humanises to nothing; the raw kind is a worse label than a real one and
    // a better one than an empty row.
    expect(eventLabel(futureKind("..."))).toBe("...");
    expect(eventLabel(futureKind("weird"))).toBe("Weird");
  });
});

describe("parseLocation", () => {
  it("is total: no input shape returns null", () => {
    const inputs: readonly (string | null)[] = [
      null,
      "",
      "offline",
      "private",
      "traveling",
      "traveling:traveling",
      "wrld_ba913a96-fac4-4048-a062-9aa5db092812:12345",
      "wrld_ba913a96-fac4-4048-a062-9aa5db092812",
      ":::~~~",
      "wrld_x:1~hidden(usr_1)~region(eu)~nonce(abc)",
    ];
    for (const input of inputs) {
      const parsed = parseLocation(input);
      expect(parsed).not.toBeNull();
      expect(typeof parsed.label).toBe("string");
      expect(parsed.label).not.toBe("");
    }
  });

  it("marks private, offline and traveling as opaque, with nothing to jump to", () => {
    // VRChat spells "nowhere" several ways and `/api/friends` passes the string through raw. Each
    // of these is a place with no instance behind it, so `opaque` is what stops the UI drawing a
    // join affordance for a world that does not exist.
    for (const [location, label] of [
      ["private", "In a private world"],
      ["offline", "Offline"],
      ["traveling", "Between worlds"],
      ["traveling:traveling", "Between worlds"],
    ] as const) {
      const parsed = parseLocation(location);
      expect(parsed.opaque).toBe(true);
      expect(parsed.label).toBe(label);
      expect(parsed.worldId).toBeNull();
      expect(parsed.instanceId).toBeNull();
      expect(parsed.access).toBe("unknown");
    }
  });

  it("treats an absent location as unknown rather than as offline", () => {
    // Absence is never a claim: not knowing where somebody is must not render as "Offline".
    for (const location of [null, ""]) {
      const parsed = parseLocation(location);
      expect(parsed.opaque).toBe(true);
      expect(parsed.label).toBe("Unknown");
    }
  });

  it("reads a real location as a joinable instance", () => {
    const parsed = parseLocation("wrld_ba913a96-fac4-4048-a062-9aa5db092812:12345");
    expect(parsed.opaque).toBe(false);
    expect(parsed.worldId).toBe("wrld_ba913a96-fac4-4048-a062-9aa5db092812");
    expect(parsed.instanceId).toBe("12345");
    expect(parsed.access).toBe("public");
    expect(parsed.label).toBe("#12345");
  });

  it("derives invite+ from canRequestInvite on top of ~private, which has no tag of its own", () => {
    const base = "wrld_x:99~private(usr_1)~region(us)";
    expect(parseLocation(base).access).toBe("invite");
    expect(parseLocation(`${base}~canRequestInvite`).access).toBe("invite+");
  });

  it("reads the remaining access tags and the region", () => {
    expect(parseLocation("wrld_x:1~hidden(usr_1)~region(eu)").access).toBe("friends+");
    expect(parseLocation("wrld_x:1~friends(usr_1)").access).toBe("friends");
    expect(parseLocation("wrld_x:1~group(grp_1)~region(jp)").access).toBe("group");
    expect(parseLocation("wrld_x:1~hidden(usr_1)~region(eu)").region).toBe("eu");
    expect(parseLocation("wrld_x:1").region).toBeNull();
  });
});
