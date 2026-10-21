/**
 * validate.mjs — clean and check the text a contributor types, before it is submitted.
 *
 * The database checks the same rules again (supabase/schema.sql), because anyone can
 * call the insert API directly and skip this file. Keep the two in step.
 */

export const MIN_LEN = 3;
export const MAX_LEN = 200;

// "name@domain.tld", allowing spaces people sometimes type around the @
const EMAIL = /[^\s@]+\s*@\s*[^\s@]+\.[a-z]{2,}/i;
// 10+ digits in a phone-like run: 2065551234, 206-555-1234, (206) 555 1234, +1 206 555 1234
const PHONE = /(\+?\d[\s.()-]*){10,}/;

/** Trim, drop control characters, collapse whitespace, cap the length. */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN);
}

export const looksLikeEmail = s => EMAIL.test(s);
export const looksLikePhone = s => PHONE.test(s);

/** Key for spotting duplicates: same words, ignoring case and punctuation. */
export const dedupeKey = s => cleanText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * @param {string} raw            what the contributor typed
 * @param {Set<string>} [seen]    dedupeKey()s already submitted in this session
 * @returns {{ok: true, text: string} | {ok: false, error: string}}
 */
export function checkQuery(raw, seen) {
  const text = cleanText(raw);
  if (text.length < MIN_LEN) return { ok: false, error: 'Type a few words first.' };
  if (looksLikeEmail(text)) return { ok: false, error: 'Please don\'t include an email address.' };
  if (looksLikePhone(text)) return { ok: false, error: 'Please don\'t include a phone number.' };
  if (!/[\p{L}]/u.test(text)) return { ok: false, error: 'Try describing it in words.' };
  if (seen && seen.has(dedupeKey(text))) return { ok: false, error: 'You already sent this one. Try different wording.' };
  return { ok: true, text };
}
