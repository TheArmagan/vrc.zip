/**
 * What a command needs from the shell, and nothing more.
 *
 * The registry must not import the toaster, the palette, or anything else that only exists because
 * this app happens to be a Svelte page — plugins register through the same interface in Phase 4,
 * and a registry that reaches for `svelte-sonner` is a registry that cannot be tested or reused.
 * So the shell hands its commands these three verbs and keeps its components to itself.
 */
export interface CommandHost {
  /** Says a stub is a stub. Never a silent no-op — see `builtin.svelte.ts`. */
  readonly notImplemented: (title: string, why: string) => void;
  readonly openPalette: () => void;
  /**
   * A plain word to the user: a clipboard that held nothing openable, a maintenance run that
   * finished. Commands act somewhere the reader is not necessarily looking, so most of them have
   * something to say.
   */
  readonly notify: (
    level: "success" | "info" | "warning" | "error",
    title: string,
    detail?: string,
  ) => void;
}
