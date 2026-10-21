import { Lexer } from 'marked';
import { blockSpans, markdownSource, renderedHighlight, type Span } from './markdown';
import { ChangedNote } from './document';
import { vaultLink, type Properties } from './model';
import { blockProjection, inlineProjection, selectionPlan } from './projection';

/** Expected selection rejection, distinct from source/write failures and parser defects. */
export class UnmappableSelection extends Error {}

/** Multiline highlights stay within one parsed paragraph, never across blocks/hard breaks. */
function paragraphGuard(
  body: string,
  blocks = () => blockSpans(body).paragraphs,
): (from: number, to: number) => boolean {
  let paragraphs: Span[] | undefined;
  return (from, to) => {
    const raw = body.slice(from, to).replace(/\r\n?/g, '\n');
    if (!raw.includes('\n')) return true;
    if (/\n\s*\n|(?: {2,}|\\)\n/.test(raw)) return false;
    paragraphs ??= blocks();
    return paragraphs.some((span) => from >= span.from && to <= span.to);
  };
}

export interface Passage {
  from: number;
  to: number;
  text: string;
  target?: string;
  /** Several native marks can describe one continuous selection across inline syntax. */
  fragments?: readonly Span[];
  hosts?: readonly string[];
  /** Includes the single separator space inserted before a native host citation. */
  citation?: Span;
}
export interface HostCitation extends Span {
  hosts: string[];
}
const citationPattern =
  /\(※[ \t]+(\[\[[^\[\]\r\n]+\]\](?:[ \t]*,[ \t]*\[\[[^\[\]\r\n]+\]\])*)[ \t]*\)/g;
const publisherLink = (target: string): boolean => /^(?:https?:|mailto:|\/\/|#)/i.test(target);
const normalized = (text: string): string =>
  text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

/** Keep source offsets, but exclude literal code, comments, HTML and escaped delimiters. */
function eligibleSource(
  body: string,
  maskEscapes = true,
  parsed?: ReturnType<typeof blockSpans>,
  decorations = true,
): string {
  const chars = body.split('');
  const hide = (from: number, to: number) => {
    for (let i = from; i < to; i++) chars[i] = '\0';
  };
  let fence: { character: string; length: number } | undefined,
    offset = 0;
  for (const line of body.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      hide(offset, offset + line.length);
      if (
        marker?.[0] === fence.character &&
        marker.length >= fence.length &&
        /^ {0,3}(?:`+|~+)\s*$/.test(line)
      )
        fence = undefined;
    } else if (marker) {
      fence = { character: marker[0], length: marker.length };
      hide(offset, offset + line.length);
    } else if (/^(?: {4}|\t)/.test(line)) hide(offset, offset + line.length);
    offset += line.length;
  }
  if (parsed) {
    // Indentation can continue any parsed paragraph or heading, not just containers.
    // Restore proven prose before applying inline masks (including cross-line comments).
    for (const span of parsed.paragraphs.concat(parsed.headings))
      for (let i = span.from; i < span.to; i++) chars[i] = body[i];
    for (const span of parsed.protected) hide(span.from, span.to);
  }
  const protectedSource = markdownSource(body, parsed);
  for (const span of protectedSource.code.concat(protectedSource.comments))
    hide(span.from, span.to);
  const masked = chars.join('');
  for (const match of masked.matchAll(/<!--[^]*?(?:-->|$)|<[^>\n]+>/g)) {
    if (
      parsed?.links.some(
        (span) => span.from === match.index! && span.to === match.index! + match[0].length,
      )
    )
      continue;
    hide(match.index!, match.index! + match[0].length);
  }
  if (maskEscapes)
    for (const match of body.matchAll(/\\[\\`*_[\]~=]/g))
      hide(match.index!, match.index! + match[0].length);
  // Native reference controls and paragraph identifiers are not publisher prose.
  // Keep columns/line boundaries while excluding their visible labels from context.
  if (decorations) {
    for (const match of body.matchAll(citationPattern))
      for (let at = match.index!; at < match.index! + match[0].length; at++)
        if (chars[at] !== '\0') chars[at] = ' ';
    for (const match of body.matchAll(/[ \t]+\^[a-zA-Z0-9-]+(?=[ \t]*(?:\r?$))/gm))
      for (let at = match.index!; at < match.index! + match[0].length; at++)
        if (chars[at] !== '\0') chars[at] = ' ';
  }
  return chars.join('');
}
/** Publisher prose is not an instruction to create Obsidian annotations or vault links. */
export function importedMarkdown(body: string): string {
  const source = eligibleSource(body, true, undefined, false);
  const matches = [...source.matchAll(/==|\[\[/g)].reverse();
  for (const match of matches) {
    const at = match.index!;
    body =
      body.slice(0, at) +
      match[0]
        .split('')
        .map((char) => `\\${char}`)
        .join('') +
      body.slice(at + 2);
  }
  return body;
}
export function nativeCitations(body: string, blocks = blockSpans(body)): HostCitation[] {
  const protectedSource = markdownSource(body, blocks);
  const protectedSpans = blocks.protected.concat(protectedSource.code, protectedSource.comments);
  const result: HostCitation[] = [];
  for (const match of body.matchAll(citationPattern)) {
    const from = match.index!,
      to = from + match[0].length;
    let escapes = 0;
    for (let at = from - 1; at >= 0 && body[at] === '\\'; at--) escapes++;
    if (escapes % 2) continue;
    if (protectedSpans.some((span) => from < span.to && to > span.from)) continue;
    // A citation inside a publisher anchor would nest note links in its label.
    if (blocks.links.some((span) => from > span.from && to < span.to)) continue;
    const hosts = [...match[1].matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)].map(
      (link) => link[1].split('|', 1)[0],
    );
    if (hosts.some((path) => !path || /[#^]|^(?:[a-z][\w+.-]*:|\/\/)/i.test(path))) continue;
    result.push({ from: from > 0 && body[from - 1] === ' ' ? from - 1 : from, to, hosts });
  }
  return result;
}

export function passageFragments(passage: Passage): readonly Span[] {
  return passage.fragments ?? [{ from: passage.from, to: passage.to }];
}

export function passages(body: string): Passage[] {
  if (!body.includes('==')) return [];
  const blocks = blockSpans(body);
  const marks = scanHighlights(body, false, blocks);
  if (!marks.length) return marks;
  const projection = blockProjection(body, blocks.inlineBlocks),
    citations = nativeCitations(body, blocks);
  const visible = (from: number, to: number): string => {
    let low = 0,
      high = projection.starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (projection.starts[middle] < from) low = middle + 1;
      else high = middle;
    }
    let text = '';
    for (let at = low; at < projection.text.length && projection.starts[at] < to; at++)
      if (projection.ends[at] <= to) text += projection.text[at];
    return text;
  };
  const sameBlock = (from: number, to: number) =>
    blocks.inlineBlocks.some(
      (block) =>
        block.text && from >= block.offset(0) && to <= block.offset(block.text.length - 1) + 1,
    );
  const result: Passage[] = [];
  for (const mark of marks) {
    const previous = result[result.length - 1];
    if (
      previous &&
      !previous.target &&
      !mark.target &&
      !previous.citation &&
      sameBlock(previous.from, mark.to) &&
      !blocks.comments
        .concat(blocks.code)
        .some((span) => previous.to < span.to && mark.from > span.from) &&
      (visible(previous.to, mark.from) === '' ||
        (!visible(previous.to, mark.from).trim() && /\S/u.test(body.slice(previous.to, mark.from))))
    ) {
      previous.fragments = [...passageFragments(previous), { from: mark.from, to: mark.to }];
      previous.to = mark.to;
      previous.text = selectionPlan(
        body,
        previous.from,
        previous.to,
        'quote',
        blocks.inlineBlocks,
      ).quoteMarkdown;
    } else result.push({ ...mark });
    const current = result[result.length - 1];
    const citation = citations.find((item) => {
      if (item.from < current.to || !sameBlock(current.from, item.to)) return false;
      if (!visible(current.to, item.from).trim()) return true;
      // A partial publisher label must close its original link before the citation.
      const enclosing = blocks.links.find((span) => span.from < current.to && span.to > current.to);
      return !!enclosing && enclosing.to <= item.from && !visible(enclosing.to, item.from).trim();
    });
    if (citation && !marks.some((other) => other.from >= current.to && other.to <= citation.from)) {
      current.hosts = citation.hosts;
      current.citation = { from: citation.from, to: citation.to };
    }
  }
  // Several excerpts can share one publisher anchor. Their separate native
  // citations follow that anchor in source order, so no note link is nested in
  // its label. A count mismatch is ambiguous and must not reassign a host to the
  // nearest mark merely because a native edit inserted another highlight.
  for (const link of blocks.links) {
    const inside = result.filter((passage) => passage.from > link.from && passage.to < link.to);
    if (!inside.length) continue;
    const stack: HostCitation[] = [];
    let cursor = link.to;
    for (const citation of citations) {
      if (citation.from < cursor) continue;
      if (!sameBlock(link.from, citation.to) || visible(cursor, citation.from).trim()) break;
      stack.push(citation);
      cursor = citation.to;
    }
    if (!stack.length) continue;
    for (const passage of inside) {
      delete passage.hosts;
      delete passage.citation;
    }
    if (stack.length !== inside.length) continue;
    inside.forEach((passage, index) => {
      const citation = stack[index];
      passage.hosts = citation.hosts;
      passage.citation = { from: citation.from, to: citation.to };
    });
  }
  return result;
}

function scanHighlights(
  body: string,
  retentionOnly: boolean,
  parsed?: ReturnType<typeof blockSpans>,
): Passage[] {
  if (!body.includes('==')) return [];
  const blocks = parsed ?? blockSpans(body),
    source = eligibleSource(body, false, blocks),
    result: Passage[] = [];
  const escaped = (at: number) => {
    let count = 0;
    while (at > 0 && body[--at] === '\\') count++;
    return count % 2 === 1;
  };
  // Authored setext headings are also one inline block. Automatic creation remains
  // paragraph-only; recognizing an existing heading mark must not permit expiry.
  const withinParagraph = paragraphGuard(body, () => blocks.paragraphs.concat(blocks.headings)),
    matches = retentionOnly ? /==([\s\S]*?)==/g : /==([^\0]*?)==/g;
  let match: RegExpExecArray | null;
  while ((match = matches.exec(source))) {
    const from = match.index!,
      raw = body.slice(from + 2, from + match[0].length - 2);
    if (
      !raw.trim() ||
      (!retentionOnly && raw.includes('==')) ||
      escaped(from) ||
      escaped(from + match[0].length - 2)
    )
      continue;
    if (!withinParagraph(from, from + match[0].length)) {
      // An unmatched opener in an earlier block must not consume a later valid highlight.
      matches.lastIndex = from + 2;
      continue;
    }
    // Protected interiors stay non-editable, but outside delimiters can still render
    // a mark around them. Retain that annotation rather than failing open on expiry.
    // Delimiters inside code/HTML remain masked, so literals do not count.
    if (retentionOnly) return [{ from, to: from + match[0].length, text: raw }];
    const link = /^\[\[([^\]|#^\r\n]+)\|([^\[\]\r\n]+)\]\]$/.exec(raw);
    if (link) {
      result.push({ from, to: from + match[0].length, text: link[2], target: link[1] });
      continue;
    }
    const tokens = Lexer.lexInline(raw),
      token = tokens[0];
    if (
      tokens.length === 1 &&
      token.type === 'link' &&
      !/^[a-z][\w+.-]*:|^\/\/|^#/i.test(token.href)
    ) {
      let target: string;
      try {
        target = decodeURIComponent(token.href).replace(/^\//, '');
      } catch {
        continue;
      }
      result.push({ from, to: from + match[0].length, text: token.text, target });
    } else result.push({ from, to: from + match[0].length, text: raw });
  }
  return result;
}
const sourceProperties = new Set([
  'type',
  'feed',
  'url',
  'title',
  'published',
  'error',
  'status',
  'bookmark',
  'reading_position', // Inert historical metadata, not a bookmark fallback or authored link.
]);

/** Cache keys may name a nested/list value. Exclusions apply only to Reader records
 * and their top-level source/state fields, never to ordinary-note backlinks. */
export function isAnnotationProperty(properties: Properties, key: string): boolean {
  if (properties.type !== 'article' && properties.type !== 'feed') return true;
  const root = Object.hasOwn(properties, key) ? key : key.split(/[.\[]/, 1)[0];
  return (
    !sourceProperties.has(root) &&
    !(properties.type === 'feed' && (root === 'prefix' || root === 'enabled'))
  );
}

/** Metadata-only: authored links can live in arbitrary scalar/list/map values.
 * Ignore source/state fields; in particular every imported feed reference is a link. */
export function hasPropertyAnnotations(properties: Properties = {}): boolean {
  if (Array.isArray(properties.topics) && properties.topics.length > 0) return true;
  const pending = Object.entries(properties)
    .filter(([key]) => key !== 'topics' && isAnnotationProperty(properties, key))
    .map(([, value]) => value);
  const seen = new Set<object>();
  const vaultTarget = (target: string) =>
    !!target.trim() && !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(target.trim());
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      // YAML strings are not Markdown bodies; a native wiki reference can occur
      // anywhere in a property value. Only links, not ==literal highlights==, count.
      for (const match of value.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) {
        if (vaultTarget(match[1].split('|', 1)[0])) return true;
      }
      if (
        value.includes('](') &&
        inlineProjection(value).links.some((link) => {
          try {
            return vaultTarget(decodeURIComponent(link.target));
          } catch {
            return false;
          }
        })
      )
        return true;
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const child of Object.values(value)) pending.push(child);
    }
  }
  return false;
}

export function hasAnnotations(body: string, properties: Properties): boolean {
  return (
    hasPropertyAnnotations(properties) ||
    scanHighlights(body, true).length > 0 ||
    renderedHighlight(body) ||
    /\[\[[^\]\n]+\]\]/.test(eligibleSource(body, true, undefined, false)) ||
    inlineProjection(eligibleSource(body, false, undefined, false)).links.some(
      (link) => !/^[a-z][\w+.-]*:|^\/\/|^#/i.test(link.target),
    )
  );
}
export function locateSelection(
  body: string,
  quote: string,
  before = '',
  after = '',
): { from: number; to: number } {
  const wanted = normalized(quote);
  if (!wanted || wanted.length > 12_000)
    throw new UnmappableSelection('Select a short passage of article text.');
  const blocks = blockSpans(body),
    source = eligibleSource(body, false, blocks),
    projection = blockProjection(source),
    plain = projection.text;
  const blocked = [
    ...passages(body),
    ...blocks.links.filter((span) => body[span.from] === '!'),
    ...projection.links.filter((link) => !publisherLink(link.target)),
    ...[...source.matchAll(/!?\[\[[^\]\n]*\]\]/g)].map((match) => ({
      from: match.index!,
      to: match.index! + match[0].length,
    })),
  ];
  const candidates: { from: number; to: number; score: number }[] = [];
  const withinParagraph = paragraphGuard(body);
  const prefix = normalized(before).slice(-40),
    suffix = normalized(after).slice(0, 40);
  const maximumScore = Number(!!prefix) + Number(!!suffix);
  let bestScore = -1;
  for (let at = plain.indexOf(wanted); at >= 0; at = plain.indexOf(wanted, at + 1)) {
    const end = at + wanted.length;
    const left = normalized(plain.slice(Math.max(0, at - 120), at)),
      right = normalized(plain.slice(end, end + 120));
    const score =
      Number(!!prefix && left.endsWith(prefix)) + Number(!!suffix && right.startsWith(suffix));
    if (score < bestScore) continue;
    const starts = [projection.starts[at], ...(projection.openings.get(at) ?? [])];
    const ends = [projection.ends[end - 1], ...(projection.closings.get(end) ?? [])];
    const variants = starts.flatMap((from) =>
      ends.map((to) => ({ from, to, raw: projection.slice(from, to) })),
    );
    // Preserve the existing single native mark whenever complete inline syntax fits.
    // Only crossing partial boundaries need multiple marks inside their containers.
    variants.sort(
      (a, b) =>
        Number(normalized(inlineProjection(a.raw ?? '').text) !== wanted) -
        Number(normalized(inlineProjection(b.raw ?? '').text) !== wanted),
    );
    for (const { from, to, raw } of variants) {
      if (
        raw === undefined ||
        /\n\s*\n|[\0`]|==/.test(raw) ||
        !withinParagraph(from, to) ||
        blocked.some((span) => from < span.to && to > span.from)
      )
        continue;
      // Partial inline boundaries are split into native marks in their original
      // containers; the independent quote closes emphasis and publisher links.
      try {
        const plan = selectionPlan(body, from, to);
        if (
          !plan.fragments.length ||
          normalized(inlineProjection(plan.quoteMarkdown).text) !== wanted
        )
          continue;
      } catch {
        continue;
      }
      if (score > bestScore) {
        bestScore = score;
        candidates.length = 0;
      }
      if (candidates.length < 2) candidates.push({ from, to, score });
      break;
    }
    if (bestScore === maximumScore && candidates.length === 2) break;
  }
  if (
    !candidates.length ||
    (candidates.length > 1 && candidates[0].score === candidates[1].score)
  ) {
    throw new UnmappableSelection(
      'This selection cannot be matched safely. Select a distinct passage within one text block.',
    );
  }
  return candidates[0];
}
export function addHighlight(body: string, from: number, to: number): string {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to <= from ||
    to > body.length
  )
    throw new ChangedNote();
  const projection = blockProjection(body),
    raw = projection.slice(from, to);
  if (raw === undefined) throw new ChangedNote();
  const start = projection.starts.findIndex((at) => at >= from),
    end = projection.starts.findIndex((at) => at >= to);
  const quote = projection.text.slice(start, end < 0 ? undefined : end);
  const match = locateSelection(
    body,
    quote,
    projection.text.slice(0, start).slice(-120),
    end < 0 ? '' : projection.text.slice(end, end + 120),
  );
  if (match.from !== from || match.to !== to) throw new ChangedNote();
  const plan = selectionPlan(body, from, to);
  if (
    !plan.insertions.length &&
    !plan.replacements.length &&
    normalized(inlineProjection(raw).text) === normalized(quote)
  )
    return `${body.slice(0, from)}==${body.slice(from, to)}==${body.slice(to)}`;
  const edits = plan.insertions.concat(
    plan.fragments.flatMap((span) => [
      { at: span.from, text: '==', order: 1 },
      { at: span.to, text: '==', order: 1 },
    ]),
  );
  const changes = edits
    .map((edit) => ({ from: edit.at, to: edit.at, text: edit.text, order: edit.order }))
    .concat(plan.replacements.map((edit) => ({ ...edit, order: 2 })));
  for (const edit of changes.sort((a, b) => b.from - a.from || (b.order ?? 2) - (a.order ?? 2)))
    body = body.slice(0, edit.from) + edit.text + body.slice(edit.to);
  return body;
}
export function changePassage(
  body: string,
  expected: Passage,
  action: 'remove' | 'unlink' | 'link',
  target?: string,
): string {
  const current = passages(body).find(
    (passage) => passage.from === expected.from && passage.to === expected.to,
  );
  if (
    !current ||
    current.text !== expected.text ||
    current.target !== expected.target ||
    JSON.stringify(current.hosts ?? []) !== JSON.stringify(expected.hosts ?? []) ||
    JSON.stringify(current.citation) !== JSON.stringify(expected.citation) ||
    JSON.stringify(passageFragments(current)) !== JSON.stringify(passageFragments(expected))
  )
    throw new ChangedNote();
  if (action === 'link' && !target) throw new Error('Choose a note target first.');
  if (current.citation || current.fragments) {
    const spans = passageFragments(current);
    const edits: (Span & { text: string })[] = [];
    if (current.citation)
      edits.push({
        ...current.citation,
        text: action === 'link' && target ? ` (※ ${vaultLink(target)})` : '',
      });
    if (action === 'remove') {
      for (const span of spans) {
        edits.push({ from: span.from, to: span.from + 2, text: '' });
        edits.push({ from: span.to - 2, to: span.to, text: '' });
      }
    } else if (action === 'link' && !current.citation) {
      if (!target) throw new Error('Choose a note target first.');
      const at = selectionPlan(body, current.from, current.to).citationAt;
      edits.push({ from: at, to: at, text: ` (※ ${vaultLink(target)})` });
    }
    for (const edit of edits.sort((a, b) => b.from - a.from))
      body = body.slice(0, edit.from) + edit.text + body.slice(edit.to);
    return body;
  }
  let replacement = current.text;
  if (action === 'link') {
    if (!target || /[\[\]|\r\n]/.test(current.text))
      throw new Error('This passage cannot be used as a wiki-link label.');
    if (
      inlineProjection(eligibleSource(body, false)).links.some(
        (link) => link.from < current.from && link.to > current.to,
      )
    )
      throw new Error('A passage inside an existing link cannot contain another link.');
    const link = vaultLink(target);
    // Ordinary Markdown links preserve emphasis/escapes/entities that a wiki alias would turn into literal characters.
    replacement =
      inlineProjection(current.text).text === current.text
        ? `==${link.slice(0, -2)}|${current.text}]]==`
        : `==[${current.text}](/${target.split('/').map(encodeURIComponent).join('/')})==`;
  } else if (action === 'unlink') replacement = `==${current.text}==`;
  return body.slice(0, current.from) + replacement + body.slice(current.to);
}
