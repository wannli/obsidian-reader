import {
  addHighlight,
  changePassage,
  locateSelection,
  nativeCitations,
  passageFragments,
  passages,
  type Passage,
} from './annotations';
import { ChangedNote } from './document';
import { blockSpans, markdownSource, type Span } from './markdown';
import { vaultLink } from './model';
import { inlineProjection, selectionPlan, visibleBetween } from './projection';

export interface HighlightSelection {
  quote: string;
  before?: string;
  after?: string;
}
export interface HostedHighlight {
  body: string;
  passage: Passage;
  quoteMarkdown: string;
  blockId: string;
}
export type PassageHostReplacement =
  | (HostedHighlight & { removed: false })
  | (Omit<HostedHighlight, 'passage'> & { removed: true; passage?: never });

export interface ParagraphAnchor extends Span {
  blockId: string;
  anchor: Span;
}

function currentPassage(body: string, expected: Passage): Passage {
  const current = passages(body).find(
    (item) => item.from === expected.from && item.to === expected.to,
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
  return current;
}

function paths(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const path = value.trim().replace(/\.md$/i, '');
    vaultLink(path);
    if (/^(?:[a-z][\w+.-]*:|\/|\.{1,2}(?:\/|$))/i.test(path) || path.includes('\\'))
      throw new Error('Choose a vault note with a safe, fully resolved path.');
    unique.add(path);
  }
  return [...unique];
}

function paragraph(body: string, from: number, to: number): Span {
  const blocks = blockSpans(body);
  const candidates = blocks.paragraphs
    .concat(blocks.headings)
    .filter((span) => from >= span.from && to <= span.to);
  if (candidates.length !== 1)
    throw new Error('Choose a passage in one paragraph before linking its highlights.');
  return candidates[0];
}

/** Native paragraph identifiers, not Reader highlight IDs. Code and comment literals
 * never become fragment destinations, and duplicate authored IDs remain ambiguous. */
export function paragraphAnchors(body: string): ParagraphAnchor[] {
  const blocks = blockSpans(body);
  const protectedSource = markdownSource(body, blocks);
  const result: ParagraphAnchor[] = [];
  for (const span of blocks.paragraphs.concat(blocks.headings)) {
    const raw = body.slice(span.from, span.to);
    // Block source maps can end before LF while retaining the preceding CR.
    const match = /[ \t]+\^([a-zA-Z0-9-]+)[ \t]*(?:\r?\n|\r)?$/.exec(raw);
    if (!match) continue;
    const from = span.from + match.index;
    if (
      protectedSource.code
        .concat(protectedSource.comments)
        .some((part) => from >= part.from && from < part.to)
    )
      continue;
    result.push({
      ...span,
      blockId: match[1],
      anchor: { from, to: from + match[0].trimEnd().length },
    });
  }
  return result;
}

function ensureAnchor(body: string, passage: Passage): { body: string; blockId: string } {
  const span = paragraph(body, passage.from, passage.to);
  const existing = paragraphAnchors(body).filter(
    (item) => item.from === span.from && item.to === span.to,
  );
  if (existing.length) {
    if (paragraphAnchors(body).filter((item) => item.blockId === existing[0].blockId).length !== 1)
      throw new Error('This paragraph identifier is duplicated. Resolve it in Markdown first.');
    return { body, blockId: existing[0].blockId };
  }
  // A small deterministic paragraph-local name, collision checked against all source
  // bytes. It identifies only this native paragraph and is shared by its highlights.
  let hash = 2166136261;
  for (const char of `${span.from}:${body.slice(span.from, span.to)}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  const stem = `reader-${(hash >>> 0).toString(36)}`;
  let blockId = stem;
  for (let suffix = 2; new RegExp(`\\^${blockId}(?![a-zA-Z0-9-])`).test(body); suffix++)
    blockId = `${stem}-${suffix}`;
  const at = span.from + body.slice(span.from, span.to).trimEnd().length;
  return { body: body.slice(0, at) + ` ^${blockId}` + body.slice(at), blockId };
}

/** Self-contained quoted Markdown; a partial link label retains its publisher URL,
 * references become explicit destinations, and partial emphasis is independently closed. */
export function passageQuote(body: string, expected: Passage): string {
  const passage = currentPassage(body, expected);
  if (passage.target) {
    // Native wiki aliases are literal labels, unlike a formatted Markdown label.
    return body.slice(passage.from + 2, passage.from + 4) === '[['
      ? passage.text.replace(/[\\`*_[\]<>|]/gu, '\\$&')
      : passage.text;
  }
  return selectionPlan(body, passage.from, passage.to, 'quote').quoteMarkdown;
}

export function passageHosts(body: string, expected: Passage): string[] {
  return paths(currentPassage(body, expected).hosts ?? []);
}

export function paragraphPassages(body: string, blockId: string): Passage[] {
  const anchors = paragraphAnchors(body).filter(
    (anchor) => anchor.blockId === blockId.replace(/^#?\^/, ''),
  );
  if (!anchors.length) return [];
  if (anchors.length !== 1) throw new Error('This paragraph identifier is ambiguous.');
  const anchor = anchors[0];
  return passages(body).filter((passage) => passage.from >= anchor.from && passage.to <= anchor.to);
}

function publisherContext(body: string, passage: Passage, all = passages(body)) {
  const link = blockSpans(body).links.find(
    (span) => passage.from > span.from && passage.to < span.to,
  );
  if (!link) return;
  const inside = all.filter((item) => item.from > link.from && item.to < link.to);
  const stack = [] as ReturnType<typeof nativeCitations>;
  let cursor = link.to;
  for (const citation of nativeCitations(body)) {
    if (citation.from < cursor) continue;
    if (
      /\r?\n[ \t]*\r?\n/.test(body.slice(cursor, citation.from)) ||
      visibleBetween(body, cursor, citation.from).trim()
    )
      break;
    stack.push(citation);
    cursor = citation.to;
  }
  return { link, inside, stack };
}

export function hostSelection(
  body: string,
  selection: HighlightSelection,
  targetPaths: readonly string[],
): HostedHighlight {
  if (!paths(targetPaths).length) throw new Error('Choose a typed highlight host first.');
  const range = locateSelection(body, selection.quote, selection.before, selection.after);
  const existing = passages(body);
  const next = addHighlight(body, range.from, range.to);
  const created = passages(next);
  // Token-local reference/autolink wrappers can shift the new mark. Bind by its
  // source order and exact visible quotation, never by a pre-insertion offset.
  const passage = created[existing.filter((item) => item.to <= range.from).length];
  if (
    !passage ||
    created.length !== existing.length + 1 ||
    inlineProjection(passageQuote(next, passage)).text.replace(/\s+/gu, ' ').trim() !==
      selection.quote.replace(/\s+/gu, ' ').trim()
  )
    throw new ChangedNote('The selected highlight could not be mapped safely.');
  const context = publisherContext(next, passage, created);
  if (context && context.inside.length > 1) {
    const originalLink = blockSpans(body).links.find(
      (link) => range.from > link.from && range.to < link.to,
    );
    const original = originalLink
      ? existing.filter((item) => item.from > originalLink.from && item.to < originalLink.to)
      : [];
    if (
      context.stack.length !== context.inside.length - 1 ||
      original.length !== context.inside.length - 1 ||
      original.some((item) => !item.citation)
    )
      throw new ChangedNote(
        'The existing publisher-link highlights have ambiguous host references. Edit them in Markdown first.',
      );
    const index = context.inside.indexOf(passage);
    const at = context.stack[index]?.from ?? context.stack[context.stack.length - 1].to;
    const citation = ` (※ ${paths(targetPaths).map(vaultLink).join(', ')})`;
    const referenced = next.slice(0, at) + citation + next.slice(at);
    const actual = passages(referenced).find((item) => item.from === passage.from);
    if (!actual?.citation) throw new ChangedNote();
    return hostPassage(referenced, actual, targetPaths);
  }
  return hostPassage(next, passage, targetPaths);
}

/** Add destinations, retaining the original host order and deduplicating native links.
 * Exact list edits use replacePassageHosts; this operation remains additive. */
export function hostPassage(
  body: string,
  expected: Passage,
  targetPaths: readonly string[],
): HostedHighlight {
  const passage = currentPassage(body, expected);
  const context = publisherContext(body, passage);
  if (
    !passage.citation &&
    context &&
    context.stack.length &&
    context.inside.length !== context.stack.length
  )
    throw new ChangedNote(
      'The publisher-link host references are ambiguous. Edit them in Markdown first.',
    );
  const hosts = paths([...(passage.hosts ?? []), ...targetPaths]);
  if (!hosts.length) throw new Error('Choose a typed highlight host first.');
  const quoteMarkdown = passageQuote(body, passage);
  let citation = ` (※ ${hosts.map(vaultLink).join(', ')})`;
  if (passage.citation) {
    const raw = body.slice(passage.citation.from, passage.citation.to);
    const references = [...raw.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)];
    const known = new Map<string, string>();
    for (const reference of references) {
      const path = paths([reference[1].split('|', 1)[0]])[0];
      if (!known.has(path)) known.set(path, reference[0]);
    }
    const additions = hosts.filter((path) => !known.has(path));
    if (references.length === known.size) {
      const close = raw.search(/[ \t]*\)$/);
      citation = additions.length
        ? raw.slice(0, close) + `, ${additions.map(vaultLink).join(', ')}` + raw.slice(close)
        : raw;
    } else citation = ` (※ ${[...known.values(), ...additions.map(vaultLink)].join(', ')})`;
  }
  const at =
    passage.citation?.from ?? selectionPlan(body, passage.from, passage.to, 'quote').citationAt;
  const end = passage.citation?.to ?? at;
  const referenced = body.slice(0, at) + citation + body.slice(end);
  const selected = passages(referenced).find((item) => item.from === passage.from);
  if (!selected?.citation || paths(selected.hosts ?? []).join('\0') !== hosts.join('\0'))
    throw new ChangedNote('The highlight host citation could not be associated safely.');
  const anchored = ensureAnchor(referenced, selected);
  const actual = passages(anchored.body).find((item) => item.from === selected.from);
  if (!actual) throw new ChangedNote();
  return { ...anchored, passage: actual, quoteMarkdown };
}

/** Replace only this passage's explicit native host group. An original wrapped
 * link remains authored content, not an extra explicit host. Clearing the list
 * removes the logical highlight too, so shared publisher citations stay paired.
 * The pre-edit quote and shared native paragraph ID survive a removal receipt. */
export function replacePassageHosts(
  body: string,
  expected: Passage,
  targetPaths: readonly string[],
): PassageHostReplacement {
  const passage = currentPassage(body, expected);
  const context = publisherContext(body, passage);
  if (context && context.stack.length && context.stack.length !== context.inside.length)
    throw new ChangedNote(
      'The publisher-link host references are ambiguous. Edit them in Markdown first.',
    );
  const hosts = paths(targetPaths);
  const quoteMarkdown = passageQuote(body, passage);
  if (!hosts.length) {
    const anchored = ensureAnchor(body, passage);
    const edits: (Span & { text: string })[] = passageFragments(passage).flatMap((span) => [
      { from: span.from, to: span.from + 2, text: '' },
      { from: span.to - 2, to: span.to, text: '' },
    ]);
    if (passage.citation) edits.push({ ...passage.citation, text: '' });
    let next = anchored.body;
    for (const edit of edits.sort((a, b) => b.from - a.from))
      next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
    return { body: next, quoteMarkdown, blockId: anchored.blockId, removed: true };
  }
  if (!passage.citation) return { ...hostPassage(body, passage, hosts), removed: false };

  const raw = body.slice(passage.citation.from, passage.citation.to);
  const references = [...raw.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)];
  const known = new Map<string, string>();
  for (const reference of references) {
    const path = paths([reference[1].split('|', 1)[0]])[0];
    if (!known.has(path)) known.set(path, reference[0]);
  }
  const same =
    references.length === known.size && [...known.keys()].join('\0') === hosts.join('\0');
  const prefix = /^[ ]?\(※[ \t]*/u.exec(raw)?.[0];
  const suffix = /[ \t]*\)$/u.exec(raw)?.[0];
  if (!prefix || !suffix) throw new ChangedNote();
  const citation = same
    ? raw
    : prefix + hosts.map((path) => known.get(path) ?? vaultLink(path)).join(', ') + suffix;
  const next = body.slice(0, passage.citation.from) + citation + body.slice(passage.citation.to);
  const actual = passages(next).find((item) => item.from === passage.from);
  if (!actual?.citation || paths(actual.hosts ?? []).join('\0') !== hosts.join('\0'))
    throw new ChangedNote('The replacement host citation could not be associated safely.');
  const hosted = hostPassage(next, actual, []);
  if (hosted.quoteMarkdown !== quoteMarkdown) throw new ChangedNote();
  return { ...hosted, removed: false };
}

/** Convert a fresh selection without ever persisting highlight marks or a quotation.
 * Reuse the same guarded passage conversion as explicit highlight conversion. */
export function mentionSelection(
  body: string,
  selection: HighlightSelection,
  nodePath: string,
): { body: string; blockId: string } {
  const range = locateSelection(body, selection.quote, selection.before, selection.after);
  const previous = passages(body);
  const marked = addHighlight(body, range.from, range.to);
  const created = passages(marked);
  const passage = created[previous.filter((item) => item.to <= range.from).length];
  if (
    !passage ||
    created.length !== previous.length + 1 ||
    inlineProjection(passageQuote(marked, passage)).text.replace(/\s+/gu, ' ').trim() !==
      selection.quote.replace(/\s+/gu, ' ').trim()
  )
    throw new ChangedNote('The selected passage could not be mapped safely.');
  return convertPassage(marked, passage, nodePath);
}

/** Convert mark text to ordinary native node mentions, keeping its surrounding
 * emphasis. Publisher links cannot acquire a second destination: refuse their
 * conversion rather than replacing/nesting a URL or inventing another reference. */
export function convertPassage(
  body: string,
  expected: Passage,
  nodePath: string,
): { body: string; blockId: string } {
  const passage = currentPassage(body, expected);
  const target = paths([nodePath])[0];
  if (passage.target) {
    const withoutHosts = passage.citation ? changePassage(body, passage, 'unlink') : body;
    const legacy = passages(withoutHosts).find((item) => item.from === passage.from);
    if (!legacy) throw new ChangedNote();
    const unlinked = changePassage(withoutHosts, legacy, 'unlink');
    const plain = passages(unlinked).find((item) => item.from === passage.from);
    if (!plain) throw new ChangedNote();
    return convertPassage(unlinked, plain, target);
  }
  const context = publisherContext(body, passage);
  if (context && context.stack.length && context.stack.length !== context.inside.length)
    throw new ChangedNote(
      'The publisher-link host references are ambiguous. Edit them in Markdown first.',
    );
  const spans = passageFragments(passage);
  const blocks = blockSpans(body);
  if (blocks.links.some((link) => spans.some((span) => link.from < span.to && link.to > span.from)))
    throw new Error(
      'This passage contains a publisher link. File it as an excerpt to preserve its original destination.',
    );
  const plan = selectionPlan(body, passage.from, passage.to, 'mention');
  const labels = plan.fragments.map((span) => ({
    ...span,
    text: inlineProjection(body.slice(span.from, span.to)).text,
  }));
  if (
    !labels.length ||
    labels.some(
      (label) =>
        /[\r\n\[\]|]/.test(body.slice(label.from, label.to)) || /[\r\n\[\]|]/.test(label.text),
    )
  )
    throw new Error(
      'This passage cannot be represented as ordinary node wikilinks without changing its wording. File it as an excerpt instead.',
    );
  const anchored = ensureAnchor(body, passage);
  const edits: (Span & { text: string })[] = [];
  for (const span of spans) {
    edits.push({ from: span.from, to: span.from + 2, text: '' });
    edits.push({ from: span.to - 2, to: span.to, text: '' });
  }
  for (const label of labels)
    edits.push({ ...label, text: `${vaultLink(target).slice(0, -2)}|${label.text}]]` });
  if (passage.citation) edits.push({ ...passage.citation, text: '' });
  let converted = anchored.body;
  for (const edit of edits.sort((a, b) => b.from - a.from || b.to - a.to))
    converted = converted.slice(0, edit.from) + edit.text + converted.slice(edit.to);
  return { body: converted, blockId: anchored.blockId };
}
