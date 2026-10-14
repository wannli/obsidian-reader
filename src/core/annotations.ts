import { Lexer } from 'marked';
import { ChangedNote } from './document';
import { vaultLink, type Properties } from './model';
import { inlineProjection } from './projection';

export interface Passage {
  from: number;
  to: number;
  text: string;
  target?: string;
}
const normalized = (text: string): string =>
  text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

/** Keep source offsets, but exclude literal code, comments, HTML and escaped delimiters. */
function eligibleSource(body: string, maskEscapes = true): string {
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
  let masked = chars.join('');
  for (const match of masked.matchAll(/<!--[^]*?(?:-->|$)|%%[^]*?(?:%%|$)|<[^>\n]+>/g))
    hide(match.index!, match.index! + match[0].length);
  masked = chars.join('');
  for (const match of masked.matchAll(/(`+)([^]*?)\1(?!`)/g))
    hide(match.index!, match.index! + match[0].length);
  if (maskEscapes)
    for (const match of body.matchAll(/\\[\\`*_[\]~=]/g))
      hide(match.index!, match.index! + match[0].length);
  return chars.join('');
}
/** Publisher prose is not an instruction to create Obsidian annotations or vault links. */
export function importedMarkdown(body: string): string {
  const source = eligibleSource(body);
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
export function passages(body: string): Passage[] {
  const source = eligibleSource(body, false),
    result: Passage[] = [];
  const escaped = (at: number) => {
    let count = 0;
    while (at > 0 && body[--at] === '\\') count++;
    return count % 2 === 1;
  };
  for (const match of source.matchAll(/==([^\0\n]*?)==/g)) {
    const from = match.index!,
      raw = body.slice(from + 2, from + match[0].length - 2);
    if (!raw.trim() || raw.includes('==') || escaped(from) || escaped(from + match[0].length - 2))
      continue;
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
  'reading_position',
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
    passages(body).length > 0 ||
    /\[\[[^\]\n]+\]\]/.test(eligibleSource(body)) ||
    inlineProjection(eligibleSource(body, false)).links.some(
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
  if (!wanted || wanted.length > 12_000) throw new Error('Select a short passage of article text.');
  const source = eligibleSource(body, false),
    projection = inlineProjection(source),
    plain = projection.text;
  const blocked = [
    ...passages(body),
    ...projection.links,
    ...[...source.matchAll(/!?\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])|!?\[\[[^\]\n]*\]\]/g)].map(
      (match) => ({ from: match.index!, to: match.index! + match[0].length }),
    ),
  ];
  const candidates: { from: number; to: number; score: number }[] = [];
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
    let found = false;
    for (const from of starts) {
      for (const to of ends) {
        const raw = body.slice(from, to);
        if (
          /\n\s*\n|[\[\]`<>]|==/.test(raw) ||
          blocked.some((span) => from < span.to && to > span.from)
        )
          continue;
        // A crossing/partial emphasis delimiter would change the visible words; reject it.
        if (normalized(inlineProjection(raw).text) !== wanted) continue;
        if (score > bestScore) {
          bestScore = score;
          candidates.length = 0;
        }
        if (candidates.length < 2) candidates.push({ from, to, score });
        found = true;
        break;
      }
      if (found) break;
    }
    if (bestScore === maximumScore && candidates.length === 2) break;
  }
  if (
    !candidates.length ||
    (candidates.length > 1 && candidates[0].score === candidates[1].score)
  ) {
    throw new Error(
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
  const quote = inlineProjection(body.slice(from, to)).text;
  const match = locateSelection(
    body,
    quote,
    inlineProjection(body.slice(0, from)).text.slice(-120),
    inlineProjection(body.slice(to)).text.slice(0, 120),
  );
  if (match.from !== from || match.to !== to) throw new ChangedNote();
  return `${body.slice(0, from)}==${body.slice(from, to)}==${body.slice(to)}`;
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
  if (!current || current.text !== expected.text || current.target !== expected.target)
    throw new ChangedNote();
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
