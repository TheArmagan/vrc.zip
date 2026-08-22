/**
 * Just enough HTTP/1.1 to be a forward proxy.
 *
 * The forward proxy sits between two HTTP/1.1 speakers and rewrites one line and one header. It has
 * no reason to understand bodies, so it does not: this module segments a request stream and hands
 * the body back as **opaque bytes to be forwarded verbatim**, chunk framing included. That is what
 * makes byte-fidelity free rather than something to be careful about — there is no decode step to
 * be wrong, and a `Transfer-Encoding` we do not recognise degrades to a failure rather than to a
 * silently mangled body.
 *
 * Segmentation is still necessary, and this is the part that is easy to get wrong by skipping.
 * A connection carries many requests, so the proxy has to know where each one *ends* in order to
 * find the next request line and rewrite its `Host` too. Blind-piping after the first request looks
 * like it works — the first call succeeds — and then every subsequent call on the same connection
 * arrives at the mirror still addressed to `api.vrchat.cloud`, which `hostGuard` rejects.
 *
 * Responses are never parsed. They travel upstream-to-client untouched.
 */

/** A request line plus its headers, in wire order, with the original casing preserved. */
export interface RequestHead {
  readonly method: string;
  /**
   * Verbatim: origin-form (`/api/1/auth/user`), absolute-form
   * (`http://api.vrchat.cloud/api/1/auth/user`), or authority-form (`api.vrchat.cloud:443`) after a
   * `CONNECT`. Which of the three it is determines how the proxy routes, so it is deliberately not
   * normalised on the way in.
   */
  readonly target: string;
  /** `HTTP/1.1`, verbatim. */
  readonly version: string;
  /**
   * `[name, value]` pairs in the order they arrived, duplicates kept. A `Set-Cookie`-shaped header
   * appearing twice is meaningful, and collapsing headers into a map loses both order and repeats.
   */
  readonly headers: readonly (readonly [string, string])[];
}

export class HttpParseError extends Error {
  /** The status to answer with. 400 for a malformed message, 431 for one that is simply too big. */
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "HttpParseError";
    this.status = status;
  }
}

/**
 * A request head bigger than this is refused rather than buffered.
 *
 * Without a cap, a client that opens a connection and never sends `\r\n\r\n` grows the buffer until
 * the daemon dies — and the daemon holds every VRChat session on the machine, so "one bad client
 * can OOM it" is not an acceptable failure mode. 64 KiB is far above any real request; VRChat's own
 * cookies and a browser's header set land around 2 KiB.
 */
export const MAX_HEAD_BYTES = 64 * 1024;

/** Chunk-size lines are a handful of hex digits. Anything longer is a malformed stream. */
const MAX_CHUNK_LINE_BYTES = 1024;

/** What the framer hands back, in the order it must be written upstream. */
export type Segment =
  | { readonly kind: "head"; readonly head: RequestHead }
  /** Body bytes, framing included. Forward verbatim; never inspect. */
  | { readonly kind: "raw"; readonly bytes: Uint8Array }
  /** The current request is complete. The next `head` starts a new one. */
  | { readonly kind: "end" };

type State =
  | { name: "head" }
  | { name: "length"; remaining: number }
  | { name: "chunk-size" }
  | { name: "chunk-data"; remaining: number }
  | { name: "chunk-trailer" }
  /** After a protocol upgrade the bytes stop being HTTP. Everything is passthrough from here. */
  | { name: "tunnel" };

/**
 * Segments a client-to-server byte stream into requests.
 *
 * Feed it whatever arrives off the socket; take whatever segments are complete. Incomplete input is
 * retained, so a head split across three TCP reads is assembled rather than rejected.
 */
export class RequestFramer {
  // Annotated rather than inferred: `new Uint8Array(0)` narrows to `Uint8Array<ArrayBuffer>`, and
  // bytes arriving off a socket are `Uint8Array<ArrayBufferLike>`.
  #buffer: Uint8Array = new Uint8Array(0);
  #state: State = { name: "head" };
  /** A segment produced alongside another one, handed out on the following call. See `#next`. */
  #queued: Segment | null = null;

  /** True once an upgrade was forwarded and this stream stopped being HTTP. */
  get tunnelled(): boolean {
    return this.#state.name === "tunnel";
  }

  /** Bytes held back because they do not yet form a complete segment. */
  get pending(): number {
    return this.#buffer.length;
  }

  /**
   * Switches the stream to passthrough for good.
   *
   * Called once an upgrade request has been forwarded: whatever comes back is the new protocol's
   * business, and continuing to look for request lines in a WebSocket frame would find nonsense.
   */
  tunnel(): void {
    this.#state = { name: "tunnel" };
  }

  push(bytes: Uint8Array): Segment[] {
    this.#buffer = concatBytes(this.#buffer, bytes);
    const segments: Segment[] = [];
    for (;;) {
      const segment = this.#next();
      if (segment === null) return segments;
      segments.push(segment);
    }
  }

  #next(): Segment | null {
    // A body's last `raw` segment and the `end` that follows it are produced together; `#queued`
    // holds the second so every other branch can keep returning exactly one segment.
    if (this.#queued !== null) {
      const queued = this.#queued;
      this.#queued = null;
      return queued;
    }

    switch (this.#state.name) {
      case "tunnel":
        return this.#takeAll();
      case "head":
        return this.#readHead();
      case "length":
        return this.#readLengthBody(this.#state.remaining);
      case "chunk-size":
        return this.#readChunkSize();
      case "chunk-data":
        return this.#readChunkData(this.#state.remaining);
      case "chunk-trailer":
        return this.#readChunkTrailer();
    }
  }

  #takeAll(): Segment | null {
    if (this.#buffer.length === 0) return null;
    return { kind: "raw", bytes: this.#consume(this.#buffer.length) };
  }

  #readHead(): Segment | null {
    const end = indexOfDoubleCrlf(this.#buffer);
    if (end === -1) {
      if (this.#buffer.length > MAX_HEAD_BYTES) {
        throw new HttpParseError("request head exceeds the size limit", 431);
      }
      return null;
    }

    const raw = this.#consume(end + 4);
    const head = parseHead(raw.subarray(0, end + 2));
    this.#state = nextStateAfter(head);
    return { kind: "head", head };
  }

  #readLengthBody(remaining: number): Segment | null {
    if (this.#buffer.length === 0) return null;
    const take = Math.min(remaining, this.#buffer.length);
    const bytes = this.#consume(take);
    const left = remaining - take;
    if (left > 0) {
      this.#state = { name: "length", remaining: left };
      return { kind: "raw", bytes };
    }
    this.#state = { name: "head" };
    // The tail of the body and the end-of-request marker are two segments so the caller can flush
    // the first without having to special-case the second.
    this.#queued = { kind: "end" };
    return { kind: "raw", bytes };
  }

  #readChunkSize(): Segment | null {
    const eol = indexOfCrlf(this.#buffer, 0);
    if (eol === -1) {
      if (this.#buffer.length > MAX_CHUNK_LINE_BYTES) {
        throw new HttpParseError("chunk size line exceeds the size limit");
      }
      return null;
    }

    const line = decodeAscii(this.#buffer.subarray(0, eol));
    // `chunk-size [ ";" chunk-ext ]` — the extension is forwarded verbatim and never interpreted.
    const sizeText = (line.split(";")[0] ?? "").trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
      throw new HttpParseError(`malformed chunk size: ${JSON.stringify(line)}`);
    }
    const size = Number.parseInt(sizeText, 16);

    const bytes = this.#consume(eol + 2);
    // A zero-length chunk closes the body; trailers may follow before the final blank line.
    this.#state =
      size === 0 ? { name: "chunk-trailer" } : { name: "chunk-data", remaining: size + 2 };
    return { kind: "raw", bytes };
  }

  #readChunkData(remaining: number): Segment | null {
    if (this.#buffer.length === 0) return null;
    const take = Math.min(remaining, this.#buffer.length);
    const bytes = this.#consume(take);
    const left = remaining - take;
    this.#state = left > 0 ? { name: "chunk-data", remaining: left } : { name: "chunk-size" };
    return { kind: "raw", bytes };
  }

  #readChunkTrailer(): Segment | null {
    // The terminating sequence is a bare CRLF when there are no trailers, and `...\r\n\r\n` when
    // there are. Looking for the first blank line covers both.
    const blank = indexOfBlankLine(this.#buffer);
    if (blank === -1) {
      if (this.#buffer.length > MAX_HEAD_BYTES) {
        throw new HttpParseError("chunked trailer exceeds the size limit", 431);
      }
      return null;
    }
    const bytes = this.#consume(blank);
    this.#state = { name: "head" };
    this.#queued = { kind: "end" };
    return { kind: "raw", bytes };
  }

  #consume(count: number): Uint8Array {
    const taken = this.#buffer.slice(0, count);
    this.#buffer = this.#buffer.slice(count);
    return taken;
  }
}

/** Which state a request's body puts the stream into. */
function nextStateAfter(head: RequestHead): State {
  // `CONNECT` and an upgrade both mean the same thing to the framer: the bytes after this head are
  // no longer HTTP. Getting this wrong is not subtle but it is easy — a client that puts its TLS
  // ClientHello in the same TCP segment as the `CONNECT` would have it parsed as a request line.
  if (head.method === "CONNECT" || isUpgrade(head)) return { name: "tunnel" };

  const transferEncoding = header(head, "transfer-encoding");
  const lengths = headerValues(head, "content-length");

  // Both present is the textbook request-smuggling setup: two hops disagree about which one frames
  // the body, and the difference is an attacker-chosen extra request. RFC 9112 says the recipient
  // must reject, and a proxy is precisely the hop where "must" is load-bearing.
  if (transferEncoding !== undefined && lengths.length > 0) {
    throw new HttpParseError("Transfer-Encoding and Content-Length must not both be present");
  }

  if (transferEncoding !== undefined) {
    // Only `chunked`, and only as the final coding, is legal for a request the proxy must segment.
    const codings = transferEncoding.split(",").map((value) => value.trim().toLowerCase());
    if (codings.at(-1) !== "chunked") {
      throw new HttpParseError(`unsupported Transfer-Encoding: ${transferEncoding}`, 501);
    }
    return { name: "chunk-size" };
  }

  if (lengths.length === 0) return { name: "head" };
  // Repeated `Content-Length` is legal only when every value agrees; otherwise it is the same
  // disagreement as above wearing one header instead of two.
  if (lengths.some((value) => value !== lengths[0])) {
    throw new HttpParseError("conflicting Content-Length headers");
  }

  const raw = (lengths[0] ?? "").trim();
  // Digits only. `Number` would happily read `1e3` as 1000, `0x10` as 16, and `+5` as 5 — each of
  // which an upstream parser reads differently, which is a desynchronised stream rather than a
  // rounding difference.
  if (!/^\d+$/.test(raw)) throw new HttpParseError(`malformed Content-Length: ${raw}`);

  const length = Number(raw);
  if (!Number.isSafeInteger(length))
    throw new HttpParseError(`Content-Length out of range: ${raw}`);
  return length === 0 ? { name: "head" } : { name: "length", remaining: length };
}

/** Every value of a header, in order. Repeats are meaningful for the framing headers. */
function headerValues(head: RequestHead, name: string): string[] {
  const wanted = name.toLowerCase();
  return head.headers.filter(([key]) => key.toLowerCase() === wanted).map(([, value]) => value);
}

// --- head parsing and serialisation -----------------------------------------

/** Parses a head whose bytes end with the final header's CRLF (the blank line excluded). */
export function parseHead(bytes: Uint8Array): RequestHead {
  const text = decodeAscii(bytes);
  const lines = text.split("\r\n");
  const requestLine = lines.shift() ?? "";

  // Exactly two spaces. Splitting on whitespace generally would accept a request line with a raw
  // space in the target, which is request smuggling's front door.
  const first = requestLine.indexOf(" ");
  const second = requestLine.indexOf(" ", first + 1);
  if (first <= 0 || second <= first + 1 || requestLine.indexOf(" ", second + 1) !== -1) {
    throw new HttpParseError(`malformed request line: ${JSON.stringify(requestLine)}`);
  }

  const version = requestLine.slice(second + 1);
  if (!/^HTTP\/1\.[01]$/.test(version)) {
    throw new HttpParseError(`unsupported HTTP version: ${version}`, 505);
  }

  const headers: (readonly [string, string])[] = [];
  for (const line of lines) {
    if (line === "") continue;
    // Obsolete line folding. It is a smuggling vector and no live client emits it.
    if (line.startsWith(" ") || line.startsWith("\t")) {
      throw new HttpParseError("obsolete header line folding is not accepted");
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw new HttpParseError(`malformed header line: ${JSON.stringify(line)}`);
    headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
  }

  return {
    method: requestLine.slice(0, first),
    target: requestLine.slice(first + 1, second),
    version,
    headers,
  };
}

export function serializeHead(head: RequestHead): Uint8Array {
  const lines = [`${head.method} ${head.target} ${head.version}`];
  for (const [name, value] of head.headers) lines.push(`${name}: ${value}`);
  // Latin-1, matching `decodeAscii`. Re-encoding as UTF-8 would turn a byte the parser widened into
  // a code point above 0x7f back into *two* bytes, altering both the header and the message length.
  return new Uint8Array(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"));
}

/** The first value of a header, matched case-insensitively as HTTP requires. */
export function header(head: RequestHead, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of head.headers) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Replaces every occurrence of a header with one instance, keeping the original position. */
export function withHeader(head: RequestHead, name: string, value: string): RequestHead {
  const wanted = name.toLowerCase();
  let placed = false;
  const headers: (readonly [string, string])[] = [];
  for (const entry of head.headers) {
    if (entry[0].toLowerCase() !== wanted) {
      headers.push(entry);
    } else if (!placed) {
      headers.push([entry[0], value]);
      placed = true;
    }
  }
  if (!placed) headers.push([name, value]);
  return { ...head, headers };
}

export function withoutHeader(head: RequestHead, name: string): RequestHead {
  const wanted = name.toLowerCase();
  return { ...head, headers: head.headers.filter(([key]) => key.toLowerCase() !== wanted) };
}

export function withTarget(head: RequestHead, target: string): RequestHead {
  return { ...head, target };
}

/** True when the request asks to leave HTTP behind — a WebSocket handshake, in practice. */
export function isUpgrade(head: RequestHead): boolean {
  const connection = header(head, "connection")?.toLowerCase() ?? "";
  return (
    header(head, "upgrade") !== undefined &&
    connection.split(",").some((token) => token.trim() === "upgrade")
  );
}

// --- targets ----------------------------------------------------------------

export interface Authority {
  readonly host: string;
  readonly port: number;
}

/** `host:port` from a `CONNECT` target. The port is mandatory in authority-form. */
export function parseAuthority(target: string): Authority | null {
  const colon = target.lastIndexOf(":");
  if (colon <= 0) return null;
  const host = target.slice(0, colon).toLowerCase();
  const port = Number(target.slice(colon + 1));
  if (host === "" || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  // A bracketed IPv6 literal would need unwrapping; nothing in scope here speaks to one, and
  // accepting it half-way is worse than declining it.
  return host.includes("[") ? null : { host, port };
}

export interface AbsoluteTarget {
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  /** Path plus query — the origin-form the request becomes once the authority is stripped. */
  readonly path: string;
}

/** `http://host/path?query` from an absolute-form request line, which is what a proxy receives. */
export function parseAbsoluteTarget(target: string): AbsoluteTarget | null {
  if (!/^https?:\/\//i.test(target)) return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(":", "");
  return {
    scheme,
    host: url.hostname.toLowerCase(),
    port: url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port),
    path: `${url.pathname}${url.search}`,
  };
}

// --- bytes ------------------------------------------------------------------

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Latin-1 rather than UTF-8, and via `Buffer` because Bun's `TextDecoder` types do not offer it.
 *
 * The distinction is not pedantic: UTF-8 decoding replaces an invalid byte with U+FFFD, so a header
 * carrying a stray high byte would come back altered and be re-encoded altered. Latin-1 is a total
 * function from bytes to code points, which is what "forward it verbatim" requires.
 */
function decodeAscii(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

function indexOfCrlf(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) return i;
  }
  return -1;
}

function indexOfDoubleCrlf(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * The length of a chunked body's terminator, trailers included: bytes up to and including the CRLF
 * that closes the final blank line. `-1` when it has not all arrived.
 */
function indexOfBlankLine(bytes: Uint8Array): number {
  if (bytes.length >= 2 && bytes[0] === 0x0d && bytes[1] === 0x0a) return 2;
  const end = indexOfDoubleCrlf(bytes);
  return end === -1 ? -1 : end + 4;
}
