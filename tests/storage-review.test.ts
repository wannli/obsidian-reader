import { expect, it } from 'vitest';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS } from '../src/types';
import { parseInlineMarkdown } from '../src/inline';
import { queued } from '../src/storage/safety';
import { newNote, writeNote } from '../src/storage/markdown';
import { sidecarPath } from './sidecar-helpers';

const path = 'Reading/Inbox/Review.md';
const repository = (store: MemoryStore) => new ReaderRepository(store, DEFAULT_SETTINGS);
const raw = (body: string, id = 'original') => writeNote(newNote({ type: 'article', title: 'Review', id, pullmanFormat: 'inline-v1', extractor: 'manual', content: 'ready' }, body));

it.each(['highlight', 'link', 'unhighlight', 'unlink', 'retarget', 'highlight-link'] as const)('rejects queued %s across delete/recreate with identical source', async operation => {
  const body = operation === 'unhighlight' || operation === 'highlight-link' ? '==word==' : operation === 'unlink' || operation === 'retarget' ? '[[Topic|word]]' : 'word';
  const store = new MemoryStore({ [path]: raw(body) }), repo = repository(store);
  const parsed = parseInlineMarkdown(body, { stripTitle: 'Review' });
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const held = queued(store, () => barrier);
  const selection = { quote: 'word', revision: parsed.revision };
  const job = operation === 'highlight' ? repo.addHighlight(path, selection)
    : operation === 'link' ? repo.addLink(path, selection, 'Topic')
    : operation === 'unhighlight' ? repo.deleteHighlight(path, parsed.highlights[0].id)
    : operation === 'highlight-link' ? repo.setHighlightLink(path, parsed.highlights[0].id, 'Other')
    : operation === 'unlink' ? repo.deleteLink(path, parsed.links[0].id)
    : repo.setLink(path, parsed.links[0].id, 'Other');
  const outcome = job.then(() => undefined, error => error);
  // Model the synchronous native-delete invalidation and replacement write.
  await repo.articleDeleted(path);
  const replacement = raw(body, 'replacement');
  await store.process(path, () => replacement);
  release(); await held;
  expect(await outcome).toBeInstanceOf(Error);
  expect(await store.read(path)).toBe(replacement);
});

it.each(['- ==authored highlight==', '> ==authored highlight==', '==math $x$ highlight=='])('does not replace unsupported authored marks in a summary: %s', async body => {
  const store = new MemoryStore(), repo = repository(store);
  const article = await repo.createArticle({ title: 'Review', url: 'https://example.com/review', body, extractor: 'summary', content: 'partial' });
  expect(parseInlineMarkdown(article.body).hasUnsupportedHighlights).toBe(true);
  const result = await repo.saveContent(article.path, { title: 'Fetched', markdown: 'Replacement publisher text.', status: 'ready', extractor: 'defuddle' });
  expect(result.body).toBe(body);
  expect(result.content).toBe('protected');
});

it('retains legacy JSON when the converted durable body changes but its receipt survives', async () => {
  const jsonPath = sidecarPath(path);
  const legacyRaw = '---\ntype: article\ntitle: Review\n---\n## Highlights\n\n> word\n\n^hl-old\n\n## Article\n\nword\n';
  const legacyJson = JSON.stringify({ schema: 1, path, metadata: { id: 'legacy', highlights: [{ id: 'hl-old', created: '2026-10-09T00:00:00.000Z', day: '2026-10-09', dailyPath: '' }] } });
  class ChangedDurableStore extends MemoryStore {
    override async read(file: string) {
      const current = await super.read(file);
      if (file === path && current.includes('pullmanLegacyHash:')) {
        // Sync/native writer lands after acknowledged process, before durable verification.
        const changed = current.replace('==word==', 'word').replace('id: legacy\n', '');
        await super.process(file, () => changed);
        return changed;
      }
      return current;
    }
  }
  const store = new ChangedDurableStore({ [path]: legacyRaw, [jsonPath]: legacyJson });
  const result = await repository(store).prepareStorage();
  expect(result.errors.length).toBeGreaterThan(0);
  expect(await store.read(jsonPath)).toBe(legacyJson);
});

it('reports unknown historical JSON fields without changing its exact bytes', async () => {
  const jsonPath = sidecarPath(path);
  const note = '---\ntype: article\n---\nReadable words.';
  const json = JSON.stringify({ schema: 1, path, metadata: {}, pendingOperation: { kind: 'unrecognized', payload: 'must survive' } });
  const store = new MemoryStore({ [path]: note, [jsonPath]: json }), before = store.snapshot();
  const report = await repository(store).prepareStorage();
  expect(report.errors.length).toBeGreaterThan(0);
  await expect(repository(store).setArticleError(path, 'blocked')).rejects.toThrow(/blocked|legacy/i);
  expect(store.snapshot()).toEqual(before);
});
