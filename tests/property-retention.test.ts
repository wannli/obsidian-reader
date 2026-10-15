// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  hasAnnotations,
  hasPropertyAnnotations,
  isAnnotationProperty,
} from '../src/core/annotations';
import { createDocument, patchProperties, readDocument } from '../src/core/document';
import type { Properties } from '../src/core/model';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

const authored: Properties[] = [
  { related: '[[Topics/X.md]]' },
  { related: ['No link', '[[Topics/X.md|X]]'] },
  { related: { links: [{ target: '[[Topics/X.md#Heading]]' }] } },
  { related: { title: '[[Topics/X.md]]' } },
  { 'title.related': '[[Topics/X.md]]' },
  { related: '[X](/Topics/X.md)' },
];
const sourceKeys = [
  'feed',
  'url',
  'title',
  'published',
  'error',
  'bookmark',
  'reading_position',
  'status',
];

async function article(properties: Properties = {}, body = 'Publisher excerpt.') {
  const vault = new MemoryVault(),
    store = new ArticleStore(vault);
  const fields = { type: 'article', published: '2026-08-01', ...properties, status: 'feed' };
  const file = await vault.create('Reading/Stream/260801 Article.md', createDocument(fields, body));
  store.catalog.update(file.path, fields);
  return { vault, store, file, snapshot: await store.read(file.path) };
}

describe('authored YAML link annotations', () => {
  it.each(authored)(
    'recognizes links in unknown scalar/list/nested properties: %j',
    (properties) => {
      expect(hasPropertyAnnotations({ type: 'article', ...properties })).toBe(true);
      expect(hasAnnotations('Unannotated text.', { type: 'article', ...properties })).toBe(true);
    },
  );

  it.each(sourceKeys)('ignores Reader-owned %s values and their cached descendant keys', (key) => {
    for (const type of ['article', 'feed']) {
      const properties = { type, [key]: { quote: ['literal [[Topics/X.md]]'] } };
      expect(hasPropertyAnnotations(properties)).toBe(false);
      expect(isAnnotationProperty(properties, key)).toBe(false);
      expect(isAnnotationProperty(properties, `${key}.quote.0`)).toBe(false);
      expect(isAnnotationProperty(properties, `${key}[0]`)).toBe(false);
    }
    expect(isAnnotationProperty({ type: 'article' }, 'type')).toBe(false);
  });

  it.each(sourceKeys)('does not suppress ordinary-note backlinks from a field named %s', (key) => {
    for (const properties of [{}, { type: 'topic' }]) {
      expect(isAnnotationProperty(properties, key)).toBe(true);
      expect(isAnnotationProperty(properties, `${key}.quote.0`)).toBe(true);
    }
  });

  it.each(['prefix', 'enabled'])('treats %s as source/state only on feed records', (key) => {
    expect(hasPropertyAnnotations({ type: 'feed', [key]: '[[Topics/X.md]]' })).toBe(false);
    expect(isAnnotationProperty({ type: 'feed' }, key)).toBe(false);
    expect(hasPropertyAnnotations({ type: 'article', [key]: '[[Topics/X.md]]' })).toBe(true);
    expect(isAnnotationProperty({ type: 'topic' }, key)).toBe(true);
  });

  it('retains authored literal dotted keys, without treating nested source fields as authored', () => {
    const properties = { type: 'article', 'title.related': '[[Topics/X.md]]' };
    expect(isAnnotationProperty(properties, 'title.related')).toBe(true);
    expect(
      isAnnotationProperty(
        { type: 'article', title: { related: '[[Topics/X.md]]' } },
        'title.related',
      ),
    ).toBe(false);
    expect(isAnnotationProperty({ type: 'article' }, 'related.title')).toBe(true);
  });

  it.each([
    'plain text',
    '==not a link==',
    'https://example.com',
    '[web](https://example.com)',
    '[toc](#section)',
    '[[#section]]',
    '[[https://example.com]]',
    '[scheme](%6aavascript%3Aalert)',
  ])('does not invent annotation heuristics for unrelated values: %s', (related) => {
    expect(hasPropertyAnnotations({ type: 'article', related })).toBe(false);
  });

  it('preserves the existing nonempty-array topics semantics', () => {
    expect(hasAnnotations('', { type: 'article', topics: ['Research'] })).toBe(true);
    expect(hasAnnotations('', { type: 'article', topics: [] })).toBe(false);
    expect(hasAnnotations('', { type: 'article', topics: '[[Topics/X.md]]' })).toBe(false);
  });

  it('visits shared/cyclic metadata once without recursive traversal', () => {
    const related: Record<string, unknown> = {};
    related.self = related;
    expect(hasPropertyAnnotations({ type: 'article', related })).toBe(false);
    related.link = '[[Topics/X.md]]';
    expect(hasPropertyAnnotations({ type: 'article', related })).toBe(true);
  });
});

describe('core YAML-link retention boundaries', () => {
  it.each(authored)(
    'promotes an aged Stream article with authored properties: %j',
    async (properties) => {
      const f = await article(properties),
        before = f.snapshot.raw;
      expect(await f.store.expire(new Date('2026-10-13'))).toEqual({
        deleted: 0,
        promoted: 1,
        retained: 0,
      });
      expect(f.file.path).toBe(f.snapshot.path);
      expect(readDocument(await f.vault.read(f.file)).properties).toEqual({
        ...readDocument(before).properties,
        status: 'later',
      });
      expect(readDocument(await f.vault.read(f.file)).body).toBe(readDocument(before).body);
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it.each(['', 'Publisher excerpt.'])(
    'rejects direct acquisition over YAML links even with exact excerpt proof (body=%s)',
    async (body) => {
      const f = await article({ related: { nested: ['[[Topics/X.md]]'] } }, body);
      await expect(
        f.store.acquire(f.snapshot, 'Replacement', 'Fetched title', body),
      ).rejects.toThrow('annotations are protected');
      expect(await f.vault.read(f.file)).toBe(f.snapshot.raw);
      expect(f.file.path).toBe(f.snapshot.path);
    },
  );

  it('does not protect the imported feed link or literal wiki syntax in source/position fields', async () => {
    const properties = Object.fromEntries(
      sourceKeys.map((key) => [key, '[[Reading/Stream/Target.md]]']),
    );
    const f = await article(properties);
    expect(await f.store.expire(new Date('2026-10-13'))).toEqual({
      deleted: 1,
      promoted: 0,
      retained: 0,
    });
    expect(f.vault.trashed).toEqual([f.snapshot.path]);
  });

  it('still acquires an exact excerpt with only feed and position references', async () => {
    const f = await article({
      feed: '[[Reading/Wires/Source.md]]',
      bookmark: 'quote:[[Topics/X.md]]',
    });
    const saved = await f.store.acquire(
      f.snapshot,
      'Replacement',
      'Fetched title',
      f.snapshot.body,
    );
    expect(saved.body).toBe('\nReplacement\n');
    expect(saved.properties.feed).toBe(f.snapshot.properties.feed);
    expect(saved.properties.bookmark).toBe(f.snapshot.properties.bookmark);
  });

  it('preserves an unknown-field link arriving at the final trash boundary and promotes on retry', async () => {
    const f = await article();
    f.vault.beforeTrash = async () => {
      f.vault.bytes.set(
        f.file,
        patchProperties(await f.vault.read(f.file), { related: { keep: '[[Topics/X.md]]' } }),
      );
    };
    expect(await f.store.expire(new Date('2026-10-13'))).toEqual({
      deleted: 0,
      promoted: 0,
      retained: 1,
    });
    const edited = await f.vault.read(f.file);
    expect(f.vault.trashed).toEqual([]);
    expect(await f.store.expire(new Date('2026-10-13'))).toEqual({
      deleted: 0,
      promoted: 1,
      retained: 0,
    });
    expect(readDocument(await f.vault.read(f.file)).properties).toEqual({
      ...readDocument(edited).properties,
      status: 'later',
    });
  });
});
