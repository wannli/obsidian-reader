import { headings, linesOf } from './sections';

export interface QuoteBlock { quote: string; start: number; end: number; quoteEnd: number; }
export function quoteBlocks(body: string): Map<string, QuoteBlock> {
  const lines = linesOf(body), seen = new Set<string>(), blocks = new Map<string, QuoteBlock>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.code || /^ {0,3}>/.test(line.text)) continue;
    const anyId = /(?:^|\s)\^(hl-[a-zA-Z0-9-]+)[ \t]*$/.exec(line.text);
    if (!anyId) continue;
    const id = anyId[1];
    if (seen.has(id)) throw new Error('Duplicate highlight block ID: ' + id);
    seen.add(id);
    if (!/^ {0,3}\^hl-[a-zA-Z0-9-]+[ \t]*$/.test(line.text)) continue;
    let last = i - 1;
    while (last >= 0 && !lines[last].text.trim()) last--;
    let first = last;
    while (first >= 0 && !lines[first].code && /^ {0,3}>/.test(lines[first].text)) first--;
    if (first === last) continue;
    const quote = lines.slice(first + 1, last + 1).map(l => l.text.replace(/^ {0,3}> ?/, '')).join('\n');
    blocks.set(id, { quote, start: lines[first + 1].start, end: line.end, quoteEnd: lines[last].start + lines[last].text.length });
  }
  return blocks;
}

function withoutRanges(body: string, ranges: { start: number; end: number }[]): string {
  let result = '', offset = 0;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    result += body.slice(offset, Math.max(offset, range.start));
    offset = Math.max(offset, range.end);
  }
  return result + body.slice(offset);
}

/** Hide known blocks, reversing ordinary separator whitespace, not source text. */
export function snapshotBody(body: string, blocks: QuoteBlock[]): string {
  const all = headings(body);
  const ranges = blocks.map(block => {
    const preceding = all.filter(h => h.end <= block.start).at(-1);
    const separated = body.slice(block.start - 2, block.start) === '\n\n' ? block.start - 2 : block.start;
    const start = Math.max(separated, preceding?.end ?? 0);
    return { start, end: block.end + (body[block.end] === '\n' ? 1 : 0) };
  });
  for (let i = 0; i < all.length; i++) {
    const heading = all[i];
    if (heading.level !== 2 || heading.title !== 'Highlights') continue;
    const end = all.slice(i + 1).find(h => h.level <= 2)?.start ?? body.length;
    const inside = blocks.filter(block => block.start >= heading.end && block.end <= end);
    if (!inside.length) continue;
    const remaining = withoutRanges(body.slice(heading.end, end), inside.map(block => ({ start: block.start - heading.end, end: block.end - heading.end })));
    if (!remaining.trim()) ranges.push({ start: body.slice(heading.start - 2, heading.start) === '\n\n' ? heading.start - 2 : heading.start, end });
  }
  return withoutRanges(body, ranges);
}
