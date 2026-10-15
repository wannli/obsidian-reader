import { Lexer, Marked, type Token } from 'marked';

/** One inline grammar for rendered Markdown and source protection. */
export function readerMarkdown(): Marked {
  return new Marked({
    gfm: true,
    breaks: false,
    extensions: [
      {
        name: 'readerComment',
        level: 'inline',
        start: (source) => source.indexOf('%%'),
        tokenizer(source) {
          const match = /^%%[\s\S]*?(?:%%|$)/.exec(source);
          if (match) return { type: 'readerComment', raw: match[0] };
        },
        renderer: () => '',
      },
      {
        name: 'readerWiki',
        level: 'inline',
        start: (source) => source.indexOf('[['),
        tokenizer(source) {
          const match = /^\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/.exec(source);
          if (match)
            return {
              type: 'readerWiki',
              raw: match[0],
              target: match[1],
              label: match[2] ?? match[1].replace(/\.md$/, '').split('/').pop()!,
            };
        },
      },
      {
        name: 'readerHighlight',
        level: 'inline',
        start: (source) => source.indexOf('=='),
        tokenizer(source) {
          const match = /^==([\s\S]+?)==/.exec(source);
          if (match && match[1].trim() && !/\n\s*\n|(?: {2,}|\\)\r?\n/.test(match[1]))
            return {
              type: 'readerHighlight',
              raw: match[0],
              tokens: this.lexer.inlineTokens(match[1]),
            };
        },
      },
    ],
  });
}
const syntax = readerMarkdown();

export type Span = { from: number; to: number };
type MappedBlock = { text: string; offset: (at: number) => number };
/** Parser-proven inline prose with exact original UTF-16 source columns. */
export interface InlineBlock {
  text: string;
  offset: (at: number) => number;
}

/** Follow Marked's actual block containers, mapping their stripped lines to original
 * Markdown offsets. Unknown transformations throw: retention must fail closed. */
export function blockSpans(body: string): {
  paragraphs: Span[];
  headings: Span[];
  protected: Span[];
  code: Span[];
  comments: Span[];
  inlineBlocks: InlineBlock[];
  links: Span[];
} {
  const result = {
    paragraphs: [] as Span[],
    headings: [] as Span[],
    protected: [] as Span[],
    code: [] as Span[],
    comments: [] as Span[],
    inlineBlocks: [] as InlineBlock[],
    links: [] as Span[],
  };
  const fail = (): never => {
    throw new Error(
      'Markdown block offsets could not be mapped safely. Open Markdown to inspect it.',
    );
  };
  const lines = (text: string) => [
    0,
    ...[...text.matchAll(/\n/g)].map((match) => match.index! + 1),
  ];
  const mapped = (
    text: string,
    origins: number[],
    parent: (at: number) => number,
    padding: number[] = [],
  ): MappedBlock => {
    const starts = lines(text);
    return {
      text,
      offset(at) {
        let low = 0,
          high = starts.length;
        while (low + 1 < high) {
          const middle = (low + high) >>> 1;
          if (starts[middle] <= at) low = middle;
          else high = middle;
        }
        return parent(origins[low] + Math.max(0, at - starts[low] - (padding[low] ?? 0)));
      },
    };
  };
  const slice = (source: MappedBlock, from: number, to: number): MappedBlock => ({
    text: source.text.slice(from, to),
    offset: (at) => source.offset(from + at),
  });
  const contents = (source: MappedBlock, text: string, kind: 'quote' | 'item'): MappedBlock => {
    const rawLines = source.text.split('\n'),
      childLines = text.split('\n'),
      starts = lines(source.text);
    const padding: number[] = [];
    const origins = childLines.map((line, i) => {
      const raw = rawLines[i];
      if (raw === undefined) return fail();
      const endOf = (value: string) =>
        raw.endsWith(value)
          ? raw.length
          : i === childLines.length - 1 && raw.trimEnd().endsWith(value)
            ? raw.trimEnd().length
            : -1;
      let end = endOf(line);
      if (end < 0) {
        // List continuation tabs can become leading spaces in Marked's text.
        // Those virtual spaces have no editable source columns; map the exact suffix.
        const suffix = line.replace(/^[ \t]*/, '');
        padding[i] = line.length - suffix.length;
        line = suffix;
        end = endOf(line);
        if (end < 0) return fail();
      }
      const prefix = raw.slice(0, end - line.length);
      const allowed =
        kind === 'quote'
          ? /^(?: {0,3}>[ \t]?)?$/
          : i === 0
            ? /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?$/
            : /^[ \t]*$/;
      if (!allowed.test(prefix)) return fail();
      return starts[i] + prefix.length;
    });
    return mapped(text, origins, source.offset, padding);
  };
  const unescape = (source: MappedBlock, following: string): MappedBlock => {
    const chars: string[] = [],
      columns: number[] = [];
    for (let i = 0; i < source.text.length; i++) {
      const next = source.text[i + 1];
      if (source.text[i] === '\\' && next && following.includes(next)) i++;
      chars.push(source.text[i]);
      columns.push(i);
    }
    return { text: chars.join(''), offset: (at) => source.offset(columns[at]) };
  };
  const needsMap = (tokens: Token[]): boolean =>
    tokens.some(
      (token) =>
        token.type === 'codespan' ||
        token.type === 'readerComment' ||
        token.type === 'link' ||
        token.type === 'image' ||
        ('tokens' in token && Array.isArray(token.tokens) && needsMap(token.tokens)),
    );
  const spanOf = (source: MappedBlock): Span => ({
    from: source.offset(0),
    to: source.offset(source.text.length - 1) + 1,
  });
  const inline = (tokens: Token[], source: MappedBlock) => {
    let cursor = 0;
    for (const token of tokens) {
      const at = source.text.indexOf(token.raw, cursor);
      if (at < 0) fail();
      cursor = at + token.raw.length;
      if (!token.raw.length) continue;
      const raw = slice(source, at, cursor);
      if (token.type === 'link' || token.type === 'image') result.links.push(spanOf(raw));
      if (token.type === 'codespan') result.code.push(spanOf(raw));
      else if (token.type === 'readerComment') result.comments.push(spanOf(raw));
      else if (token.type === 'readerHighlight')
        inline(token.tokens ?? fail(), slice(raw, 2, raw.text.length - 2));
      else if (['em', 'strong', 'del', 'link', 'text'].includes(token.type)) {
        const child = token as Token & { tokens?: Token[]; text: string };
        if (!child.tokens || !needsMap(child.tokens)) continue;
        // Marked unescapes label brackets before tokenizing link contents.
        const content = token.type === 'link' ? unescape(raw, '[]') : raw;
        const inner = content.text.indexOf(child.text);
        if (inner < 0) fail();
        inline(child.tokens, slice(content, inner, inner + child.text.length));
      }
    }
  };
  const visit = (tokens: Token[], source: MappedBlock) => {
    let cursor = 0;
    for (const token of tokens) {
      if (token.type === 'checkbox') continue; // Removed from Marked's item.text.
      const at = source.text.indexOf(token.raw, cursor);
      if (at < 0) fail();
      cursor = at + token.raw.length;
      if (!token.raw.length) continue;
      const raw = slice(source, at, cursor),
        span = spanOf(raw);
      if (token.type === 'paragraph' || token.type === 'text' || token.type === 'heading') {
        (token.type === 'heading' ? result.headings : result.paragraphs).push(span);
        inline(lexInline(raw.text), raw);
        // Containers have already been stripped by contents(), not by a regex.
        // Heading delimiters are block syntax too; retain only their inline text.
        const content = token.type === 'heading' ? token.text : raw.text;
        const inner = raw.text.indexOf(content);
        if (inner < 0) fail();
        const prose = slice(raw, inner, inner + content.length);
        result.inlineBlocks.push({
          text: prose.text,
          offset: prose.offset,
        });
      } else if (token.type === 'code' || token.type === 'html') {
        result.protected.push(span);
        if (token.type === 'code') result.code.push(span);
      } else if (token.type === 'table') {
        const starts = lines(raw.text);
        for (const [row, cells] of [token.header, ...token.rows].entries()) {
          const index = row ? row + 1 : 0;
          const line = slice(raw, starts[index], starts[index + 1] ?? raw.text.length);
          // Locate cells by unescaped separators, never by their possibly repeated text.
          const ranges: Span[] = [];
          let start = 0;
          for (let at = 0; at < line.text.length; at++) {
            if (line.text[at] !== '|') continue;
            let escapes = 0;
            for (let before = at - 1; before >= 0 && line.text[before] === '\\'; before--)
              escapes++;
            if (escapes % 2) continue;
            ranges.push({ from: start, to: at });
            start = at + 1;
          }
          ranges.push({ from: start, to: line.text.length });
          if (!line.text.slice(ranges[0].from, ranges[0].to).trim()) ranges.shift();
          const last = ranges[ranges.length - 1];
          if (last && !line.text.slice(last.from, last.to).trim()) ranges.pop();
          for (const [column, cell] of cells.entries()) {
            if (!cell.text) continue;
            const range = ranges[column];
            if (!range) fail();
            const rawCell = slice(line, range.from, range.to);
            // Marked unescapes pipes before inline tokenization; protect those tokens
            // with that mapping, but project the original escape pair for safe insertion.
            const mappedCell = unescape(rawCell, '|');
            const at = mappedCell.text.indexOf(cell.text);
            if (at < 0) fail();
            inline(cell.tokens, slice(mappedCell, at, at + cell.text.length));
            const leading = rawCell.text.length - rawCell.text.trimStart().length;
            const prose = slice(rawCell, leading, rawCell.text.trimEnd().length);
            result.inlineBlocks.push({ text: prose.text, offset: prose.offset });
          }
        }
      } else if (token.type === 'blockquote') {
        if (token.text) visit(token.tokens ?? fail(), contents(raw, token.text, 'quote'));
      } else if (token.type === 'list') {
        let itemCursor = 0;
        for (const item of token.items) {
          const start = raw.text.indexOf(item.raw, itemCursor);
          if (start < 0) fail();
          itemCursor = start + item.raw.length;
          if (item.text)
            visit(item.tokens, contents(slice(raw, start, itemCursor), item.text, 'item'));
        }
      }
    }
  };
  const source = body.replace(/\r\n?/g, '\n');
  const origins = [
    0,
    ...[...body.matchAll(/\r\n?|\n/g)].map((match) => match.index! + match[0].length),
  ];
  const parsed = Lexer.lex(source, syntax.defaults);
  const lexInline = (text: string): Token[] => {
    const lexer = new Lexer(syntax.defaults);
    // Resolve references against this document, while preserving raw indentation
    // that Marked's block text tokens may have normalized away.
    lexer.tokens.links = parsed.links;
    return lexer.inlineTokens(text);
  };
  visit(
    parsed,
    mapped(source, origins, (at) => at),
  );
  return result;
}

/** Hide comments only outside actual code tokens. Re-lex after each comment so a
 * backtick inside a cross-paragraph comment cannot bind to later visible prose.
 * Empty comment tokens retain line/block boundaries without introducing code indentation. */
export function markdownSource(
  body: string,
  parsed = blockSpans(body),
): { source: string; comments: Span[]; code: Span[] } {
  let source = body,
    blocks = parsed,
    cursor = 0,
    delta = 0;
  const edits: (Span & { start: number; end: number })[] = [];
  for (;;) {
    const from = blocks.comments.find((span) => span.from >= cursor)?.from;
    if (from === undefined) break;
    const close = source.indexOf('%%', from + 2),
      to = close < 0 ? source.length : close + 2;
    const replacement = '%%%%' + (source.slice(from, to).match(/\r\n?|\n/g) ?? []).join('');
    edits.push({ from: from + delta, to: to + delta, start: from, end: from + replacement.length });
    source = source.slice(0, from) + replacement + source.slice(to);
    delta += to - from - replacement.length;
    cursor = from + replacement.length;
    blocks = blockSpans(source);
  }
  const original = (at: number) => {
    let delta = 0;
    for (const edit of edits) {
      if (at < edit.start) break;
      if (at < edit.end) return edit.from;
      delta += edit.to - edit.from - (edit.end - edit.start);
    }
    return at + delta;
  };
  return {
    source,
    comments: edits.map(({ from, to }) => ({ from, to })),
    code: blocks.code.map(({ from, to }) => ({ from: original(from), to: original(to) })),
  };
}

export function visibleMarkdown(body: string): string {
  return body.includes('%%') ? markdownSource(body).source : body;
}

/** Conservative retention uses the exact renderer grammar, not edit eligibility. */
export function renderedHighlight(body: string): boolean {
  if (!body.includes('==')) return false;
  let found = false;
  syntax.walkTokens(Lexer.lex(visibleMarkdown(body), syntax.defaults), (token) => {
    if (token.type === 'readerHighlight') found = true;
  });
  return found;
}
