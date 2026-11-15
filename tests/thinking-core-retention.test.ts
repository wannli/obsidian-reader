import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

it.each(['keep', 'gap comment', 'exploration inclusion'] as const)(
  'reports confirmed source retention when the immediate post-retention validation read fails during %s',
  async (action) => {
    const vault = new MemoryVault();
    await vault.create('Book.md', '---\nfileClass: Notebook\n---\nAuthored notebook.\n');
    await vault.create('Explore.md', '---\nfileClass: Exploration\n---\nAuthored exploration.\n');
    const file = await vault.create(
      'Source.md',
      '---\ntype: article\nstatus: feed\nunknown: preserved\n---\nSelected words.\n\nNext paragraph.\n',
    );
    const source = await new ArticleStore(vault).read(file.path);
    const retainedRaw = source.raw.replace('status: feed', 'status: later');
    const read = vault.read.bind(vault);
    let rejectSourceRead = false;
    vault.read = async (file) => {
      if (file === source.file && rejectSourceRead)
        throw new Error('Post-retention source read unavailable.');
      return read(file);
    };
    const store = new ThinkingStore(vault, {
      retainSource: async (current) => {
        vault.bytes.set(current.file, retainedRaw);
        rejectSourceRead = true;
        return {
          ...current,
          raw: retainedRaw,
          properties: { ...current.properties, status: 'later' },
        };
      },
    });
    const notebookBefore = await store.read('Book.md');
    const explorationBefore = await store.read('Explore.md');
    const result =
      action === 'keep'
        ? await store.keep({
            notebookPath: 'Book.md',
            source,
            from: 0,
            to: 'Selected words.'.length,
          })
        : action === 'gap comment'
          ? await store.comment({
              notebookPath: 'Book.md',
              source,
              gap: source.body.indexOf('\n\n'),
              body: 'Personal writing.',
            })
          : await store.editExploration({
              document: explorationBefore,
              action: 'add',
              target: { path: source.path },
              source,
            });
    expect(result.status).toBe('partial');
    expect(result.retainedSource).toMatchObject({
      file: source.file,
      path: source.path,
      raw: retainedRaw,
      body: source.body,
      properties: { status: 'later', unknown: 'preserved' },
    });
    expect(result.message).toContain('Post-retention source read unavailable');
    expect(result.records).toEqual([]);
    expect((await store.read('Book.md')).raw).toBe(notebookBefore.raw);
    expect((await store.read('Explore.md')).raw).toBe(explorationBefore.raw);
    rejectSourceRead = false;
    const reopened = await new ArticleStore(vault).read(source.path);
    expect(reopened.raw).toBe(retainedRaw);
    expect(reopened.body).toBe(source.body);
  },
);
