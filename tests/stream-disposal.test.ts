import { expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
const path = 'Reading/Stream/260820 RSS article.md';
const raw = '---\ntype: article\ntitle: RSS article\nurl: https://example.com/article\nfeed: "[[Reading/Wires/Example]]"\npublished: 2026-08-20\nsummary: Short excerpt\nreading_position: a paragraph\n---\n# RSS article\n\nFull RSS article, longer than the summary.\n\nMore publisher paragraphs and unmarked edits.\n\n[Read more](https://example.com/article) | [Unsubscribe](https://example.com/unsubscribe)\n';
async function fixture(text = raw) {
  const store = new MemoryStore(), repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS });
  await store.create(path, text);
  return { store, repo, candidate: { path, raw: text, generation: repo.articleGeneration(path) } };
}
it('shares full RSS body/footer eligibility for bulk and expired automatic cleanup, including valid position', async () => {
  const f = await fixture();
  expect((await f.repo.previewStreamTrash([f.candidate])).skipped).toBe(0);
  expect((await f.repo.cleanupStream(Date.parse('2026-10-12'))).deleted).toEqual([path]);
});
it.each([
  ['comment section', raw + '\n## Comments\nMy comment'],
  ['highlight', raw + '\n==Important=='],
  ['topics', raw.replace('type: article', 'type: article\ntopics: [Science]')],
  ['authors', raw.replace('type: article', 'type: article\nauthors: [Person]')],
  ['retired metadata', raw.replace('type: article', 'type: article\nsourceHash: historical')],
  ['unknown metadata', raw.replace('type: article', 'type: article\ncustom: authored')],
  ['unknown position', raw.replace('reading_position: a paragraph', 'reading_position: {version: 1}')],
  ['non-RSS manual prose', raw.replace('feed: "[[Reading/Wires/Example]]"\n', '')],
  ['authored layout', raw.replace('# RSS article', 'Authored introduction\n\n## Article') + '\n## Comments\nComment'],
  ['HTML comment', raw + '\n<!-- My comment -->'],
])('protects %s in both policies', async (_name, text) => {
  const f = await fixture(text);
  expect((await f.repo.previewStreamTrash([f.candidate])).skipped).toBe(1);
  expect((await f.repo.cleanupStream(Date.parse('2026-10-12'))).deleted).toEqual([]);
  // Annotated RSS notes may be promoted to Inbox, never trashed.
  expect((await f.store.list()).some(file => file.endsWith('RSS article.md'))).toBe(true);
});
it('incoming backlinks protect full RSS while ordinary outgoing publisher links do not', async () => {
  const f = await fixture(); await f.store.create('Journal.md', `[[${path}]]`);
  expect((await f.repo.previewStreamTrash([f.candidate])).skipped).toBe(1);
  expect((await f.repo.cleanupStream(Date.parse('2026-10-12'))).deleted).toEqual([]);
});
