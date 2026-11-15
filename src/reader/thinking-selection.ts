import { blockSpans } from '../core/markdown';
import type { Token } from 'marked';
import { sourceProjection as thinkingSourceProjection } from '../core/thinking';
export { thinkingSourceProjection };
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
/** Only unique quote AND adjacent visible evidence may authorize original source columns. */
export function thinkingSelectionOffsets(
  body: string,
  selection: { quote: string; before: string; after: string },
): { from: number; to: number } {
  const projection = thinkingSourceProjection(body),
    quote = normalize(selection.quote);
  if (!quote || quote.length > 12000) throw new Error('Select a short passage of article text.');
  const before = normalize(selection.before),
    after = normalize(selection.after);
  const matches: { from: number; to: number }[] = [];
  for (
    let at = projection.text.indexOf(quote);
    at >= 0;
    at = projection.text.indexOf(quote, at + 1)
  ) {
    const end = at + quote.length;
    if (before && !normalize(projection.text.slice(0, at)).endsWith(before)) continue;
    if (after && !normalize(projection.text.slice(end)).startsWith(after)) continue;
    // Include complete inline delimiters, never expand across another prose block.
    let from = Math.min(projection.starts[at], ...(projection.openings.get(at) ?? []));
    let to = Math.max(projection.ends[end - 1], ...(projection.closings.get(end) ?? []));
    for (const block of blockSpans(body).inlineBlocks) {
      const includeCode = (tokens: Token[], text: string, base: number) => {
        let cursor = 0;
        for (const token of tokens) {
          const offset = text.indexOf(token.raw, cursor);
          cursor = offset + token.raw.length;
          if (offset < 0) continue;
          if (token.type === 'codespan') {
            const start = block.offset(base + offset),
              finish = block.offset(base + cursor - 1) + 1;
            if (from < finish && to > start) {
              // Nested and top-level projection offsets may include different
              // inline delimiters. Compare logical visible columns, not guessed
              // delimiter widths, before including the complete parsed code span.
              const columns = projection.starts.flatMap((offset, index) =>
                offset >= start && projection.ends[index] <= finish ? [index] : [],
              );
              if (!columns.length || at > columns[0] || end <= columns.at(-1)!)
                throw new Error('Select the complete inline code span.');
              from = Math.min(from, start);
              to = Math.max(to, finish);
            }
          } else if (
            'tokens' in token &&
            Array.isArray(token.tokens) &&
            'text' in token &&
            typeof token.text === 'string'
          ) {
            const inner = token.raw.indexOf(token.text);
            if (inner >= 0) includeCode(token.tokens, token.text, base + offset + inner);
          }
        }
      };
      includeCode(block.tokens, block.text, 0);
    }
    matches.push({ from, to });
  }
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? 'This selection is ambiguous. Select more surrounding words.'
        : 'This selection cannot be mapped to current source text.',
    );
  return matches[0];
}
export function thinkingContextMarker(body: string, from: number, to: number): string | undefined {
  const projection = thinkingSourceProjection(body);
  const start = projection.starts.findIndex((offset) => offset >= from);
  if (start < 0) return;
  let end = start;
  while (end < projection.ends.length && projection.ends[end] <= to) end++;
  // ReadingSurface requires exact, unique visible evidence; its own resolver checks
  // again. For a gap use adjacent following text, never numeric persisted offsets.
  const text = projection.text
    .slice(start, Math.max(end, start + 100))
    .slice(0, 240)
    .trim();
  return text || undefined;
}
