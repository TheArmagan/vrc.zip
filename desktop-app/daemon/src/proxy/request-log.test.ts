import { describe, expect, test } from "bun:test";
import {
  createProxyLogger,
  describeHeaders,
  MAX_LOGGED_BODY,
  PROXY_LOG_ENV,
  parseProxyLogLevel,
  redact,
} from "./request-log.ts";

/**
 * These tests are mostly about what does **not** come out.
 *
 * A logger is the one component whose bugs are silent until someone pastes its output into an issue,
 * so the redaction cases matter more than the formatting ones. Both credential shapes are used
 * verbatim: `authcookie_<uuid>` is a real VRChat session, `authcookie_<uuid>_vrczip` is ours.
 */

const REAL = "authcookie_2e0a5f9c-1b3d-4a77-9f0e-6c1d2b3a4e5f";
const OURS = "authcookie_9f8e7d6c-5b4a-3210-fedc-ba9876543210_vrczip";

/** A logger writing into an array rather than the terminal. */
function capture(level: string) {
  const lines: string[] = [];
  const logger = createProxyLogger(
    { [PROXY_LOG_ENV]: level },
    { write: (line) => lines.push(line) },
  );
  return { logger, lines, text: () => lines.join("\n") };
}

describe("parseProxyLogLevel", () => {
  test("off unless asked for, and unset is off", () => {
    expect(parseProxyLogLevel(undefined)).toBe("off");
    expect(parseProxyLogLevel("")).toBe("off");
    expect(parseProxyLogLevel("0")).toBe("off");
    expect(parseProxyLogLevel("nonsense")).toBe("off");
  });

  test("accepts the spellings someone would actually put in a .env", () => {
    expect(parseProxyLogLevel("1")).toBe("basic");
    expect(parseProxyLogLevel("true")).toBe("basic");
    expect(parseProxyLogLevel(" Headers ")).toBe("headers");
    expect(parseProxyLogLevel("BODY")).toBe("body");
  });
});

describe("redact", () => {
  test("never lets a real VRChat credential through", () => {
    const out = redact(`{"ok":true,"token":"${REAL}"}`);
    expect(out).not.toContain(REAL);
    // Named loudly: a real credential appearing on this path is a bug report on its own.
    expect(out).toContain("REAL VRCHAT CREDENTIAL");
  });

  test("redacts our own tokens too, and says which is which", () => {
    const out = redact(`set-cookie: auth=${OURS}`);
    expect(out).not.toContain(OURS);
    expect(out).toContain("authcookie_<vrc.zip>");
  });

  test("redacts pairing codes and passwords in JSON bodies", () => {
    // The six digits are the consent gesture; the password is the user's real VRChat one.
    expect(redact('{"code":"123456"}')).toBe('{"code":"<redacted>"}');
    expect(redact('{"password": "hunter2", "username":"alice"}')).toContain(
      '"password":"<redacted>"',
    );
    expect(redact('{"password": "hunter2", "username":"alice"}')).toContain('"username":"alice"');
  });

  test("leaves ordinary text alone", () => {
    expect(redact('{"displayName":"Alice","userId":"usr_123"}')).toBe(
      '{"displayName":"Alice","userId":"usr_123"}',
    );
  });
});

describe("describeHeaders", () => {
  test("prints cookie names and never cookie values", () => {
    const headers = new Headers({ cookie: `auth=${OURS}; twoFactorAuth=${REAL}; theme=dark` });
    const [line = ""] = describeHeaders(headers);

    expect(line).not.toContain(OURS);
    expect(line).not.toContain(REAL);
    expect(line).toContain("auth=<vrc.zip token>");
    expect(line).toContain("twoFactorAuth=<REAL VRCHAT CREDENTIAL>");
    // A non-credential cookie is still not printed: the logger does not judge values, only shapes.
    expect(line).toContain("theme=<redacted>");
  });

  test("prints the Authorization scheme and nothing else", () => {
    // On the login path this header decodes to the user's real VRChat password.
    const headers = new Headers({ authorization: "Basic YWxpY2U6aHVudGVyMg==" });
    const [line = ""] = describeHeaders(headers);
    expect(line).toBe("authorization: Basic <redacted>");
  });

  test("passes ordinary headers through, redacted", () => {
    const headers = new Headers({ "user-agent": "VRCX/1.2.3 me@example.com" });
    expect(describeHeaders(headers)).toEqual(["user-agent: VRCX/1.2.3 me@example.com"]);
  });
});

describe("levels", () => {
  test("off builds a logger that writes nothing and says so", () => {
    const { logger, lines } = capture("off");
    expect(logger.enabled).toBe(false);
    logger.line("proxy", "GET /x");
    logger.headers("req", new Headers({ "x-a": "1" }));
    logger.body("req", "hello");
    expect(lines).toEqual([]);
  });

  test("basic writes the line and withholds headers and bodies", () => {
    const { logger, lines } = capture("1");
    logger.line("proxy", "GET /api/1/config -> 200 getConfig VRCX/1.2.3 41ms");
    logger.headers("req", new Headers({ "x-a": "1" }));
    logger.body("req", '{"a":1}');
    expect(lines).toEqual(["[vrcz:proxy] GET /api/1/config -> 200 getConfig VRCX/1.2.3 41ms"]);
    expect(logger.wantsBodies).toBe(false);
  });

  test("headers adds headers but still no bodies", () => {
    const { logger, lines } = capture("headers");
    logger.headers("req", new Headers({ "x-a": "1" }));
    logger.body("req", '{"a":1}');
    expect(lines).toEqual(["    req x-a: 1"]);
    expect(logger.wantsBodies).toBe(false);
  });

  test("body adds bodies, redacted and truncated", () => {
    const { logger, lines, text } = capture("body");
    expect(logger.wantsBodies).toBe(true);

    logger.body("res", `{"token":"${REAL}"}`);
    expect(text()).not.toContain(REAL);

    lines.length = 0;
    logger.body("res", "x".repeat(MAX_LOGGED_BODY + 500));
    expect(lines[0]).toContain("…");
    expect(lines[0]?.length).toBeLessThan(MAX_LOGGED_BODY + 100);
  });

  test("a multi-line body stays on one line, so one request is one entry", () => {
    const { logger, lines } = capture("body");
    logger.body("res", '{\n  "a": 1\n}');
    expect(lines[0]).toBe('    res {   "a": 1 }');
  });
});
