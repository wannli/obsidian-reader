import { Lexer, type Token } from 'marked';
import { decodeHTML } from 'entities';
import { blockSpans, readerMarkdown, type InlineBlock, type Span } from './markdown';

const syntax = readerMarkdown();

interface Projection {
  text: string;
  starts: number[];
  ends: number[];
  openings: Map<number, number[]>;
  closings: Map<number, number[]>;
  links: { from: number; to: number; target: string }[];
}
/** Project parser-proven prose, removing block syntax without losing source columns.
 * Keep inlineProjection separate: link labels and partial source slices are not documents.
 * Callers still enforce protected spans, paragraph boundaries and balanced formatting. */
export function blockProjection(
  source: string,
  blocks = blockSpans(source).inlineBlocks,
): Projection & {
  slice: (from: number, to: number) => string | undefined;
} {
  const result = {
    text: '',
    starts: [] as number[],
    ends: [] as number[],
    openings: new Map<number, number[]>(),
    closings: new Map<number, number[]>(),
    links: [] as Projection['links'],
    slice(from: number, to: number): string | undefined {
      for (const block of blocks) {
        if (!block.text || from < block.offset(0) || to > block.offset(block.text.length - 1) + 1)
          continue;
        let start = -1;
        for (let at = 0; at < block.text.length; at++) {
          if (start < 0 && block.offset(at) === from) start = at;
          if (start >= 0 && block.offset(at) + 1 === to) return block.text.slice(start, at + 1);
        }
      }
      return undefined;
    },
  };
  for (const block of blocks) {
    const local = inlineProjection(block.text, block.tokens);
    const first = local.text.search(/\S/u);
    if (first < 0) continue;
    const last = local.text.trimEnd().length;
    if (result.text) {
      result.text += ' ';
      result.starts.push(block.offset(local.starts[first]));
      result.ends.push(block.offset(local.starts[first]));
    }
    const base = result.text.length - first;
    result.text += local.text.slice(first, last);
    for (let at = first; at < last; at++) {
      result.starts.push(block.offset(local.starts[at]));
      result.ends.push(block.offset(local.ends[at] - 1) + 1);
    }
    for (const [at, offsets] of local.openings)
      result.openings.set(base + at, offsets.map(block.offset));
    for (const [at, offsets] of local.closings)
      result.closings.set(
        base + at,
        offsets.map((end) => block.offset(end - 1) + 1),
      );
    for (const link of local.links)
      result.links.push({
        ...link,
        from: block.offset(link.from),
        to: block.offset(link.to - 1) + 1,
      });
  }
  return result;
}

/** A transient source map for the one selected article, not a parallel annotation representation. */
export function inlineProjection(
  source: string,
  tokens: Token[] = Lexer.lexInline(source, syntax.defaults),
): Projection {
  const projection: Projection = {
    text: '',
    starts: [],
    ends: [],
    openings: new Map(),
    closings: new Map(),
    links: [],
  };
  const characters: string[] = [];
  let length = 0,
    space = false;
  function emit(value: string, start: number, end: number) {
    for (const char of value) {
      if (/\s/u.test(char)) {
        if (space) {
          projection.ends[projection.ends.length - 1] = end;
          continue;
        }
        characters.push(' ');
        length++;
        space = true;
        projection.starts.push(start);
        projection.ends.push(end);
      } else {
        characters.push(char);
        length += char.length;
        space = false;
        for (let i = 0; i < char.length; i++) {
          projection.starts.push(start);
          projection.ends.push(end);
        }
      }
    }
  }
  function literal(raw: string, base: number) {
    for (let i = 0; i < raw.length;) {
      const entity =
        raw[i] === '&'
          ? /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/.exec(raw.slice(i))?.[0]
          : undefined;
      if (entity) {
        emit(decodeHTML(entity), base + i, base + i + entity.length);
        i += entity.length;
      } else {
        const char = String.fromCodePoint(raw.codePointAt(i)!);
        emit(char, base + i, base + i + char.length);
        i += char.length;
      }
    }
  }
  function visit(tokens: Token[], raw: string, base: number) {
    let cursor = 0;
    for (const token of tokens) {
      const at = raw.indexOf(token.raw, cursor);
      if (at < 0) throw new Error('Markdown source could not be mapped safely.');
      cursor = at + token.raw.length;
      const start = base + at,
        end = start + token.raw.length;
      if (token.type === 'escape') {
        emit((token as { text: string }).text, start, end);
        continue;
      }
      if (token.type === 'readerWiki') {
        const wiki = token as Token & { target: string; label: string };
        emit(wiki.label, start, end);
        projection.links.push({ from: start, to: end, target: wiki.target });
        continue;
      }
      if (
        token.type === 'codespan' ||
        token.type === 'image' ||
        token.type === 'html' ||
        token.type === 'readerComment'
      ) {
        emit('\0', start, end);
        continue;
      }
      if (token.type === 'br') {
        emit(' ', start, end);
        continue;
      }
      const children = (token as Token & { tokens?: Token[] }).tokens;
      if (token.type === 'readerHighlight' && children) {
        visit(children, token.raw.slice(2, -2), start + 2);
        continue;
      }
      if (children && 'text' in token && typeof token.text === 'string') {
        const inner = token.raw.indexOf(token.text);
        if (inner < 0) {
          emit('\0', start, end);
          continue;
        }
        const visibleStart = length;
        visit(children, token.text, start + inner);
        const visibleEnd = length;
        if (['em', 'strong', 'del', 'link'].includes(token.type)) {
          const openings = projection.openings.get(visibleStart) ?? [];
          openings.push(start);
          projection.openings.set(visibleStart, openings);
          const closings = projection.closings.get(visibleEnd) ?? [];
          closings.push(end);
          projection.closings.set(visibleEnd, closings);
        }
        if (token.type === 'link')
          projection.links.push({
            from: start,
            to: end,
            target: (token as Token & { href: string }).href,
          });
      } else literal(token.raw, start);
    }
  }
  visit(tokens, source, 0);
  projection.text = characters.join('');
  return projection;
}

export interface SelectionPlan {
  /** Native mark spans before insertion. All offsets refer to the original body. */
  fragments: Span[];
  quoteMarkdown: string;
  /** A host citation must be outside an enclosing publisher link. */
  citationAt: number;
  /** A partial shortcut/collapsed reference needs its original explicit key. */
  insertions: { at: number; text: string; order?: number }[];
  /** Only angle-autolink delimiters need a token-local replacement for partial labels. */
  replacements: (Span & { text: string })[];
}

const publisherLink = (target: string): boolean => /^(?:https?:|mailto:|\/\/|#)/i.test(target);
const linkDestination = (target: string): string =>
  target.replace(/[\s<>"'`()[\]\\]/gu, (char) =>
    encodeURIComponent(char).replace(
      /[!'()*]/g,
      (part) => '%' + part.charCodeAt(0).toString(16).toUpperCase(),
    ),
  );

/** Slice parser-proven inline content, keeping source bytes intact. Partial container
 * boundaries become several native marks; quotations independently close their syntax.
 * No source token is reserialized and no publisher destination is replaced.
 * 'quote' is read-only: callers must first verify an existing saved passage;
 * it never yields editing fragments or makes vault labels new selection surfaces. */
export function selectionPlan(
  body: string,
  from: number,
  to: number,
  mode: 'highlight' | 'mention' | 'quote' = 'highlight',
  blocks = blockSpans(body).inlineBlocks,
): SelectionPlan {
  let block: InlineBlock | undefined;
  let localFrom = -1,
    localTo = -1;
  for (const candidate of blocks) {
    if (
      !candidate.text ||
      from < candidate.offset(0) ||
      to > candidate.offset(candidate.text.length - 1) + 1
    )
      continue;
    block = candidate;
    for (let at = 0; at < block.text.length; at++) {
      if (localFrom < 0 && block.offset(at) >= from) localFrom = at;
      if (block.offset(at) < to) localTo = at + 1;
    }
    break;
  }
  if (!block || localFrom < 0 || localTo <= localFrom)
    throw new Error('The selection does not belong to one editable text block.');
  const fragments: Span[] = [];
  const insertions: { at: number; text: string; order?: number }[] = [];
  const replacements: (Span & { text: string })[] = [];
  let citationAt = localTo;
  const push = (start: number, end: number) => {
    if (end <= start) return;
    const previous = fragments[fragments.length - 1];
    if (previous?.to === start) previous.to = end;
    else fragments.push({ from: start, to: end });
  };
  const format = (before: string, text: string, after: string): string => {
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
    return match[2] ? match[1] + before + match[2] + after + match[3] : text;
  };
  const visit = (tokens: Token[], source: string, base: number, collect = true): string => {
    let cursor = 0,
      quote = '';
    for (const token of tokens) {
      const index = source.indexOf(token.raw, cursor);
      if (index < 0) throw new Error('Markdown source could not be mapped safely.');
      cursor = index + token.raw.length;
      const start = base + index,
        end = start + token.raw.length;
      if (end <= localFrom || start >= localTo) continue;
      const selectedFrom = Math.max(start, localFrom),
        selectedTo = Math.min(end, localTo),
        complete = selectedFrom === start && selectedTo === end;
      const children = (token as Token & { tokens?: Token[] }).tokens;
      if (token.type === 'readerHighlight') {
        quote += visit(
          children ?? [],
          token.raw.slice(2, -2),
          start + 2,
          collect && mode === 'mention',
        );
        continue;
      }
      if (token.type === 'readerWiki') {
        // Existing native links are quoteable, but not new selection surfaces.
        const wiki = token as Token & { label: string };
        quote += wiki.label.replace(/[\\`*_[\]<>]/gu, '\\$&');
        if (collect) throw new Error('An existing vault link is not editable prose.');
        continue;
      }
      if (['code', 'codespan', 'image', 'html', 'readerComment', 'br'].includes(token.type))
        throw new Error('The selected content contains a protected inline boundary.');
      if (children && 'text' in token && typeof token.text === 'string') {
        const inner = token.raw.indexOf(token.text);
        if (inner < 0) throw new Error('The selected inline label cannot be mapped safely.');
        const contentStart = start + inner;
        const link = token.type === 'link';
        if (link && collect && !publisherLink((token as Token & { href: string }).href))
          throw new Error('An existing vault link is not editable prose.');
        if (link && localTo > contentStart && localTo < end) citationAt = Math.max(citationAt, end);
        const prefix = token.raw.slice(0, inner);
        const suffix = token.raw.slice(inner + token.text.length);
        if (link && collect && !complete && prefix === '<' && suffix === '>') {
          if (localFrom <= contentStart && localTo >= contentStart + token.text.length)
            throw new Error('A complete angle URL must include its original link syntax.');
          const href = (token as Token & { href: string }).href;
          replacements.push(
            { from: start, to: start + 1, text: '[' },
            { from: end - 1, to: end, text: `](${linkDestination(href)})` },
          );
        }
        if (link && collect && !complete && !prefix && !suffix) {
          // Bare GFM URLs would stop being links if delimiters interrupted them.
          // Add an explicit publisher label around their unchanged visible bytes.
          const href = (token as Token & { href: string }).href;
          insertions.push(
            { at: start, text: '[', order: 0 },
            { at: end, text: `](${linkDestination(href)})`, order: 2 },
          );
        }
        if (link && collect && !complete && (suffix === ']' || suffix === '][]')) {
          if (localFrom <= contentStart && localTo >= contentStart + token.text.length)
            throw new Error('A complete reference label must include its original link syntax.');
          // Reference lookup uses the original label. Native mark delimiters must
          // not change that lookup when only a few label words are selected.
          insertions.push(
            suffix === ']'
              ? { at: end, text: `[${token.text}]` }
              : { at: end - 1, text: token.text },
          );
        }
        const nested = visit(
          children,
          token.text,
          contentStart,
          collect && (!complete || mode === 'mention'),
        );
        if (link) {
          const value = token as Token & { href: string; title?: string | null };
          const title = value.title ? ` "${value.title.replace(/["\\]/g, '\\$&')}"` : '';
          quote +=
            mode === 'quote' &&
            !publisherLink(value.href) &&
            prefix === '[' &&
            suffix.startsWith('](')
              ? `[${nested}${suffix}`
              : `[${nested}](${linkDestination(value.href)}${title})`;
        } else if (['em', 'strong', 'del'].includes(token.type)) {
          quote += format(
            token.raw.slice(0, inner),
            nested,
            token.raw.slice(inner + token.text.length),
          );
        } else quote += nested;
        if (collect && complete && mode === 'highlight') push(start, end);
      } else {
        if (collect) push(selectedFrom, selectedTo);
        quote += token.raw.slice(selectedFrom - start, selectedTo - start);
      }
    }
    return quote;
  };
  const quoteMarkdown = visit(block.tokens, block.text, 0, mode !== 'quote');
  return {
    fragments: fragments
      .filter((span) => block!.text.slice(span.from, span.to).trim())
      .map((span) => ({
        from: block!.offset(span.from),
        to: block!.offset(span.to - 1) + 1,
      })),
    quoteMarkdown,
    citationAt: block.offset(citationAt - 1) + 1,
    insertions: insertions.map((item) => ({ ...item, at: block!.offset(item.at - 1) + 1 })),
    replacements: replacements.map((item) => ({
      ...item,
      from: block!.offset(item.from),
      to: block!.offset(item.to - 1) + 1,
    })),
  };
}

/** Visible source columns between two spans, excluding only parser-proven syntax.
 * Used to associate adjacent native mark fragments without a persisted highlight ID. */
export function visibleBetween(body: string, from: number, to: number): string {
  const projected = blockProjection(body);
  let text = '';
  for (let at = 0; at < projected.text.length; at++)
    if (projected.starts[at] >= from && projected.ends[at] <= to) text += projected.text[at];
  return text;
}
