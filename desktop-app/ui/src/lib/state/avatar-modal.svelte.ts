/**
 * The one avatar modal, and everything it knows.
 *
 * The fourth of the entity modals and built on the same base as the other three, for the same
 * reason: an avatar is named from a feed row, from the command palette and from a profile picture,
 * all of which are controls that re-render under a live socket, so there is exactly one `<Dialog>`
 * — mounted by `App.svelte` — and this module is the only thing that decides what it shows. The
 * abort/generation machinery and the shared back stack come from `entity-modal.svelte.ts`.
 *
 * ## An avatar is reached two ways, and only one of them is an id
 *
 * `openAvatar` is the ordinary door: somebody already has an `avtr_…`. `openByFile` is the one that
 * matters more often, because **VRChat never puts an avatar id on a user**. What a "changed avatar"
 * row carries is a picture, and the file id inside that picture URL is the only handle there is.
 * `avatar-ids.svelte.ts` maps that file back to an id, and this waits on it.
 *
 * That wait has an ordinary null in it. Most VRChat image files are not avatars at all — profile
 * icons, banners, gallery images — and the resolver being switched off answers the same way on
 * purpose. So a null is not a fault: the dialog opens anyway and says that this picture is not an
 * avatar vrc.zip can identify, which is a real answer, where doing nothing would be indistinguishable
 * from a broken button.
 *
 * Three outcomes past that are modelled rather than caught, because each is ordinary:
 *  - **a deleted or hidden avatar** (404). Avatars are deleted and made private constantly, and an
 *    id recovered from an old feed row is exactly where a dead one comes from.
 *  - **no account online** (503). Unlike a world, an avatar record is VRChat's alone, so there is
 *    nothing to serve from cache when nobody is signed in.
 *  - **the daemon gone** (offline), which the shell has already said at the top of the app.
 */

import { type AvatarDetail, api } from "../api.ts";
import { shortId } from "../format.ts";
import { type AvatarIdEntry, avatarIds } from "./avatar-ids.svelte.ts";
import { EntityModalState, type ResumePoint } from "./entity-modal.svelte.ts";

/** What an avatar is: the record as this app reads it, and the bytes behind that reading. */
export type AvatarModalTab = "overview" | "raw";

export const AVATAR_MODAL_TABS: readonly AvatarModalTab[] = ["overview", "raw"];

export const AVATAR_MODAL_TAB_LABELS: Record<AvatarModalTab, string> = {
  overview: "Overview",
  raw: "Raw JSON",
};

export function isAvatarModalTab(value: string): value is AvatarModalTab {
  return (AVATAR_MODAL_TABS as readonly string[]).includes(value);
}

export interface OpenAvatarOptions {
  /**
   * The name the caller already had on screen, when there was one. Shown while the record loads, so
   * the dialog opens with something readable in its heading rather than a spinner over an id.
   */
  readonly name?: string | null | undefined;
  /** The account this avatar was seen through; it decides whose credentials the lookup spends. */
  readonly accountId?: string | null | undefined;
}

/**
 * Waits for the shared resolver to have an answer about one file.
 *
 * The resolver is deliberately fire-and-forget — it exists so that thirty rows naming the same
 * picture make one request — and it has no promise to hand back. Rather than reaching past it to
 * `api.avatars.byFile` and paying for the same lookup twice, this watches its map: `ensure` starts
 * the work, and a rooted effect resolves as soon as the entry stops being `loading`.
 *
 * The `null` branch is the resolver's abort path, which deletes the entry outright so a later
 * `ensure` can ask again. Resolving on it rather than waiting forever is what keeps this from
 * leaving a dialog spinning on a load nobody is doing any more.
 */
function resolveFile(fileId: string): Promise<AvatarIdEntry | null> {
  const known = avatarIds.entry(fileId);
  if (known !== null && known.status !== "loading") return Promise.resolve(known);

  let stop: (() => void) | null = null;
  const answer = new Promise<AvatarIdEntry | null>((settle) => {
    let started = false;
    stop = $effect.root(() => {
      $effect(() => {
        const entry = avatarIds.entry(fileId);
        if (entry === null) {
          if (started) settle(null);
          return;
        }
        if (entry.status === "loading") {
          started = true;
          return;
        }
        settle(entry);
      });
    });
  });

  avatarIds.ensure(fileId);
  return answer.finally(() => {
    // Outside the effect that settled it: tearing a root down from inside its own effect is not a
    // thing to rely on, and one microtask later costs nothing.
    queueMicrotask(() => stop?.());
  });
}

class AvatarModalState extends EntityModalState {
  avatarId = $state<string | null>(null);
  /**
   * The picture this was opened from, when it was opened from one rather than from an id.
   *
   * Kept past the lookup because it is what the reader actually clicked, and because it is the only
   * identifier there is in the case where the file turns out not to name an avatar at all.
   */
  fileId = $state<string | null>(null);
  hintName = $state<string | null>(null);

  avatar = $state<AvatarDetail | null>(null);

  /** True when the file was asked about and is not an avatar. Not a fault; see the note above. */
  unidentified = $state(false);

  tab = $state<AvatarModalTab>("overview");

  /**
   * The failure the dialog should put words to.
   *
   * `unidentified` is not one of the base's `LoadFailure` values and should not be — nothing went
   * wrong — but it wants the same three-part treatment every other dead end gets, so it joins the
   * vocabulary here, where the words are chosen, rather than in the shared classifier.
   */
  displayFailure = $derived<string | null>(this.unidentified ? "not-an-avatar" : this.failure);

  /** The loaded name, the caller's hint, then the id. An avatar has no name resolver behind it. */
  title = $derived(this.avatar?.name ?? this.hintName ?? shortId(this.avatarId, 18));

  /**
   * Everything the dialog is holding, as a plain object — what the copy button copies.
   *
   * The same reasoning as the other three modals' Raw JSON: the layout above is a curated reading
   * of the data, and when the curation and the data disagree, this is how anyone finds out.
   */
  snapshot = $derived({
    avatarId: this.avatarId,
    fromFileId: this.fileId,
    seenThroughAccountId: this.accountId,
    avatar: this.avatar,
  });

  /** Opens the dialog on `avatarId`, replacing whatever it was showing. */
  openAvatar(avatarId: string, options: OpenAvatarOptions = {}): void {
    const same = this.avatarId === avatarId && this.phase === "ready";
    // First, before the assignments below — see `EntityModalState.takeScreen`.
    this.takeScreen(!same);
    this.avatarId = avatarId;
    this.hintName = options.name ?? (same ? this.hintName : null);
    this.accountId = options.accountId ?? null;
    if (!same) {
      this.fileId = null;
      this.tab = "overview";
      void this.#load(avatarId);
    }
  }

  /**
   * Opens the dialog on whichever avatar wears this picture.
   *
   * Opens *first* and looks up second. The lookup is a network round trip that can find nothing,
   * and a control that stays silent for a second and then stays silent forever is the worst of both
   * — so the dialog is on screen for the whole of it, and the "this is not an avatar" answer lands
   * inside it rather than nowhere.
   */
  async openByFile(fileId: string, options: OpenAvatarOptions = {}): Promise<void> {
    const known = avatarIds.entry(fileId);
    if (known !== null && known.avatarId !== null) {
      this.openAvatar(known.avatarId, options);
      this.fileId = fileId;
      return;
    }

    const same = this.fileId === fileId && this.phase === "ready";
    this.takeScreen(!same);
    if (same) return;

    this.avatarId = null;
    this.fileId = fileId;
    this.hintName = options.name ?? null;
    this.accountId = options.accountId ?? null;
    this.tab = "overview";

    // Takes the generation and the signal before the wait, so a second click on a different picture
    // while this one is still resolving cannot land its answer in the dialog.
    const { generation } = this.beginLoad();
    const entry = await resolveFile(fileId);
    if (!this.isCurrent(generation)) return;

    const resolved = entry?.avatarId ?? null;
    if (resolved === null) {
      this.unidentified = true;
      // `error` because the load is over and produced nothing to draw, not because anything failed.
      // `displayFailure` is what decides the words.
      this.phase = "error";
      this.error = entry?.error ?? null;
      return;
    }

    this.avatarId = resolved;
    void this.#load(resolved);
  }

  /**
   * Re-reads the record. The error state's retry button.
   *
   * Only ever the record: when the id was never found there is nothing here to try again, because
   * the resolver latches both of its answers for the session. That case is offered no retry control
   * at all rather than one that cannot change anything.
   */
  retry(): void {
    if (this.avatarId !== null) void this.#load(this.avatarId);
  }

  selectTab(tab: AvatarModalTab): void {
    this.tab = tab;
  }

  /**
   * Captured by value, every field of it: the closure runs after the singleton has been re-targeted
   * at somebody else, so anything read off `this` at call time would be the wrong subject.
   */
  protected resumePoint(): ResumePoint | null {
    const { avatarId, fileId, title, hintName: name, accountId, tab } = this;
    if (avatarId === null && fileId === null) return null;
    return {
      label: title,
      restore: () => {
        if (avatarId !== null) this.openAvatar(avatarId, { name, accountId });
        else if (fileId !== null) void this.openByFile(fileId, { name, accountId });
        // After the open, which resets it.
        this.tab = tab;
      },
    };
  }

  protected resetPayload(): void {
    this.avatar = null;
    this.unidentified = false;
  }

  async #load(avatarId: string): Promise<void> {
    const { generation, signal } = this.beginLoad();
    try {
      const avatar = await api.avatars.get(avatarId, this.accountId, signal);
      if (!this.isCurrent(generation)) return;
      this.avatar = avatar;
      this.phase = "ready";
    } catch (cause) {
      // Aborted or superseded loads are not failures; see `EntityModalState.recordFailure`.
      this.recordFailure(cause, generation);
    }
  }
}

export const avatarModal = new AvatarModalState();
