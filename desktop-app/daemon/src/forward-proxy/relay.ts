import type { Socket } from "bun";

/**
 * A write side that tolerates not having a socket yet, and tolerates the socket saying "not now".
 *
 * Both cases are the normal path in a proxy rather than edge cases. A `CONNECT` client starts its
 * TLS handshake the instant it sees `200 Connection Established`, which can be before
 * `Bun.connect` has resolved; and `Socket.write` returns a **short count** under backpressure —
 * a partial write whose remainder is silently dropped is exactly how a proxy corrupts a large
 * upload in a way that only shows up on slow links and big payloads.
 *
 * So: queue everything, flush on attach and on `drain`, and never assume a write completed.
 */
export class Writer {
  #socket: Socket<unknown> | null = null;
  #queue: Uint8Array[] = [];
  #ending = false;
  #destroyed = false;

  /** Bytes waiting on backpressure or on a socket that has not connected yet. */
  get buffered(): number {
    let total = 0;
    for (const chunk of this.#queue) total += chunk.length;
    return total;
  }

  attach(socket: Socket<unknown>): void {
    if (this.#destroyed) {
      socket.end();
      return;
    }
    this.#socket = socket;
    this.#flush();
  }

  write(bytes: Uint8Array): void {
    if (this.#destroyed || bytes.length === 0) return;
    this.#queue.push(bytes);
    this.#flush();
  }

  /** Called from the socket's `drain` handler. */
  resume(): void {
    this.#flush();
  }

  /** Half-closes once everything queued has gone out. */
  end(): void {
    this.#ending = true;
    this.#flush();
  }

  /** Drops the queue and closes now. For error paths, where the queued bytes are meaningless. */
  destroy(): void {
    this.#destroyed = true;
    this.#queue = [];
    try {
      this.#socket?.end();
    } catch {
      // Already gone. Closing a closed socket is the outcome we wanted either way.
    }
    this.#socket = null;
  }

  #flush(): void {
    const socket = this.#socket;
    if (socket === null) return;

    while (this.#queue.length > 0) {
      const head = this.#queue[0];
      if (head === undefined) break;
      let written: number;
      try {
        written = socket.write(head);
      } catch {
        // The peer went away mid-flush. Everything still queued is undeliverable.
        this.destroy();
        return;
      }
      if (written <= 0) return;
      if (written < head.length) {
        // Short write: keep the remainder at the head of the queue for the next `drain`.
        this.#queue[0] = head.subarray(written);
        return;
      }
      this.#queue.shift();
    }

    if (this.#ending) {
      this.#socket = null;
      try {
        socket.end();
      } catch {
        // See above.
      }
    }
  }
}

/** A tiny HTTP/1.1 response, for the answers the proxy itself has to give. */
export function httpResponse(
  status: number,
  reason: string,
  body: string,
  contentType = "text/plain; charset=utf-8",
  extraHeaders: readonly (readonly [string, string])[] = [],
): Uint8Array {
  const payload = new TextEncoder().encode(body);
  const lines = [
    `HTTP/1.1 ${String(status)} ${reason}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${String(payload.length)}`,
    // Every response the proxy generates itself terminates the connection. It is the honest
    // framing: these are all error or informational pages, and none of them is worth the risk of
    // desynchronising a pipelined stream to keep alive.
    "Connection: close",
    ...extraHeaders.map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  const head = new TextEncoder().encode(lines.join("\r\n"));
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}
