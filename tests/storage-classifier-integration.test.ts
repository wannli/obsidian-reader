import { parseInlineMarkdown } from '../src/inline';
import { mark } from './markdown-helpers';
import { readNoteRaw } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS as BASE_SETTINGS } from '../src/types';
const DEFAULT_SETTINGS = BASE_SETTINGS;
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { newNote, parseNote, writeNote } from '../src/storage/markdown';
import { isArticleNote } from '../src/storage/classifier';

const path = 'Reading/Inbox/Minimal.md';
const template = 'Templates/Reader/Article.md';
const topic = 'Topics/Philosophy.md';
const body = '## Article\n\n## Comments\n\nPersonal comments.\n';
const minimal = () => writeNote(newNote({ type: 'article', url: 'https://example.com/minimal', custom: 'keep' }, body));
const templateNote = () => writeNote(newNote({ type: 'article', status: 'inbox', url: '{{VALUE:url|label:Article URL}}', title: '{{VALUE:articleTitle|optional}}' }, body + '\n{{CURSOR}}\n'));
const result = { title: 'Publisher', markdown: 'selected text', status: 'ready' as const, extractor: 'defuddle' as const };

function fixture() {
  const store = new MemoryStore({ [path]: minimal(), [template]: templateNote(), [topic]: '---\ntype: topic\n---\nPhilosophy.\n' });
  return { store, repo: new ReaderRepository(store, DEFAULT_SETTINGS) };
}

describe('shared article classification in production repository paths', () => {
  it('discovers typed articles while excluding templates, URL-only notes, and other types', async () => {
    const { store, repo } = fixture();
    await store.create('Elsewhere/Manual.md', '---\ntype: article\n---\nAuthored manual text.');
    await store.create('Reading/Articles/Topic.md', '---\ntype: topic\nurl: https://example.com/topic\n---\n');
    await store.create('Elsewhere/Normal.md', writeNote(newNote({ url: 'https://example.com/ordinary' }, body)));
    await store.create('Reading/Articles-neighbor/Normal.md', minimal());
    expect((await repo.listArticles()).map(article => article.path).sort()).toEqual([path]);
    expect(await repo.getArticle(path)).toMatchObject({ status: 'inbox', extractor: 'pending', body: '' });
    expect(await repo.getArticle('Elsewhere/Manual.md')).toMatchObject({ url: '', extractor: 'manual', status: undefined });
    await expect(repo.getArticle(template)).rejects.toThrow();
    await expect(repo.getArticle('Reading/Articles/Topic.md')).rejects.toThrow();
    await expect(repo.getArticle('Elsewhere/Normal.md')).rejects.toThrow();
  });

  it('supports acquisition, topics, highlight/link/delete, status and error mutations on explicitly typed articles', async () => {
    const { store, repo } = fixture();
    await repo.saveContent(path, result);
    const acquired = await repo.getArticle(path);
    expect(acquired.body).toBe('selected text');
    await repo.updateArticleTopics(path, { add: [topic] });
    const highlighted = await mark(repo, path, { quote: 'selected text' });
    const linked = await repo.setHighlightLink(path, highlighted.highlights[0].id, 'Target note');
    await repo.deleteLink(path, parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links[0].id);
    const moved = await repo.setStatus(path, 'later');
    await repo.setArticleError(moved.path, 'Retry later', '2030-01-01T00:00:00Z');
    const note = parseNote(await readNoteRaw(store, moved.path));
    expect(note.doc.get('type')).toBe('article');
    expect(note.doc.get('custom')).toBe('keep');
    expect(note.doc.has('status')).toBe(false);
    expect(moved.status).toBe('later');
    expect(note.body).toContain('Personal comments.');
    expect((await repo.getArticle(moved.path)).body).toBe(acquired.body);
    expect((await repo.getArticle(moved.path)).topics).toEqual([topic]);
  });

  it('preserves raw unfamiliar status during unrelated mutations', async () => {
    const { store, repo } = fixture();
    await store.process(path, raw => { const note = parseNote(raw); note.doc.set('status', 'personal-state'); return writeNote(note); });
    expect((await repo.getArticle(path)).status).toBe('inbox');
    await repo.updateArticleTopics(path, { add: [topic] });
    expect(parseNote(await readNoteRaw(store, path)).doc.get('status')).toBe('personal-state');
  });

  it('refuses every article mutation against unresolved QuickAdd templates without adding failure metadata', async () => {
    const { store, repo } = fixture(), before = store.snapshot();
    const attempts = [
      () => repo.setArticleError(template, 'Only absolute HTTP(S) URLs are supported.', '2030-01-01T00:00:00Z'),
      () => repo.setStatus(template, 'later'),
      () => repo.saveContent(template, result),
      () => repo.updateArticleTopics(template, { add: [topic] }),
      () => mark(repo, template, { quote: 'template' }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow();
    expect(store.snapshot()).toEqual(before);
  });
  it('vetoes a late error mutation when latest process content has become a template', async () => {
    class LateStore extends MemoryStore {
      inject = true;
      override async process(target: string, update: (current: string) => string): Promise<void> {
        if (this.inject && target === path) {
          this.inject = false;
          await super.process(target, raw => { const note = parseNote(raw); note.doc.set('url', '{{VALUE:url}}'); return writeNote(note); });
        }
        await super.process(target, update);
      }
    }
    const store = new LateStore({ [path]: minimal() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await expect(repo.setArticleError(path, 'Late failure', '2030-01-01T00:00:00Z')).rejects.toThrow();
    const note = parseNote(await readNoteRaw(store, path));
    expect(note.doc.get('url')).toBe('{{VALUE:url}}');
    for (const field of ['id', 'error', 'content', 'retryAfter']) expect(note.doc.has(field)).toBe(false);
    expect(note.body).toBe(body);
  });

  it('typed article annotations never invoke a retired daily writer', async () => {
    class NoDaily extends MemoryStore {
      override async create(target: string, value: string) {
        if (target.startsWith('Daily/')) throw new Error('No journal writes allowed');
        return super.create(target, value);
      }
    }
    const store = new NoDaily({ [path]: minimal() }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repo.saveContent(path, result);
    await mark(repo, path, { quote: 'selected text' });
    expect(await store.exists('Daily/day.md')).toBe(false);
  });
  it('highlighting one article does not mutate other typed article notes', async () => {
    const { store, repo } = fixture(), other = 'Reading/Articles/Other.md';
    await store.create(other, minimal().replace('example.com/minimal', 'example.com/other'));
    await repo.saveContent(path, result); const before = await store.read(other);
    await mark(repo, path, { quote: 'selected text' });
    expect(await store.read(other)).toBe(before);
  });
  it.each(['{{VALUE:url|label:Article URL}}', '{{URL}}', '<% tp.system.prompt("URL") %>', '${url}'])(
    'rejects unresolved identity metadata before explicit type allowance: %s', url => {
      expect(isArticleNote(template, { type: 'article', url })).toBe(false);
      expect(isArticleNote(template, { type: 'article', url: '', title: url })).toBe(false);
      expect(isArticleNote(template, { type: 'article' })).toBe(true);
    },
  );
});
