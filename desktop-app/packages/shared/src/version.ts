/** Display name. Also the prefix of the User-Agent sent to VRChat — see PLAN.md §1.4. */
export const APP_NAME = "vrc.zip";

/**
 * Application version. Kept in step with the workspace root `package.json` by a test in this
 * package; it is duplicated rather than imported so that nothing at runtime has to read a
 * `package.json` off disk (the shipped bundle has no reliable path to one).
 */
export const APP_VERSION = "0.1.0";

/**
 * Protocol major for the plugin API. Plugins declare `engines.pluginApi` against *this*, not
 * against `APP_VERSION` — the app and the plugin protocol version independently, and conflating
 * them would force a plugin-ecosystem break on every app release.
 */
export const PLUGIN_API_PROTOCOL_MAJOR = 0;
