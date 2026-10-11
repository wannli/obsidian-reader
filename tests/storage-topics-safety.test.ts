import { readNoteRaw } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote, writeNote } from '../src/storage/markdown';
import { fingerprint } from '../src/storage/fingerprint';

const topic = 'Topics/Philosophy.md';
const topicNote = '---\ntype: topic\n---\nUser topic writing.\n';

describe('topic assignment source and YAML safety', () => {
  it('preserves a verifiably tracked legacy source including publisher-authored Topics headings as protected unknown text', async () => {
    const path = 'Reading/Inbox/Tracked.md';
    const body = 'Publisher text.\n\n## Topics\n\nA publisher-authored heading.';
    const raw = `---\ntype: article\nurl: https://example.com/tracked\nextractor: defuddle\ncontent: ready\nsourceLength: ${body.length}\nsourceHash: ${fingerprint(body)}\n---\n${body}`;
    const store = new MemoryStore({ [topic]: topicNote, [path]: raw });
    const repository = new ReaderRepository(store, DEFAULT_SETTINGS);
    const before = parseNote(await readNoteRaw(store, path));
    const result = await repository.updateArticleTopics(path, { add: [topic] });
    const after = parseNote(await readNoteRaw(store, path));
    expect(result.content).toBe('protected'); expect(result.extractor).toBe('manual');
    expect(after.body).toBe(before.body);
    expect(result.body).toBe((await repository.getArticle(path)).body);
    const { topics: _topics, ...other } = after.doc.toJS();
    expect(other).toEqual(before.doc.toJS());
  });

  it('preserves BOM, CRLF body bytes, and ordinary authored Topics/Comments sections', async () => {
    const path = 'Elsewhere/CRLF.md';
    const rawBody = '\r\n## Article\r\n\r\nSource.\r\n\r\n## Comments\r\n\r\nMine.\r\n\r\n## Topics\r\n\r\nMy body topic writing.\r\n';
    const store = new MemoryStore({ [topic]: topicNote, [path]: '\uFEFF---\r\ntype: article\r\nid: article-crlf-topic\r\nurl: https://example.com/crlf\r\n---\r\n' + rawBody });
    const repository = new ReaderRepository(store, DEFAULT_SETTINGS);
    await repository.updateArticleTopics(path, { add: [topic] });
    const saved = await store.read(path);
    expect(saved.startsWith('\uFEFF---\r\n')).toBe(true);
    expect(parseNote(saved).body).toBe(rawBody);
    await repository.updateArticleTopics(path, { remove: [topic] });
    expect(parseNote(await readNoteRaw(store, path)).body).toBe(rawBody);
  });

  it('preserves scalar YAML aliases while deriving their topic and avoids duplicate assignments', async () => {
    const path = 'Alias.md';
    const store = new MemoryStore({ [topic]: topicNote, [path]: '---\ntype: article\nid: article-alias-topic\nfavorite: &favorite "[[Philosophy|User label]]"\ntopics: [*favorite]\n---\nSource unchanged.\n' });
    const repository = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
    expect((await repository.getArticle(path)).topics).toEqual([topic]);
    await repository.updateArticleTopics(path, { add: [topic] });
    expect(store.snapshot()).toEqual(before);
    await repository.updateArticleTopics(path, { remove: [topic] });
    expect(parseNote(await readNoteRaw(store, path)).doc.toJS().favorite).toBe('[[Philosophy|User label]]');
    expect(parseNote(await readNoteRaw(store, path)).doc.has('topics')).toBe(false);
  });

  it('refuses removal of a topic defining an anchor used by another user property', async () => {
    const path = 'Anchored.md';
    const store = new MemoryStore({ [topic]: topicNote, [path]: '---\ntype: article\nid: article-anchored-topic\ntopics: [&favorite "[[Philosophy]]"]\nother: *favorite\n---\nSource.\n' });
    const repository = new ReaderRepository(store, DEFAULT_SETTINGS), before = store.snapshot();
    await expect(repository.updateArticleTopics(path, { remove: [topic] })).rejects.toThrow('YAML anchor');
    expect(store.snapshot()).toEqual(before);
  });

  it('rechecks topics shape against latest process content instead of overwriting a late scalar edit', async () => {
    const path = 'Late.md';
    class LateStore extends MemoryStore {
      inject = true;
      override async process(target: string, update: (current: string) => string): Promise<void> {
        if (this.inject && target === path) {
          this.inject = false;
          await super.process(target, current => {
            const note = parseNote(current); note.doc.set('topics', 'Late personal wording');
            return writeNote(note);
          });
        }
        await super.process(target, update);
      }
    }
    const store = new LateStore({ [topic]: topicNote, [path]: '---\ntype: article\nid: article-late-topic\n---\nSource.\n' });
    const repository = new ReaderRepository(store, DEFAULT_SETTINGS);
    await expect(repository.updateArticleTopics(path, { add: [topic] })).rejects.toThrow('YAML list');
    const note = parseNote(await readNoteRaw(store, path));
    expect(note.doc.get('topics')).toBe('Late personal wording');
    expect(note.body).toBe('Source.\n');
  });
});
