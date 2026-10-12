import { afterEach, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { articleFrom } from '../src/storage/models';
import { parseNote } from '../src/storage/markdown';
import { parseInlineMarkdown } from '../src/inline/parser';
import { ReaderApp } from '../src/ui/app';
import { ReaderController } from '../src/controller';

const raw = (body: string) => `---\ntype: article\ntitle: Example\n---\n${body}`;
afterEach(() => vi.restoreAllMocks());

it('lists a large unhighlighted library without constructing DOM for every article', async () => {
  const body = '# Example\n\n' + 'Publisher **text** and [a link](https://example.com).\n\n'.repeat(20);
  const files = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`Reading/Stream/Article ${i}.md`, raw(body)]));
  for (let i = 0; i < 40; i++) files[`Feeds/Feed ${i}.md`] = `---\ntype: feed\ntitle: Feed ${i}\nurl: https://example.com/${i}\n---\n`;
  const repository = new ReaderRepository(new MemoryStore(files), DEFAULT_SETTINGS);
  const dom = vi.spyOn(document, 'createElement');
  const start = performance.now();
  const articles = await repository.listArticles();
  console.info('Synthetic library list:', { articles: articles.length, milliseconds: Math.round(performance.now() - start), domElements: dom.mock.calls.length });
  expect(articles).toHaveLength(300);
  expect(articles.every(article => article.body === body && article.highlights.length === 0)).toBe(true);
  // Operation count, not a machine-dependent timing budget. Rendering the active
  // reader still parses normally; listing should never render unmarked bodies.
  expect(dom.mock.calls.length).toBe(0);
});

it('does not construct remote image elements while listing unhighlighted feed articles', async () => {
  const path = 'Reading/Stream/Images.md';
  const body = '![photo](https://example.com/photo.jpg)\n\n<img src="https://example.com/logo.png">';
  const repository = new ReaderRepository(new MemoryStore({ [path]: raw(body) }), DEFAULT_SETTINGS);
  const dom = vi.spyOn(document, 'createElement');
  const [article] = await repository.listArticles();
  expect(article.body).toBe(body);
  expect(article.highlights).toEqual([]);
  expect(dom.mock.calls.length).toBe(0);
});

it('opens the default article in a large library without rendering the other bodies', async () => {
  const body = '# Example\n\n' + 'Publisher **text** and [a link](https://example.com).\n\n'.repeat(20);
  const files = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`Reading/Inbox/Article ${i}.md`, raw(body)]));
  for (let i = 0; i < 40; i++) files[`Feeds/Feed ${i}.md`] = `---\ntype: feed\ntitle: Feed ${i}\n---\n`;
  const store = new MemoryStore(files), repository = new ReaderRepository(store, DEFAULT_SETTINGS);
  // Background acquisition stays inactive; exercise real ReaderApp, repository,
  // parser and renderer without network, native Obsidian, or any vault access.
  const controller = new ReaderController(repository, vi.fn(), DEFAULT_SETTINGS);
  const reads = vi.spyOn(store, 'read'), dom = vi.spyOn(document, 'createElement');
  const root = document.createElement('div'); document.body.append(root);
  const start = performance.now();
  const reader = new ReaderApp(root, controller, { openNote: async () => {}, shouldFocus: () => false });
  try {
    await vi.waitFor(() => expect(root.querySelector('.r2-article-body')?.textContent).toContain('Publisher'));
    console.info('Synthetic default open:', { milliseconds: Math.round(performance.now() - start), reads: reads.mock.calls.length, domElements: dom.mock.calls.length });
    expect(reader.getArticle()?.path).toBe('Reading/Inbox/Article 0.md');
    // The active article still renders; cost must not include 300 offscreen DOMs.
    expect(dom.mock.calls.length).toBeLessThan(300);
  } finally { await reader.destroy(); await controller.shutdown(); root.remove(); }
});

it.each([
  'Plain **text**, [link](https://example.com), and &#61;&#61;entities&#61;&#61;.',
  '<mark>HTML is not a Reader highlight</mark>',
  'A ==plain highlight==.',
  'A ==🟡typed highlight==.',
  'A ==[linked highlight](Notes/Topic.md)==.',
  '`==code==` and \\==escaped==',
  '# Example\n\n==highlight after title==',
  '```\n==fenced==\n```\n\n==real highlight==',
])('preserves parser highlight semantics for %s', body => {
  const expected = parseInlineMarkdown(body, { stripTitle: 'Example' }).highlights;
  expect(articleFrom(parseNote(raw(body)), 'Reading/Inbox/Example.md').highlights).toEqual(expected);
});
