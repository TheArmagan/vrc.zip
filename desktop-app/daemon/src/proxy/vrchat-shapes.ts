/**
 * VRChat's own response shapes, reproduced.
 *
 * The mirror's contract is "byte-identical to VRChat", and on the handshake there is no upstream
 * response to copy — the proxy is synthesising a login that never reaches VRChat at all. So these
 * envelopes are written out by hand, and they are the one place in the daemon where matching
 * someone else's exact JSON is the requirement rather than a nicety.
 *
 * Two details that look like mistakes and are not:
 *
 *  - **`message` is double-encoded.** VRChat sends a JSON string *inside* the JSON — the wire
 *    carries `"message":"\"Invalid Username or Password\""`. Clients strip the quotes; one that
 *    does so unconditionally breaks against a message we sent singly-encoded.
 *  - **`status_code` is repeated in the body** as well as being the HTTP status. Some clients read
 *    one, some the other, and they must agree.
 */

/** VRChat's error envelope. */
export function vrchatError(
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return json(
    {
      error: {
        message: JSON.stringify(message),
        status_code: status,
        ...(extra ?? {}),
      },
    },
    status,
  );
}

/** VRChat's success envelope, used by `PUT /logout` among others. */
export function vrchatSuccess(message = "Ok!", status = 200): Response {
  return json({ success: { message, status_code: status } }, status);
}

/**
 * The 403 a missing or malformed User-Agent earns, `waf_code` and all.
 *
 * Reproducing this is both byte-faithful and the correct behaviour to teach: an app that gets it
 * from the proxy learns it will get the same from VRChat, which is the outcome we want. The
 * alternative — accepting a UA VRChat would reject — produces an app that works locally and is
 * banned in production.
 */
export function wafForbidden(): Response {
  return vrchatError(403, "Forbidden", { waf_code: 13799 });
}

/** The 401 an unrecognised username earns. There is deliberately no "default account" fallback. */
export function invalidCredentials(): Response {
  return vrchatError(401, "Invalid Username or Password");
}

/** The 401 a request with no usable session earns. */
export function missingCredentials(): Response {
  return vrchatError(401, "Missing Credentials");
}

/** `{"requiresTwoFactorAuth":[…]}` — a 200, exactly as VRChat sends it. */
export function requiresTwoFactorAuth(methods: readonly string[]): Response {
  return json({ requiresTwoFactorAuth: methods }, 200);
}

/** The verify endpoints' entire response body. */
export function verified(ok: boolean): Response {
  return json({ verified: ok }, 200);
}

/**
 * A vrc.zip error, for the cases VRChat has no equivalent of — an unknown scope, a missing scope.
 *
 * Deliberately *not* dressed up as a VRChat error. Byte-fidelity is a promise about mirroring
 * VRChat's API, and inventing a VRChat error that VRChat would never send is a worse lie than
 * admitting the proxy is the one talking. The shape stays close enough to be parseable by the same
 * code path, with `vrczip` naming who is speaking.
 */
export function vrczipError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return json(
    {
      error: { message, status_code: status, code, vrczip: true, ...(extra ?? {}) },
    },
    status,
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
