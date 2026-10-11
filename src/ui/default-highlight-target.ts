import { linkTarget } from '../storage/links';

/**
 * Decide whether primary Link can use the selection verbatim as a note name.
 * No resolution, creation, normalization or external-link conversion happens here.
 * On fallback, the caller must pass the ORIGINAL quote to the native chooser.
 */
export function defaultHighlightTarget(quote: string): { target: string } | { needsChooser: true; reason: string } {
  const chooser = (reason: string): { needsChooser: true; reason: string } => ({ needsChooser: true, reason });
  if (!quote.trim()) return chooser('The selection is empty. Choose an existing note.');
  if (/[\r\n\u0085\u2028\u2029]/u.test(quote)) {
    return chooser('The selection spans multiple lines. Choose an existing note without changing the quote.');
  }
  if (quote !== quote.trim()) {
    return chooser('The selection has surrounding whitespace. Choose an existing note without trimming the quote.');
  }
  if (/^https?:\/\//i.test(quote)) {
    return chooser('The selection is a URL, not a note name. Choose a note or explicitly confirm an HTTP(S) link.');
  }
  // A portable filename component allows 255 UTF-8 bytes, including ".md".
  // Never shorten a long selection to a different, plausible-looking target.
  if (quote.length > 252 || new TextEncoder().encode(quote).length > 252) {
    return chooser('The selection is too long for a note name. Choose an existing note without shortening the quote.');
  }
  // Paths, headings and block references are not literal note names. Keep them
  // available through the explicit chooser, rather than silently interpreting prose.
  if (/[\\/:*?"<>|#^\[\]\x60\x00-\x1f\x7f]/u.test(quote) || /[. ]$/u.test(quote)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(quote)) {
    return chooser('The selection contains characters or a name that cannot safely be used as a note name. Choose an existing note.');
  }
  // Reject unpaired surrogates rather than permitting replacement characters in
  // the eventual filename. Valid Unicode (including emoji) remains unchanged.
  for (const character of quote) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return chooser('The selection contains invalid Unicode. Choose an existing note.');
  }
  try {
    if (linkTarget(quote) !== quote) return chooser('The selection requires target rewriting. Choose an existing note instead.');
  } catch {
    return chooser('The selection is not a safe note target. Choose an existing note without changing the quote.');
  }
  return { target: quote };
}
