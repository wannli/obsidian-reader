import { Lexer, type Token } from 'marked';
import { decodeHTML } from 'entities';

interface Projection {
  text: string;
  starts: number[];
  ends: number[];
  openings: Map<number, number[]>;
  closings: Map<number, number[]>;
  links: { from: number; to: number; target: string }[];
}
/** A transient source map for the one selected article, not a parallel annotation representation. */
export function inlineProjection(source: string): Projection {
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
      if (token.type === 'codespan' || token.type === 'image' || token.type === 'html') {
        emit('\0', start, end);
        continue;
      }
      if (token.type === 'br') {
        emit(' ', start, end);
        continue;
      }
      const children = (token as Token & { tokens?: Token[] }).tokens;
      if (children && 'text' in token && typeof token.text === 'string') {
        const inner = token.raw.indexOf(token.text);
        if (inner < 0) {
          emit('\0', start, end);
          continue;
        }
        const visibleStart = length;
        visit(children, token.text, start + inner);
        const visibleEnd = length;
        if (['em', 'strong', 'del'].includes(token.type)) {
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
  visit(Lexer.lexInline(source), source, 0);
  projection.text = characters.join('');
  return projection;
}
