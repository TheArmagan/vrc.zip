/** Display name. Also the prefix of the User-Agent sent to VRChat — see PLAN.md §1.4. */
export const APP_NAME = "vrc.zip";

/**
 * Application version. Kept in step with the workspace root `package.json` by a test in this
 * package; it is duplicated rather than imported so that nothing at runtime has to read a
 * `package.json` off disk (the shipped bundle has no reliable path to one).
 */
export const APP_VERSION = "0.1.6";

/**
 * Where the project lives.
 *
 * Here rather than typed out at the two places that open it, because one of them is a menu item in
 * the notification area and the other is the README's own link: a repository that moves and takes
 * one of them with it is the kind of drift nothing would catch.
 */
export const REPOSITORY_URL = "https://github.com/TheArmagan/vrc.zip";

/**
 * Protocol major for the plugin API. Plugins declare `engines.pluginApi` against *this*, not
 * against `APP_VERSION` — the app and the plugin protocol version independently, and conflating
 * them would force a plugin-ecosystem break on every app release.
 */
export const PLUGIN_API_PROTOCOL_MAJOR = 0;
