/**
 * Version 1 contract: logical DOM order, Unicode code-point offsets (not UTF-16),
 * no case folding or NFC/NFKC conversion; combining marks remain distinct points.
 * Decode entities through DOM parsing first. Unicode White_Space, block boundaries
 * and BR become one ASCII space, with leading/trailing spaces removed. Zero-width
 * characters are preserved. RTL is indexed logically, never in visual order.
 */
export const NORMALISATION_VERSION = 1 as const;
export function isWhitespace(value: string): boolean {
  return /^\p{White_Space}+$/u.test(value);
}
export function normaliseText(value: string): string {
  return value.replace(/\p{White_Space}+/gu, ' ').replace(/^ | $/gu, '');
}
