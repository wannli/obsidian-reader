import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { MemoryVault } from './helpers/memory-vault';

it('rejects an oversized append before native dispatch so the previously readable notebook remains readable', async () => {
  const vault = new MemoryVault();
  const original = '---\nfileClass: Notebook\n---\n' + 'x'.repeat(1_999_900);
  const file = await vault.create('Book.md', original);
  const store = new ThinkingStore(vault);
  let dispatched = false;
  vault.process = async () => {
    dispatched = true;
    throw new Error('Must not dispatch');
  };
  const result = await store.comment({
    notebookPath: 'Book.md',
    body: 'This append exceeds the same bounded read contract.',
  });
  expect(result.status).toBe('failed');
  expect(dispatched).toBe(false);
  expect(await vault.read(file)).toBe(original);
  expect((await store.read('Book.md')).records).toEqual([]);
});
it('allocates around native anchors in newly authored content, not only preexisting notebook bytes', async () => {
  const vault = new MemoryVault();
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
  const result = await new ThinkingStore(vault).comment({
    notebookPath: 'Book.md',
    body: 'Authored block.\n\n^comment-1',
  });
  expect(result.status, result.message).toBe('saved');
  expect(result.affectedRecords?.[0].blockId).toMatch(/^comment-[a-f0-9]{32}$/);
  expect(result.affectedRecords?.[0].blockId).not.toBe('comment-1');
  expect(result.affectedRecords?.[0].body).toBe('Authored block.\n\n^comment-1');
});
