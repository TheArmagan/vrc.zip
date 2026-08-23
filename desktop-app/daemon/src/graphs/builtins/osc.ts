/**
 * Just enough OSC to send one message, and a UDP socket to send it over.
 *
 * OSC is the lingua franca of the VR overlay world: VRChat itself listens on 9000, OVR Toolkit and
 * most overlay tools speak it, and XSOverlay takes its own JSON over UDP. A dependency for this
 * would be a dependency for **one packet format** — an address, a type tag string, and padded
 * arguments — which is smaller than the code that would configure the library.
 *
 * Everything here is local by construction: UDP to a host the user typed, with no retries, no
 * acknowledgement and no way to learn whether anything was listening. That is what UDP is, and it is
 * why an overlay action is best-effort by nature rather than by choice.
 */

import { createSocket } from "node:dgram";

/** An OSC argument. Deliberately three types: the overlay tools accept nothing more interesting. */
export type OscArgument = string | number | boolean;

/** Four-byte alignment, which OSC requires after every string and blob. */
function padTo4(length: number): number {
  return (4 - (length % 4)) % 4;
}

function encodeString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  // At least one trailing null, then padded to the next multiple of four.
  const total = bytes.length + 1 + padTo4(bytes.length + 1);
  const out = new Uint8Array(total);
  out.set(bytes);
  return out;
}

/**
 * One OSC message: `/address` plus a type tag string plus the arguments.
 *
 * Integers and floats are told apart the way every OSC sender does it — an integral number is `i`
 * and anything else is `f`. VRChat's own parameters are mostly floats and bools, so a value of `1`
 * meant as a float would arrive as an integer and be ignored; a caller that needs a float sends
 * `1.0`, which is not integral and encodes correctly.
 */
export function encodeOscMessage(address: string, args: readonly OscArgument[]): Uint8Array {
  const tags = [","];
  const payloads: Uint8Array[] = [];

  for (const arg of args) {
    if (typeof arg === "string") {
      tags.push("s");
      payloads.push(encodeString(arg));
      continue;
    }
    if (typeof arg === "boolean") {
      // `T` and `F` carry no payload at all: the type tag *is* the value.
      tags.push(arg ? "T" : "F");
      continue;
    }
    const buffer = new Uint8Array(4);
    const view = new DataView(buffer.buffer);
    if (Number.isInteger(arg)) {
      tags.push("i");
      view.setInt32(0, arg, false);
    } else {
      tags.push("f");
      view.setFloat32(0, arg, false);
    }
    payloads.push(buffer);
  }

  const head = encodeString(address.startsWith("/") ? address : `/${address}`);
  const tagBytes = encodeString(tags.join(""));
  const size = head.length + tagBytes.length + payloads.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  out.set(head, offset);
  offset += head.length;
  out.set(tagBytes, offset);
  offset += tagBytes.length;
  for (const payload of payloads) {
    out.set(payload, offset);
    offset += payload.length;
  }
  return out;
}

/**
 * Sends one datagram and closes the socket.
 *
 * A socket per send rather than one held open: these fire seconds or hours apart, a held socket is
 * a handle that keeps the process alive at shutdown, and the cost of opening one is a syscall.
 */
export function sendUdp(host: string, port: number, payload: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const finish = (error?: Error): void => {
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    socket.on("error", finish);
    socket.send(payload, port, host, (error) => {
      finish(error ?? undefined);
    });
  });
}
