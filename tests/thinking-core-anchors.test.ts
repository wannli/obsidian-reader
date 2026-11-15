import { expect, it, vi } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

it.each(['existing notebook', 'new authored body'] as const)(
  'checks fresh anchor collisions against %s even with random allocation',
  async (location) => {
    const vault = new MemoryVault();
    const occupied = 'comment-' + '11'.repeat(16);
    await vault.create(
      'Book.md',
      '---\nfileClass: Notebook\n---\n' +
        (location === 'existing notebook' ? `\n\`\`\`\n^${occupied}\n\`\`\`\n` : ''),
    );
    let attempts = 0;
    const entropy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      if (array instanceof Uint8Array) array.fill(++attempts === 1 ? 0x11 : 0x22);
      return array;
    });
    try {
      const result = await new ThinkingStore(vault).comment({
        notebookPath: 'Book.md',
        body:
          location === 'new authored body' ? `Authored block.\n\n^${occupied}` : 'A fresh thought.',
      });
      expect(result.status, result.message).toBe('saved');
      expect(result.affectedRecords![0].blockId).toBe('comment-' + '22'.repeat(16));
      expect(result.affectedRecords![0].readOnly).toBe(false);
    } finally {
      entropy.mockRestore();
    }
  },
);

it.each(['remove', 'change anchor'] as const)(
  'does not recycle a stale native target after users %s the old entry, even across restart',
  async (change) => {
    const vault = new MemoryVault();
    await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
    const sourceFile = await vault.create(
      'Source.md',
      '---\ntype: article\n---\nFirst selection. Second selection.',
    );
    const source = await new ArticleStore(vault).read(sourceFile.path);
    const options = { retainSource: async () => source };
    const store = new ThinkingStore(vault, options);
    const first = await store.keep({ notebookPath: 'Book.md', source, from: 0, to: 16 });
    expect(first.status).toBe('saved');
    const anchor = first.affectedRecords![0].blockId;
    const external = await vault.create(
      'External.md',
      `---\nfileClass: Exploration\n---\n- [[Book#^${anchor}]]\n`,
    );
    const notebook = await store.read('Book.md');
    const native =
      change === 'remove'
        ? notebook.raw.replace(notebook.records[0].raw, '')
        : notebook.raw.replace(`^${anchor}`, '^user-edited-anchor');
    vault.bytes.set(notebook.file, native);
    store.dispose();
    const reopened = new ThinkingStore(vault, options);
    const second = await reopened.keep({
      notebookPath: 'Book.md',
      source,
      from: 17,
      to: source.body.length,
    });
    expect(second.status).toBe('saved');
    expect(second.affectedRecords![0].blockId).not.toBe(anchor);
    expect(second.affectedRecords![0].blockId).toMatch(/^passage-[a-f0-9]{32}$/);
    expect(await vault.read(external)).toContain(`[[Book#^${anchor}]]`);
  },
);
