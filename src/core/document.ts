import { isMap, isNode, isScalar, isSeq, parseDocument, Scalar, type Document } from 'yaml';
import { deletedUrls, formatPublished, webUrl, type Properties } from './model';

interface ArticleDocument {
  raw: string;
  body: string;
  properties: Properties;
  headerEnd: number;
  yaml: Document;
}
export class ChangedNote extends Error {
  constructor(message = 'The note changed. Nothing was overwritten; reopen it and retry.') {
    super(message);
    this.name = 'ChangedNote';
  }
}
export function readDocument(raw: string): ArticleDocument {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match)
    throw new Error('Reader notes need YAML frontmatter. Ordinary notes are left untouched.');
  const yaml = parseDocument(match[1], { uniqueKeys: true, schema: 'core' });
  if (yaml.errors.length || yaml.warnings.length || !isMap(yaml.contents))
    throw new Error('Invalid or unsupported frontmatter; preserved the note.');
  const properties = yaml.toJS({ maxAliasCount: 20 }) as Properties;
  return { raw, body: raw.slice(match[0].length), properties, headerEnd: match[0].length, yaml };
}
export function requireArticle(raw: string): ArticleDocument {
  const doc = readDocument(raw);
  if (doc.properties.type !== 'article') throw new Error('Not an article; preserved the note.');
  return doc;
}
export function rememberDeletedUrl(raw: string, url: string): string {
  const doc = readDocument(raw);
  if (doc.properties.type !== 'feed') throw new ChangedNote('Not a subscription.');
  const urls = deletedUrls(doc.properties.deleted_urls);
  const normalized = webUrl(url);
  if (urls.includes(normalized)) return raw;
  // Keep existing sequence nodes (and their comments); normalize only the new entry.
  return patchProperties(raw, {
    deleted_urls: [...((doc.properties.deleted_urls as string[] | undefined) ?? []), normalized],
  });
}
export function replaceBody(raw: string, expectedBody: string, next: string): string {
  const doc = requireArticle(raw);
  if (doc.body !== expectedBody) throw new ChangedNote();
  return raw.slice(0, doc.headerEnd) + next;
}
function collectComments(node: unknown, comments: string[]): void {
  if (!isNode(node)) return;
  if (node.commentBefore != null) comments.push(node.commentBefore);
  if (isMap(node)) {
    for (const pair of node.items) {
      collectComments(pair.key, comments);
      collectComments(pair.value, comments);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) collectComments(item, comments);
  }
  if (node.comment != null) comments.push(node.comment);
}
export function patchProperties(raw: string, changes: Properties): string {
  const doc = readDocument(raw),
    yaml = doc.yaml.clone();
  const removedComments: string[] = [];
  let changed = false;
  for (const [key, value] of Object.entries(changes)) {
    if (JSON.stringify(doc.properties[key]) === JSON.stringify(value)) continue;
    changed = true;
    if (value === undefined) {
      // YAML deletion drops the entire pair. Keep key/value/descendant comments, without
      // following aliases into surviving fields or inventing a replacement property.
      const pair = isMap(yaml.contents)
        ? yaml.contents.items.find(
            (pair) => (isScalar(pair.key) ? pair.key.value : pair.key) === key,
          )
        : undefined;
      if (pair) {
        collectComments(pair.key, removedComments);
        collectComments(pair.value, removedComments);
      }
      yaml.delete(key);
    } else {
      const previous = yaml.get(key, true);
      const next = typeof value === 'string' ? new Scalar(value) : yaml.createNode(value);
      if (next instanceof Scalar && typeof value === 'string')
        next.type =
          key === 'published' && formatPublished(value) === value
            ? Scalar.PLAIN
            : Scalar.QUOTE_DOUBLE;
      if (isNode(previous)) {
        next.comment = previous.comment;
        next.commentBefore = previous.commentBefore;
        next.spaceBefore = previous.spaceBefore;
      }
      if (
        isSeq(previous) &&
        isSeq(next) &&
        Array.isArray(doc.properties[key]) &&
        Array.isArray(value)
      ) {
        const old = doc.properties[key] as unknown[];
        next.items = next.items.map((item, index) => {
          const match = old.findIndex(
            (candidate) => JSON.stringify(candidate) === JSON.stringify(value[index]),
          );
          return match >= 0 ? previous.items[match] : item;
        });
      }
      yaml.set(key, next);
    }
  }
  if (!changed) return raw;
  if (removedComments.length) {
    // Retain the existing document ending after the relocated comments, all inside YAML.
    if (yaml.comment != null) removedComments.push(yaml.comment);
    yaml.comment = removedComments.join('\n');
  }
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const header = yaml.toString({ lineWidth: 0 }).replace(/\r?\n/g, newline);
  const output = `${raw.startsWith('\uFEFF') ? '\uFEFF' : ''}---${newline}${header}---${newline}${doc.body}`;
  const verified = readDocument(output);
  for (const [key, value] of Object.entries(doc.properties)) {
    if (!(key in changes) && JSON.stringify(verified.properties[key]) !== JSON.stringify(value)) {
      throw new ChangedNote(
        'This property shares YAML anchors with other data. Preserved the note.',
      );
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (JSON.stringify(verified.properties[key]) !== JSON.stringify(value))
      throw new Error('Could not safely write frontmatter.');
  }
  return output;
}
export function createDocument(properties: Properties, body = ''): string {
  const empty = '---\ntype: article\n---\n';
  return patchProperties(empty, properties) + body;
}
export function readingMarker(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 256 || value.trim() !== value) return;
  return value;
}
export function savePosition(raw: string, marker: string): string {
  const doc = requireArticle(raw);
  if (readingMarker(marker) === undefined) throw new Error('Invalid reading position.');
  if (
    doc.properties.bookmark !== undefined &&
    readingMarker(doc.properties.bookmark) === undefined
  ) {
    throw new Error('Unsupported reading position; preserved the note.');
  }
  return patchProperties(raw, { bookmark: marker || undefined });
}
/** Recovering acquisition never treats arbitrary nonempty text as a disposable excerpt. */
export function acquireBody(
  raw: string,
  expectedRaw: string,
  markdown: string,
  title: string,
  provenExcerpt?: string,
): string {
  if (raw !== expectedRaw) throw new ChangedNote();
  const doc = requireArticle(raw);
  if (doc.body.trim() && (provenExcerpt === undefined || doc.body !== provenExcerpt)) {
    throw new Error(
      'Existing text is protected. Reader will not replace an unverified article body.',
    );
  }
  if (!markdown.trim()) throw new Error('No readable article text found.');
  const replaced = replaceBody(raw, doc.body, `\n${markdown.trim()}\n`);
  return patchProperties(replaced, {
    error: undefined,
    ...(!Object.hasOwn(doc.properties, 'title') && title.trim() ? { title: title.trim() } : {}),
  });
}
