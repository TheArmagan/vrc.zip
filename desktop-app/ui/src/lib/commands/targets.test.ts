/**
 * What a paste is allowed to mean.
 *
 * These are the cases that actually arrive: a link out of Discord with the embed suppressed, the
 * game's own `vrchat://` copy, the website's `/home/launch?worldId=…&instanceId=…`, and a bare id
 * quoted in the middle of a sentence. The two that are easy to get wrong and expensive to get wrong
 * are the trailing parenthesis of `~region(eu)` — stripping it turns a joinable location into a
 * broken one — and refusing to guess at unprefixed words, without which the palette would offer to
 * "open user 'friends'" for every search anyone types.
 */

import { describe, expect, it } from "vitest";
import { parseTarget, unsupportedReason } from "./targets.ts";

describe("parseTarget", () => {
  it("reads the bare ids", () => {
    expect(parseTarget("usr_abc")).toMatchObject({ kind: "user", id: "usr_abc" });
    expect(parseTarget("wrld_abc")).toMatchObject({ kind: "world", id: "wrld_abc" });
    expect(parseTarget("grp_abc")).toMatchObject({ kind: "group", id: "grp_abc" });
  });

  it("splits a location into its world and keeps the whole of it", () => {
    const entry = parseTarget("wrld_abc:12345~region(eu)");
    expect(entry).toMatchObject({
      kind: "instance",
      id: "wrld_abc",
      location: "wrld_abc:12345~region(eu)",
    });
  });

  it("keeps a trailing region parenthesis but drops one nothing opened", () => {
    expect(parseTarget("<wrld_abc:1~region(eu)>")?.location).toBe("wrld_abc:1~region(eu)");
    expect(parseTarget("(usr_abc)")).toMatchObject({ id: "usr_abc" });
    expect(parseTarget("usr_abc.")).toMatchObject({ id: "usr_abc" });
  });

  it("reads vrchat.com pages", () => {
    expect(parseTarget("https://vrchat.com/home/user/usr_abc")).toMatchObject({
      kind: "user",
      id: "usr_abc",
    });
    expect(parseTarget("https://www.vrchat.com/home/world/wrld_abc/info")).toMatchObject({
      kind: "world",
      id: "wrld_abc",
    });
    expect(parseTarget("https://vrchat.com/home/group/grp_abc/members")).toMatchObject({
      kind: "group",
      id: "grp_abc",
    });
  });

  it("rejoins the website's split launch link", () => {
    expect(
      parseTarget("https://vrchat.com/home/launch?worldId=wrld_abc&instanceId=12345~region(us)"),
    ).toMatchObject({ kind: "instance", location: "wrld_abc:12345~region(us)" });
    expect(parseTarget("https://vrchat.com/home/launch?worldId=wrld_abc")).toMatchObject({
      kind: "world",
      id: "wrld_abc",
    });
  });

  it("reads the game's own deep link", () => {
    expect(parseTarget("vrchat://launch?ref=vrchat.com&id=wrld_abc:12345")).toMatchObject({
      kind: "instance",
      location: "wrld_abc:12345",
    });
  });

  it("finds the one id in a pasted paragraph", () => {
    expect(parseTarget("saw them in wrld_abc:99 earlier, weird")).toMatchObject({
      kind: "instance",
      location: "wrld_abc:99",
    });
  });

  it("recognises rather than guesses", () => {
    expect(parseTarget("")).toBeNull();
    expect(parseTarget("friends")).toBeNull();
    expect(parseTarget("usr_")).toBeNull();
    expect(parseTarget("https://example.com/home/user/usr_abc")).toBeNull();
  });

  it("opens an avatar id now that there is an avatar modal", () => {
    const avatar = parseTarget("avtr_abc");
    if (avatar === null) throw new Error("an avtr_ id is a recognised target");
    expect(avatar).toMatchObject({ kind: "avatar", id: "avtr_abc", supported: true });
    expect(unsupportedReason(avatar)).toBeNull();
  });

  it("recognises what it cannot open, and says which it is", () => {
    const file = parseTarget("file_abc");
    if (file === null) throw new Error("a file_ id is a recognised target");
    expect(file).toMatchObject({ kind: "file", supported: false });
    expect(unsupportedReason(file)).toContain("file");

    const user = parseTarget("usr_abc");
    if (user === null) throw new Error("a usr_ id is a recognised target");
    expect(unsupportedReason(user)).toBeNull();
  });
});
