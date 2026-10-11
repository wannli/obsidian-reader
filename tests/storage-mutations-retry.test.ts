import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { mark } from './markdown-helpers';

for (const op of ['link', 'unmark'] as const) {
  it(`${op}: rejected single-note write leaves source intact and can retry with current revision`, async () => {
    class FaultStore extends MemoryStore {
      fail = false;
      override async process(path: string, update: (raw: string) => string) {
        if (this.fail) { this.fail = false; throw new Error('Write refused'); }
        return super.process(path, update);
      }
    }
    const store = new FaultStore({ 'Daily/old.md': 'User journal.' }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const article = await repo.createArticle({ title: 'Source', url: '', body: 'Selected words.' });
    const saved = await mark(repo, article.path, { quote: 'Selected' });
    const change = (r: ReaderRepository, id: string) => op === 'link' ? r.setHighlightLink(article.path, id, 'Target') : r.deleteHighlight(article.path, id);
    const before = store.snapshot(); store.fail = true;
    await expect(change(repo, saved.highlights[0].id)).rejects.toThrow('Write refused');
    expect(store.snapshot()).toEqual(before);
    const restarted = new ReaderRepository(store, DEFAULT_SETTINGS);
    await change(restarted, (await restarted.getArticle(article.path)).highlights[0].id);
    expect((await restarted.getArticle(article.path)).body).toBe(op === 'link' ? '[[Target|Selected]] words.' : 'Selected words.');
    expect(await store.read('Daily/old.md')).toBe('User journal.');
    expect(Object.keys(store.snapshot()).sort()).toEqual(['Daily/old.md', article.path].sort());
  });
  it(`${op}: concurrent source edit is preserved rather than replaying stale intent`, async () => {
    const store = new MemoryStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    const article = await repo.createArticle({ title: 'Source', url: '', body: 'Selected words.' });
    const saved = await mark(repo, article.path, { quote: 'Selected' });
    await store.process(article.path, raw => raw + '\nUser typed here.');
    const before = store.snapshot();
    await expect(op === 'link' ? repo.setHighlightLink(article.path, saved.highlights[0].id, 'Target') : repo.deleteHighlight(article.path, saved.highlights[0].id)).rejects.toThrow(/changed/i);
    expect(store.snapshot()).toEqual(before);
  });
}
