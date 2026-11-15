import { Lexer, type Token } from 'marked';
import { readDocument } from '../document';
import { readerMarkdown } from '../markdown';
import { timestamp, webUrl } from '../model';
import type { NoteFile } from '../store';
import type { ThinkingConnection, ThinkingDocument, ThinkingRecord, ThinkingTarget } from './types';

const syntax = readerMarkdown();
const lex = (raw: string) => Lexer.lex(raw, syntax.defaults);
export const escapeText = (text: string): string =>
  text.replace(/[\\!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/gu, '\\$&');
export const unescapeText = (text: string): string =>
  text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, '$1');
export function targetLink(target: ThinkingTarget): string {
  if (
    !target.path ||
    /[\[\]|#^\r\n\x00-\x1f]/u.test(target.path) ||
    (target.blockId !== undefined && !/^[A-Za-z0-9-]+$/.test(target.blockId)) ||
    (target.label !== undefined && /[\[\]|\r\n\x00-\x1f]/u.test(target.label))
  )
    throw new Error('This target cannot be represented by a native link.');
  return `[[${target.path}${target.blockId ? `#^${target.blockId}` : ''}${target.label ? `|${target.label}` : ''}]]`;
}
export function parseTarget(raw: string): ThinkingTarget | undefined {
  const match = /^\[\[([^\[\]|#^\r\n]+)(?:#\^([A-Za-z0-9-]+))?(?:\|([^\[\]|\r\n]+))?\]\]$/.exec(
    raw,
  );
  if (!match) return;
  const target = {
    path: match[1],
    ...(match[2] ? { blockId: match[2] } : {}),
    ...(match[3] ? { label: match[3] } : {}),
  };
  try {
    targetLink(target);
    return target;
  } catch {
    return;
  }
}
export function connectionLine(connection: ThinkingConnection): string {
  const label = connection.label?.trim();
  if (label && /[\x00-\x1f\x7f]/u.test(label))
    throw new Error('Connection labels must be single-line plain text.');
  return `- ${targetLink(connection.target)}${label ? ` — ${escapeText(label)}` : ''}`;
}
function parseConnections(raw: string): ThinkingConnection[] | undefined {
  if (raw === '_None._') return [];
  const items: ThinkingConnection[] = [];
  for (const line of raw.split('\n')) {
    const match = /^- (\[\[[^\r\n]+?\]\])(?: — (.+))?$/.exec(line);
    const target = match && parseTarget(match[1]);
    if (!match || !target) return;
    const label = match[2] ? unescapeText(match[2]) : undefined;
    if (label && (escapeText(label) !== match[2] || /[\x00-\x1f\x7f]/u.test(label))) return;
    items.push({ target, ...(label ? { label } : {}) });
  }
  return items.length ? items : undefined;
}
interface Located {
  token: Token;
  from: number;
  to: number;
}
function normalizedMap(raw: string): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  for (let at = 0; at < raw.length; at++) {
    offsets.push(at);
    if (raw[at] === '\r' && raw[at + 1] === '\n') at++;
    text += raw[at];
  }
  offsets.push(raw.length);
  return { text, offsets };
}
function located(raw: string): Located[] {
  const { text, offsets } = normalizedMap(raw);
  let at = 0;
  return lex(text).map((token) => {
    const from = text.indexOf(token.raw, at);
    if (from < 0) throw new Error('Unsupported Markdown mapping.');
    at = from + token.raw.length;
    return {
      token: { ...token, raw: raw.slice(offsets[from], offsets[at]) } as Token,
      from: offsets[from],
      to: offsets[at],
    };
  });
}
/** Conservative collision scan includes anchors in unknown/fenced content. */
export function anchorCounts(raw: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of raw.matchAll(/(?:^|\s)\^([A-Za-z0-9-]+)(?=\s|$)/gu))
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  return counts;
}
function record(
  raw: string,
  path: string,
  from: number,
  quoteRaw: string,
  blockId: string,
  to: number,
): ThinkingRecord | undefined {
  // Only explicit top-level quoted lines are owned. Lazy continuation is readable but not editable.
  const rows = quoteRaw.replace(/\r\n/g, '\n').trimEnd().split('\n');
  if (rows.some((line) => !/^> ?/.test(line))) return;
  const stripped = rows.map((line) => line.replace(/^> ?/, ''));
  const title = stripped.shift();
  const kind =
    title === '[!quote] Passage' ? 'passage' : title === '[!note] Comment' ? 'comment' : undefined;
  if (!kind) return;
  const payload = stripped.join('\n');
  const tokens = located(payload).filter((item) => item.token.type !== 'space');
  const firstRule = tokens.findIndex((item) => item.token.type === 'hr');
  if (firstRule < 1) return;
  const metadata = tokens.slice(0, firstRule);
  if (metadata.some((item) => item.token.type !== 'paragraph')) return;
  const fields: [string, string][] = [];
  for (const item of metadata) {
    const match = /^\*\*(Source|About|URL|Collected|Before|After):\*\* ?([^\n]*)$/.exec(
      item.token.raw.trimEnd(),
    );
    if (!match) return;
    fields.push([match[1], match[2]]);
  }
  const names = fields.map(([name]) => name).join(',');
  const sourceBased = /^Source,(?:URL,)?Collected,Before,After$/.test(names);
  if (
    kind === 'passage'
      ? !sourceBased
      : !(sourceBased || names === 'About,Collected' || names === 'Collected')
  )
    return;
  const values = Object.fromEntries(fields);
  const source = values.Source === undefined ? undefined : parseTarget(values.Source);
  const about = values.About === undefined ? undefined : parseTarget(values.About);
  if ((values.Source !== undefined && !source) || (values.About !== undefined && !about)) return;
  const date = /^\[\[(\d{4}-\d{2}-\d{2})\]\]$/.exec(values.Collected)?.[1];
  if (!date || timestamp(date) === undefined) return;
  let url: string | undefined;
  if (values.URL !== undefined) {
    const match = /^<(https?:\/\/[^<>\s]+)>$/.exec(values.URL);
    if (!match) return;
    try {
      webUrl(match[1]);
      url = match[1];
    } catch {
      return;
    }
  }
  const context = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : unescapeText(value);
  const before = context(values.Before),
    after = context(values.After);
  if (
    [before, after].some(
      (value) =>
        value !== undefined && (Array.from(value).length > 160 || /[\x00-\x1f]/u.test(value)),
    )
  )
    return;
  if (
    (before !== undefined && escapeText(before) !== values.Before) ||
    (after !== undefined && escapeText(after) !== values.After)
  )
    return;
  // Structural rules/headings are found only among lexer-proven top-level blocks.
  const heading = tokens[tokens.length - 2];
  const terminal = tokens[tokens.length - 1];
  const rule = tokens[tokens.length - 3];
  if (
    !heading ||
    heading.token.type !== 'heading' ||
    heading.token.depth !== 4 ||
    heading.token.text !== 'Connections' ||
    rule?.token.type !== 'hr' ||
    rule === tokens[firstRule]
  )
    return;
  const connections = parseConnections(terminal.token.raw.trimEnd());
  if (!connections || !['paragraph', 'list'].includes(terminal.token.type)) return;
  const bodyStart = tokens[firstRule].to;
  const bodyEnd = rule.from;
  const bodyRegion = payload.slice(bodyStart, bodyEnd);
  // Exactly the canonical separator blank line is structural. Further blank lines
  // belong to the authored body and must survive Reader edits unchanged.
  if (!bodyRegion.startsWith('\n\n') || !bodyRegion.endsWith('\n\n')) return;
  const leading = 2;
  const body = bodyRegion.slice(leading, -2);
  if (!body.trim()) return;
  // Map payload columns back to original quoted bytes, including CRLF and outer prefixes.
  const originalRows = quoteRaw.split('\n');
  const starts: number[] = [];
  let cursor = from;
  for (const line of originalRows) {
    starts.push(cursor);
    cursor += line.length + 1;
  }
  const map = (offset: number): number => {
    const prior = payload.slice(0, offset).split('\n');
    const row = prior.length; // payload starts after the callout header
    return (
      starts[row] + (originalRows[row].startsWith('> ') ? 2 : 1) + prior[prior.length - 1].length
    );
  };
  return {
    path,
    blockId,
    kind,
    body,
    source,
    about,
    url,
    collected: date,
    before,
    after,
    connections,
    raw: raw.slice(from, to),
    from,
    to,
    readOnly: false,
    bodyFrom: map(bodyStart + leading),
    bodyTo: map(bodyStart + leading + body.length),
    connectionsFrom: map(terminal.from),
    connectionsTo: map(terminal.from + terminal.token.raw.trimEnd().length),
  };
}
export function parseThinking<File extends NoteFile>(
  file: File,
  raw: string,
): ThinkingDocument<File> {
  const doc = readDocument(raw);
  const result: ThinkingDocument<File> = {
    file,
    path: file.path,
    raw,
    records: [],
    memberships: [],
    issues: [],
  };
  const counts = anchorCounts(raw);
  const blocks = located(doc.body);
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (
      block.token.type === 'blockquote' &&
      /^> \[!(?:quote|note)\] (?:Passage|Comment)(?:\r?\n|$)/.test(block.token.raw)
    ) {
      let next = index + 1;
      while (blocks[next]?.token.type === 'space') next++;
      const anchor = blocks[next];
      const id =
        anchor?.token.type === 'paragraph'
          ? /^\^([A-Za-z0-9-]+)$/.exec(anchor.token.raw.trimEnd())?.[1]
          : undefined;
      const parsed = id
        ? record(
            raw,
            file.path,
            doc.headerEnd + block.from,
            block.token.raw,
            id,
            doc.headerEnd + anchor.from + anchor.token.raw.trimEnd().length,
          )
        : undefined;
      if (!parsed)
        result.issues.push('Unsupported Thinking record; open native Markdown to inspect.');
      else {
        parsed.readOnly = counts.get(parsed.blockId) !== 1;
        if (parsed.readOnly)
          result.issues.push('Duplicate native anchor; affected records are read-only.');
        result.records.push(parsed);
      }
    }
    if (block.token.type === 'list') {
      let cursor = 0;
      const mapped = normalizedMap(block.token.raw);
      for (const item of block.token.items) {
        const local = mapped.text.indexOf(item.raw, cursor);
        if (local < 0) throw new Error('Unsupported native list mapping.');
        cursor = local + item.raw.length;
        const at = block.from + mapped.offsets[local];
        const end = block.from + mapped.offsets[cursor];
        const nativeRaw = doc.body.slice(at, end);
        const match = /^- (\[\[[^\r\n]+\]\])(?:\r?\n)?$/.exec(nativeRaw);
        const target = match && parseTarget(match[1]);
        if (target)
          result.memberships.push({
            target,
            raw: nativeRaw,
            from: doc.headerEnd + at,
            to: doc.headerEnd + end,
          });
      }
    }
  }
  return result;
}
export function quoteLines(text: string, newline = '\n'): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : '>'))
    .join(newline);
}
export function renderRecord(
  record: Pick<
    ThinkingRecord,
    | 'kind'
    | 'body'
    | 'source'
    | 'about'
    | 'url'
    | 'collected'
    | 'before'
    | 'after'
    | 'connections'
    | 'blockId'
  >,
  newline = '\n',
): string {
  const metadata: string[] = [];
  if (record.source) metadata.push(`**Source:** ${targetLink(record.source)}`);
  if (record.about) metadata.push(`**About:** ${targetLink(record.about)}`);
  if (record.url) {
    webUrl(record.url);
    if (/[<>\s]/u.test(record.url)) throw new Error('Unsafe publisher URL.');
    metadata.push(`**URL:** <${record.url}>`);
  }
  metadata.push(`**Collected:** [[${record.collected}]]`);
  if (record.source)
    metadata.push(
      `**Before:** ${escapeText(record.before ?? '')}`,
      `**After:** ${escapeText(record.after ?? '')}`,
    );
  const inner = `[!${record.kind === 'passage' ? 'quote] Passage' : 'note] Comment'}\n${metadata.join('\n\n')}\n\n---\n\n${record.body}\n\n---\n\n#### Connections\n\n${record.connections.length ? record.connections.map(connectionLine).join('\n') : '_None._'}`;
  return quoteLines(inner, newline) + newline + newline + `^${record.blockId}` + newline;
}
