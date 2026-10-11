import { parseInlineMarkdown } from '../src/inline';
import { expect, it, vi } from 'vitest';
import { nativeStore, gate } from './helpers/native-store';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { mark } from './markdown-helpers';

const path = 'Reading/Inbox/Source.md', daily = 'Daily/old.md';
const raw = '---\ntype: article\n---\nReadable words.\n';
for (const operation of ['mark', 'link', 'unmark', 'unlink'] as const) {
  it(`${operation}: waits for durable article Markdown and never touches an open journal`, async () => {
    const f = nativeStore({ [path]: raw, [daily]: 'User journal writing.' });
    const repo = new ReaderRepository(f.store, DEFAULT_SETTINGS);
    if (operation !== 'mark') await mark(repo, path, { quote: 'Readable' });
    if (operation === 'unlink') {
      const article = await repo.getArticle(path); await repo.setHighlightLink(path, article.highlights[0].id, 'Target');
    }
    const article = await repo.getArticle(path), source = f.open(path), journal = f.open(daily), writing = gate();
    const before = f.disk.get(path); let acknowledged = false;
    source.view.gateSave = () => writing.promise;
    const promise = operation === 'mark' ? mark(repo, path, { quote: 'Readable' }) :
      operation === 'link' ? repo.setHighlightLink(path, article.highlights[0].id, 'Target') :
      operation === 'unmark' ? repo.deleteHighlight(path, article.highlights[0].id) : repo.deleteLink(path, parseInlineMarkdown(article.body, { stripTitle: article.title }).links[0].id);
    const outcome = promise.then(() => { acknowledged = true; });
    try {
      await vi.waitFor(() => expect(source.view.started).toHaveLength(1));
      expect(acknowledged).toBe(false); expect(f.disk.get(path)).toBe(before);
      expect(source.editor.value).not.toBe(before);
      writing.release(); await outcome;
      expect(f.disk.get(path)).toBe(source.editor.value); expect(acknowledged).toBe(true);
      expect(journal.view.save).not.toHaveBeenCalled(); expect(journal.editor.transaction).not.toHaveBeenCalled();
      expect(f.disk.get(daily)).toBe('User journal writing.');
      expect([...f.disk.keys()].sort()).toEqual([path, daily].sort());
      expect(source.editor.setValue).not.toHaveBeenCalled(); expect(source.editor.reloads).toBe(0);
    } finally { writing.release(); await outcome; }
  });
}
