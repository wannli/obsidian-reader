import { hostFixture } from './helpers/reader-view-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { feedAge, feedExcerpt, readTriageFlags, saveTriageFlag } from '../src/reader/feed-triage';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());
const action = (f: ReturnType<typeof hostFixture>, name: string) =>
  f.view.contentEl.querySelector<HTMLButtonElement>(`[data-triage-action="${name}"]`)!;

it('defaults off, toggles independently, and fails closed when local storage is unavailable', () => {
  expect(readTriageFlags()).toEqual({ feedPreviews: false, feedTouchActions: false });
  saveTriageFlag('feedPreviews', true);
  expect(readTriageFlags()).toEqual({ feedPreviews: true, feedTouchActions: false });
  saveTriageFlag('feedTouchActions', true);
  saveTriageFlag('feedPreviews', false);
  expect(readTriageFlags()).toEqual({ feedPreviews: false, feedTouchActions: true });
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('Unavailable');
    },
  });
  expect(readTriageFlags()).toEqual({ feedPreviews: false, feedTouchActions: false });
});
it('bounds and flattens saved Markdown excerpts and handles missing or future publication dates', () => {
  expect(
    feedExcerpt(
      '# Heading\n\n**Words** [here](https://example.com) [[Node|label]] ![image](https://example.com/image)',
    ),
  ).toBe('Heading Words here label');
  expect(feedExcerpt('x'.repeat(20000))).toHaveLength(280);
  expect(feedAge(undefined)).toBe('');
  expect(feedAge('invalid')).toBe('');
  expect(feedAge('2026-01-01', Date.parse('2026-01-03'))).toBe('2 days ago');
  expect(feedAge('2026-01-04', Date.parse('2026-01-03'))).toBe('2026-01-04');
});
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'gates Feed previews (%s) and actions (%s) independently and leaves other queues unchanged',
  async (previews, touch) => {
    const f = hostFixture();
    await f.note('Reading/Stream/A.md');
    await f.note('Reading/Inbox/B.md');
    saveTriageFlag('feedPreviews', previews);
    saveTriageFlag('feedTouchActions', touch);
    f.view.showList('Feed');
    expect(!!f.view.contentEl.querySelector('.reader-row-excerpt')).toBe(previews);
    expect(!!f.view.contentEl.querySelector('.reader-triage-actions')).toBe(touch);
    const open = vi.spyOn(f.view, 'openArticle').mockResolvedValue();
    f.view.contentEl.querySelector<HTMLButtonElement>('.reader-list-item')!.click();
    expect(open).toHaveBeenCalledTimes(touch ? 0 : 1);
    f.view.showList('Inbox');
    expect(f.view.contentEl.querySelector('.reader-row-excerpt,.reader-triage-actions')).toBeNull();
    saveTriageFlag('feedPreviews', false);
    saveTriageFlag('feedTouchActions', false);
    f.view.showList('Feed');
    expect(f.view.contentEl.querySelector('.reader-row-excerpt,.reader-triage-actions')).toBeNull();
  },
);
it('Next only changes selection, stops at the end, and Open remains explicit', async () => {
  const f = hostFixture();
  const first = await f.note('Reading/Stream/A.md');
  const second = await f.note('Reading/Stream/B.md');
  const before = [await f.vault.read(first), await f.vault.read(second)];
  saveTriageFlag('feedTouchActions', true);
  f.view.showList('Feed');
  const open = vi.spyOn(f.view, 'openArticle').mockResolvedValue();
  action(f, 'Next').click();
  expect(f.probe.listSelectedPath).toBe(second.path);
  expect(action(f, 'Next').disabled).toBe(true);
  expect(open).not.toHaveBeenCalled();
  expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
  expect([await f.vault.read(first), await f.vault.read(second)]).toEqual(before);
  action(f, 'Open').click();
  expect(open).toHaveBeenCalledWith(second.path, true);
});
it('keeps Enter opening the selected article with touch triage enabled', async () => {
  const f = hostFixture();
  const file = await f.note('Reading/Stream/A.md');
  saveTriageFlag('feedTouchActions', true);
  f.view.showList('Feed');
  const open = vi.spyOn(f.view, 'openArticle').mockResolvedValue();
  f.view.key(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  expect(open).toHaveBeenCalledWith(file.path, true);
});
it('Later advances using existing writes, and Delete protects annotated articles', async () => {
  const f = hostFixture();
  const first = await f.note('Reading/Stream/A.md');
  const second = await f.note('Reading/Stream/B.md', '==Keep this quotation==');
  saveTriageFlag('feedTouchActions', true);
  f.view.showList('Feed');
  action(f, 'Later').click();
  await f.probe.operations;
  expect(f.store.catalog.article(first.path)?.queue).toBe('Later');
  expect(f.probe.listSelectedPath).toBe(second.path);
  expect(action(f, 'Delete').disabled).toBe(false);
  action(f, 'Delete').click();
  await f.probe.operations;
  expect(f.store.catalog.article(second.path)?.queue).toBe('Archive');
  expect(f.vault.trashed).toEqual([]);
  for (const name of ['Open', 'Later', 'Next', 'Delete'])
    expect(action(f, name).disabled).toBe(true);
});
it('Next extends the mounted list at the pagination boundary', async () => {
  const f = hostFixture();
  for (let i = 0; i < 51; i++) await f.note(`Reading/Stream/${String(i).padStart(2, '0')}.md`);
  saveTriageFlag('feedTouchActions', true);
  f.view.showList('Feed');
  const rows = f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-list-item');
  rows[49].click();
  action(f, 'Next').click();
  expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(51);
  expect(f.probe.listSelectedPath).toBe('Reading/Stream/50.md');
});
