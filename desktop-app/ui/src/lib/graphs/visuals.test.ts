import { describe, expect, test } from "vitest";
import { familyOf, iconNameFor, isListPort, portFamily } from "./visuals.ts";

describe("familyOf", () => {
  test("a built-in takes its palette category's family", () => {
    expect(familyOf("Control", "vrcz")).toBe("control");
    expect(familyOf("Triggers", "vrcz")).toBe("trigger");
    expect(familyOf("Send", "vrcz")).toBe("send");
  });

  test("the three data-ish categories share one hue", () => {
    // They are the same kind of thing; the icon is what tells them apart.
    expect(familyOf("Lists", "vrcz")).toBe("data");
    expect(familyOf("Collections", "vrcz")).toBe("data");
    expect(familyOf("Stored data", "vrcz")).toBe("data");
  });

  test("the generated API groups are all VRChat", () => {
    expect(familyOf("API: friends", "vrcz")).toBe("vrchat");
    expect(familyOf("VRChat", "vrcz")).toBe("vrchat");
  });

  test("owner decides before category, so a plugin cannot draw itself as a built-in", () => {
    expect(familyOf("Triggers", "acme.notes")).toBe("plugin");
  });

  test("an unrecognised category is neutral rather than a guess", () => {
    expect(familyOf("Whatever", "vrcz")).toBe("value");
    expect(familyOf(undefined, "vrcz")).toBe("value");
  });
});

describe("iconNameFor", () => {
  test("the data categories differ by icon even though they share a hue", () => {
    expect(iconNameFor("Lists", "vrcz")).toBe("list");
    expect(iconNameFor("Collections", "vrcz")).toBe("layers");
    expect(iconNameFor("Stored data", "vrcz")).toBe("archive");
    expect(iconNameFor("Data", "vrcz")).toBe("database");
  });

  test("a loop is a repeat, whoever is looking", () => {
    expect(iconNameFor("Control", "vrcz")).toBe("repeat");
  });

  test("a plugin's node is a puzzle piece whatever it calls its category", () => {
    expect(iconNameFor("Control", "acme.notes")).toBe("puzzle");
  });
});

describe("port colours", () => {
  test("a list is the same family as its element", () => {
    expect(portFamily("list<user>")).toBe(portFamily("user"));
    expect(portFamily("list<string>")).toBe("string");
  });

  test("every domain type is one family, because they are all ids", () => {
    for (const type of ["friend", "user", "world", "instance", "group", "avatar"]) {
      expect(portFamily(type)).toBe("entity");
    }
  });

  test("a type this build does not know falls to json rather than throwing", () => {
    expect(portFamily("list<nonsense>")).toBe("json");
    expect(portFamily("")).toBe("json");
  });

  test("one thing is filled and several is hollow", () => {
    expect(isListPort("list<friend>")).toBe(true);
    expect(isListPort("friend")).toBe(false);
    expect(isListPort("json")).toBe(false);
  });
});
