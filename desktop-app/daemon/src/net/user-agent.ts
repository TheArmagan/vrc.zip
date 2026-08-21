import { APP_NAME, APP_VERSION } from "@vrcz/shared";

/**
 * The User-Agent. **Mandatory** — VRChat answers a missing or generic UA with `403` and
 * `waf_code 13799`, on the pipeline WebSocket handshake too. See PLAN.md §1.4.
 *
 * Format: `vrc.zip/<version> (<contact>)`. The contact is collected during first-run setup and is
 * how VRChat reaches the human responsible for the traffic. That is the entire point of the header,
 * so a placeholder is worse than useless — it is dishonest attribution.
 */

export const USER_AGENT_HEADER = "User-Agent";

/**
 * Rejected outright. The community docs' sample UA is explicitly blocklisted upstream, and the rest
 * are the placeholders people reach for when they don't want to answer the question.
 */
const BANNED_CONTACT_PATTERNS: readonly RegExp[] = [
  /@example\.(com|org|net|invalid)$/i,
  /^(test|foo|bar|none|n\/a|na|null|undefined|email|your.?email)$/i,
  /@(test|localhost)$/i,
];

export type ContactValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validates a first-run contact string.
 *
 * Deliberately not an email-shaped regex: a Discord handle or a GitHub profile is a perfectly good
 * contact, and rejecting them would push users toward typing a fake address, which is the outcome
 * this check exists to prevent.
 */
export function validateContact(contact: string): ContactValidation {
  const trimmed = contact.trim();

  if (trimmed === "") return { ok: false, reason: "Contact is required." };
  if (trimmed.length < 5) return { ok: false, reason: "Contact is too short to reach you." };
  if (trimmed.length > 120)
    return { ok: false, reason: "Contact must be 120 characters or fewer." };

  // A newline would let a caller inject a second header; DEL and the C1 range are equally
  // unwanted in a header value. Checked by codepoint rather than by a regex character class,
  // which is the kind of thing that silently turns into a literal range when it passes through
  // a tool that eats escapes.
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return { ok: false, reason: "Contact must not contain control characters or line breaks." };
    }
  }
  if (trimmed.includes("(") || trimmed.includes(")")) {
    return { ok: false, reason: "Contact must not contain parentheses." };
  }
  for (const pattern of BANNED_CONTACT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: "Use a contact you actually read — VRChat may use it to reach you.",
      };
    }
  }
  return { ok: true };
}

/**
 * Builds the User-Agent. Throws on an invalid contact rather than silently substituting a
 * placeholder: shipping traffic under a fake contact is the exact behaviour that gets tools blocked.
 */
export function buildUserAgent(contact: string, version: string = APP_VERSION): string {
  const validation = validateContact(contact);
  if (!validation.ok) throw new Error(`invalid User-Agent contact: ${validation.reason}`);
  return `${APP_NAME}/${version} (${contact.trim()})`;
}
