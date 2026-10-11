import { expect, it } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';

const path = 'Reading/Inbox/Legacy.md';
const raw = '---\ntype: article\nhighlights: [{id: hl-old, pending: {op: link}}]\n---\n## Article\n\nText.\n\n> Text.\n\n^hl-old\n';

it('preserves pending legacy link work and quote/backlink bytes rather than repairing it', async () => {
  const store = new MemoryStore({ [path]: raw, 'Daily/2020-01-01.md': 'Edited journal [[Reading/Inbox/Legacy#^hl-old]].\n' });
  const before = store.snapshot(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  await repo.getArticle(path);
  await expect(repo.setStatus(path, 'later')).rejects.toThrow(/links|reference/i);
  expect(store.snapshot()).toEqual(before);
});
