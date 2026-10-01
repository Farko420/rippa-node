import crypto from "node:crypto";

/**
 * NODE CODE FORMAT — the single source of truth for `RIPPA-XXXX-XXXX`.
 *
 * WHY THIS LIVES IN ITS OWN MODULE. Two very different places need to recognise
 * a node code: `configManager` (which validates whatever the operator typed into
 * the Remote / Cloud Link box) and `nodeAuth` (which mints codes and builds relay
 * URLs). `nodeAuth` already imports `configManager`, so letting the manager import
 * the normaliser back out of `nodeAuth` would create a require cycle. This module
 * depends on NOTHING, so both can import it safely.
 *
 * THE FORMAT. `RIPPA-` + 8 characters drawn from an alphabet with the visually
 * ambiguous glyphs removed (no `0`/`1`, no `I`/`O`), split 4-4 by a hyphen:
 *
 *     RIPPA-D2N6-6VZV
 *
 * It is deliberately NOT purely numeric. An earlier build treated a code as a
 * 6-digit number in every layer — a `maxlength="6"` input, a `.replace(/\D+/g,"")`
 * keystroke filter, a digits-only regex on the server — which silently mangled
 * `RIPPA-D2N6-6VZV` into `D266VZV` and made the documented "paste your Master's
 * node code" flow impossible. Letters are part of the identity; every layer that
 * touches a code must therefore accept them.
 */

/** Human-readable prefix shown on every Node screen and pairing dialog. */
export const NODE_CODE_PREFIX = "RIPPA";

/** Code body alphabet: digits 2-9 and letters minus the ambiguous I and O. */
const NODE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** One body character. */
const NODE_CODE_CHAR = `[${NODE_CODE_ALPHABET}]`;

/** The classic 6-digit Cloudflare tunnel relay code. */
const RELAY_CODE_RE = /^\d{6}$/;

/**
 * Cryptographically random uppercase code body (8 chars, no ambiguous glyphs).
 *
 * Rejection sampling rather than `byte % alphabet.length`: the alphabet is 32
 * characters, so the modulo happens to be unbiased here, but the rejection loop
 * is what keeps that true if the alphabet is ever edited to a size that does not
 * divide 256. Cheap, and it removes a class of silent bias bug.
 */
function randomCodeBody(): string {
  const out: string[] = [];
  while (out.length < 8) {
    for (const byte of crypto.randomBytes(8)) {
      if (out.length >= 8) break;
      // Bytes at or above the largest whole multiple of the alphabet size would
      // bias the low indices, so they are discarded rather than folded.
      if (byte >= 256 - (256 % NODE_CODE_ALPHABET.length)) continue;
      out.push(NODE_CODE_ALPHABET[byte % NODE_CODE_ALPHABET.length]);
    }
  }
  return `${out.slice(0, 4).join("")}-${out.slice(4, 8).join("")}`;
}

/** Mints a brand-new node code in the canonical `RIPPA-XXXX-XXXX` form. */
export function generateNodeCode(): string {
  return `${NODE_CODE_PREFIX}-${randomCodeBody()}`;
}

/**
 * Normalises user input into canonical code form (`RIPPA-XXXX-XXXX`).
 *
 * Tolerant on the way in — case, spacing, a missing or duplicated `RIPPA`
 * prefix, and the grouping hyphen are all repaired — and strict on the way out:
 * anything that cannot be a valid code returns "", so callers can treat an empty
 * string as "not a code" and fall back to URL/IP entry.
 */
export function normalizeNodeCode(value: unknown): string {
  const raw = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const body = raw.startsWith(NODE_CODE_PREFIX) ? raw.slice(NODE_CODE_PREFIX.length) : raw;
  const match = new RegExp(`^(${NODE_CODE_CHAR}{4})(${NODE_CODE_CHAR}{4})$`).exec(body);
  return match ? `${NODE_CODE_PREFIX}-${match[1]}-${match[2]}` : "";
}

/** True when `value` is (or normalises to) a well-formed node code. */
export function isValidNodeCode(value: unknown): boolean {
  return normalizeNodeCode(value).length > 0;
}

/**
 * Normalises a Remote / Cloud Link value.
 *
 * TWO ACCEPTED FORMS, and this is the fix for the input that "only accepts
 * numbers":
 *
 *   1. `123456`        — the original 6-digit Cloudflare tunnel relay code.
 *   2. `RIPPA-D2N6-6VZV` — a node code, which is the modern identifier.
 *
 * Historically only (1) was accepted, so an operator pasting a node code into
 * the Remote / Cloud Link box was told "must be exactly 6 digits" and the link
 * silently did nothing. Both are valid link targets, so both are preserved here
 * in canonical form; anything else returns "" (LAN-only linking) and the
 * validation layer turns that into a clear message rather than a silent drop.
 *
 * Like the digit-only rule it replaces, this does NOT truncate: quietly turning
 * a 7-digit value into a 6-digit one would point the satellite at the wrong
 * tunnel, so a near-miss is reported instead of "fixed".
 */
export function normalizeCloudLinkCode(value: unknown): string {
  const trimmed = String(value ?? "").trim().toUpperCase();
  if (!trimmed) return "";
  if (RELAY_CODE_RE.test(trimmed)) return trimmed;
  return normalizeNodeCode(trimmed);
}
