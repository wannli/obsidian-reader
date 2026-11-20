// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { hostFixture, articleAction } from './helpers/reader-view-fixture';
import { ArticleStore } from '../src/core/store';
import { createDocument } from '../src/core/document';
import { MemoryVault } from './helpers/memory-vault';

const outcome = (f: ReturnType<typeof hostFixture>) =>
  f.view.contentEl.querySelector('.reader-action-outcome');

async function coreFixture(protectedBody = false) {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault);
  const file = await vault.create(
    'Reading/Inbox/A.md',
    createDocument({ type: 'article' }, protectedBody ? '==Saved words==' : 'Plain words'),
  );
  return { vault, store, file, snapshot: await store.read(file.path) };
}

describe('truthful guarded deletion outcomes', () => {
  it.each([false, true])(
    'returns the actual successful outcome (protected=%s)',
    async (protectedBody) => {
      const f = await coreFixture(protectedBody);
      expect(await f.store.trash(f.snapshot)).toBe(
        protectedBody ? 'archived-protected' : 'trashed',
      );
      expect(f.vault.trashed).toEqual(protectedBody ? [] : ['Reading/Inbox/A.md']);
      if (protectedBody) {
        expect(f.file.path).toBe('Reading/Inbox/A.md');
        expect((await f.store.read(f.file.path)).properties.status).toBe('archive');
      }
    },
  );

  it.each([false, true])(
    'rejects stale bytes rather than claiming completion (protected=%s)',
    async (protectedBody) => {
      const f = await coreFixture(protectedBody);
      f.vault.bytes.set(f.file, f.snapshot.raw + '\nNew authored text');
      await expect(f.store.trash(f.snapshot)).rejects.toThrow();
      expect(f.vault.trashed).toEqual([]);
      expect(f.file.path).toBe('Reading/Inbox/A.md');
    },
  );
});

describe('failed deletion outcomes', () => {
  it.each([false, true])(
    'never returns success when native mutation fails (protected=%s)',
    async (protectedBody) => {
      const f = await coreFixture(protectedBody);
      if (protectedBody) vi.spyOn(f.vault, 'process').mockRejectedValue(new Error('Status failed'));
      else vi.spyOn(f.vault, 'trash').mockRejectedValue(new Error('Trash uncertain'));
      await expect(f.store.trash(f.snapshot)).rejects.toThrow();
      expect(f.vault.trashed).toEqual([]);
    },
  );
});

describe('visible status and retention guidance', () => {
  it.each([false, true])(
    'preserves five controls, mode isolation and measured clearance (paged=%s)',
    async (paged) => {
      const f = hostFixture();
      f.host.paged = paged;
      const article = await f.note('Reading/Stream/A.md');
      await f.view.openArticle(article.path, true);
      const guidance = () => f.view.contentEl.querySelector('.reader-action-guidance');
      expect(guidance()?.textContent).toContain('next article (list at end)');
      expect(guidance()?.querySelector('summary')?.textContent).toContain(
        'reading alone does not keep it',
      );
      expect(guidance()?.textContent).toContain('calendar month after publication');
      expect(f.view.contentEl.querySelectorAll('.reader-actions > button')).toHaveLength(5);
      Object.defineProperty(f.probe.actions, 'offsetHeight', { value: 180 });
      f.probe.tapHighlighter.refreshActions();
      expect(
        f.probe.surface.viewport.parentElement.style.getPropertyValue(
          '--reader-controls-clearance',
        ),
      ).toContain('192px');
      articleAction(f.view, 'Highlight mode');
      expect(guidance()).toBeNull();
      f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Done"]')!.click();
      expect(guidance()).not.toBeNull();
    },
  );

  it('uses YAML status, not folder membership, and does not change bytes', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.vault.process(article, () =>
      createDocument({ type: 'article', status: 'feed' }, 'Words'),
    );
    f.store.catalog.update(article.path, { type: 'article', status: 'feed' });
    await f.view.openArticle(article.path, true);
    const before = await f.vault.read(article);
    f.view.refreshArticleControls();
    expect(f.view.contentEl.querySelector('.reader-action-guidance details')).not.toBeNull();
    expect(await f.vault.read(article)).toBe(before);
  });
});

describe('exception-only local archive feedback', () => {
  it.each([false, true])(
    'explains protected trash after advancing or at end (last=%s)',
    async (last) => {
      const f = hostFixture();
      const article = await f.note('Reading/Inbox/A.md', '==Saved words==');
      const next = last ? undefined : await f.note('Reading/Inbox/B.md');
      await f.view.openArticle(article.path, true);
      articleAction(f.view, 'Archive protected article and advance');
      await f.probe.operations;
      expect(outcome(f)?.textContent).toContain('Archived instead of trashed');
      expect(outcome(f)?.getAttribute('role')).toBe('status');
      expect(f.vault.trashed).toEqual([]);
      expect(article.path).toBe('Reading/Inbox/A.md');
      expect(f.view.file).toBe(next);
    },
  );

  it('explains protected list deletion without opening an article', async () => {
    const f = hostFixture();
    await f.note('Reading/Inbox/A.md', '==Saved words==');
    await f.view.readingList('Inbox');
    await f.probe.actOnListArticle('t');
    expect(outcome(f)?.textContent).toContain('Archived instead of trashed');
    expect(f.view.file).toBeUndefined();
  });

  it('ignores a late list outcome after the list was replaced', async () => {
    const f = hostFixture();
    await f.note('Reading/Inbox/A.md', '==Saved words==');
    await f.view.readingList('Inbox');
    let complete!: (outcome: 'archived-protected') => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(f.store, 'trash').mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const pending = f.probe.actOnListArticle('t');
    await started;
    f.probe.showList('Later');
    complete('archived-protected');
    await pending;
    expect(outcome(f)).toBeNull();
  });

  it('keeps ordinary trash quiet and suppresses success on uncertain completion', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path, true);
    vi.spyOn(f.store, 'trash').mockRejectedValueOnce(new Error('Uncertain completion'));
    await expect(f.probe.finish('delete')).rejects.toThrow('Uncertain completion');
    expect(outcome(f)).toBeNull();
    expect(f.view.file).toBe(article);
    await f.probe.finish('delete');
    expect(outcome(f)).toBeNull();
    expect(f.vault.trashed).toContain('Reading/Inbox/A.md');
  });
});
