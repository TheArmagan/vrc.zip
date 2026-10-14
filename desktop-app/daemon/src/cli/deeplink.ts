/**
 * Handing a `vrczip://` link to the daemon that is already running.
 *
 * Windows starts a fresh `vrc.zip.exe` for every link that is clicked. When a daemon is already up,
 * that process must not become a second one, which would only find three ports taken. So it reads
 * `state.json` for the control URL and the session token, exactly as `vrc.zip dev` does, posts the
 * link, and exits. The daemon does the work and raises the toast.
 *
 * It runs before `claimConsole`, on purpose: a click in a browser that flashed a console window on
 * the way past would look like something had gone wrong.
 */

import { readStateFile } from "../security/state-file.ts";

/**
 * How long to wait for the daemon to answer.
 *
 * Long, because the answer includes a VRChat round trip behind the rate limiter. A timeout is
 * still "handled": the daemon got the link and will toast the outcome whether anyone waits for it.
 */
const FORWARD_TIMEOUT_MS = 20_000;

/**
 * `handled` means a running daemon took the link, whatever it then made of it: a refusal has
 * already been toasted, and starting a second daemon would not change the answer. `not-running`
 * means nothing answered, so the caller should become the daemon itself.
 */
export type ForwardResult = "handled" | "not-running";

export interface ForwardOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function forwardDeepLink(
  url: string,
  options: ForwardOptions = {},
): Promise<ForwardResult> {
  const state = await readStateFile(options.env);
  // No file means no daemon. A file left behind by a crash is caught below, when nothing answers.
  if (state === null) return "not-running";

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${state.controlUrl}/api/deeplink`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(options.timeoutMs ?? FORWARD_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return "handled";
  } catch (error) {
    // A timeout means somebody is listening and slow, which is not a reason to start a rival.
    if (error instanceof DOMException && error.name === "TimeoutError") return "handled";
    return "not-running";
  }
}
