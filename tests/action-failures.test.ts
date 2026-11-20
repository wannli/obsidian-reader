// @vitest-environment node
import { hostFixture } from './helpers/reader-view-fixture';
import { describe, expect, it, vi } from 'vitest';
import { readDocument } from '../src/core/document';

async function fixture() {
  const f = hostFixture();
  const article = await f.note('Reading/Later/Failure.md');
  await f.view.openArticle(article.path, true);
  return { ...f, article };
}
const alert = (f: ReturnType<typeof hostFixture>) =>
  f.view.contentEl.querySelector<HTMLElement>('.reader-action-error');
async function settled(f: ReturnType<typeof hostFixture>) {
  await f.probe.operations.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
}

describe('local actionable Reader failures', () => {
  it('shows failed status writes beside the article without navigating or stealing focus', async () => {
    const f = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await f.vault.read(f.article);
    vi.spyOn(f.store, 'move').mockRejectedValue(new Error('Disk full'));
    const button = f.view.contentEl.querySelector<HTMLButtonElement>(
      '[aria-label="Archive and advance"]',
    )!;
    button.focus();
    button.click();
    await settled(f);
    expect(alert(f)?.getAttribute('role')).toBe('alert');
    expect(alert(f)?.textContent).toContain('Archive and advance: Disk full');
    expect(alert(f)?.textContent).toContain('Check the current note');
    expect(f.view.file).toBe(f.article);
    expect(await f.vault.read(f.article)).toBe(before);
    expect(document.activeElement).toBe(button);
  });

  it('preserves partial status outcomes rather than claiming no save', async () => {
    const f = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (...args) => {
      const raw = await process(...args);
      f.store.setStatusFolders({ archive: 'Reading/Kept' });
      return raw;
    });
    f.view.key(new KeyboardEvent('keydown', { key: 'a', cancelable: true }));
    await settled(f);
    expect(alert(f)?.textContent).toContain('Status saved as archive');
    expect(readDocument(await f.vault.read(f.article)).properties.status).toBe('archive');
    expect(f.article.path).toBe('Reading/Later/Failure.md');
    expect(alert(f)?.textContent).not.toContain('Nothing was saved');
    expect(f.view.file).toBe(f.article);
  });

  it('reports uncertain deletion without advancing or blindly retrying', async () => {
    const f = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const trash = vi
      .spyOn(f.store, 'trash')
      .mockRejectedValue(new Error('Trash completion uncertain'));
    f.view.key(new KeyboardEvent('keydown', { key: 't', cancelable: true }));
    await settled(f);
    expect(alert(f)?.textContent).toContain('Trash completion uncertain');
    expect(f.view.file).toBe(f.article);
    expect(trash).toHaveBeenCalledOnce();
  });

  it('makes missing Fileclass visible from the real Related notes button', async () => {
    const f = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await f.vault.read(f.article);
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Related notes"]')!.click();
    await settled(f);
    expect(alert(f)?.textContent).toMatch(/Related notes:.*requires Fileclass/);
    expect(await f.vault.read(f.article)).toBe(before);
  });

  it('clears an error after success without replacing acquisition status', async () => {
    const f = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f.probe.status.textContent = 'Fetch failed';
    await f.probe.userAction('Test', () => {
      throw new Error('Failure');
    });
    expect(alert(f)?.textContent).toContain('Failure');
    expect(f.probe.status.textContent).toBe('Fetch failed');
    await f.probe.userAction('Test', () => {});
    expect(alert(f)).toBeNull();
    expect(f.probe.status.textContent).toBe('Fetch failed');
  });

  it('ignores late failures from a replaced article or stopped generation', async () => {
    const f = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let reject!: (error: Error) => void;
    const pending = f.probe.userAction(
      'Old action',
      () =>
        new Promise<void>((_, no) => {
          reject = no;
        }),
    );
    const other = await f.note('Reading/Later/Other.md');
    await f.view.openArticle(other.path, true);
    reject(new Error('Old failure'));
    await pending;
    expect(alert(f)).toBeNull();
    f.host.signal = AbortSignal.abort();
    await f.probe.userAction('Stopped action', () => {
      throw new Error('Stopped');
    });
    expect(alert(f)).toBeNull();
  });
});
