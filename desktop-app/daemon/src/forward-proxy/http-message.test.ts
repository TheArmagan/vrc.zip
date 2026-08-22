import { describe, expect, test } from "bun:test";
import {
  HttpParseError,
  header,
  parseAbsoluteTarget,
  parseAuthority,
  parseHead,
  RequestFramer,
  type Segment,
  serializeHead,
  withHeader,
  withoutHeader,
} from "./http-message.ts";

/**
 * The framer is the part of the forward proxy whose bugs are invisible until they are not: a
 * mis-segmented stream does not throw, it silently forwards the *next* request unrewritten. So the
 * cases here are mostly about boundaries — two requests in one read, one request across three
 * reads, a body that ends exactly on a read boundary, and the two shapes that stop being HTTP.
 */

const encode = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));
const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

/** Everything the framer produced, with `raw` segments joined so assertions read as wire text. */
function drain(
  framer: RequestFramer,
  ...reads: string[]
): { heads: string[]; body: string; ends: number } {
  const segments: Segment[] = [];
  for (const read of reads) segments.push(...framer.push(encode(read)));
  return {
    heads: segments.filter((s) => s.kind === "head").map((s) => decode(serializeHead(s.head))),
    body: segments
      .filter((s) => s.kind === "raw")
      .map((s) => decode(s.bytes))
      .join(""),
    ends: segments.filter((s) => s.kind === "end").length,
  };
}

describe("parseHead", () => {
  test("keeps header order, casing, and duplicates", () => {
    const head = parseHead(encode("GET /x HTTP/1.1\r\nHost: a\r\nX-A: 1\r\nX-a: 2\r\n"));
    expect(head.method).toBe("GET");
    expect(head.target).toBe("/x");
    expect(head.headers).toEqual([
      ["Host", "a"],
      ["X-A", "1"],
      ["X-a", "2"],
    ]);
    // `header` is case-insensitive and returns the first, as HTTP requires.
    expect(header(head, "x-a")).toBe("1");
  });

  test("rejects a request line with a raw space in the target", () => {
    // The smuggling case: split-on-whitespace parsers accept this and disagree with the next hop.
    expect(() => parseHead(encode("GET /a b HTTP/1.1\r\nHost: a\r\n"))).toThrow(HttpParseError);
  });

  test("rejects obsolete line folding", () => {
    expect(() => parseHead(encode("GET / HTTP/1.1\r\nHost: a\r\n  continued\r\n"))).toThrow(
      HttpParseError,
    );
  });

  test("rejects a version it cannot frame", () => {
    expect(() => parseHead(encode("GET / HTTP/2.0\r\nHost: a\r\n"))).toThrow(HttpParseError);
  });

  test("round-trips through latin-1 without widening a high byte", () => {
    const wire = "GET / HTTP/1.1\r\nHost: a\r\nX-Odd: \xa9\r\n\r\n";
    const head = parseHead(encode(wire.slice(0, -2)));
    expect(serializeHead(head)).toEqual(encode(wire));
  });
});

describe("header rewriting", () => {
  const head = parseHead(encode("GET / HTTP/1.1\r\nHost: a\r\nOrigin: b\r\nAccept: c\r\n"));

  test("withHeader replaces in place rather than appending", () => {
    expect(withHeader(head, "host", "z").headers).toEqual([
      ["Host", "z"],
      ["Origin", "b"],
      ["Accept", "c"],
    ]);
  });

  test("withHeader appends when the header is absent", () => {
    expect(withHeader(head, "X-New", "1").headers.at(-1)).toEqual(["X-New", "1"]);
  });

  test("withoutHeader removes case-insensitively", () => {
    expect(header(withoutHeader(head, "ORIGIN"), "origin")).toBeUndefined();
  });
});

describe("RequestFramer", () => {
  test("segments two pipelined requests in one read", () => {
    // The case that makes framing necessary at all: without it the second request reaches the
    // mirror still addressed to api.vrchat.cloud, and `hostGuard` answers 403.
    const result = drain(
      new RequestFramer(),
      "GET /one HTTP/1.1\r\nHost: a\r\n\r\nGET /two HTTP/1.1\r\nHost: a\r\n\r\n",
    );
    expect(result.heads).toEqual([
      "GET /one HTTP/1.1\r\nHost: a\r\n\r\n",
      "GET /two HTTP/1.1\r\nHost: a\r\n\r\n",
    ]);
  });

  test("assembles a head split across reads", () => {
    const framer = new RequestFramer();
    expect(framer.push(encode("GET /x HT"))).toEqual([]);
    expect(framer.push(encode("TP/1.1\r\nHos"))).toEqual([]);
    const segments = framer.push(encode("t: a\r\n\r\n"));
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("head");
  });

  test("forwards a Content-Length body verbatim and ends the request", () => {
    const result = drain(
      new RequestFramer(),
      "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhel",
      "lo",
      "GET /y HTTP/1.1\r\nHost: a\r\n\r\n",
    );
    expect(result.body).toBe("hello");
    expect(result.ends).toBe(1);
    expect(result.heads).toHaveLength(2);
  });

  test("forwards a chunked body with its framing intact", () => {
    const wire =
      "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "5\r\nhello\r\n3\r\n abc\r\n0\r\n\r\n" +
      "GET /next HTTP/1.1\r\nHost: a\r\n\r\n";
    const result = drain(new RequestFramer(), wire);
    // Byte-identical, extensions and all: the proxy never decodes a body, only measures it.
    expect(result.body).toBe("5\r\nhello\r\n3\r\n abc\r\n0\r\n\r\n");
    expect(result.ends).toBe(1);
    expect(result.heads).toHaveLength(2);
  });

  test("handles chunked trailers before finding the next request", () => {
    const result = drain(
      new RequestFramer(),
      "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "0\r\nX-Checksum: 1\r\n\r\n" +
        "GET /next HTTP/1.1\r\nHost: a\r\n\r\n",
    );
    expect(result.body).toBe("0\r\nX-Checksum: 1\r\n\r\n");
    expect(result.heads).toHaveLength(2);
  });

  test("CONNECT ends HTTP parsing, so a ClientHello in the same read is not a request line", () => {
    // A real client puts its TLS handshake in the very next byte, and often the same TCP segment.
    const framer = new RequestFramer();
    const segments = framer.push(
      encode(
        "CONNECT api.vrchat.cloud:443 HTTP/1.1\r\nHost: api.vrchat.cloud:443\r\n\r\n\x16\x03\x01\x00\x05",
      ),
    );
    expect(segments[0]?.kind).toBe("head");
    expect(segments[1]).toEqual({ kind: "raw", bytes: encode("\x16\x03\x01\x00\x05") });
    expect(framer.tunnelled).toBe(true);
  });

  test("an upgrade ends HTTP parsing too", () => {
    const framer = new RequestFramer();
    framer.push(
      encode(
        "GET /?authToken=x HTTP/1.1\r\nHost: pipeline.vrchat.cloud\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n\r\n",
      ),
    );
    expect(framer.tunnelled).toBe(true);
    expect(framer.push(encode("\x81\x03abc"))).toEqual([
      { kind: "raw", bytes: encode("\x81\x03abc") },
    ]);
  });

  test("refuses a head that never terminates rather than buffering it forever", () => {
    const framer = new RequestFramer();
    expect(() => framer.push(encode("GET / HTTP/1.1\r\nX: ".padEnd(70_000, "a")))).toThrow(
      expect.objectContaining({ status: 431 }),
    );
  });

  test("refuses a Transfer-Encoding it cannot frame", () => {
    const framer = new RequestFramer();
    expect(() =>
      framer.push(encode("POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip\r\n\r\n")),
    ).toThrow(expect.objectContaining({ status: 501 }));
  });

  test("refuses a malformed Content-Length", () => {
    const framer = new RequestFramer();
    expect(() =>
      framer.push(encode("POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 1e3\r\n\r\n")),
    ).toThrow(HttpParseError);
  });
});

describe("targets", () => {
  test("parseAuthority requires an explicit port", () => {
    expect(parseAuthority("api.vrchat.cloud:443")).toEqual({ host: "api.vrchat.cloud", port: 443 });
    expect(parseAuthority("api.vrchat.cloud")).toBeNull();
    expect(parseAuthority("api.vrchat.cloud:0")).toBeNull();
    expect(parseAuthority("[::1]:443")).toBeNull();
  });

  test("parseAuthority lowercases the host, since the intercept set is compared by equality", () => {
    expect(parseAuthority("API.VRChat.Cloud:443")?.host).toBe("api.vrchat.cloud");
  });

  test("parseAbsoluteTarget splits authority from origin-form", () => {
    expect(parseAbsoluteTarget("http://api.vrchat.cloud/api/1/auth?x=1")).toEqual({
      scheme: "http",
      host: "api.vrchat.cloud",
      port: 80,
      path: "/api/1/auth?x=1",
    });
  });

  test("parseAbsoluteTarget declines origin-form, which is what keeps a web page off the mirror", () => {
    expect(parseAbsoluteTarget("/api/1/auth")).toBeNull();
  });
});
