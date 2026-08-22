/**
 * Validating a webhook target URL. **This is an SSRF boundary**, and the second one in the daemon.
 *
 * The first is `GET /api/image` (see `servers/control.ts` §`parseImageUrl`), and the two differ in a
 * way that decides the whole shape of this file: an image URL can be checked against an allowlist of
 * three VRChat hosts, because the daemon knows every host it will ever legitimately fetch an image
 * from. A webhook cannot. The user's whole reason for registering one is to name a host we have
 * never heard of — so this is a *denylist* of the places a webhook must not point, which is the
 * weaker construction, and it is used only because an allowlist is genuinely unavailable here.
 *
 * What it refuses, and why each one is a real attack rather than tidiness:
 *
 * - **Plain http to anything but loopback.** The body carries the user's presence, their friends'
 *   locations, and their notifications; over http that is readable by anything on the path. Loopback
 *   is exempt because there is no path, and a local receiver is the common case for a home-made
 *   integration. It is *not* upgraded to https — an upgrade would silently change where a caller
 *   that meant something local ends up.
 * - **Non-loopback private, link-local, CGNAT, multicast, unspecified, and reserved IP literals.**
 *   The daemon sits inside the user's LAN with no credentials required of it. A webhook pointed at
 *   `http://192.168.1.1/admin/...` or `http://169.254.169.254/latest/meta-data/` turns "notify me
 *   about my friends" into an unauthenticated request generator inside a trusted network, and the
 *   response comes back in `last_error` where the registrant can read it.
 * - **Credentials in the URL.** `https://user:pass@host/` would put a password in a database column
 *   and in every log line that names the target. If an endpoint needs auth, it has the HMAC.
 * - **Single-label hostnames and `.local`.** `http://nas/` and `http://printer.local/` are LAN names
 *   by construction; a public webhook endpoint always has a dot and a real TLD.
 *
 * What it does **not** solve, stated plainly rather than left to be discovered: a public hostname
 * that resolves to `10.0.0.1` — DNS rebinding, or simply a domain someone pointed at their own LAN —
 * passes every check here, because the check happens at registration and the resolution happens at
 * delivery. Closing that means resolving the name ourselves and pinning the address into the socket,
 * which Bun's `fetch` does not expose. The mitigation that is actually available is that registering
 * a webhook is a consented act by the user, and the target is shown to them.
 */

/** Rejection reason, thrown by {@link validateWebhookUrl}. Safe to show the registrant verbatim. */
export class WebhookUrlError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

/**
 * Long enough for a real endpoint with a signing path and a query, short enough that the column is
 * never a place to stash a payload.
 */
const MAX_URL_LENGTH = 2048;

/** Hostnames that mean "this machine" without asking a resolver. Mirrors `security/guards.ts`. */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(["localhost"]);

/** How an IP literal is classified. `null` from the classifier means "not an IP literal at all". */
export type IpClass = "loopback" | "blocked" | "public";

/**
 * Validates and normalises a webhook target.
 *
 * Returns the URL as `URL` serialised it, which is what gets stored: the stored value must be the
 * one the checks were applied to, or a normalisation difference between check time and send time is
 * a hole. Throws {@link WebhookUrlError} for anything the daemon must not send to.
 */
export function validateWebhookUrl(raw: string): string {
  if (raw === "") throw new WebhookUrlError("invalid_url", "url is required");
  if (raw.length > MAX_URL_LENGTH) {
    throw new WebhookUrlError("invalid_url", `url must be at most ${MAX_URL_LENGTH} characters`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError("invalid_url", "url is not a URL");
  }

  if (url.username !== "" || url.password !== "") {
    throw new WebhookUrlError("credentials_in_url", "url must not contain credentials");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebhookUrlError("bad_scheme", "url must be http or https");
  }

  // `URL` has already lowercased, punycoded, and — for IPv4 — canonicalised the host, so
  // `http://0x7f000001/` and `http://2130706433/` both arrive here as `127.0.0.1`.
  const host = url.hostname;
  const ipClass = classifyHost(host);

  if (ipClass === "blocked") {
    throw new WebhookUrlError(
      "private_address",
      `url must not point at a private or reserved address (${host})`,
    );
  }

  if (url.protocol === "http:" && ipClass !== "loopback") {
    throw new WebhookUrlError("insecure_scheme", "url must be https unless it targets loopback");
  }

  return url.toString();
}

/**
 * Classifies a URL hostname.
 *
 * Names that are not IP literals come back `"public"` unless they are structurally local — see the
 * header on why `nas` and `printer.local` are refused while `hooks.example.com` is not.
 */
export function classifyHost(host: string): IpClass {
  const literal = classifyIpLiteral(host);
  if (literal !== null) return literal;

  if (LOOPBACK_NAMES.has(host)) return "loopback";

  // mDNS, and the "just the machine name" form. Both only resolve inside a LAN.
  if (host.endsWith(".local") || host.endsWith(".localhost")) return "blocked";
  if (!host.includes(".")) return "blocked";

  return "public";
}

/**
 * Classifies a bare IP literal, or returns `null` when the host is a name rather than an address.
 *
 * IPv6 arrives from `URL.hostname` bracketed (`[::1]`), which is stripped here rather than by the
 * caller — forgetting that is how an IPv6 check silently matches nothing.
 */
export function classifyIpLiteral(host: string): IpClass | null {
  const v4 = parseIpv4(host);
  if (v4 !== null) return classifyIpv4(v4);

  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const v6 = parseIpv6(inner);
  if (v6 !== null) return classifyIpv6(v6);

  return null;
}

/** Dotted quad → four octets, or null. Strict: `URL` has already canonicalised anything looser. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (part === "" || part.length > 3 || !/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }

  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

function classifyIpv4(octets: readonly [number, number, number, number]): IpClass {
  const [a, b] = octets;

  if (a === 127) return "loopback";

  // 0.0.0.0/8 unspecified, 10/8 + 172.16/12 + 192.168/16 private, 169.254/16 link-local,
  // 100.64/10 carrier-grade NAT, 224/4 multicast, 240/4 reserved (255.255.255.255 falls in it).
  if (a === 0) return "blocked";
  if (a === 10) return "blocked";
  if (a === 172 && b >= 16 && b <= 31) return "blocked";
  if (a === 192 && b === 168) return "blocked";
  if (a === 169 && b === 254) return "blocked";
  if (a === 100 && b >= 64 && b <= 127) return "blocked";
  if (a >= 224) return "blocked";

  return "public";
}

/**
 * `::`-compressed IPv6 → eight 16-bit groups, or null.
 *
 * Handles the trailing-IPv4 form (`::ffff:127.0.0.1`) because that is the shape an IPv4-mapped
 * address takes, and a v6 check that does not understand it would wave through
 * `http://[::ffff:169.254.169.254]/`.
 */
function parseIpv6(text: string): number[] | null {
  if (text === "") return null;

  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return null;

  const [headText, tailText] =
    doubleColon === -1 ? [text, null] : [text.slice(0, doubleColon), text.slice(doubleColon + 2)];

  const head = splitIpv6Groups(headText);
  const tail = tailText === null ? [] : splitIpv6Groups(tailText);
  if (head === null || tail === null) return null;

  if (doubleColon === -1) return head.length === 8 ? head : null;

  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** One `:`-separated run, with an optional dotted-quad in the final position. */
function splitIpv6Groups(text: string): number[] | null {
  if (text === "") return [];

  const parts = text.split(":");
  const groups: number[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined || part === "") return null;

    if (i === parts.length - 1 && part.includes(".")) {
      const v4 = parseIpv4(part);
      if (v4 === null) return null;
      groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }

    if (part.length > 4 || !/^[0-9a-f]+$/i.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }

  return groups;
}

function classifyIpv6(groups: readonly number[]): IpClass {
  const first = groups[0] ?? 0;

  // `::1` loopback and `::` unspecified are both "everything zero except maybe the last group".
  if (groups.slice(0, 7).every((g) => g === 0)) {
    return groups[7] === 1 ? "loopback" : "blocked";
  }

  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible: classify the address that is really meant,
  // or `[::ffff:10.0.0.1]` would read as a public v6 address.
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    return classifyIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }

  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  if ((first & 0xfe00) === 0xfc00) return "blocked";
  if ((first & 0xffc0) === 0xfe80) return "blocked";
  if ((first & 0xff00) === 0xff00) return "blocked";

  return "public";
}
