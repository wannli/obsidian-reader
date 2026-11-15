import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

export async function fixture() {
  const vault = new MemoryVault();
  const article = await vault.create(
    'Source.md',
    '---\ntype: article\nstatus: later\nurl: https://example.org/article\n---\n\nBefore. Exact **selected words** and `code` with [links](https://example.org). After.\n',
  );
  await vault.create('Notebook.md', '---\nfileClass: Notebook\n---\nUntouched prose.\n');
  const articles = new ArticleStore(vault);
  const source = await articles.read(article.path);
  const thinking = new ThinkingStore(vault, {
    now: () => new Date(2026, 10, 15),
    retainSource: async (snapshot, guard) => {
      guard();
      await articles.validate(snapshot);
      return snapshot;
    },
  });
  return { vault, article, articles, source, thinking };
}
it('keeps a rich selection and attached personal comment in one notebook write, without touching the article', async () => {
  const { thinking, source, vault, article } = await fixture();
  const from = source.body.indexOf('Exact'),
    to = source.body.indexOf(' After.');
  const result = await thinking.keep({
    notebookPath: 'Notebook.md',
    source,
    from,
    to,
    comment: 'My **own** words.',
  });
  expect(result.status).toBe('saved');
  const reopened = await thinking.read('Notebook.md');
  expect(reopened.records.map((record) => record.body)).toEqual([
    'Exact **selected words** and `code` with [links](https://example.org).',
    'My **own** words.',
  ]);
  expect(reopened.records[1].about).toMatchObject({
    path: 'Notebook.md',
    blockId: reopened.records[0].blockId,
  });
  expect(reopened.raw.startsWith('---\nfileClass: Notebook\n---\nUntouched prose.\n')).toBe(true);
  expect(await vault.read(article)).toBe(source.raw);
});
it('includes an original in an exploration without copying it and duplicate inclusion is a no-op', async () => {
  const { thinking, vault } = await fixture();
  await vault.create('Explore.md', '---\nfileClass: Exploration\n---\nMy unfinished question.\n');
  const saved = await thinking.comment({
    notebookPath: 'Notebook.md',
    body: 'An independent thought.',
  });
  expect(saved.status).toBe('saved');
  const target = { path: 'Notebook.md', blockId: saved.records[0].blockId };
  const included = await thinking.editExploration({
    document: await thinking.read('Explore.md'),
    action: 'add',
    target,
  });
  expect(included.status).toBe('saved');
  expect(included.document?.raw).toContain(`- [[Notebook.md#^comment-1]]`);
  expect(included.document?.raw).not.toContain('An independent thought.');
  const again = await thinking.editExploration({
    document: await thinking.read('Explore.md'),
    action: 'add',
    target,
  });
  expect(again.status).toBe('unchanged');
});
