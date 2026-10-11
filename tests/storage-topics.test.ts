import { mark } from './markdown-helpers';
import { readNoteRaw, rawStore } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote, writeNote } from '../src/storage/markdown';
import { isArticleNote } from '../src/storage/classifier';

const articlePath = 'Reading/Inbox/Story.md';
const a = 'Topics/Philosophy.md', b = 'Elsewhere/Ecology.md', c = 'Topics/Technology.md';
const topicFiles = {
  [a]: '---\ntype: topic\n---\nPhilosophy notes.\n',
  [b]: '---\ntype: topic\nurl: https://example.com/topic\n---\nEcology notes.\n',
  [c]: '---\ntype: topic\n---\nTechnology notes.\n',
};
const body = '\n## Article\n\nPublisher text.\n\n## Topics\n\nPublisher-authored heading, not assignment metadata.\n\n## Comments\n\nMy personal comments.\n\n## Custom\n\nLeave this alone.\n';
function source(extra = '', content = body): string {
  return '---\ntype: article\nid: article-topic-test\nurl: https://example.com/story\nstatus: inbox\ncustom: keep\n' + extra + '---\n' + content;
}
function fixture(extra = '') {
  const store = new MemoryStore({ ...topicFiles, [articlePath]: source(extra) });
  return { store, repository: new ReaderRepository(store, DEFAULT_SETTINGS) };
}

describe('frontmatter-only article topics', () => {
  it('discovers explicit topic notes across the whole vault without turning them into Reader articles', async () => {
    const { store, repository } = fixture();
    await store.create('Reading/Articles/Topic.md', '---\ntype: topic\nurl: https://example.com/inside\n---\n');
    await store.create('Topics/Ordinary.md', '---\nurl: https://example.com/ordinary\n---\n');
    expect((await repository.listTopics()).map(item => item.path)).toEqual([b, 'Reading/Articles/Topic.md', a, c]);
    expect((await repository.listTopics()).find(item => item.path === a)?.title).toBe('Philosophy');
    expect((await repository.listArticles()).map(item => item.path)).toEqual([articlePath]);
    expect(isArticleNote('Reading/Articles/Topic.md', { type: 'topic', url: 'https://example.com/inside' })).toBe(false);
  });

  it('writes quoted native wikilinks only in YAML and preserves every body byte and all other files', async () => {
    const { store, repository } = fixture();
    const before = store.snapshot(), beforeNote = parseNote(before[articlePath]);
    const article = await repository.updateArticleTopics(articlePath, { add: [a, b, a] });
    const saved = store.snapshot(), afterNote = parseNote(saved[articlePath]);
    expect(article.topics).toEqual([a, b]);
    expect(saved[articlePath]).toContain('topics: [ "[[Topics/Philosophy]]", "[[Elsewhere/Ecology]]" ]');
    expect(afterNote.body).toBe(beforeNote.body);
    const { topics, ...properties } = parseNote(await readNoteRaw(store, articlePath)).doc.toJS();
    expect(topics).toEqual(['[[Topics/Philosophy]]', '[[Elsewhere/Ecology]]']);
    expect(properties).toEqual(beforeNote.doc.toJS());
    for (const path of Object.keys(before).filter(path => path !== articlePath)) expect(saved[path]).toBe(before[path]);
    expect(Object.keys(saved).sort()).toEqual(Object.keys(before).sort());
    expect(afterNote.doc.get('id')).toBe('article-topic-test');
    expect(afterNote.doc.get('status')).toBe('inbox');
    await repository.updateArticleTopics(articlePath, { add: [a, b] });
    expect(store.snapshot()).toEqual(saved);
  });

  it('preserves aliases, comments, and unsupported existing list values', async () => {
    const { store, repository } = fixture('topics:\n  - "[[Philosophy|Chosen words]]" # preserve alias\n  - old-category\n  - {custom: value}\n  - 42\n');
    const before = store.snapshot();
    expect((await repository.getArticle(articlePath)).topics).toEqual([a]);
    await repository.updateArticleTopics(articlePath, { add: [a] });
    expect(store.snapshot()).toEqual(before);
    await repository.updateArticleTopics(articlePath, { add: [b] });
    const note = parseNote(await readNoteRaw(store, articlePath));
    expect(note.doc.toJS().topics).toEqual(['[[Philosophy|Chosen words]]', 'old-category', { custom: 'value' }, 42, '[[Elsewhere/Ecology]]']);
    expect(await store.read(articlePath)).toContain('# preserve alias');
    await repository.updateArticleTopics(articlePath, { remove: [a, b] });
    expect(parseNote(await readNoteRaw(store, articlePath)).doc.toJS().topics).toEqual(['old-category', { custom: 'value' }, 42]);
  });

  it.each(['topics: "[[Philosophy]]"\n', 'topics: null\n', 'topics: {mine: keep}\n', 'topics: 42\n'])(
    'refuses scalar/non-list topics without any write: %s', async field => {
      const { store, repository } = fixture(field), before = store.snapshot();
      await expect(repository.updateArticleTopics(articlePath, { add: [a] })).rejects.toThrow('YAML list');
      expect(store.snapshot()).toEqual(before);
    },
  );

  it('does not emit an empty placeholder and removes the field after the last explicit removal', async () => {
    const { store, repository } = fixture();
    const original = store.snapshot();
    await repository.updateArticleTopics(articlePath, {});
    expect(store.snapshot()).toEqual(original);
    expect(parseNote(await readNoteRaw(store, articlePath)).doc.has('topics')).toBe(false);
    await repository.updateArticleTopics(articlePath, { add: [a] });
    await repository.updateArticleTopics(articlePath, { remove: [a] });
    expect(parseNote(await readNoteRaw(store, articlePath)).doc.has('topics')).toBe(false);
    expect(parseNote(await readNoteRaw(store, articlePath)).body).toBe(body);
    const fresh = await repository.createArticle({ title: 'Unassigned', url: 'https://example.com/new' });
    expect(fresh.topics).toEqual([]);
    expect(parseNote(await readNoteRaw(store, fresh.path)).doc.has('topics')).toBe(false);
  });

  it('validates additions, rejects overlapping deltas, and never creates target files', async () => {
    const { store, repository } = fixture();
    await store.create('Notes/Ordinary.md', 'Normal note.');
    const before = store.snapshot();
    for (const path of ['Topics/Missing.md', 'Notes/Ordinary.md', '../Unsafe.md'])
      await expect(repository.updateArticleTopics(articlePath, { add: [path] })).rejects.toThrow();
    await expect(repository.updateArticleTopics(articlePath, { add: [a], remove: [a] })).rejects.toThrow('both');
    expect(store.snapshot()).toEqual(before);
  });

  it('removes an explicit stale assignment without requiring its file to exist', async () => {
    const { store, repository } = fixture('topics: ["[[Gone/Old topic|Remembered name]]", "[[Philosophy]]"]\n');
    await repository.updateArticleTopics(articlePath, { remove: ['Gone/Old topic.md'] });
    expect(parseNote(await readNoteRaw(store, articlePath)).doc.toJS().topics).toEqual(['[[Philosophy]]']);
  });

  it('disambiguates same-named files with full paths without guessing ambiguous legacy links', async () => {
    const { store, repository } = fixture('topics: ["[[Shared|Legacy ambiguous label]]"]\n');
    await store.create('One/Shared.md', '---\ntype: topic\n---\n');
    await store.create('Two/Shared.md', '---\ntype: topic\n---\n');
    expect((await repository.getArticle(articlePath)).topics).toEqual([]);
    const result = await repository.updateArticleTopics(articlePath, { add: ['One/Shared.md', 'Two/Shared.md'] });
    expect(result.topics).toEqual(['One/Shared.md', 'Two/Shared.md']);
    expect(parseNote(await readNoteRaw(store, articlePath)).doc.toJS().topics).toEqual(['[[Shared|Legacy ambiguous label]]', '[[One/Shared]]', '[[Two/Shared]]']);
  });

  it('applies a delta to latest process content, preserving concurrent assignments and author changes', async () => {
    class ConcurrentStore extends MemoryStore {
      inject = false;
      override async process(path: string, update: (current: string) => string): Promise<void> {
        return super.process(path, current => {
          if (this.inject && path === articlePath) {
            this.inject = false;
            const note = parseNote(current);
            note.doc.set('topics', note.doc.createNode(['[[Philosophy]]', '[[Topics/Technology|Concurrent alias]]']));
            note.doc.set('user-change', 'preserved');
            note.body += '\nConcurrent author text.\n';
            current = writeNote(note);
          }
          return update(current);
        });
      }
    }
    const store = new ConcurrentStore({ ...topicFiles, [articlePath]: source('topics: ["[[Philosophy]]"]\n') });
    const repository = new ReaderRepository(store, DEFAULT_SETTINGS);
    store.inject = true;
    const result = await repository.updateArticleTopics(articlePath, { remove: [a], add: [b] });
    const note = parseNote(await readNoteRaw(store, articlePath));
    expect(result.topics).toEqual([c, b]);
    expect(note.doc.toJS().topics).toEqual(['[[Topics/Technology|Concurrent alias]]', '[[Elsewhere/Ecology]]']);
    expect(note.doc.get('user-change')).toBe('preserved');
    expect(note.body).toBe(body + '\nConcurrent author text.\n');
  });
  it('keeps protected source/fingerprints, highlight metadata/blocks, and daily notes unchanged', async () => {
    const { store, repository } = fixture();
    await mark(repository, articlePath, { quote: 'Publisher text.' });
    await rawStore(store).process(articlePath, current => {
      const note = parseNote(current);
      note.doc.set('content', 'protected'); note.doc.set('extractor', 'dummy');
      note.doc.set('sourceHash', 'a'.repeat(64)); note.doc.set('sourceLength', 15);
      note.doc.set('error', 'Keep my protection reason'); note.doc.set('retryAfter', '2030-01-01T00:00:00Z');
      return writeNote(note);
    });
    const before = store.snapshot(), prior = parseNote(await readNoteRaw(store, articlePath));
    const result = await repository.updateArticleTopics(articlePath, { add: [a] });
    const after = store.snapshot(), note = parseNote(await readNoteRaw(store, articlePath));
    const { topics: _topics, ...other } = note.doc.toJS();
    expect(other).toEqual(prior.doc.toJS());
    expect(note.body).toBe(prior.body);
    expect(result.content).toBe('protected');
    expect(after['Daily/2026-10-08.md']).toBe(before['Daily/2026-10-08.md']);
  });

  it.each(['topics: &shared ["[[Philosophy]]"]\nother: *shared\n', 'other: &shared ["[[Philosophy]]"]\ntopics: *shared\n'])(
    'refuses mutations of shared/aliased sequences without changing other user properties', async field => {
      const { store, repository } = fixture(field), before = store.snapshot();
      await expect(repository.updateArticleTopics(articlePath, { add: [b] })).rejects.toThrow();
      expect(store.snapshot()).toEqual(before);
    },
  );
});
