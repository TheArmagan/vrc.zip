import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateTlsMaterial, normaliseHosts } from "./ca.ts";

/**
 * The CA is verified two ways on purpose.
 *
 * Structurally — SANs, chain, signature — because a certificate that parses is not the same as one
 * a client accepts, and DER written by hand fails in ways that only a real validator notices.
 * And then behaviourally, with an actual TLS handshake under strict verification, because that is
 * the only assertion that means what the feature needs it to mean: Chromium will accept this.
 */

let stateDir: string;
let env: NodeJS.ProcessEnv;

const HOSTS = ["api.vrchat.cloud", "pipeline.vrchat.cloud"];

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "vrczip-ca-"));
  env = { ...process.env, VRCZIP_STATE_DIR: stateDir };
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** The leaf out of the chain, which is the first certificate in it. */
function leafOf(chainPem: string): X509Certificate {
  const marker = "-----END CERTIFICATE-----";
  return new X509Certificate(chainPem.slice(0, chainPem.indexOf(marker) + marker.length));
}

describe("loadOrCreateTlsMaterial", () => {
  test("issues a leaf naming exactly the requested hosts", async () => {
    const material = await loadOrCreateTlsMaterial(HOSTS, env);
    const leaf = leafOf(material.chainPem);

    expect(leaf.subjectAltName).toBe("DNS:api.vrchat.cloud, DNS:pipeline.vrchat.cloud");
    expect(leaf.checkHost("api.vrchat.cloud")).toBe("api.vrchat.cloud");
    // The property that keeps a client from coalescing an unrelated origin onto this connection.
    expect(leaf.checkHost("vrchat.com")).toBeUndefined();
    expect(leaf.checkHost("evil.example")).toBeUndefined();
  });

  test("the leaf chains to the CA and the CA is a self-signed root", async () => {
    const material = await loadOrCreateTlsMaterial(HOSTS, env);
    const leaf = leafOf(material.chainPem);
    const ca = new X509Certificate(material.caCertPem);

    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(ca.ca).toBe(true);
    expect(ca.verify(ca.publicKey)).toBe(true);
    // A leaf that could sign further certificates would make a stolen key far worse.
    expect(leaf.ca).toBe(false);
  });

  test("a strict TLS client accepts it as the host it impersonates", async () => {
    const material = await loadOrCreateTlsMaterial(HOSTS, env);

    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: material.leafKeyPem, cert: material.chainPem },
      socket: {
        data: (socket) => void socket.write("HTTP/1.1 204 No Content\r\n\r\n"),
        open: () => {},
        close: () => {},
        error: () => {},
      },
    });

    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out")), 5000);
        void Bun.connect({
          hostname: "127.0.0.1",
          port: server.port,
          // Only the minted root is trusted, and the name must match: exactly Chromium's check.
          tls: {
            ca: material.caCertPem,
            serverName: "api.vrchat.cloud",
            rejectUnauthorized: true,
          },
          socket: {
            open: (socket) => void socket.write("GET / HTTP/1.1\r\nHost: api.vrchat.cloud\r\n\r\n"),
            data: (_socket, bytes) => {
              clearTimeout(timer);
              resolve(Buffer.from(bytes).toString("latin1"));
            },
            close: () => {},
            error: (_socket, error) => {
              clearTimeout(timer);
              reject(error);
            },
          },
        }).catch(reject);
      });
      expect(answer).toStartWith("HTTP/1.1 204");
    } finally {
      server.stop(true);
    }
  });

  test("reuses what it wrote, so an installed CA stays installed", async () => {
    const first = await loadOrCreateTlsMaterial(HOSTS, env);
    // Reordered: normalisation must make this the same request, not a reissue.
    const second = await loadOrCreateTlsMaterial([...HOSTS].reverse(), env);

    expect(first.caIsNew).toBe(true);
    expect(second.caIsNew).toBe(false);
    expect(second.chainPem).toBe(first.chainPem);
  });

  test("reissues the leaf when the host set changes, keeping the CA", async () => {
    const first = await loadOrCreateTlsMaterial(HOSTS, env);
    const narrowed = await loadOrCreateTlsMaterial(["api.vrchat.cloud"], env);

    expect(narrowed.chainPem).not.toBe(first.chainPem);
    // Replacing the CA here would silently invalidate the trust the user installed by hand.
    expect(narrowed.caCertPem).toBe(first.caCertPem);
    expect(narrowed.caIsNew).toBe(false);
  });

  test("recovers from a corrupt CA rather than failing to start", async () => {
    const first = await loadOrCreateTlsMaterial(HOSTS, env);
    await writeFile(join(stateDir, "tls", "ca.crt"), "-----BEGIN CERTIFICATE-----\nnope\n", "utf8");

    const second = await loadOrCreateTlsMaterial(HOSTS, env);
    expect(second.caIsNew).toBe(true);
    expect(second.caCertPem).not.toBe(first.caCertPem);
    // The banner tells the user to install the new one, which is the whole point of `caIsNew`.
    expect(leafOf(second.chainPem).checkIssued(new X509Certificate(second.caCertPem))).toBe(true);
  });

  test("writes the private keys and nothing else as secrets", async () => {
    const material = await loadOrCreateTlsMaterial(HOSTS, env);
    const caKey = await readFile(join(stateDir, "tls", "ca.key"), "utf8");
    expect(caKey).toStartWith("-----BEGIN PRIVATE KEY-----");
    // The published certificate must never carry key material.
    expect(material.caCertPem).not.toContain("PRIVATE KEY");
    expect(material.chainPem).not.toContain("PRIVATE KEY");
  });

  test("refuses to issue a certificate for nothing", async () => {
    await expect(loadOrCreateTlsMaterial([], env)).rejects.toThrow("at least one host");
  });
});

describe("normaliseHosts", () => {
  test("lowercases, trims, de-duplicates, and sorts", () => {
    expect(normaliseHosts([" API.VRChat.Cloud ", "api.vrchat.cloud", "", "b.example"])).toEqual([
      "api.vrchat.cloud",
      "b.example",
    ]);
  });
});
