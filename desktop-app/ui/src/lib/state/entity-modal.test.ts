/**
 * The machinery behind the three entity modals: first-wins deduplication, failure classification,
 * and the back stack the three of them share.
 *
 * Every rule asserted here has already been broken once in this codebase. A duplicate key in a
 * keyed `{#each}` is a **hard runtime error** in Svelte 5 rather than a warning — the section stops
 * rendering — and the back stack replaced three peer dialogs that stacked their scrims into black
 * and closed onto a subject the reader had navigated away from.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api.ts";
import {
  classifyFailure,
  dedupeById,
  EntityModalState,
  modalBack,
  type ResumePoint,
} from "./entity-modal.svelte.ts";

/**
 * A concrete modal, because `EntityModalState` is abstract and the stack is only reachable through
 * a subclass. It is the smallest thing that can hold a subject: a string id, no payload beyond a
 * marker so `resetPayload` has something to clear.
 *
 * Deliberately no runes in here. The base class's `$state` fields are compiled where they are
 * declared, so a plain subclass field is enough to drive the stack — and it keeps this file a
 * `.test.ts` rather than a `.svelte.test.ts`.
 */
class TestModal extends EntityModalState {
  subject: string | null = null;
  payload: string | null = null;
  retries = 0;

  /** The subclass's `open…`, written the way the real ones are: `takeScreen` first, then assign. */
  openSubject(id: string): void {
    const changing = this.subject !== id;
    this.takeScreen(changing);
    if (changing) {
      this.subject = id;
      this.payload = `loaded:${id}`;
    }
  }

  retry(): void {
    this.retries += 1;
  }

  protected resumePoint(): ResumePoint | null {
    // Captured by value: the closure runs after the singleton has been re-targeted, so reading
    // `this.subject` at call time would restore whoever is on screen instead.
    const id = this.subject;
    if (id === null) return null;
    return {
      label: id,
      restore: () => {
        this.openSubject(id);
      },
    };
  }

  protected resetPayload(): void {
    this.payload = null;
  }
}

const modals: TestModal[] = [];

function newModal(): TestModal {
  const modal = new TestModal();
  modals.push(modal);
  return modal;
}

afterEach(() => {
  // The stack and the "who owns the screen" pointer are module-level singletons shared by every
  // modal, so a test that left a level behind would be read as history by the next one.
  for (const modal of modals.splice(0)) modal.dismiss();
  expect(modalBack()).toBeNull();
});

describe("dedupeById", () => {
  it("keeps the first row for an id, so a keyed {#each} can never see a duplicate key", () => {
    const rows = [
      { id: "grp_a", name: "first" },
      { id: "grp_b", name: "other" },
      { id: "grp_a", name: "second" },
    ] as const;
    expect(dedupeById(rows)).toEqual([
      { id: "grp_a", name: "first" },
      { id: "grp_b", name: "other" },
    ]);
  });

  it("preserves the order the server sent, minus the repeats", () => {
    const rows = ["c", "a", "b", "a", "c"].map((id) => ({ id }));
    expect(dedupeById(rows).map((row) => row.id)).toEqual(["c", "a", "b"]);
  });

  it("handles the empty list and a list that is already unique without copying identity away", () => {
    expect(dedupeById([])).toEqual([]);
    const unique = [{ id: "a" }, { id: "b" }];
    const result = dedupeById(unique);
    expect(result).toEqual(unique);
    expect(result[0]).toBe(unique[0]);
  });
});

describe("classifyFailure", () => {
  it("reads a 503 as nobody being signed in, which is a fact about now and not about the subject", () => {
    expect(classifyFailure(new ApiError("http", "no account", 503, null))).toBe("no-account");
  });

  it("reads a 404 as the ordinary end of a record's life", () => {
    expect(classifyFailure(new ApiError("http", "gone", 404, null))).toBe("not-found");
  });

  it("reads an unreachable daemon as offline, which the shell has already explained", () => {
    expect(classifyFailure(new ApiError("offline", "daemon down", null, null))).toBe("offline");
  });

  it("calls anything else a fault, including a non-Error thrown value", () => {
    expect(classifyFailure(new ApiError("http", "server exploded", 500, null))).toBe("other");
    expect(classifyFailure(new Error("boom"))).toBe("other");
    expect(classifyFailure("boom")).toBe("other");
    expect(classifyFailure(null)).toBe("other");
  });

  it("prefers no-account over not-found when both could apply", () => {
    // The order in `classifyFailure` is the contract: a 503 is checked first, so a daemon that is
    // merely unable to ask never gets reported as "this thing does not exist".
    expect(classifyFailure(new ApiError("http", "", 503, "no_account_online"))).toBe("no-account");
  });
});

describe("the shared back stack", () => {
  it("has nowhere to go back to before anything is open", () => {
    expect(modalBack()).toBeNull();
  });

  it("does not push a level for the first thing opened, because nothing was set aside", () => {
    const modal = newModal();
    modal.openSubject("usr_first");
    expect(modal.open).toBe(true);
    expect(modalBack()).toBeNull();
  });

  it("pushes a labelled resume point when a second subject takes the screen", () => {
    const modal = newModal();
    modal.openSubject("usr_first");
    modal.openSubject("usr_second");
    expect(modalBack()?.label).toBe("usr_first");
    expect(modal.subject).toBe("usr_second");
  });

  it("closes by popping and restoring, not by dismissing", () => {
    const modal = newModal();
    modal.openSubject("usr_first");
    modal.openSubject("usr_second");

    modal.close();
    // The one control means one thing: with a level on the stack, close is the back button.
    expect(modal.open).toBe(true);
    expect(modal.subject).toBe("usr_first");
    expect(modalBack()).toBeNull();

    modal.close();
    expect(modal.open).toBe(false);
  });

  it("steps back across modals, because the three are one screen", () => {
    const profile = newModal();
    const group = newModal();
    profile.openSubject("usr_owner");
    group.openSubject("grp_theirs");

    expect(group.open).toBe(true);
    expect(profile.open).toBe(false);
    expect(modalBack()?.label).toBe("usr_owner");

    group.close();
    expect(group.open).toBe(false);
    expect(profile.open).toBe(true);
    expect(profile.subject).toBe("usr_owner");
  });

  it("does not push a level for re-opening the subject already on screen", () => {
    const modal = newModal();
    modal.openSubject("usr_first");
    modal.openSubject("usr_second");
    // The same user reached from three different rows is not three steps of navigation, and a back
    // button that returns to where the reader already is reads as broken.
    modal.openSubject("usr_second");
    modal.openSubject("usr_second");

    expect(modalBack()?.label).toBe("usr_first");
    modal.close();
    expect(modalBack()).toBeNull();
  });

  it("keeps a re-opened subject's payload rather than reloading it", () => {
    const modal = newModal();
    modal.openSubject("usr_first");
    expect(modal.payload).toBe("loaded:usr_first");
    modal.openSubject("usr_first");
    expect(modal.payload).toBe("loaded:usr_first");
  });

  it("caps the stack at 16 levels and drops the oldest, keeping the levels nearest the reader", () => {
    const modal = newModal();
    // 18 subjects means 17 pushes; one over the cap.
    for (let index = 1; index <= 18; index += 1) modal.openSubject(`usr_${String(index)}`);

    const walked: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const back = modalBack();
      if (back === null) break;
      walked.push(back.label);
      modal.close();
    }

    expect(walked).toHaveLength(16);
    // Newest first on the way back, and `usr_1` — the oldest — is the level that was dropped.
    expect(walked[0]).toBe("usr_17");
    expect(walked.at(-1)).toBe("usr_2");
    expect(walked).not.toContain("usr_1");
  });

  it("dismiss() throws the whole history away rather than stepping back through it", () => {
    const modal = newModal();
    modal.openSubject("usr_first");
    modal.openSubject("usr_second");
    modal.openSubject("usr_third");

    modal.dismiss();
    expect(modal.open).toBe(false);
    expect(modalBack()).toBeNull();
  });
});
