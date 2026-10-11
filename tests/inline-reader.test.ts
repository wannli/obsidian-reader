import { afterEach, expect, it, vi } from 'vitest';
import type { Article, CompactAnchor } from '../src/types';
import type { ReaderController } from '../src/controller';
import { renderArticle } from '../src/ui/render';
import { mountReader, type ReaderHost } from '../src/ui/reader';
import { parseInlineMarkdown } from '../src/inline/parser';
import { addInlineHighlight, removeInlineHighlight, setInlineHighlightLink, setInlineLink, removeInlineLink } from '../src/inline/edit';
import { buildCanonicalTextIndex, rangeFromPosition } from '../src/highlights/text-index';
const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(source = 'one two three', extra: Partial<ReaderHost> = {}) {
  vi.useFakeTimers();
  let generation = 0;
  let article: Article = { path: 'Reading/Inbox/Test.md', id: 'test', title: 'Test', body: source, highlights: [], url: '', status: 'inbox', content: 'ready', extractor: 'manual' };
  const target = document.createElement('div'); document.body.append(target);
  const options = { stripTitle: article.title };
  function update(body: string) { article = { ...article, body, highlights: parseInlineMarkdown(body, options).highlights }; return article; }
  update(source);
  const api = {
    settings: {},
    repository: { articleGeneration: () => generation, getArticle: async () => article },
    highlight: vi.fn(async (_path: string, quote: string, anchor: CompactAnchor) => update(addInlineHighlight(article.body, { quote, anchor }, options))),
    linkHighlight: vi.fn(async (_path: string, id: string, link: string) => update(setInlineHighlightLink(article.body, id, link, options))),
    deleteHighlight: vi.fn(async (_path: string, id: string) => update(removeInlineHighlight(article.body, id, options))),
    setLinkTarget: vi.fn(async (_path: string, id: string, link: string) => update(setInlineLink(article.body, id, link, options))),
    unlink: vi.fn(async (_path: string, id: string) => update(removeInlineLink(article.body, id, options))),
    capture: vi.fn(async () => article),
  };
  const host = { openNote: vi.fn(), ...extra };
  const mount = mountReader(target, article, api as unknown as ReaderController, host, () => {}); stops.push(mount);
  const body = target.querySelector<HTMLElement>('.r2-article-body')!;
  const choose = (start: number, end: number) => {
    const range = rangeFromPosition(buildCanonicalTextIndex(body), { start, end });
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); return range;
  };
  const collapse = () => { document.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); };
  const button = (text: string) => [...target.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
  return { target, body, api, host, mount, choose, collapse, button, article: () => article, invalidate: () => generation++, external: (body: string) => { mount.update!(update(body)); } };
}
it('renders native highlights, internal and external links safely with source headings retained', () => {
  const target = document.createElement('div');
  const parsed = renderArticle('# Title\n\n==Text== [[Some note|words]] [site](https://example.com)\n\n<script>alert(1)</script>', target);
  expect(target.querySelector('h1')?.textContent).toBe('Title');
  expect(target.querySelector('mark')?.textContent).toBe('Text');
  expect(target.querySelector('.internal-link')?.getAttribute('href')).toBe('Some note');
  expect(target.querySelector('a[target="_blank"]')?.getAttribute('rel')).toBe('noopener noreferrer');
  expect(target.querySelector('script')).toBeNull(); expect(parsed.links).toHaveLength(2);
});
it('reparses mapping options and invalidates menu IDs when only the title changes', async () => {
  const f = fixture('# Test\n\n==one== two');
  expect(f.body.querySelector('h1')).toBeNull();
  f.body.querySelector('mark')!.click(); const remove = f.button('Remove highlight');
  f.mount.update!({ ...f.article(), title: 'Other title' }); remove.click(); await vi.advanceTimersByTimeAsync(1);
  const parsed = parseInlineMarkdown(f.article().body, { stripTitle: 'Other title' });
  expect(f.api.deleteHighlight).not.toHaveBeenCalled(); expect(f.body.querySelector('h1')?.textContent).toBe('Test');
  expect(f.body.dataset.articleVersion).toBe(parsed.revision); expect(f.body.querySelector('mark')?.dataset.inlineHighlightId).toBe(parsed.highlights[0].id);
});
it('autosaves only source syntax and retains native range/DOM/scroll', async () => {
  const f = fixture(), scroller = f.target.querySelector<HTMLElement>('.r2-reader-scroll')!; scroller.scrollTop = 120;
  const node = f.body.firstChild, range = f.choose(0, 3);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.article().body).toBe('==one== two three'); expect(f.api.highlight).toHaveBeenCalledTimes(1);
  expect(f.api.highlight.mock.calls[0]).toHaveLength(3);
  expect(f.body.firstChild).toBe(node); expect(document.getSelection()?.getRangeAt(0)).toBe(range); expect(scroller.scrollTop).toBe(120);
  document.dispatchEvent(new Event('selectionchange')); await vi.advanceTimersByTimeAsync(1200); expect(f.api.highlight).toHaveBeenCalledTimes(1);
  f.collapse(); expect(f.body.querySelector('mark')?.textContent).toBe('one');
});
it('serializes settled selections and rebinds unchanged canonical text after its own write', async () => {
  const f = fixture(); let release!: () => void;
  const original = f.api.highlight.getMockImplementation()!;
  f.api.highlight.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return original(...args); });
  f.choose(0, 3); await vi.advanceTimersByTimeAsync(1000); f.choose(4, 7); await vi.advanceTimersByTimeAsync(1000);
  expect(f.api.highlight).toHaveBeenCalledTimes(1); release(); await vi.advanceTimersByTimeAsync(1);
  expect(f.api.highlight).toHaveBeenCalledTimes(2); expect(f.article().body).toBe('==one== ==two== three');
  expect(f.api.highlight.mock.calls[0][2].version).not.toBe(f.api.highlight.mock.calls[1][2].version);
});
it('rejects overlap without deleting words or adding nested delimiters', async () => {
  const f = fixture(); f.choose(0, 3); await vi.advanceTimersByTimeAsync(1000);
  f.choose(0, 7); await vi.advanceTimersByTimeAsync(1000);
  expect(f.article().body).toBe('==one== two three'); expect(f.target.querySelector('.r2-error')?.textContent).toMatch(/overlap/);
});
it('keeps selected DOM on external text edits, blocks stale selection and renders after collapse', async () => {
  const f = fixture(); f.choose(0, 3); const node = f.body.firstChild;
  f.external('different words'); await vi.advanceTimersByTimeAsync(1000);
  expect(f.api.highlight).not.toHaveBeenCalled(); expect(f.body.firstChild).toBe(node);
  f.collapse(); expect(f.body.textContent?.trim()).toBe('different words');
});
it('invalidates pending selection writes when a note is renamed or deleted', async () => {
  const f = fixture(); f.choose(0, 3); f.invalidate(); await vi.advanceTimersByTimeAsync(1000);
  expect(f.api.highlight).not.toHaveBeenCalled(); expect(f.article().body).toBe('one two three');
});
it('opens unresolved wiki links via the host with source context, not a browser or file creator', async () => {
  const f = fixture('[[Unresolved|words]]'); f.body.querySelector('a')!.click();
  expect(f.button('Save as article')).toBeUndefined(); f.button('Open note').click(); await vi.advanceTimersByTimeAsync(1);
  expect(f.host.openNote).toHaveBeenCalledWith('Unresolved', 'Reading/Inbox/Test.md');
});
it('converts highlight to an ordinary link; generic unlink preserves words', async () => {
  const f = fixture('==one== two'); f.body.querySelector('mark')!.click(); f.button('Link').click(); await vi.advanceTimersByTimeAsync(1);
  expect(f.article().body).toBe('[[one]] two'); expect(f.body.querySelector('mark')).toBeNull();
  f.body.querySelector('a')!.click(); f.button('Unlink').click(); await vi.advanceTimersByTimeAsync(1);
  expect(f.article().body).toBe('one two'); expect(f.body.textContent).toBe('one two');
});
it('removes only highlight delimiters', async () => {
  const f = fixture('==one== two'); f.body.querySelector('mark')!.click(); f.button('Remove highlight').click(); await vi.advanceTimersByTimeAsync(1);
  expect(f.article().body).toBe('one two'); expect(f.api.deleteHighlight).toHaveBeenCalledTimes(1);
});
it('edits ordinary publisher links and preserves external Save as article', async () => {
  const f = fixture('[words](https://example.com)'); f.body.querySelector('a')!.click();
  expect(f.button('Save as article')).toBeTruthy(); f.button('Edit link…').click();
  const input = f.target.querySelector('input')!; input.value = 'Other note'; input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await vi.advanceTimersByTimeAsync(1);
  expect(parseInlineMarkdown(f.article().body).links[0]).toMatchObject({ target: 'Other note', quote: 'words' }); expect(f.api.setLinkTarget).toHaveBeenCalledTimes(1);
});
it.each(['link', 'highlight'])('keeps the %s chooser alive through outside-panel pointerdown, keyboard and click', async kind => {
  let picker!: HTMLElement, choice!: HTMLButtonElement; const dismissed = vi.fn();
  const f = fixture(kind === 'link' ? '[[First|words]]' : '==words==', { pickLinkTarget: (_quote, callback) => {
    picker = document.createElement('div'); picker.setAttribute('role', 'dialog');
    choice = document.createElement('button'); choice.textContent = 'Choose target'; picker.append(choice); document.body.append(picker); choice.focus();
    choice.addEventListener('click', () => { picker.remove(); callback('Chosen'); });
    return () => { dismissed(); picker.remove(); callback(null); };
  } });
  f.body.querySelector<HTMLElement>(kind === 'link' ? 'a' : 'mark')!.click(); f.button(kind === 'link' ? 'Edit link…' : 'Link to…').click();
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); choice.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false); expect(document.activeElement).toBe(choice);
  choice.dispatchEvent(new Event('pointerdown', { bubbles: true })); expect(dismissed).not.toHaveBeenCalled(); expect(picker.isConnected).toBe(true);
  choice.click(); await vi.advanceTimersByTimeAsync(1);
  expect(parseInlineMarkdown(f.article().body, { stripTitle: f.article().title }).links[0]).toMatchObject({ target: 'Chosen', quote: 'words' });
  expect(kind === 'link' ? f.api.setLinkTarget : f.api.linkHighlight).toHaveBeenCalledTimes(1); expect(dismissed).toHaveBeenCalledTimes(1);
});
it('clears the final removed highlight without emptying text or resaving a stale selection', async () => {
  const f = fixture('==one== two'); f.choose(0, 3); const selectedNode = f.body.querySelector('mark');
  f.external('one two'); await vi.advanceTimersByTimeAsync(1000);
  expect(f.api.highlight).not.toHaveBeenCalled(); expect(f.body.querySelector('mark')).toBe(selectedNode);
  f.collapse(); expect(f.body.textContent).toBe('one two'); expect(f.body.querySelector('mark')).toBeNull(); expect(f.body.dataset.highlightCount).toBe('0');
});
it('disposes stale link chooser callbacks on a changed note', async () => {
  let choose!: (target: string | null) => void;
  const f = fixture('[[First|words]]', { pickLinkTarget: (_quote, callback) => { choose = callback; } });
  f.body.querySelector('a')!.click(); f.button('Edit link…').click(); f.external('[[Other|words]]'); choose('Wrong'); await vi.advanceTimersByTimeAsync(1);
  expect(f.api.setLinkTarget).not.toHaveBeenCalled(); expect(f.article().body).toBe('[[Other|words]]');
});
