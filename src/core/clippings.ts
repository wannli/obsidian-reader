import { Lexer } from 'marked';
import { stringify } from 'yaml';
import { locateSelection, type Passage } from './annotations';
import { readDocument } from './document';
import { ensureAnchor, paragraphAnchors, type HighlightSelection } from './hosted-highlights';
import { inlineProjection, selectionPlan, blockProjection } from './projection';
import { filename } from './model';
import { markdownSource } from './markdown';

export interface ClippingBinding {
  property: string;
  type: string;
}
export interface Clipping {
  origin: string;
  quoteMarkdown: string;
  quote: string;
}
export interface LocatedClipping {
  from: number;
  to: number;
  quote: string;
  blockId: string;
}

/** A source address, never an instruction to rewrite/repair either note. */
export function clippingOrigin(value: unknown): { path: string; blockId: string } | undefined {
  if (typeof value !== 'string') return;
  const match = /^\[\[([^\[\]|#\r\n]+)#\^([a-zA-Z0-9-]+)(?:\|[^\]\r\n]*)?\]\]$/u.exec(value);
  return match ? { path: match[1], blockId: match[2] } : undefined;
}
export function clippingMember(
  properties: Record<string, unknown>,
  bindings: readonly ClippingBinding[],
): boolean {
  return bindings.some(
    ({ property, type }) =>
      properties[property] === type ||
      (Array.isArray(properties[property]) && (properties[property] as unknown[]).includes(type)),
  );
}
/** The first actual top-level blockquote; never mistake a fenced/comment literal for a card. */
export function readClipping(
  raw: string,
  bindings: readonly ClippingBinding[],
): Clipping | undefined {
  if (!/^(?:\uFEFF)?---\r?\n/u.test(raw)) return;
  const doc = readDocument(raw);
  if (!clippingMember(doc.properties, bindings) || !clippingOrigin(doc.properties.origin)) return;
  const comments = markdownSource(doc.body).comments;
  let cursor = 0,
    quoteMarkdown: string | undefined;
  for (const token of Lexer.lex(doc.body)) {
    const from = doc.body.indexOf(token.raw, cursor);
    if (from < 0) return;
    cursor = from + token.raw.length;
    if (
      token.type !== 'blockquote' ||
      comments.some((comment) => from < comment.to && cursor > comment.from)
    )
      continue;
    quoteMarkdown = token.text.trim();
    break;
  }
  if (!quoteMarkdown) return;
  const quote = blockProjection(quoteMarkdown).text.trim();
  if (!quote) return;
  return { origin: doc.properties.origin as string, quoteMarkdown, quote };
}
export function planClipping(body: string, selection: HighlightSelection) {
  const range = locateSelection(body, selection.quote, selection.before, selection.after);
  const quoteMarkdown = selectionPlan(body, range.from, range.to, 'quote').quoteMarkdown;
  if (!quoteMarkdown.trim()) throw new Error('Choose a passage with words to keep.');
  const anchored = ensureAnchor(body, range);
  return { ...anchored, quoteMarkdown, quote: inlineProjection(quoteMarkdown).text.trim() };
}
export function locateClipping(
  body: string,
  blockId: string,
  quote: string,
): LocatedClipping | undefined {
  const anchors = paragraphAnchors(body).filter((anchor) => anchor.blockId === blockId);
  if (anchors.length !== 1) return;
  const anchor = anchors[0];
  const scope = body.slice(anchor.from, anchor.anchor.from);
  try {
    const located = locateSelection(scope, quote);
    return { from: anchor.from + located.from, to: anchor.from + located.to, quote, blockId };
  } catch {
    return;
  } // Missing/repeated words are not a unique original selection.
}
export function clippingMarkdown(
  binding: ClippingBinding,
  origin: string,
  quoteMarkdown: string,
): string {
  if (!clippingOrigin(origin)) throw new Error('A clipping requires a precise native source link.');
  const properties = { [binding.property]: binding.type, origin };
  if (binding.property === 'origin')
    throw new Error('The Fileclass binding property cannot also be origin.');
  const quote = quoteMarkdown
    .replace(/\r\n/gu, '\n')
    .trim()
    .split('\n')
    .map((line) => (line ? '> ' + line : '>'))
    .join('\n');
  return `---\n${stringify(properties, { lineWidth: 0 }).trimEnd()}\n---\n\n${quote}\n`;
}
export function clippingTitle(quote: string): string {
  const words = quote.trim().split(/\s+/u).slice(0, 12).join(' ');
  const short = [...words].slice(0, 100).join('');
  return filename(short, new Date(2000, 0, 1))
    .replace(/^\d{6} /u, '')
    .replace(/\.md$/u, '');
}
export function sameClipping(
  a: Pick<Passage, 'from' | 'to'>,
  b: Pick<Passage, 'from' | 'to'>,
): boolean {
  return a.from === b.from && a.to === b.to;
}
