import { buildCanonicalTextIndex, positionFromRange, rangeFromPosition } from './text-index';
import { rangeFromDomSelector } from './selectors';
import { NORMALISATION_VERSION, normaliseText } from './text-normalisation';
import type { AnchorResolution, ArticleAnchor, TextPositionSelector } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accept untrusted persisted selectors. Exact text alone is insufficient when saved
 * context disagrees. Optional DOM paths must never break a quote-search tie.
 */
export function resolveAnchor(
  root: HTMLElement, input: unknown, currentArticleVersion = root.dataset.articleVersion,
): AnchorResolution {
  if (!isRecord(input)) return { state: 'orphaned', reason: 'invalid-anchor' };
  if (input.normalisationVersion !== NORMALISATION_VERSION) {
    return { state: 'orphaned', reason: 'unsupported-normalisation' };
  }
  const { quote, position } = input;
  if (!isRecord(quote) || !isRecord(position) ||
      typeof quote.exact !== 'string' || !quote.exact || normaliseText(quote.exact) !== quote.exact ||
      typeof quote.prefix !== 'string' || typeof quote.suffix !== 'string' ||
      typeof input.articleVersion !== 'string' || !input.articleVersion ||
      typeof position.start !== 'number' || typeof position.end !== 'number' ||
      !Number.isSafeInteger(position.start) || !Number.isSafeInteger(position.end) ||
      position.start < 0 || position.end <= position.start ||
      position.end - position.start !== Array.from(quote.exact).length) {
    return { state: 'orphaned', reason: 'invalid-anchor' };
  }
  const anchor = input as unknown as ArticleAnchor;
  const index = buildCanonicalTextIndex(root);
  const offsets = [0];
  const codePointAtOffset = new Map<number, number>();
  for (let i = 0; i < index.codePoints.length; i++) {
    const offset = offsets[i]!;
    codePointAtOffset.set(offset, i);
    offsets.push(offset + index.codePoints[i]!.length);
  }
  codePointAtOffset.set(offsets[index.codePoints.length]!, index.codePoints.length);

  const matches = (candidate: TextPositionSelector) => {
    const start = offsets[candidate.start];
    const end = offsets[candidate.end];
    return start !== undefined && end !== undefined && index.text.slice(start, end) === quote.exact;
  };
  const contextMatches = (candidate: TextPositionSelector) => {
    const start = offsets[candidate.start];
    const end = offsets[candidate.end];
    // Work in UTF-16 here solely for string comparisons, not persisted positions.
    // No per-occurrence Array.from/slicing of potentially large untrusted contexts.
    return start !== undefined && end !== undefined && start >= anchor.quote.prefix.length &&
      codePointAtOffset.has(start - anchor.quote.prefix.length) &&
      codePointAtOffset.has(end + anchor.quote.suffix.length) &&
      index.text.startsWith(anchor.quote.prefix, start - anchor.quote.prefix.length) &&
      index.text.startsWith(anchor.quote.suffix, end);
  };
  const samePosition = (a: TextPositionSelector, b: TextPositionSelector) => a.start === b.start && a.end === b.end;
  const result = (candidate: TextPositionSelector, method: 'position' | 'structural' | 'quote'): AnchorResolution => ({
    state: 'resolved', position: candidate, range: rangeFromPosition(index, candidate), method,
  });
  let structuralCandidate: TextPositionSelector | undefined;
  if (currentArticleVersion === anchor.articleVersion) {
    if (anchor.structural) {
      try {
        const candidate = positionFromRange(index, rangeFromDomSelector(root, anchor.structural));
        if (matches(candidate) && contextMatches(candidate)) structuralCandidate = candidate;
      } catch { /* Invalid/stale optional structure must not abort quote recovery. */ }
    }
    if (matches(anchor.position) && contextMatches(anchor.position)) {
      if (structuralCandidate && !samePosition(structuralCandidate, anchor.position)) {
        return { state: 'orphaned', reason: 'ambiguous' };
      }
      return result(anchor.position, 'position');
    }
  }

  // Search all occurrences, including overlaps; proximity is not identity.
  // Even a valid structural candidate cannot bypass this uniqueness check.
  let from = 0;
  let foundExact = false;
  let accepted: TextPositionSelector | undefined;
  while (from <= index.text.length) {
    const occurrence = index.text.indexOf(anchor.quote.exact, from);
    if (occurrence === -1) break;
    from = occurrence + 1;
    const start = codePointAtOffset.get(occurrence);
    const end = codePointAtOffset.get(occurrence + anchor.quote.exact.length);
    if (start === undefined || end === undefined) continue;
    foundExact = true;
    const candidate = { start, end };
    if (!contextMatches(candidate)) continue;
    if (accepted) return { state: 'orphaned', reason: 'ambiguous' };
    accepted = candidate;
  }
  if (accepted) {
    return result(accepted, structuralCandidate && samePosition(accepted, structuralCandidate) ? 'structural' : 'quote');
  }
  return { state: 'orphaned', reason: foundExact ? 'context-mismatch' : 'not-found' };
}
