import { normaliseText } from '../highlights/text-normalisation';
import { buildCanonicalTextIndex } from '../highlights/text-index';
import { parseMapped, type MappedDocument } from './parser';
import { requireTarget } from './syntax';
import { typedNodeTarget, validateHighlightTypes, type TypedHighlightType } from '../typed-highlights';
import { InlineMarkdownError, type InlineParseOptions, type InlineSelection, type SourceRange } from './types';

const fail = (code: ConstructorParameters<typeof InlineMarkdownError>[0], message: string): never => { throw new InlineMarkdownError(code, message); };
const intersects = (a: SourceRange, b: SourceRange) => a.start < b.end && b.start < a.end;

function selectionRange(mapped: MappedDocument, selection: InlineSelection): SourceRange {
  const { parsed, units, scopes, forbidden } = mapped;
  const revision = selection.revision ?? selection.anchor?.version;
  if (revision !== parsed.revision || (selection.anchor?.version !== undefined && selection.anchor.version !== parsed.revision)) {
    fail('stale', 'The article changed or this selection has no revision. Select the text again.');
  }
  const points = Array.from(parsed.canonicalText), quote = normaliseText(selection.quote), quotePoints = Array.from(quote);
  if (!quote) fail('not-found', 'Select some readable text first.');
  let start: number, end: number;
  if (selection.anchor) {
    ({ start, end } = selection.anchor);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > points.length ||
        points.slice(start, end).join('') !== quote) fail('stale', 'The selection no longer matches the article. Select it again.');
    const { prefix, suffix } = selection.anchor;
    if (!points.slice(0, start).join('').endsWith(prefix) || !points.slice(end).join('').startsWith(suffix)) {
      fail('stale', 'The selection context no longer matches the article. Select it again.');
    }
  } else {
    const matches: number[] = [];
    for (let i = 0; i <= points.length - quotePoints.length; i++) {
      if (points.slice(i, i + quotePoints.length).join('') === quote) matches.push(i);
      if (matches.length > 1) break;
    }
    if (matches.length !== 1) fail(matches.length ? 'ambiguous' : 'not-found', 'This quote is missing or repeated. Select its exact occurrence again.');
    start = matches[0]; end = start + quotePoints.length;
  }
  const selected = units.slice(start!, end!);
  if (!selected.length || selected.some(unit => !unit || unit.block !== selected[0]?.block)) {
    fail('unsupported', 'Select text within one supported paragraph or heading, outside code, math and raw HTML.');
  }
  const range = { start: selected[0]!.start, end: selected.at(-1)!.end };
  // Never divide a decoded entity which produced multiple Unicode code points.
  if ((start! > 0 && units[start! - 1]?.end! > range.start) || (end! < units.length && units[end!]?.start! < range.end)) {
    fail('unsupported', 'This selection divides an entity. Select the whole displayed character sequence.');
  }
  for (const scope of scopes) {
    if (!intersects(range, scope)) continue;
    if (scope.kind !== 'format') fail('overlap', 'Selections cannot overlap an existing highlight or link.');
    const containsScope = start! <= scope.startIndex && end! >= scope.endIndex;
    const insideScope = start! >= scope.startIndex && end! <= scope.endIndex;
    if (containsScope) { range.start = Math.min(range.start, scope.start); range.end = Math.max(range.end, scope.end); }
    else if (!insideScope) fail('unsupported', 'Select all of the formatting span, or text entirely inside it.');
  }
  if (forbidden.some(span => intersects(range, span))) fail('unsupported', 'This selection crosses unsupported Markdown syntax.');
  return range;
}

function formattingSignature(root: HTMLElement): string {
  return buildCanonicalTextIndex(root).units.map(unit => {
    const tags: string[] = [];
    for (let element = unit.start.node.parentElement; element && element !== root; element = element.parentElement) {
      if (!['MARK', 'A', 'SPAN'].includes(element.tagName)) tags.push(element.tagName);
    }
    return tags.join('/');
  }).join('|');
}

function checkedEdit(markdown: string, mapped: MappedDocument, range: SourceRange, replacement: string,
  options: InlineParseOptions, expectedHighlights: number, expectedLinks: number): string {
  const next = markdown.slice(0, range.start) + replacement + markdown.slice(range.end);
  const result = parseMapped(next, options).parsed;
  if (result.canonicalText !== mapped.parsed.canonicalText || result.highlights.length !== expectedHighlights || result.links.length !== expectedLinks ||
      formattingSignature(result.root) !== formattingSignature(mapped.parsed.root)) {
    fail('unsupported', 'This Markdown boundary cannot be edited without changing its displayed text. Nothing was changed.');
  }
  return next;
}

function markdownDestination(target: string): string {
  // Keep ordinary links clean; bracket only destinations needing delimiter protection.
  // Markdown destinations decode character references. Escape even apparently
  // literal '&copy;' / '&#65;' so ordinary/native rendering retains the requested URL.
  const escaped = target.replace(/&/g, '&amp;');
  return /[\s()]/u.test(target) ? `<${escaped}>` : escaped;
}

function linkMarkup(rawLabel: string, target: string): string {
  requireTarget(target);
  if (!/^(https?|mailto):/i.test(target) && !/[\[\]|\\*_~`&<>\n\r]/.test(rawLabel) && !rawLabel.includes('==')) {
    return rawLabel === target ? `[[${target}]]` : `[[${target}|${rawLabel}]]`;
  }
  return `[${rawLabel}](${markdownDestination(target)})`;
}

function annotation(mapped: MappedDocument, id: string, highlight: boolean, allowContainedLinks = false) {
  if (!id.startsWith(mapped.parsed.revision + ':')) fail('stale', 'The article changed. Reopen this highlight or link.');
  const item = (highlight ? mapped.parsed.highlights : mapped.parsed.links).find(item => item.id === id);
  if (!item) fail('not-found', 'This highlight or link is no longer present.');
  const scope = mapped.scopes.find(scope => scope.start === item!.source.start && scope.end === item!.source.end &&
    (highlight ? scope.kind === 'highlight' : scope.kind === 'wiki' || scope.kind === 'markdown'))!;
  if (!scope.editable || mapped.forbidden.some(span => intersects(scope, span))) {
    fail('unsupported', 'This highlight or link contains unsupported Markdown. Edit it in the Markdown editor.');
  }
  if (mapped.scopes.some(other => other !== scope && other.kind !== 'format' && intersects(scope, other) &&
      !(allowContainedLinks && highlight && (other.kind === 'wiki' || other.kind === 'markdown') &&
        other.start >= scope.inner.start && other.end <= scope.inner.end))) {
    fail('overlap', 'Nested highlights and links must be edited in the Markdown editor.');
  }
  return scope;
}

export function addInlineHighlight(markdown: string, selection: InlineSelection, options: InlineParseOptions = {}): string {
  const mapped = parseMapped(markdown, options), range = selectionRange(mapped, selection);
  const raw = markdown.slice(range.start, range.end);
  if (/[\n\r]/.test(raw) || raw.includes('==') || markdown[range.start - 1] === '=' || markdown[range.end] === '=') {
    fail('unsupported', 'Highlight delimiters cannot safely surround this selection.');
  }
  return checkedEdit(markdown, mapped, range, `==${raw}==`, options, mapped.parsed.highlights.length + 1, mapped.parsed.links.length);
}

export function setInlineHighlightLink(markdown: string, id: string, target: string, options: InlineParseOptions = {}): string {
  const mapped = parseMapped(markdown, options), scope = annotation(mapped, id, true);
  return checkedEdit(markdown, mapped, scope, linkMarkup(markdown.slice(scope.inner.start, scope.inner.end), target),
    options, mapped.parsed.highlights.length - 1, mapped.parsed.links.length + 1);
}

export function setInlineHighlightType(markdown: string, id: string, type: TypedHighlightType, options: InlineParseOptions = {}): string {
  const item = parseMapped(markdown, options).parsed.highlights.find(item => item.id === id);
  if (!item) fail('stale', 'The article changed. Reopen this highlight.');
  return setInlineHighlightTypedLink(markdown, id, type, typedNodeTarget(item!.quote), options);
}

export function setInlineHighlightTypedLink(markdown: string, id: string, type: TypedHighlightType, target: string, options: InlineParseOptions = {}): string {
  validateHighlightTypes([type]);
  const mapped = parseMapped(markdown, options), scope = annotation(mapped, id, true, true);
  const item = mapped.parsed.highlights.find(item => item.id === id)!;
  const raw = markdown.slice(scope.inner.start, scope.inner.end);
  const linked = item.link === target && mapped.parsed.links.some(link => link.target === target && link.source.start >= scope.inner.start && link.source.end <= scope.inner.end);
  // Only a complete emphasis span is eligible: retain its exact Markdown delimiters
  // inside a Markdown link, rather than flattening italic text into a wiki alias.
  const italic = /^([*_])([^*_\r\n]+)\1$/.exec(raw);
  if (raw !== item.quote && !italic && !linked) fail('unsupported', 'Only plain words, fully italicized words or an existing typed node highlight can be typed. Edit this highlight in Markdown.');
  const body = linked ? raw : italic ? linkMarkup(raw, target) : `[[${target}|${item.quote}]]`;
  return checkedEdit(markdown, mapped, scope, `==${type.color}${body}==`, options,
    mapped.parsed.highlights.length, mapped.parsed.links.length + (linked ? 0 : 1));
}

export function removeInlineHighlight(markdown: string, id: string, options: InlineParseOptions = {}, removeLinked = false): string {
  const mapped = parseMapped(markdown, options), scope = annotation(mapped, id, true, true);
  const highlight = mapped.parsed.highlights.find(item => item.id === id)!;
  const links = mapped.scopes.filter(other => (other.kind === 'wiki' || other.kind === 'markdown') &&
    (removeLinked || !!highlight.color && highlight.link === other.target && !/^(?:https?|mailto):/i.test(other.target ?? '')) &&
    other.start >= scope.inner.start && other.end <= scope.inner.end).sort((a, b) => b.start - a.start);
  let raw = markdown.slice(scope.inner.start, scope.inner.end);
  for (const link of links) {
    const start = link.start - scope.inner.start, end = link.end - scope.inner.start;
    raw = raw.slice(0, start) + markdown.slice(link.inner.start, link.inner.end) + raw.slice(end);
  }
  return checkedEdit(markdown, mapped, scope, raw, options, mapped.parsed.highlights.length - 1, mapped.parsed.links.length - links.length);
}

/** Create an ordinary bare link directly from a version-checked selection. */
export function addInlineLink(markdown: string, selection: InlineSelection, target: string, options: InlineParseOptions = {}): string {
  const mapped = parseMapped(markdown, options), range = selectionRange(mapped, selection);
  return checkedEdit(markdown, mapped, range, linkMarkup(markdown.slice(range.start, range.end), target),
    options, mapped.parsed.highlights.length, mapped.parsed.links.length + 1);
}

export function setInlineLink(markdown: string, id: string, target: string, options: InlineParseOptions = {}): string {
  const mapped = parseMapped(markdown, options), scope = annotation(mapped, id, false);
  requireTarget(target);
  if (scope.kind === 'markdown') {
    // Change only the destination; authored whitespace and optional link title survive.
    let start = scope.inner.end + 2;
    while (/\s/.test(markdown[start] ?? '') && start < scope.end) start++;
    let end = start;
    if (markdown[start] === '<') {
      end = markdown.indexOf('>', start + 1) + 1;
      if (end <= start || end >= scope.end) fail('unsupported', 'This link destination cannot be safely mapped.');
    } else {
      let depth = 0;
      while (end < scope.end) {
        const char = markdown[end];
        if (char === '\\') { end += 2; continue; }
        if (/\s/.test(char) || (char === ')' && depth === 0)) break;
        if (char === '(') depth++;
        if (char === ')') depth--;
        end++;
      }
    }
    return checkedEdit(markdown, mapped, { start, end }, markdownDestination(target), options,
      mapped.parsed.highlights.length, mapped.parsed.links.length);
  }
  return checkedEdit(markdown, mapped, scope, linkMarkup(markdown.slice(scope.inner.start, scope.inner.end), target),
    options, mapped.parsed.highlights.length, mapped.parsed.links.length);
}

/** Removes only link syntax; no provenance and no restoration of an earlier highlight. */
export function removeInlineLink(markdown: string, id: string, options: InlineParseOptions = {}): string {
  const mapped = parseMapped(markdown, options), scope = annotation(mapped, id, false);
  return checkedEdit(markdown, mapped, scope, markdown.slice(scope.inner.start, scope.inner.end),
    options, mapped.parsed.highlights.length, mapped.parsed.links.length - 1);
}

/** Keep exact label bytes, formatting and revision guards when linking or unlinking. */
export function setInlineNodeLink(markdown: string, id: string, target: string | null, color = '', options: InlineParseOptions = {}): string {
  const mapped = parseMapped(markdown, options), scope = annotation(mapped, id, true, true);
  const links = mapped.scopes.filter(other => (other.kind === 'wiki' || other.kind === 'markdown') && other.start >= scope.inner.start && other.end <= scope.inner.end);
  if (links.length > 1 || links.some(link => link.start !== scope.inner.start || link.end !== scope.inner.end)) fail('unsupported', 'Highlight must contain only one complete link.');
  const link = links[0];
  const raw = link ? markdown.slice(link.inner.start, link.inner.end) : markdown.slice(scope.inner.start, scope.inner.end);
  const body = target === null ? raw : linkMarkup(raw, target);
  return checkedEdit(markdown, mapped, scope, `==${target === null ? '' : color}${body}==`, options, mapped.parsed.highlights.length, mapped.parsed.links.length - links.length + (target === null ? 0 : 1));
}
