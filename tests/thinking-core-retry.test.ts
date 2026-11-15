import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

it.each(['selection comment', 'free comment', 'gap comment'] as const)(
  'surfaces native candidates instead of blindly appending a %s after uncertain readback and restart',
  async (route) => {
    const vault = new MemoryVault();
    await vault.create('Book.md', '---\nfileClass: Notebook\n---\nNotebook prose.\n');
    const sourceFile = await vault.create(
      'Source.md',
      '---\ntype: article\n---\nSelected words.\n\nFollowing paragraph.',
    );
    const source = await new ArticleStore(vault).read(sourceFile.path);
    const options = { retainSource: async () => source };
    const save = (store: ThinkingStore<{ path: string }>, body = 'A personal thought.') =>
      route === 'selection comment'
        ? store.keep({
            notebookPath: 'Book.md',
            source,
            from: 0,
            to: 'Selected words.'.length,
            comment: body,
          })
        : route === 'gap comment'
          ? store.comment({
              notebookPath: 'Book.md',
              source,
              gap: source.body.indexOf('\n\n'),
              body,
            })
          : store.comment({ notebookPath: 'Book.md', body });
    const read = vault.read.bind(vault),
      process = vault.process.bind(vault);
    let settled = false;
    vault.process = async (file, update) => {
      const next = await process(file, update);
      settled = true;
      return next;
    };
    vault.read = async (file) => {
      if (settled && file.path === 'Book.md') throw new Error('Readback unavailable.');
      return read(file);
    };
    const original = new ThinkingStore(vault, options);
    expect((await save(original)).status).toBe('possibly-saved');
    original.dispose();
    vault.read = read;
    vault.process = process;
    const restarted = new ThinkingStore(vault, options);
    const before = await restarted.read('Book.md');
    const retry = await save(restarted);
    expect(retry.status).toBe('failed');
    expect(retry.message).toMatch(/existing|candidate/i);
    expect(retry.existingCandidates?.some((record) => record.body === 'A personal thought.')).toBe(
      true,
    );
    expect((await restarted.read('Book.md')).raw).toBe(before.raw);
    const different = await save(restarted, 'A meaningfully different response.');
    expect(different.status).toBe('saved');
    expect(
      (await restarted.read('Book.md')).records
        .filter((record) => record.kind === 'comment')
        .map((record) => record.body),
    ).toEqual(['A personal thought.', 'A meaningfully different response.']);
  },
);
