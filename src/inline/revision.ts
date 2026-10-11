import { fingerprint } from '../storage/fingerprint';
import type { InlineParseOptions } from './types';

/** Full-source revision using the existing portable, synchronous SHA-256 implementation. */
export function inlineRevision(source: string, options: InlineParseOptions = {}): string {
  // Well-formed JSON string encoding is lossless for UTF-16, including lone surrogates.
  // Hashing source directly as UTF-8 would collapse distinct malformed surrogates to U+FFFD.
  const revision = 'inline-v1-' + fingerprint(JSON.stringify(source));
  // A selection from a title-stripped view must not be applied to an unstripped index.
  return options.stripTitle === undefined ? revision : revision + '-view-' + inlineRevision(options.stripTitle).slice(10);
}
