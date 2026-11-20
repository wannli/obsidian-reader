import { expect, it, vi } from 'vitest';
import { hostFixture } from './helpers/reader-view-fixture';
import { patchProperties, readDocument } from '../src/core/document';
import { gate } from './helpers/memory-vault';

const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const rows = (f: ReturnType<typeof hostFixture>) =>
  [...f.view.contentEl.querySelectorAll<HTMLElement>('.reader-list-item')].map(
    (row) => row.dataset.readerPath,
  );
async function capture(
  f: ReturnType<typeof hostFixture>,
  name: string,
  body: string,
  extra: Record<string, unknown>,
) {
  const file = await f.note(`Elsewhere/${name}.md`, body);
  const raw = patchProperties(await f.vault.read(file), extra);
  f.vault.bytes.set(file, raw);
  file.stat.size = raw.length;
  f.store.catalog.update(file.path, readDocument(raw).properties);
  return file;
}
it('separates video and failed empty captures without writes, while retaining readable and pending captures', async () => {
  const f = hostFixture();
  const video = await capture(f, 'Video', '', { url: 'https://youtu.be/abc' });
  const failed = await capture(f, 'Failed', '', {
    url: 'https://example.com/fail',
    error: 'No text',
  });
  const pending = await capture(f, 'Pending', '', { url: 'https://example.com/pending' });
  const readable = await capture(f, 'Transcript', 'Saved transcript', {
    url: 'https://youtu.be/other',
  });
  const short = await capture(f, 'Short', 'A', { error: 'Old error' });
  const process = vi.spyOn(f.vault, 'process');
  f.view.showList('Inbox');
  await settle();
  expect(rows(f)).toEqual(expect.arrayContaining([pending.path, readable.path, short.path]));
  expect(rows(f)).not.toContain(video.path);
  expect(rows(f)).not.toContain(failed.path);
  f.view.showList('Needs attention');
  await settle();
  expect(rows(f).sort()).toEqual([failed.path, video.path].sort());
  expect(f.view.contentEl.textContent).toContain('Video without saved text');
  expect(f.view.contentEl.textContent).toContain('Text extraction failed');
  expect(process).not.toHaveBeenCalled();
  expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
});
it('keeps normal list navigation and direct-entry navigation clear of Needs attention', async () => {
  const f = hostFixture();
  const a = await capture(f, 'A', 'Text', {});
  await capture(f, 'B', '', { url: 'https://youtu.be/abc' });
  const c = await capture(f, 'C', 'Text', {});
  f.view.showList('Inbox');
  await settle();
  await f.view.openArticle(a.path, true);
  await f.view.navigate(1);
  expect(f.view.file).toBe(c);
  await f.view.openArticle(a.path);
  await f.view.navigate(1);
  expect(f.view.file).toBe(c);
});
it('skips a capture that fails after the browsing snapshot was created', async () => {
  const f = hostFixture();
  const a = await capture(f, 'A', 'Text', {});
  const b = await capture(f, 'B', '', { url: 'https://example.com/article' });
  const c = await capture(f, 'C', 'Text', {});
  f.view.showList('Inbox');
  await f.view.openArticle(a.path, true);
  await f.store.error(await f.store.read(b.path), 'Extraction failed');
  await f.view.navigate(1);
  expect(f.view.file).toBe(c);
});
it('shows recovery actions and automatically reclassifies manually added text on body-only changes', async () => {
  const f = hostFixture();
  const video = await capture(f, 'Video', '', { url: 'https://youtu.be/abc' });
  f.view.showList('Needs attention');
  await settle();
  await f.view.openArticle(video.path, true);
  expect(f.view.contentEl.querySelector('[aria-label="Open original"]')).not.toBeNull();
  expect(f.view.contentEl.querySelector('[aria-label="Retry"]')).not.toBeNull();
  expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
  await f.view.readingList('Needs attention');
  await settle();
  f.vault.bytes.set(video, (await f.vault.read(video)) + '\nManually saved transcript.');
  video.stat.mtime++;
  video.stat.size = (await f.vault.read(video)).length;
  await f.view.changed({ path: video.path, metadataChanged: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  expect(rows(f)).toEqual([]);
  f.view.showList('Inbox');
  await settle();
  expect(rows(f)).toEqual([video.path]);
  expect((await f.store.read(video.path)).properties.status).toBe('inbox');
});
it('keeps cancelled native scans in their two occupied slots and ignores late results', async () => {
  const f = hostFixture();
  for (let index = 0; index < 4; index++)
    await capture(f, `Video${index}`, '', { url: `https://youtu.be/id${index}` });
  const release = gate();
  const read = f.vault.read.bind(f.vault);
  let active = 0,
    maximum = 0,
    calls = 0;
  vi.spyOn(f.vault, 'read').mockImplementation(async (file) => {
    calls++;
    maximum = Math.max(maximum, ++active);
    await release.promise;
    try {
      return await read(file);
    } finally {
      active--;
    }
  });
  f.view.showList('Inbox');
  await settle();
  expect(calls).toBe(2);
  f.view.showList('Needs attention');
  await settle();
  expect(calls).toBe(2);
  release.resolve();
  await settle();
  expect(maximum).toBe(2);
  expect(f.view.getState().queue).toBe('Needs attention');
  expect(rows(f)).toHaveLength(4);
});
it('returns a successful Retry to Inbox without changing status or file location', async () => {
  const f = hostFixture();
  const file = await capture(f, 'Failed', '', {
    url: 'https://example.com/article',
    error: 'Failed',
  });
  f.host.ingestion.acquire.mockImplementation(async () => {
    await f.store.acquire(await f.store.read(file.path), 'Downloaded readable article.', 'Title');
  });
  f.view.showList('Needs attention');
  await settle();
  await f.view.openArticle(file.path, true);
  f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Retry"]')!.click();
  await settle();
  await f.view.readingList('Needs attention');
  await settle();
  expect(rows(f)).toEqual([]);
  f.view.showList('Inbox');
  await settle();
  expect(rows(f)).toEqual([file.path]);
  const saved = await f.store.read(file.path);
  expect(saved.properties.status).toBe('inbox');
  expect(saved.properties.error).toBeUndefined();
  expect(saved.path).toBe('Elsewhere/Failed.md');
});
it('keeps topic-filter results within the chosen derived list', async () => {
  const f = hostFixture();
  const file = await capture(f, 'Climate', '', { url: 'https://youtu.be/abc' });
  await capture(f, 'Other', '', { error: 'Failed' });
  f.probe.topicFilter = { label: 'Climate', terms: ['Climate'] };
  f.view.showList('Needs attention');
  await settle();
  expect(rows(f)).toEqual([file.path]);
  f.view.showList('Inbox');
  await settle();
  expect(rows(f)).toEqual([]);
});
it('leaves uncertain reads visible in Inbox rather than silently hiding them', async () => {
  const f = hostFixture();
  const file = await capture(f, 'Unreadable', '', { error: 'Failed' });
  vi.spyOn(f.vault, 'read').mockRejectedValue(new Error('Unavailable'));
  f.view.showList('Inbox');
  await settle();
  expect(rows(f)).toEqual([file.path]);
  f.view.showList('Needs attention');
  await settle();
  expect(rows(f)).toEqual([]);
  expect(f.view.contentEl.textContent).toContain('could not be checked');
});
