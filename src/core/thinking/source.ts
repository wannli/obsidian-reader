import type { Token } from 'marked';
import { blockSpans } from '../markdown';
import { blockProjection, selectionPlan } from '../projection';
import { assertSafeExternalText } from '../../content/security';
import type { ThinkingContext, ThinkingRecord } from './types';

function visibleTokens(tokens: Token[]): Token[] {
  return tokens.map((token) => {
    if (token.type === 'codespan')
      return {
        ...token,
        type: 'text',
        tokens: [{ type: 'text', raw: token.text, text: token.text }],
      } as Token;
    if ('tokens' in token && Array.isArray(token.tokens))
      return { ...token, tokens: visibleTokens(token.tokens) } as Token;
    return token;
  });
}
export function sourceProjection(body: string) {
  const blocks = blockSpans(body).inlineBlocks.map((block) => {
    const text = block.text.replace(/\s+\^[A-Za-z0-9-]+\s*$/, '');
    let remaining = text.length;
    const tokens = block.tokens.flatMap((token) => {
      if (remaining <= 0) return [];
      const length = Math.min(remaining, token.raw.length);
      remaining -= token.raw.length;
      return length === token.raw.length
        ? [token]
        : [
            {
              type: 'text',
              raw: token.raw.slice(0, length),
              text: token.raw.slice(0, length),
            } as Token,
          ];
    });
    return { ...block, text, tokens: visibleTokens(tokens) };
  });
  return blockProjection(body, blocks);
}
export function selectedSource(body: string, from: number, to: number) {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to <= from ||
    to > body.length
  )
    throw new Error('Select source words before keeping a passage.');
  const blocks = blockSpans(body).inlineBlocks;
  // Existing projection deliberately protects inline code for source mutation. Thinking
  // never mutates the source: allow only complete code tokens in a snapshot selection.
  function quoteTokens(
    tokens: Token[],
    text: string,
    base: number,
    map: (at: number) => number,
  ): Token[] {
    let cursor = 0;
    return tokens.map((token) => {
      const at = text.indexOf(token.raw, cursor);
      cursor = at + token.raw.length;
      if (token.type === 'codespan') {
        const start = map(base + at),
          end = map(base + at + token.raw.length - 1) + 1;
        if (from < end && to > start && (from > start || to < end))
          throw new Error('Select the complete inline code span.');
        return { ...token, type: 'text' } as Token;
      }
      if (
        'tokens' in token &&
        Array.isArray(token.tokens) &&
        'text' in token &&
        typeof token.text === 'string'
      ) {
        const inner = token.raw.indexOf(token.text);
        if (inner < 0) throw new Error('The nested selection cannot be mapped safely.');
        return {
          ...token,
          tokens: quoteTokens(token.tokens, token.text, base + at + inner, map),
        } as Token;
      }
      return token;
    });
  }
  const mapped = blocks.map((block) => ({
    ...block,
    tokens: quoteTokens(block.tokens, block.text, 0, block.offset),
  }));
  const quote = selectionPlan(body, from, to, 'quote', mapped).quoteMarkdown;
  if (!quote.trim()) throw new Error('Select visible source words.');
  assertSafeExternalText(quote);
  const projection = sourceProjection(body);
  let first = -1,
    last = -1;
  for (let at = 0; at < projection.text.length; at++)
    if (projection.starts[at] >= from && projection.ends[at] <= to) {
      if (first < 0) first = at;
      last = at + 1;
    }
  if (first < 0) throw new Error('This selection cannot be mapped to source text.');
  const before = Array.from(projection.text.slice(0, first).trimEnd()).slice(-160).join('');
  const after = Array.from(projection.text.slice(last).trimStart()).slice(0, 160).join('');
  assertSafeExternalText(before);
  assertSafeExternalText(after);
  return { body: quote, before, after };
}
export function sourceGap(body: string, gap: number) {
  if (
    !Number.isInteger(gap) ||
    !blockSpans(body).paragraphs.some(
      (span) => span.to === gap || (span.to >= gap && !body.slice(gap, span.to).trim()),
    )
  )
    throw new Error('Choose an explicit paragraph gap.');
  const projection = sourceProjection(body);
  const at = projection.starts.findIndex((start) => start >= gap);
  const split = at < 0 ? projection.text.length : at;
  const before = Array.from(projection.text.slice(0, split).trimEnd()).slice(-160).join('');
  const after = Array.from(projection.text.slice(split).trimStart()).slice(0, 160).join('');
  assertSafeExternalText(before);
  assertSafeExternalText(after);
  return { before, after };
}
export function lookupContext(
  record: Pick<ThinkingRecord, 'body' | 'kind' | 'source' | 'before' | 'after'>,
  body: string,
): ThinkingContext {
  const fallback = { snapshot: record.body, source: record.source };
  if (!record.source || record.before === undefined || record.after === undefined)
    return { ...fallback, status: 'unplaced' };
  const projection = sourceProjection(body);
  const quote =
    record.kind === 'passage'
      ? blockProjection(
          record.body,
          blockSpans(record.body).inlineBlocks.map((block) => ({
            ...block,
            tokens: visibleTokens(block.tokens),
          })),
        ).text
      : '';
  const candidates: { from: number; to: number }[] = [];
  if (record.kind === 'comment') {
    for (const paragraph of blockSpans(body).paragraphs) {
      const gap = paragraph.to;
      const evidence = sourceGap(body, gap);
      if (evidence.before === record.before && evidence.after === record.after)
        candidates.push({ from: gap, to: gap });
    }
  } else if (quote) {
    for (
      let at = projection.text.indexOf(quote);
      at >= 0;
      at = projection.text.indexOf(quote, at + 1)
    ) {
      const end = at + quote.length;
      if (
        projection.text.slice(0, at).trimEnd().endsWith(record.before) &&
        projection.text.slice(end).trimStart().startsWith(record.after) &&
        (record.before !== '' || at === 0) &&
        (record.after !== '' || end === projection.text.length)
      )
        candidates.push({ from: projection.starts[at], to: projection.ends[end - 1] });
    }
  }
  return candidates.length === 1
    ? { ...fallback, status: 'exact', ...candidates[0] }
    : {
        ...fallback,
        status: candidates.length
          ? 'ambiguous'
          : record.kind === 'comment'
            ? 'unplaced'
            : 'missing',
      };
}
/** Native links in source evidence remain untouched; this helper never assigns anchors. */
export function existingSourceAnchor(body: string, from: number, to: number): string | undefined {
  const paragraph = blockSpans(body).paragraphs.find((span) => span.from <= from && span.to >= to);
  if (!paragraph) return;
  const id = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(body.slice(paragraph.from, paragraph.to))?.[1];
  if (!id) return;
  const count = [...body.matchAll(/(?:^|\s)\^([A-Za-z0-9-]+)(?=\s|$)/gu)].filter(
    (match) => match[1] === id,
  ).length;
  return count === 1 ? id : undefined;
}
