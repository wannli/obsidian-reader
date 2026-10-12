import { Parser, type Token } from 'marked';
import { buildCanonicalTextIndex } from '../highlights/text-index';
import { normaliseText } from '../highlights/text-normalisation';
import type { CompactAnchor } from '../types';
import { inlineRevision } from './revision';
import { decodeMarkdownDestination, inlineMarked, safeTarget, sanitize } from './syntax';
import type { InlineParseOptions, ParsedInlineMarkdown, SourceRange } from './types';

interface Span extends SourceRange { block: number }
interface Scope extends SourceRange {
  element: HTMLElement; kind: 'format' | 'highlight' | 'wiki' | 'markdown';
  inner: SourceRange; target?: string; editable: boolean; startIndex: number; endIndex: number;
}
export interface MappedDocument {
  parsed: ParsedInlineMarkdown;
  units: (Span | undefined)[];
  scopes: Scope[];
  forbidden: SourceRange[];
}

/** All offsets originate in lexer tokens, never in a quote search or source HTML attributes. */
export function parseMapped(markdown: string, options: InlineParseOptions = {}): MappedDocument {
  const revision = inlineRevision(markdown, options);
  // Detached elements owned by the live document can still fetch images when HTML
  // is materialized. Keep every parser node in a document with no browsing context,
  // including temporary fallback containers; retain resource attributes for display.
  const inertDocument = document.implementation.createHTMLDocument('');
  const root = inertDocument.createElement('article');
  root.dataset.articleVersion = revision;
  // marked normalizes newlines; keep an exact inverse boundary table for CRLF and lone CR.
  let source = ''; const original = [0];
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === '\r') { if (markdown[i + 1] === '\n') i++; source += '\n'; }
    else source += markdown[i];
    original.push(i + 1);
  }
  const range = (start: number, end: number): SourceRange => ({ start: original[start], end: original[end] });
  const textMaps = new WeakMap<Text, Span[]>();
  const scopes: Scope[] = [], forbidden: SourceRange[] = [];
  let hasUnsupportedHighlights = false;
  const noteUnsupported = (token: Token) => {
    inlineMarked.walkTokens([token], child => {
      if (child.type === 'reader_highlight') hasUnsupportedHighlights = true;
    });
  };
  let block = 0;
  const decode = (value: string): string => {
    const element = inertDocument.createElement('textarea'); element.innerHTML = value; return element.value;
  };
  function appendText(parent: HTMLElement, raw: string, start: number, mode: 'markdown' | 'escape' | 'literal' = 'markdown'): void {
    let value = ''; const spans: Span[] = [];
    let i = 0;
    while (i < raw.length) {
      const entity = mode === 'markdown' && raw[i] === '&' ? /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]+);/.exec(raw.slice(i))?.[0] : undefined;
      const part = mode === 'escape' ? raw : entity ?? String.fromCodePoint(raw.codePointAt(i)!);
      const decoded = mode === 'escape' ? raw.slice(1) : entity ? decode(entity) : part;
      const span = { ...range(start + i, start + i + part.length), block };
      value += decoded;
      for (let j = 0; j < decoded.length; j++) spans.push(span);
      i += part.length;
    }
    const text = inertDocument.createTextNode(value); parent.append(text); textMaps.set(text, spans);
  }
  function addScope(element: HTMLElement, token: Token, start: number, innerStart: number, innerEnd: number,
    kind: Scope['kind'], target?: string, editable = true): void {
    scopes.push({ element, ...range(start, start + token.raw.length), inner: range(innerStart, innerEnd),
      kind, target, editable, startIndex: -1, endIndex: -1 });
  }
  function fallback(parent: HTMLElement, token: Token, start: number, inline = false): void {
    const container = inertDocument.createElement('span');
    // Use the existing tokens: re-lexing raw inline syntax loses resolved image definitions.
    container.innerHTML = sanitize(inline ? Parser.parseInline([token], inlineMarked.defaults) : inlineMarked.parser([token])); parent.append(...container.childNodes);
    forbidden.push(range(start, start + token.raw.length));
    noteUnsupported(token);
  }
  function renderInline(parent: HTMLElement, tokens: Token[], start: number, end: number): boolean {
    let cursor = start;
    for (const token of tokens) {
      if (source.slice(cursor, cursor + token.raw.length) !== token.raw) return false;
      const tokenStart = cursor; cursor += token.raw.length;
      switch (token.type) {
        case 'text':
          if (token.tokens) { if (!renderInline(parent, token.tokens, tokenStart, cursor)) return false; }
          else appendText(parent, token.raw, tokenStart);
          break;
        case 'escape': appendText(parent, token.raw, tokenStart, 'escape'); break;
        case 'strong': case 'em': case 'del': case 'reader_highlight': {
          const width = token.type === 'em' ? 1 : 2;
          const element = inertDocument.createElement(token.type === 'reader_highlight' ? 'mark' : token.type);
          parent.append(element);
          const contentOffset = token.type === 'reader_highlight' ? token.contentOffset ?? width : width;
          if (token.type === 'reader_highlight' && token.color) element.dataset.highlightColor = token.color;
          if (!renderInline(element, token.tokens!, tokenStart + contentOffset, cursor - width)) return false;
          addScope(element, token, tokenStart, tokenStart + contentOffset, cursor - width,
            token.type === 'reader_highlight' ? 'highlight' : 'format');
          break;
        }
        case 'reader_wiki': {
          const target = safeTarget(token.target);
          const element = inertDocument.createElement(target ? 'a' : 'span');
          if (target) { element.setAttribute('href', target); element.className = 'internal-link'; }
          parent.append(element);
          // Wiki aliases are literal labels, matching the passive extension renderer.
          // Do not invent Markdown formatting or entity semantics inside aliases.
          appendText(element, token.text, tokenStart + token.labelOffset, 'literal');
          addScope(element, token, tokenStart, tokenStart + token.labelOffset, cursor - 2, 'wiki', token.target, !!target);
          break;
        }
        case 'link': {
          const decodedTarget = decodeMarkdownDestination(token.href);
          const target = safeTarget(decodedTarget);
          const element = inertDocument.createElement(target ? 'a' : 'span'); parent.append(element);
          if (target) {
            element.setAttribute('href', target);
            if (token.title) element.setAttribute('title', token.title);
            if (!/^(https?|mailto):/i.test(target)) element.className = 'internal-link';
            else element.setAttribute('rel', 'noopener noreferrer');
          }
          // Only inline [label](destination) forms are editable; reference/autolinks remain readable.
          const innerStart = tokenStart + 1, innerEnd = innerStart + token.text.length;
          const ordinary = token.raw.startsWith('[') && source.slice(innerEnd, innerEnd + 2) === '](' && token.raw.endsWith(')');
          if (ordinary) {
            if (!renderInline(element, token.tokens!, innerStart, innerEnd)) return false;
          } else element.innerHTML = sanitize(Parser.parseInline(token.tokens!, inlineMarked.defaults));
          addScope(element, token, tokenStart, innerStart, innerEnd, 'markdown', decodedTarget, ordinary && !!target);
          break;
        }
        case 'br': parent.append(inertDocument.createElement('br')); forbidden.push(range(tokenStart, cursor)); break;
        case 'codespan': {
          const element = inertDocument.createElement('code'); element.textContent = token.text; parent.append(element);
          forbidden.push(range(tokenStart, cursor)); break;
        }
        default: fallback(parent, token, tokenStart, true);
      }
    }
    return cursor === end;
  }
  const frontmatter = /^(?:\uFEFF)?---\n(?:[\s\S]*?\n)?(?:---|\.\.\.)(?:\n|$)/.exec(source)?.[0] ?? '';
  let cursor = frontmatter.length;
  const tokens = inlineMarked.lexer(source.slice(cursor));
  // marked can omit duplicate definitions. Never align later tokens to an earlier lookalike.
  const sourceAligned = tokens.map(token => token.raw).join('') === source.slice(cursor);
  if (!sourceAligned) {
    root.innerHTML = sanitize(inlineMarked.parser(tokens));
    tokens.forEach(noteUnsupported);
  }
  let first = true;
  for (const token of sourceAligned ? tokens : []) {
    const start = cursor; cursor += token.raw.length; block++;
    if (token.type === 'space' || token.type === 'def') continue;
    if (source.slice(start, cursor) !== token.raw) {
      // No approximate recovery: render the remaining source without any writeable mapping.
      root.insertAdjacentHTML('beforeend', sanitize(inlineMarked.parse(source.slice(start), { async: false })));
      inlineMarked.lexer(source.slice(start)).forEach(noteUnsupported);
      break;
    }
    if (token.type !== 'paragraph' && token.type !== 'heading') { fallback(root, token, start); first = false; continue; }
    const element = inertDocument.createElement(token.type === 'heading' ? `h${token.depth}` : 'p');
    const rawText = token.text as string;
    let innerStart = start;
    if (token.type === 'heading') {
      const prefix = /^(?: {0,3}#{1,6}[ \t]+)/.exec(token.raw)?.[0];
      innerStart += prefix?.length ?? 0;
    }
    const oldScopes = scopes.length;
    // Raw HTML and math are deliberately not mapped, including text nested in HTML tags.
    let hasHTML = false;
    inlineMarked.walkTokens(token.tokens!, child => { if (child.type === 'html') hasHTML = true; });
    const unsafe = /(^|[^\\])\$/.test(rawText) || rawText.includes('\0') || hasHTML;
    if (unsafe || source.slice(innerStart, innerStart + rawText.length) !== rawText ||
      !renderInline(element, token.tokens!, innerStart, innerStart + rawText.length)) {
      scopes.splice(oldScopes); element.replaceChildren();
      element.innerHTML = sanitize(Parser.parseInline(token.tokens!, inlineMarked.defaults));
      forbidden.push(range(start, cursor));
      noteUnsupported(token);
    }
    const strip = first && token.type === 'heading' && token.depth === 1 && options.stripTitle !== undefined &&
      buildCanonicalTextIndex(element).text === normaliseText(options.stripTitle);
    first = false;
    if (strip) scopes.splice(oldScopes); else root.append(element);
  }
  // Validate every rendered destination, including links in fallback blocks and source HTML.
  for (const link of root.querySelectorAll('a[href]')) {
    if (!safeTarget(link.getAttribute('href')!)) link.removeAttribute('href');
  }
  const index = buildCanonicalTextIndex(root);
  const units = index.units.map(unit => {
    const start = textMaps.get(unit.start.node)?.[unit.start.offset];
    const end = textMaps.get(unit.end.node)?.[unit.end.offset - 1];
    return start && end && start.block === end.block ? { start: start.start, end: end.end, block: start.block } : undefined;
  });
  for (let i = 1; i < units.length - 1; i++) {
    if (index.codePoints[i] !== ' ') continue;
    const before = units[i - 1], after = units[i + 1];
    units[i] = before && after && before.block === after.block
      ? { start: before.end, end: after.start, block: before.block } : undefined;
  }
  const anchorFor = (start: number, end: number): CompactAnchor => ({ start, end,
    prefix: index.codePoints.slice(Math.max(0, start - 32), start).join(''),
    suffix: index.codePoints.slice(end, end + 32).join(''), version: revision });
  const parsed: ParsedInlineMarkdown = { revision, root, html: '', canonicalText: index.text, highlights: [], links: [],
    hasUnsupportedHighlights, warnings: [
      ...(!sourceAligned ? ['This document contains unsupported source transformations. Edit annotations in the Markdown editor.'] : []),
      ...(hasUnsupportedHighlights ? ['Some highlights use unsupported Markdown. They remain readable; edit them in the Markdown editor.'] : []),
    ] };
  const scopesByElement = new Map(scopes.map(scope => [scope.element, scope]));
  for (let i = 0; i < index.units.length; i++) {
    const unit = index.units[i];
    for (let element = unit.start.node.parentElement; element && element !== root; element = element.parentElement) {
      const scope = scopesByElement.get(element);
      if (scope && element.contains(unit.end.node)) {
        if (scope.startIndex < 0) scope.startIndex = i;
        scope.endIndex = i + 1;
      }
    }
  }
  for (const scope of scopes) {
    while (index.codePoints[scope.startIndex] === ' ') scope.startIndex++;
    while (scope.endIndex > scope.startIndex && index.codePoints[scope.endIndex - 1] === ' ') scope.endIndex--;
    if (scope.startIndex < 0 || scope.startIndex === scope.endIndex || scope.kind === 'format') continue;
    const id = `${revision}:${scope.kind}:${scope.start}:${scope.end}`;
    const quote = index.codePoints.slice(scope.startIndex, scope.endIndex).join('');
    const sourceRange = { start: scope.start, end: scope.end };
    const anchor = anchorFor(scope.startIndex, scope.endIndex);
    // Attributes are generated only here; arbitrary source attributes were stripped by DOMPurify.
    if (scope.kind === 'highlight') {
      scope.element.dataset.inlineHighlightId = id;
      parsed.highlights.push({ id, quote, link: scope.element.dataset.highlightColor ? scope.element.querySelector('a')?.getAttribute('href') ?? undefined : undefined, color: scope.element.dataset.highlightColor as import('../typed-highlights').HighlightColor | undefined, source: sourceRange, anchor });
    } else {
      scope.element.dataset.inlineLinkId = id;
      parsed.links.push({ id, quote, source: sourceRange, anchor, target: scope.target!, kind: scope.kind });
    }
  }
  parsed.html = root.innerHTML;
  return { parsed, units, scopes, forbidden };
}

export function parseInlineMarkdown(markdown: string, options?: InlineParseOptions): ParsedInlineMarkdown {
  return parseMapped(markdown, options).parsed;
}
