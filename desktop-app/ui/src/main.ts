/**
 * The entry point.
 *
 * Order matters here. The session token is adopted out of the launch URL *before* the app mounts,
 * because the first thing `AppState.start()` does is fetch `/api/status` and open the event
 * socket, and both need the token in hand. Adopting it also strips it from the address bar, so it
 * never survives in history or in a screenshot of the window.
 */

import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { adoptTokenFromLocation } from "$lib/session.ts";

adoptTokenFromLocation();

// A hash-routed app with no hash loads as a bare origin, which reads as a blank slate rather than
// a screen. Normalise before mount so the first paint is already on a route.
if (window.location.hash === "") window.location.hash = "#/sessions";

const target = document.getElementById("app");
if (target === null) {
  throw new Error("index.html is missing #app; the bundle has nothing to mount into");
}

export default mount(App, { target });
