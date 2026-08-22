/**
 * A DER encoder, just wide enough to build an X.509 certificate.
 *
 * This exists because the daemon has to mint its own TLS certificates (see `ca.ts`) and neither Bun
 * nor `node:crypto` can issue one — `X509Certificate` parses, it does not sign. The alternatives
 * were a pure-JS PKI dependency or shelling out to an `openssl` that is not present on a stock
 * Windows box, and neither is worth it for the ~200 lines below: X.509 is a fixed structure, we
 * emit exactly one shape of it, and nothing here ever has to *read* DER back.
 *
 * Everything is definite-length and canonical, which is what DER means and what every TLS stack
 * expects. There is deliberately no parser: a decoder would be the half of ASN.1 where the
 * interesting bugs live, and we have no reason to own one.
 */

/** ASN.1 universal tags, plus the two constructed-context tags a certificate needs. */
const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  printableString: 0x13,
  ia5String: 0x16,
  utcTime: 0x17,
  sequence: 0x30,
  set: 0x31,
} as const;

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * One tag-length-value triple.
 *
 * The long form is only used when it has to be — DER requires the *shortest* length encoding, and a
 * two-byte length for a 10-byte value is not merely wasteful, it is invalid, and OpenSSL will
 * reject the certificate rather than tolerate it.
 */
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length;
  if (n < 0x80) return concat([new Uint8Array([tag, n]), content]);

  const bytes: number[] = [];
  for (let value = n; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return concat([new Uint8Array([tag, 0x80 | bytes.length, ...bytes]), content]);
}

export const sequence = (...items: Uint8Array[]): Uint8Array => tlv(TAG.sequence, concat(items));
export const set = (...items: Uint8Array[]): Uint8Array => tlv(TAG.set, concat(items));
export const nullValue = (): Uint8Array => new Uint8Array([TAG.null, 0x00]);
export const boolean = (value: boolean): Uint8Array =>
  tlv(TAG.boolean, new Uint8Array([value ? 0xff : 0x00]));
export const octetString = (content: Uint8Array): Uint8Array => tlv(TAG.octetString, content);
export const utf8String = (text: string): Uint8Array =>
  tlv(TAG.utf8String, new TextEncoder().encode(text));
export const printableString = (text: string): Uint8Array =>
  tlv(TAG.printableString, new TextEncoder().encode(text));
export const ia5String = (text: string): Uint8Array =>
  tlv(TAG.ia5String, new TextEncoder().encode(text));

/** `[n]` constructed — an EXPLICIT context tag, which is how a certificate wraps version and extensions. */
export const explicit = (n: number, content: Uint8Array): Uint8Array => tlv(0xa0 | n, content);

/** `[n]` primitive — an IMPLICIT context tag, which is how `SubjectAltName` carries a `dNSName`. */
export const implicit = (n: number, content: Uint8Array): Uint8Array => tlv(0x80 | n, content);

/**
 * A non-negative INTEGER from a big-endian byte string.
 *
 * Two DER rules meet here and both bite in practice. Leading zero bytes are not allowed, so a
 * serial number that happens to start with a zero byte must be trimmed. But ASN.1 integers are
 * *signed*, so a value whose top bit is set needs a `0x00` pad or it decodes as negative — and a
 * negative serial number is a hard rejection in every certificate validator.
 */
export function integer(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) start += 1;
  const trimmed = bytes.subarray(start);
  const first = trimmed[0] ?? 0x00;
  return tlv(TAG.integer, first & 0x80 ? concat([new Uint8Array([0x00]), trimmed]) : trimmed);
}

/** A small non-negative INTEGER, for version numbers and path lengths. */
export function smallInteger(value: number): Uint8Array {
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return integer(new Uint8Array(bytes.length === 0 ? [0x00] : bytes));
}

/**
 * A BIT STRING.
 *
 * The leading byte counts the unused bits in the final octet. It is zero for anything byte-aligned
 * — signatures, public keys — and non-zero only for a genuine bit field such as `KeyUsage`.
 */
export function bitString(content: Uint8Array, unusedBits = 0): Uint8Array {
  return tlv(TAG.bitString, concat([new Uint8Array([unusedBits]), content]));
}

/**
 * An OBJECT IDENTIFIER from dotted-decimal form.
 *
 * The first two arcs share one byte as `40*a + b`; every arc after that is base-128 with the
 * continuation bit set on all but the last byte.
 */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map((part) => Number.parseInt(part, 10));
  const [first, second, ...rest] = arcs;
  if (first === undefined || second === undefined || arcs.some((arc) => !Number.isInteger(arc))) {
    throw new Error(`not an object identifier: ${dotted}`);
  }

  const bytes: number[] = [first * 40 + second];
  for (const arc of rest) {
    const chunks: number[] = [arc % 128];
    for (let rem = Math.floor(arc / 128); rem > 0; rem = Math.floor(rem / 128)) {
      chunks.unshift((rem % 128) | 0x80);
    }
    bytes.push(...chunks);
  }
  return tlv(TAG.oid, new Uint8Array(bytes));
}

/**
 * A `UTCTime`, which is what a certificate uses for any year before 2050.
 *
 * The two-digit year is not a bug to fix: RFC 5280 mandates `UTCTime` below 2050 and
 * `GeneralizedTime` at or above it, and mixing them up is a validation failure rather than a
 * cosmetic one. Nothing this daemon issues reaches 2050, so only this half exists.
 */
export function utcTime(when: Date): Uint8Array {
  const year = when.getUTCFullYear();
  if (year < 1950 || year >= 2050) throw new Error(`UTCTime cannot represent ${String(year)}`);

  const pad = (value: number): string => value.toString().padStart(2, "0");
  const text =
    pad(year % 100) +
    pad(when.getUTCMonth() + 1) +
    pad(when.getUTCDate()) +
    pad(when.getUTCHours()) +
    pad(when.getUTCMinutes()) +
    pad(when.getUTCSeconds()) +
    "Z";
  return tlv(TAG.utcTime, new TextEncoder().encode(text));
}
