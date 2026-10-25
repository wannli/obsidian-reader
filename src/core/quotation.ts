import { Lexer } from 'marked';
import { patchProperties, readDocument } from './document';
import { markdownSource, type Span } from './markdown';

/** A native paragraph link, not an excerpt identifier or an annotation record. */
export function originLink(path: string, blockId: string, title?: string): string {
  if (!path || /[\r\n#|\[\]]/u.test(path) || !/^[a-zA-Z0-9-]+$/u.test(blockId))
    throw new Error('This source cannot be represented safely as a paragraph wikilink.');
  const target = `${path.replace(/\.md$/iu, '')}#^${blockId}`;
  if (title === undefined) return `[[${target}]]`;
  const alias = title
    .replace(/[\r\n|\[\]]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
}

/** Birth provenance is only written by the caller for a newly created typed note. */
export function rememberOrigin(raw: string, origin: string): string {
  const doc = readDocument(raw);
  return Object.hasOwn(doc.properties, 'origin') ? raw : patchProperties(raw, { origin });
}

export interface QuotationAppend {
  raw: string;
  added: boolean;
}
export interface QuotationSourceInfo {
  path?: string;
  title?: string;
  collectedOn?: string;
}

function validCollectionDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(value + 'T12:00:00Z');
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}
/** Local collection day, not the UTC date of the instant. No daily note is created. */
export function localCollectionDate(date = new Date()): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw new Error('Invalid local collection date.');
  const day =
    String(date.getFullYear()).padStart(4, '0') +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0');
  if (!validCollectionDate(day)) throw new Error('Invalid local collection date.');
  return day;
}

function quotationText(quoteMarkdown: string, source: string, date?: string): string {
  if (!quoteMarkdown.trim()) throw new Error('There is no passage to collect.');
  if (!/^\[\[[^\r\n]+\]\]$/u.test(source)) throw new Error('Invalid quotation source.');
  return (
    quoteMarkdown.replace(/\r\n/gu, '\n').trimEnd() +
    ' (※ ' +
    source +
    (date ? ' [[' + date + ']]' : '') +
    ')'
  )
    .split('\n')
    .map((line) => (line ? '> ' + line : '>'))
    .join('\n');
}

function matchesQuotation(content: string, undated: string): boolean {
  if (content === undated) return true;
  const prefix = undated.slice(0, -1);
  if (!content.startsWith(prefix)) return false;
  const dated = /^ \[\[(\d{4}-\d{2}-\d{2})\]\]\)$/u.exec(content.slice(prefix.length));
  return !!dated && validCollectionDate(dated[1]);
}

function indexedDocument(raw: string) {
  const doc = readDocument(raw),
    offsets: number[] = [],
    characters: string[] = [];
  for (let at = 0; at < doc.body.length; at++) {
    offsets.push(at);
    const char = doc.body[at];
    characters.push(char === '\r' ? '\n' : char);
    if (char === '\r' && doc.body[at + 1] === '\n') at++;
  }
  offsets.push(doc.body.length);
  const normalized = characters.join('');
  // Native comments are not Markdown block syntax to Marked. Use Reader's code-aware
  // protection spans in ORIGINAL body coordinates, never an offset-changing rewrite.
  const comments = doc.body.includes('%%') ? markdownSource(doc.body).comments : [];
  const overlapsComment = (from: number, to: number) =>
    comments.some((comment) => from < comment.to && to > comment.from);
  const blocks: { from: number; to: number; content: string }[] = [];
  const headings: { start: number; end: number; depth: number; text: string }[] = [];
  const addBlock = (from: number, to: number, content: string) => {
    const originalFrom = offsets[from],
      originalTo = offsets[to];
    if (!overlapsComment(originalFrom, originalTo))
      blocks.push({ from: originalFrom, to: originalTo, content });
  };
  let cursor = 0;
  for (const token of Lexer.lex(normalized)) {
    const at = normalized.indexOf(token.raw, cursor);
    if (at < 0) throw new Error('Could not locate the destination section safely.');
    cursor = at + token.raw.length;
    if (token.type === 'blockquote') {
      const content = token.raw.replace(/\n+$/u, '');
      // Marked may merge consecutive blockquotes separated by unquoted blank lines.
      // Canonical multiline snapshots quote even empty lines ('>'), so these breaks
      // delimit snapshots without splitting an excerpt's own paragraph breaks.
      let start = 0;
      for (const separator of content.matchAll(/\n(?:[ \t]*\n)+/gu)) {
        addBlock(at + start, at + separator.index, content.slice(start, separator.index));
        start = separator.index + separator[0].length;
      }
      addBlock(at + start, at + content.length, content.slice(start));
    }
    if (token.type === 'heading' && !overlapsComment(offsets[at], offsets[cursor]))
      headings.push({
        start: offsets[at],
        end: offsets[cursor],
        depth: token.depth,
        text: token.text,
      });
  }
  return { doc, blocks, headings, comments };
}

function headingPath(heading: string): string | undefined {
  return /^\[\[([^\]|#\r\n]+)(?:\|[^\]\r\n]*)?\]\]$/u.exec(heading)?.[1].replace(/\.md$/iu, '');
}
function sourceGroup(source: string, info: QuotationSourceInfo): { path: string; heading: string } {
  const match = /^\[\[([^\]|#\r\n]+)#\^([a-zA-Z0-9-]+)(?:\|([^\]\r\n]*))?\]\]$/u.exec(source);
  if (!match) throw new Error('Invalid native paragraph quotation source.');
  const path = info.path ?? match[1];
  if (path.replace(/\.md$/iu, '') !== match[1].replace(/\.md$/iu, ''))
    throw new Error('The quotation source heading does not match its paragraph citation.');
  return {
    path: path.replace(/\.md$/iu, ''),
    heading: originLink(path, match[2], info.title ?? match[3]).replace('#^' + match[2], ''),
  };
}
function insertQuotation(
  raw: string,
  headerEnd: number,
  offset: number,
  addition: string,
  newline: string,
  comments: readonly Span[],
): string {
  for (const comment of comments) {
    if (offset > comment.from && offset < comment.to)
      throw new Error(
        'A quotation cannot be appended inside an Obsidian comment. Inspect the destination in Markdown.',
      );
    if (
      offset === comment.to &&
      headerEnd + offset === raw.length &&
      (comment.to < comment.from + 4 ||
        raw.slice(headerEnd + comment.to - 2, headerEnd + comment.to) !== '%%')
    )
      throw new Error(
        'The destination has an unclosed Obsidian comment. Close it in Markdown before collecting.',
      );
  }
  const before = raw.slice(0, headerEnd + offset),
    after = raw.slice(headerEnd + offset);
  const separator = before.endsWith(newline + newline)
    ? ''
    : before.endsWith(newline)
      ? newline
      : newline + newline;
  return (
    before +
    separator +
    addition.replace(/\n/gu, newline) +
    (after ? newline + newline : newline) +
    after
  );
}

/** Explicit, user-owned snapshots, grouped by native source path. An unchanged retry
 * preserves both legacy flat quotations and the original collection date. */
export function appendQuotation(
  raw: string,
  quoteMarkdown: string,
  source: string,
  info: QuotationSourceInfo = {},
): QuotationAppend {
  const { doc, blocks, headings, comments } = indexedDocument(raw);
  const undated = quotationText(quoteMarkdown, source);
  const date = info.collectedOn ?? localCollectionDate();
  if (!validCollectionDate(date)) throw new Error('Invalid local collection date.');
  const group = sourceGroup(source, info);
  const highlights = headings.filter(
    (heading) => heading.depth === 2 && heading.text === 'Highlights',
  );
  if (highlights.length > 1)
    throw new Error(
      'The destination has more than one Highlights section. Choose one in Markdown first.',
    );
  const section = highlights[0];
  const sectionEnd = section
    ? (headings.find((heading) => heading.start >= section.end && heading.depth <= 2)?.start ??
      doc.body.length)
    : doc.body.length;
  const groups = section
    ? headings.filter(
        (heading) =>
          heading.depth === 3 &&
          heading.start >= section.end &&
          heading.start < sectionEnd &&
          headingPath(heading.text) === group.path,
      )
    : [];
  if (groups.length > 1)
    throw new Error(
      'The destination has more than one matching source heading. Resolve it in Markdown first.',
    );
  if (blocks.some((block) => matchesQuotation(block.content.trim(), undated)))
    return { raw, added: false };
  const entry = quotationText(quoteMarkdown, source, date),
    newline = raw.includes('\r\n') ? '\r\n' : '\n';
  if (!section)
    return {
      raw: insertQuotation(
        raw,
        doc.headerEnd,
        doc.body.length,
        '## Highlights\n\n### ' + group.heading + '\n\n' + entry,
        newline,
        comments,
      ),
      added: true,
    };
  const existing = groups[0];
  // Keep new snapshots directly under their source heading, before authored subsections.
  const end =
    headings.find((heading) => heading.start >= (existing?.end ?? section.end))?.start ??
    doc.body.length;
  return {
    raw: insertQuotation(
      raw,
      doc.headerEnd,
      end,
      (existing ? '' : '### ' + group.heading + '\n\n') + entry,
      newline,
      comments,
    ),
    added: true,
  };
}

export class QuotationRemovalError extends Error {
  constructor(readonly reason: 'missing' | 'ambiguous') {
    super(
      reason === 'missing'
        ? 'The stored quotation is missing or was edited. Check the destination in Markdown before removing this highlight reference.'
        : 'More than one matching quotation exists. Resolve the duplicate quotations in Markdown before removing this highlight reference.',
    );
    this.name = 'QuotationRemovalError';
  }
}

/** Only explicit removal from this particular highlight may delete its exact unique
 * snapshot. Never remove a heading, origin, another quote, or trailing authored text. */
export function removeQuotation(
  raw: string,
  quoteMarkdown: string,
  source: string,
): { raw: string; removed: true } {
  const { doc, blocks } = indexedDocument(raw);
  const undated = quotationText(quoteMarkdown, source);
  const matches = blocks.filter((block) => matchesQuotation(block.content, undated));
  if (!matches.length) throw new QuotationRemovalError('missing');
  if (matches.length !== 1) throw new QuotationRemovalError('ambiguous');
  const { from, to } = matches[0];
  return {
    raw: raw.slice(0, doc.headerEnd) + doc.body.slice(0, from) + doc.body.slice(to),
    removed: true,
  };
}
