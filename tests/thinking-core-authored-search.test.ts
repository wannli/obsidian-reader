import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { MemoryVault } from './helpers/memory-vault';

it('searches authored notebook regions around entries without reporting record text twice', async () => {
  const vault = new MemoryVault();
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\nMy authored telescope question.\n');
  const store = new ThinkingStore(vault);
  const saved = await store.comment({ notebookPath: 'Book.md', body: 'A saved neutrino thought.' });
  const file = saved.document!.file;
  await vault.process(file, (raw) => raw + '\nMy later authored comet question.\n');
  const before = (await store.read('Book.md')).raw;
  for (const query of ['telescope', 'comet']) {
    const result = await store.search(['Book.md'], query);
    expect(result.complete).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ path: 'Book.md', evidence: 'literal' });
    expect(result.hits[0].record).toBeUndefined();
    expect(result.hits[0].text).toContain(query);
    expect(result.hits[0].text).not.toContain('A saved neutrino thought.');
  }
  const recordOnly = await store.search(['Book.md'], 'neutrino');
  expect(recordOnly.hits).toHaveLength(1);
  expect(recordOnly.hits[0].record?.body).toBe('A saved neutrino thought.');
  expect((await store.read('Book.md')).raw).toBe(before);
});
