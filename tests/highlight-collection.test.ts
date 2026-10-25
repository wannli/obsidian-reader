import { describe, expect, it, vi } from 'vitest';
import { ChangedNote, createDocument, readDocument } from '../src/core/document';
import { changePassage, passages } from '../src/core/annotations';
import {
  appendQuotation,
  originLink,
  QuotationRemovalError,
  removeQuotation,
} from '../src/core/quotation';
import { ArticleStore, PartialCollectionError, type NoteFile } from '../src/core/store';
import { MemoryVault, gate } from './helpers/memory-vault';

const blockId = 'reader-a1';
const quoteMarkdown = 'Clear **rules** build [trust](https://example.com/report).';
const sourceBody = `\n${quoteMarkdown}\n`;
const targetPath = 'Concepts/Trust.md';
const hostedBody = `\n==${quoteMarkdown}== (※ [[Concepts/Trust]]) ^${blockId}\n`;
const edit = { body: hostedBody, quoteMarkdown, blockId };
const collectedDay = '2026-10-20';
const options = () => ({ guard: vi.fn(), collectedOn: new Date(2026, 9, 20, 12) });

async function fixture(queue: 'Inbox' | 'Feed' = 'Inbox') {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault, { articles: 'Capture', feeds: 'Subscriptions' });
  const source = await store.capture({
    url: 'https://example.com/source',
    title: 'Source title',
    queue,
    body: quoteMarkdown,
  });
  const target = await vault.create(
    targetPath,
    '---\nfileClass: Concept\ncustom: untouched # keep\n---\n\n# Trust\n\nAuthored explanation.\n',
  );
  const snapshot = await store.read(source.path);
  return { vault, store, source, target, snapshot };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected collection to fail.');
    },
    (error: unknown) => error,
  );
}

async function manyFixture(queue: 'Inbox' | 'Feed' = 'Inbox') {
  const f = await fixture(queue);
  const second = await f.vault.create(
    'Concepts/Rules.md',
    '---\nfileClass: Concept\ncustom: second # preserve\n---\n\n# Rules\n\nAuthored rules.\n',
  );
  const paths = [f.target.path, second.path];
  const manyEdit = {
    ...edit,
    body: hostedBody.replace('[[Concepts/Trust]]', '[[Concepts/Trust]], [[Concepts/Rules]]'),
  };
  return { ...f, second, paths, manyEdit };
}

describe('one-passage multi-destination collection', () => {
  it('commits every final source reference and remembered destination together, then files to each target', async () => {
    const f = await manyFixture('Feed'),
      trace: string[] = [],
      process = f.vault.process.bind(f.vault),
      move = f.vault.move.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) =>
      process(file, (raw) => {
        const next = update(raw);
        trace.push(
          file === f.source
            ? readDocument(next).body === f.manyEdit.body
              ? 'annotation'
              : 'retention'
            : file.path,
        );
        if (file === f.source && readDocument(next).body === f.manyEdit.body)
          expect(readDocument(next).properties.topics).toEqual([
            '[[Concepts/Trust]]',
            '[[Concepts/Rules]]',
          ]);
        return next;
      }),
    );
    vi.spyOn(f.vault, 'move').mockImplementation(async (...args) => {
      trace.push('move');
      return move(...args);
    });
    const saved = await f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, options());
    expect(trace).toEqual(['retention', 'annotation', 'move', ...f.paths]);
    expect(saved.body).toBe(f.manyEdit.body);
    expect(saved.path).toBe(f.source.path);
    const citation = originLink(saved.path, blockId, 'Source title');
    for (const target of [f.target, f.second]) {
      const raw = await f.vault.read(target);
      expect(raw).toContain(`### [[${saved.path.replace(/\.md$/, '')}|Source title]]`);
      expect(raw).toContain(`> ${quoteMarkdown} (※ ${citation} [[${collectedDay}]])`);
      expect(readDocument(raw).properties).not.toHaveProperty('origin');
    }
    expect(await f.vault.read(f.target)).toContain('Authored explanation.');
    expect(await f.vault.read(f.second)).toContain('custom: second # preserve');
  });

  it.each(['dirty', 'read-only', 'missing', 'malformed', 'ambiguous', 'source itself'] as const)(
    'preflights the final %s target before any source retention or earlier target write',
    async (kind) => {
      const f = await manyFixture('Feed'),
        originalPath = f.source.path;
      if (kind === 'dirty') f.vault.dirty.add(f.second);
      if (kind === 'read-only') {
        const writable = f.vault.assertWritable.bind(f.vault);
        vi.spyOn(f.vault, 'assertWritable').mockImplementation((file) => {
          if (file === f.second) throw new Error('Read only');
          writable(file);
        });
      }
      if (kind === 'missing') f.vault.files.delete(f.second.path);
      if (kind === 'malformed') f.vault.bytes.set(f.second, 'Not a supported target');
      if (kind === 'ambiguous')
        f.vault.bytes.set(
          f.second,
          (await f.vault.read(f.second)) + '\n## Highlights\n\n## Highlights\n',
        );
      const paths = kind === 'source itself' ? [f.target.path, f.source.path] : f.paths;
      const firstBefore = await f.vault.read(f.target),
        secondBefore = f.vault.bytes.get(f.second),
        writes = vi.spyOn(f.vault, 'process');
      await expect(
        f.store.collectHighlightMany(f.snapshot, f.manyEdit, paths, options()),
      ).rejects.toThrow();
      expect(f.source.path).toBe(originalPath);
      expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
      expect(await f.vault.read(f.target)).toBe(firstBefore);
      expect(f.vault.bytes.get(f.second)).toBe(secondBefore);
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it('requires a public eligibility guard and rejects a zero-host creation without a source write', async () => {
    const f = await manyFixture('Feed');
    await expect(f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths)).rejects.toThrow(
      /typed.*guard/,
    );
    await expect(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, [], options()),
    ).rejects.toThrow('at least one typed destination');
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
  });

  it('deduplicates selected paths and assigns origin only to selected newly-created notes', async () => {
    const f = await manyFixture();
    const process = vi.spyOn(f.vault, 'process');
    const saved = await f.store.collectHighlightMany(
      f.snapshot,
      f.manyEdit,
      [...f.paths, ...f.paths],
      { ...options(), createdPaths: [f.second.path] },
    );
    expect(process.mock.calls.filter(([file]) => file === f.source)).toHaveLength(1);
    expect(process.mock.calls.filter(([file]) => file === f.target)).toHaveLength(1);
    expect(process.mock.calls.filter(([file]) => file === f.second)).toHaveLength(1);
    expect(readDocument(await f.vault.read(f.target)).properties).not.toHaveProperty('origin');
    expect(readDocument(await f.vault.read(f.second)).properties.origin).toBe(
      originLink(saved.path, blockId),
    );
  });

  it('exposes completed filings, stops at the failed target, and retries without changing the first collection date', async () => {
    const f = await manyFixture('Feed'),
      process = f.vault.process.bind(f.vault);
    let failSecond = true;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      if (file === f.second && failSecond) throw new Error('Second destination failed');
      return process(file, update);
    });
    const partial = (await failure(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, options()),
    )) as PartialCollectionError<NoteFile>;
    expect(partial).toBeInstanceOf(PartialCollectionError);
    expect(partial.annotationSaved).toBe(true);
    expect(partial.snapshot.raw).toBe(await f.vault.read(f.source));
    expect(partial.snapshot.body).toBe(f.manyEdit.body);
    expect(partial.destinationPath).toBe(f.second.path);
    expect(partial.destinationOperation).toBe('collect');
    expect(partial.completedDestinationPaths).toEqual([f.target.path]);
    expect(partial.completedRemovalPaths).toEqual([]);
    expect(Object.isFrozen(partial.completedDestinationPaths)).toBe(true);
    expect(() => (partial.completedDestinationPaths as string[]).push('Not authorized')).toThrow();
    expect(await f.vault.read(f.second)).not.toContain('## Highlights');
    failSecond = false;
    await f.store.collectHighlightMany(partial.snapshot, f.manyEdit, f.paths, {
      ...options(),
      collectedOn: new Date(2026, 9, 21, 12),
    });
    const first = await f.vault.read(f.target),
      second = await f.vault.read(f.second);
    expect(first.split(`> ${quoteMarkdown}`).length - 1).toBe(1);
    expect(second.split(`> ${quoteMarkdown}`).length - 1).toBe(1);
    expect(first).toContain('[[2026-10-20]]');
    expect(first).not.toContain('[[2026-10-21]]');
    expect(second).toContain('[[2026-10-21]]');
  });

  it('preserves a native edit of a later target and reports already completed target writes', async () => {
    const f = await manyFixture(),
      process = f.vault.process.bind(f.vault),
      original = await f.vault.read(f.second);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      if (file === f.second) f.vault.bytes.set(file, original + '\nNative target edit.\n');
      return process(file, update);
    });
    const partial = (await failure(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, options()),
    )) as PartialCollectionError<NoteFile>;
    expect(partial.cause).toBeInstanceOf(ChangedNote);
    expect(partial.completedDestinationPaths).toEqual([f.target.path]);
    expect(await f.vault.read(f.second)).toBe(original + '\nNative target edit.\n');
    expect(await f.vault.read(f.target)).toContain(`> ${quoteMarkdown}`);
  });

  it('does not abandon source A after it saves when the user begins a new selection B', async () => {
    const f = await manyFixture('Feed'),
      process = f.vault.process.bind(f.vault);
    let nativeSelectionCurrent = true;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const raw = await process(file, update);
      if (file === f.source && readDocument(raw).body === f.manyEdit.body)
        nativeSelectionCurrent = false;
      return raw;
    });
    const guard = vi.fn((phase: 'source' | 'destination') => {
      if (phase === 'source' && !nativeSelectionCurrent)
        throw new Error('A was superseded before annotation');
    });
    await f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, { ...options(), guard });
    expect(guard).toHaveBeenCalledWith('source');
    expect(guard).toHaveBeenCalledWith('destination');
    expect(nativeSelectionCurrent).toBe(false);
    expect(await f.vault.read(f.target)).toContain(`> ${quoteMarkdown}`);
    expect(await f.vault.read(f.second)).toContain(`> ${quoteMarkdown}`);
  });

  it('still rechecks provider lifetime at each destination after source commit', async () => {
    const f = await manyFixture(),
      process = f.vault.process.bind(f.vault);
    let providerCurrent = true;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const raw = await process(file, update);
      if (file === f.target) providerCurrent = false;
      return raw;
    });
    const guard = vi.fn(() => {
      if (!providerCurrent) throw new Error('Provider reloaded');
    });
    const partial = (await failure(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, { ...options(), guard }),
    )) as PartialCollectionError<NoteFile>;
    expect(partial.cause).toHaveProperty('message', 'Provider reloaded');
    expect(partial.completedDestinationPaths).toEqual([f.target.path]);
    expect(await f.vault.read(f.second)).not.toContain('## Highlights');
  });

  it('uses one local collection date for all newly filed destinations even when the write crosses midnight', async () => {
    const f = await manyFixture(),
      process = f.vault.process.bind(f.vault);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 23, 59, 59));
    try {
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
        const raw = await process(file, update);
        if (file === f.source) vi.setSystemTime(new Date(2026, 9, 21, 0, 0, 1));
        return raw;
      });
      await f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, { guard: vi.fn() });
      for (const target of [f.target, f.second]) {
        expect(await f.vault.read(target)).toContain('[[2026-10-20]]');
        expect(await f.vault.read(target)).not.toContain('[[2026-10-21]]');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('freezes caller edits, destinations, creation flags, guard and local date before queued work', async () => {
    const f = await manyFixture(),
      paths = [...f.paths],
      createdPaths = [f.second.path],
      mutableEdit = { ...f.manyEdit },
      opts = { ...options(), createdPaths };
    const guard = opts.guard;
    const collecting = f.store.collectHighlightMany(f.snapshot, mutableEdit, paths, opts);
    paths.splice(0, paths.length, f.source.path);
    createdPaths.length = 0;
    mutableEdit.body = 'Do not write this.';
    mutableEdit.quoteMarkdown = 'Do not quote this.';
    opts.guard = vi.fn(() => {
      throw new Error('Do not use this replacement guard');
    });
    opts.collectedOn.setDate(21);
    const saved = await collecting;
    expect(saved.body).toBe(f.manyEdit.body);
    expect(guard).toHaveBeenCalled();
    expect(readDocument(await f.vault.read(f.second)).properties.origin).toBe(
      originLink(saved.path, blockId),
    );
    for (const target of [f.target, f.second]) {
      expect(await f.vault.read(target)).toContain(`> ${quoteMarkdown}`);
      expect(await f.vault.read(target)).toContain('[[2026-10-20]]');
      expect(await f.vault.read(target)).not.toContain('[[2026-10-21]]');
    }
  });

  it('rereads every destination after a native source move rewrites their links', async () => {
    const f = await manyFixture('Feed'),
      originalPath = f.source.path,
      move = f.vault.move.bind(f.vault);
    for (const target of [f.target, f.second])
      f.vault.bytes.set(
        target,
        (await f.vault.read(target)) + `\nEarlier [[${originalPath.replace(/\.md$/, '')}]].\n`,
      );
    vi.spyOn(f.vault, 'move').mockImplementation(async (file, path, guard) => {
      await move(file, path, guard);
      for (const target of [f.target, f.second])
        f.vault.bytes.set(
          target,
          (await f.vault.read(target)).replaceAll(
            originalPath.replace(/\.md$/, ''),
            path.replace(/\.md$/, ''),
          ),
        );
    });
    const saved = await f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, options());
    for (const target of [f.target, f.second]) {
      const raw = await f.vault.read(target);
      expect(raw).toContain(`Earlier [[${saved.path.replace(/\.md$/, '')}]].`);
      expect(raw).not.toContain(originalPath.replace(/\.md$/, ''));
      expect(raw).toContain(`> ${quoteMarkdown}`);
    }
  });

  it('captures destination identity before its collection lane starts', async () => {
    const f = await manyFixture('Feed'),
      before = await f.vault.read(f.second);
    const collecting = f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, options());
    f.vault.files.delete(f.second.path);
    const replacement = await f.vault.create(f.second.path, before + '\nReplacement note.\n');
    await expect(collecting).rejects.toBeInstanceOf(ChangedNote);
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
    expect(await f.vault.read(replacement)).toBe(before + '\nReplacement note.\n');
    expect(await f.vault.read(f.target)).not.toContain('## Highlights');
  });

  it('rejects a superseded native selection at the source process boundary before any retention', async () => {
    const f = await manyFixture('Feed'),
      process = f.vault.process.bind(f.vault);
    let current = true;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      if (file === f.source) current = false;
      return process(file, update);
    });
    const guard = (phase: 'source' | 'destination') => {
      if (phase === 'source' && !current) throw new Error('Selection superseded');
    };
    await expect(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, { ...options(), guard }),
    ).rejects.toThrow('Selection superseded');
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
    for (const target of [f.target, f.second])
      expect(await f.vault.read(target)).not.toContain('## Highlights');
  });

  it('keeps explicit mention conversion on the single-destination API', async () => {
    const f = await manyFixture('Feed');
    await expect(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, {
        ...options(),
        mode: 'mention' as 'highlight',
      }),
    ).rejects.toThrow('only supports highlights');
    await expect(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, {
        ...options(),
        createdPaths: ['Not selected.md'],
      }),
    ).rejects.toThrow('newly created destination must be selected');
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
  });

  it('rejects an invalid collection clock before source retention or destination creation', async () => {
    const f = await manyFixture('Feed'),
      process = vi.spyOn(f.vault, 'process');
    await expect(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, {
        ...options(),
        collectedOn: new Date(NaN),
      }),
    ).rejects.toThrow('Invalid local collection date');
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
    expect(process).not.toHaveBeenCalled();
  });

  it('serializes reciprocal multi-file operations without nesting file lanes', async () => {
    const f = await manyFixture();
    const other = await f.store.capture({
      url: 'https://example.com/other-many',
      title: 'Other',
      body: 'Other source.',
    });
    const otherSnapshot = await f.store.read(other.path);
    const results = await Promise.allSettled([
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, [other.path, f.target.path], options()),
      f.store.collectHighlightMany(
        otherSnapshot,
        {
          body: '\n==Other source.== ^reader-other\n',
          quoteMarkdown: 'Other source.',
          blockId: 'reader-other',
        },
        [f.source.path, f.second.path],
        options(),
      ),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    if (results[1].status === 'rejected') expect(results[1].reason).toBeInstanceOf(ChangedNote);
    expect(f.store.busy(f.source)).toBe(false);
    expect(f.store.busy(other)).toBe(false);
  });
});

describe('explicit removal of a highlight destination and its exact filed snapshot', () => {
  it('unchecks one host while preserving other quotations, headings, origins and article relationships', async () => {
    const f = await manyFixture();
    const first = await f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, {
      ...options(),
      createdPaths: [f.target.path],
    });
    const citation = originLink(first.path, blockId, 'Source title');
    f.vault.bytes.set(
      f.target,
      appendQuotation(await f.vault.read(f.target), 'A different passage.', citation, {
        collectedOn: collectedDay,
      }).raw,
    );
    const beforeFirst = await f.vault.read(f.target),
      beforeSecond = await f.vault.read(f.second);
    const saved = await f.store.collectHighlightMany(first, edit, [f.target.path], {
      ...options(),
      removedDestinationPaths: [f.second.path],
      previousQuote: edit,
    });
    expect(saved.body).toBe(hostedBody);
    expect(saved.properties.topics).toEqual(['[[Concepts/Trust]]', '[[Concepts/Rules]]']);
    expect(await f.vault.read(f.target)).toBe(beforeFirst);
    expect(await f.vault.read(f.second)).toBe(
      removeQuotation(beforeSecond, quoteMarkdown, citation).raw,
    );
    expect(await f.vault.read(f.second)).toContain('## Highlights');
    expect(await f.vault.read(f.second)).toContain('### [[');
    expect(readDocument(await f.vault.read(f.target)).properties.origin).toBe(
      originLink(first.path, blockId),
    );
    expect(f.vault.file(f.second.path)).toBe(f.second);
    expect(f.vault.trashed).toEqual([]);
  });

  it('can explicitly clear all hosts and remove the entire highlight without deleting words or its paragraph anchor', async () => {
    const f = await manyFixture();
    const first = await f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, options());
    const removedBody = changePassage(first.body, passages(first.body)[0], 'remove');
    const saved = await f.store.collectHighlightMany(first, { ...edit, body: removedBody }, [], {
      ...options(),
      removedDestinationPaths: f.paths,
      previousQuote: edit,
    });
    expect(saved.body).toBe(removedBody);
    expect(saved.body).toContain(quoteMarkdown);
    expect(saved.body).toContain('^' + blockId);
    expect(passages(saved.body)).toEqual([]);
    for (const target of [f.target, f.second]) {
      expect(await f.vault.read(target)).not.toContain(`> ${quoteMarkdown}`);
      expect(await f.vault.read(target)).toContain('## Highlights');
      expect(f.vault.file(target.path)).toBe(target);
    }
    expect(f.vault.trashed).toEqual([]);
  });

  it.each(['\n', '\r\n'])(
    'never unlinks or retains Feed from a comment-only quotation match (%j)',
    async (newline) => {
      const f = await fixture('Feed');
      const citation = originLink(f.snapshot.path, blockId, 'Source title');
      f.vault.bytes.set(
        f.source,
        createDocument({ ...f.snapshot.properties, topics: ['[[Concepts/Trust]]'] }, hostedBody),
      );
      const targetBefore = (
        (await f.vault.read(f.target)) +
        `\n%%\n\n> ${quoteMarkdown} (※ ${citation} [[${collectedDay}]])\n\n%%\n`
      ).replace(/\n/gu, newline);
      f.vault.bytes.set(f.target, targetBefore);
      const snapshot = await f.store.read(f.source.path),
        process = vi.spyOn(f.vault, 'process'),
        move = vi.spyOn(f.vault, 'move');
      const removedBody = changePassage(snapshot.body, passages(snapshot.body)[0], 'remove');
      await expect(
        f.store.collectHighlightMany(snapshot, { ...edit, body: removedBody }, [], {
          ...options(),
          removedDestinationPaths: [f.target.path],
          previousQuote: edit,
        }),
      ).rejects.toMatchObject({ name: 'QuotationRemovalError', reason: 'missing' });
      expect(process).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
      expect(f.source.path).toBe(snapshot.path);
      expect(await f.vault.read(f.source)).toBe(snapshot.raw);
      expect(readDocument(await f.vault.read(f.source)).properties.status).toBe('feed');
      expect(await f.vault.read(f.target)).toBe(targetBefore);
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it.each(['edited', 'duplicate'] as const)(
    'preflights a later %s removed quotation before unlinking or retaining Feed',
    async (kind) => {
      const f = await manyFixture('Feed'),
        citation = originLink(f.snapshot.path, blockId, 'Source title');
      f.vault.bytes.set(
        f.source,
        createDocument(
          { ...f.snapshot.properties, topics: ['[[Concepts/Trust]]', '[[Concepts/Rules]]'] },
          f.manyEdit.body,
        ),
      );
      for (const target of [f.target, f.second])
        f.vault.bytes.set(
          target,
          appendQuotation(await f.vault.read(target), quoteMarkdown, citation, {
            collectedOn: collectedDay,
          }).raw,
        );
      let second = await f.vault.read(f.second);
      second =
        kind === 'edited'
          ? second.replace('Clear **rules**', 'Edited rules')
          : second + `\n> ${quoteMarkdown} (※ ${citation})\n`;
      f.vault.bytes.set(f.second, second);
      const snapshot = await f.store.read(f.source.path),
        beforeFirst = await f.vault.read(f.target),
        process = vi.spyOn(f.vault, 'process');
      const removedBody = changePassage(snapshot.body, passages(snapshot.body)[0], 'remove');
      await expect(
        f.store.collectHighlightMany(snapshot, { ...edit, body: removedBody }, [], {
          ...options(),
          removedDestinationPaths: f.paths,
          previousQuote: edit,
        }),
      ).rejects.toBeInstanceOf(QuotationRemovalError);
      expect(await f.vault.read(f.source)).toBe(snapshot.raw);
      expect(f.source.path).toBe(snapshot.path);
      expect(await f.vault.read(f.target)).toBe(beforeFirst);
      expect(await f.vault.read(f.second)).toBe(second);
      expect(process).not.toHaveBeenCalled();
    },
  );

  it('checks every removed destination for dirty buffers before changing any source reference or earlier quotation', async () => {
    const f = await manyFixture();
    const first = await f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, options());
    const aBefore = await f.vault.read(f.target),
      bBefore = await f.vault.read(f.second);
    f.vault.dirty.add(f.second);
    const process = vi.spyOn(f.vault, 'process');
    const removed = { ...edit, body: changePassage(first.body, passages(first.body)[0], 'remove') };
    await expect(
      f.store.collectHighlightMany(first, removed, [], {
        ...options(),
        removedDestinationPaths: f.paths,
        previousQuote: edit,
      }),
    ).rejects.toThrow('Native editor has unfinished edits');
    expect(await f.vault.read(f.source)).toBe(first.raw);
    expect(await f.vault.read(f.target)).toBe(aBefore);
    expect(await f.vault.read(f.second)).toBe(bBefore);
    expect(process).not.toHaveBeenCalled();
  });

  it('reports completed removals when a later native deletion races, without deleting the changed quotation', async () => {
    const f = await manyFixture();
    const first = await f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, options());
    const beforeSecond = await f.vault.read(f.second),
      process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      if (file === f.second)
        f.vault.bytes.set(file, beforeSecond.replace('Clear **rules**', 'Native edited rules'));
      return process(file, update);
    });
    const removedBody = changePassage(first.body, passages(first.body)[0], 'remove');
    const partial = (await failure(
      f.store.collectHighlightMany(first, { ...edit, body: removedBody }, [], {
        ...options(),
        removedDestinationPaths: f.paths,
        previousQuote: edit,
      }),
    )) as PartialCollectionError<NoteFile>;
    expect(partial).toBeInstanceOf(PartialCollectionError);
    expect(partial.annotationSaved).toBe(true);
    expect(partial.snapshot.raw).toBe(await f.vault.read(f.source));
    expect(partial.snapshot.body).toBe(removedBody);
    expect(partial.destinationOperation).toBe('remove');
    expect(partial.destinationPath).toBe(f.second.path);
    expect(partial.completedDestinationPaths).toEqual([]);
    expect(partial.completedRemovalPaths).toEqual([f.target.path]);
    expect(Object.isFrozen(partial.completedRemovalPaths)).toBe(true);
    expect(await f.vault.read(f.target)).not.toContain(`> ${quoteMarkdown}`);
    expect(await f.vault.read(f.second)).toBe(
      beforeSecond.replace('Clear **rules**', 'Native edited rules'),
    );
    expect(f.vault.trashed).toEqual([]);
  });

  it('changes hosts in one source commit and performs both the new filing and explicit old-snapshot removal', async () => {
    const f = await manyFixture();
    const first = await f.store.collectHighlight(f.snapshot, edit, f.target.path, options());
    const changed = { ...edit, body: hostedBody.replace('Concepts/Trust', 'Concepts/Rules') };
    const process = vi.spyOn(f.vault, 'process');
    const saved = await f.store.collectHighlightMany(first, changed, [f.second.path], {
      ...options(),
      removedDestinationPaths: [f.target.path],
      previousQuote: edit,
    });
    expect(saved.body).toBe(changed.body);
    expect(saved.properties.topics).toEqual(['[[Concepts/Trust]]', '[[Concepts/Rules]]']);
    expect(process.mock.calls.map(([file]) => file)).toEqual([f.source, f.second, f.target]);
    expect(await f.vault.read(f.target)).not.toContain(`> ${quoteMarkdown}`);
    expect(await f.vault.read(f.second)).toContain(`> ${quoteMarkdown}`);
    expect(f.vault.trashed).toEqual([]);
  });

  it('does not infer deletion authority from an absent quote, but can retry only the unfinished removal paths', async () => {
    const f = await manyFixture();
    const first = await f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, options());
    const removed = { ...edit, body: changePassage(first.body, passages(first.body)[0], 'remove') };
    const process = f.vault.process.bind(f.vault);
    let failing = true;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      if (file === f.second && failing) throw new Error('Second removal disk failure');
      return process(file, update);
    });
    const partial = (await failure(
      f.store.collectHighlightMany(first, removed, [], {
        ...options(),
        removedDestinationPaths: f.paths,
        previousQuote: edit,
      }),
    )) as PartialCollectionError<NoteFile>;
    expect(partial.completedRemovalPaths).toEqual([f.target.path]);
    expect(partial.destinationPath).toBe(f.second.path);
    const sourceBeforeRetry = await f.vault.read(f.source);
    failing = false;
    await expect(
      f.store.collectHighlightMany(partial.snapshot, removed, [], {
        ...options(),
        removedDestinationPaths: f.paths,
        previousQuote: edit,
      }),
    ).rejects.toBeInstanceOf(QuotationRemovalError);
    expect(await f.vault.read(f.source)).toBe(sourceBeforeRetry);
    await f.store.collectHighlightMany(partial.snapshot, removed, [], {
      ...options(),
      removedDestinationPaths: [f.second.path],
      previousQuote: edit,
    });
    for (const target of [f.target, f.second])
      expect(await f.vault.read(target)).not.toContain(`> ${quoteMarkdown}`);
    expect(await f.vault.read(f.source)).toBe(sourceBeforeRetry);
  });

  it('refuses removals without previous passage authority or with a simultaneously selected destination', async () => {
    const f = await manyFixture('Feed');
    await expect(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, {
        ...options(),
        removedDestinationPaths: [f.second.path],
      }),
    ).rejects.toThrow('previous highlight passage');
    await expect(
      f.store.collectHighlightMany(f.snapshot, f.manyEdit, f.paths, {
        ...options(),
        removedDestinationPaths: [f.second.path],
        previousQuote: edit,
      }),
    ).rejects.toThrow('both selected and removed');
    expect(await f.vault.read(f.source)).toBe(f.snapshot.raw);
  });
});

describe('guarded highlight collection', () => {
  it('saves the source body and remembered destination together, then appends a snapshot', async () => {
    const { vault, store, source, target, snapshot } = await fixture();
    const writes: { file: NoteFile; raw: string }[] = [];
    const process = vault.process.bind(vault);
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) =>
      process(file, (raw) => {
        const next = update(raw);
        writes.push({ file, raw: next });
        return next;
      }),
    );
    const saved = await store.collectHighlight(snapshot, edit, target.path, options());
    expect(saved.body).toBe(hostedBody);
    expect(saved.properties.topics).toEqual(['[[Concepts/Trust]]']);
    expect(writes.filter(({ file }) => file === source)).toHaveLength(1);
    expect(readDocument(writes[0].raw).body).toBe(hostedBody);
    expect(readDocument(writes[0].raw).properties.topics).toEqual(['[[Concepts/Trust]]']);
    const collected = await vault.read(target);
    expect(collected).toContain(
      `> ${quoteMarkdown} (※ [[${source.path.replace(/\.md$/, '')}#^${blockId}|Source title]] [[${collectedDay}]])`,
    );
    expect(collected).toContain('custom: untouched # keep');
    expect(collected).toContain('Authored explanation.');
    expect(readDocument(collected).properties).not.toHaveProperty('origin');
  });

  it('fails closed without a typed-destination guard', async () => {
    const { vault, store, source, target, snapshot } = await fixture();
    const raw = await vault.read(target);
    await expect(store.collectHighlight(snapshot, edit, target.path)).rejects.toThrow(
      /typed|eligib|guard/i,
    );
    expect(await vault.read(source)).toBe(snapshot.raw);
    expect(await vault.read(target)).toBe(raw);
  });

  it.each(['dirty', 'read-only', 'unreadable', 'ambiguous'] as const)(
    'preflights a %s target before even promoting the source',
    async (kind) => {
      const { vault, store, source, target, snapshot } = await fixture('Feed');
      const path = source.path;
      if (kind === 'dirty') vault.dirty.add(target);
      if (kind === 'read-only') {
        const writable = vault.assertWritable.bind(vault);
        vi.spyOn(vault, 'assertWritable').mockImplementation((file) => {
          if (file === target) throw new Error('Read-only destination');
          writable(file);
        });
      }
      if (kind === 'unreadable') vault.bytes.set(target, 'No usable frontmatter.');
      if (kind === 'ambiguous')
        vault.bytes.set(target, `${await vault.read(target)}\n## Highlights\n\n## Highlights\n`);
      const before = await vault.read(target);
      await expect(
        store.collectHighlight(snapshot, edit, target.path, options()),
      ).rejects.toThrow();
      expect(source.path).toBe(path);
      expect(await vault.read(source)).toBe(snapshot.raw);
      expect(await vault.read(target)).toBe(before);
    },
  );

  it('rejects a stale source and does not touch the target', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const targetRaw = await vault.read(target);
    vault.bytes.set(source, `${snapshot.raw}\nNative edit.\n`);
    await expect(
      store.collectHighlight(snapshot, edit, target.path, options()),
    ).rejects.toBeInstanceOf(ChangedNote);
    expect(await vault.read(source)).toContain('Native edit.');
    expect(await vault.read(target)).toBe(targetRaw);
  });

  it('revalidates class membership and provider lifetime at source mutation boundaries', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    let valid = true;
    const process = vault.process.bind(vault);
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      if (file === source) valid = false;
      return process(file, update);
    });
    const guard = vi.fn(() => {
      if (!valid) throw new Error('Typed provider reloaded');
    });
    await expect(store.collectHighlight(snapshot, edit, target.path, { guard })).rejects.toThrow(
      'Typed provider reloaded',
    );
    expect(await vault.read(source)).toBe(snapshot.raw);
    expect(await vault.read(target)).not.toContain('## Highlights');
    expect(guard.mock.calls.length).toBeGreaterThan(1);
  });

  it('reports a changed target after saving the source without overwriting native edits', async () => {
    const { vault, store, source, target, snapshot } = await fixture();
    const targetRaw = await vault.read(target);
    const process = vault.process.bind(vault);
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      if (file === target) vault.bytes.set(target, `${targetRaw}\nNative target edit.\n`);
      return process(file, update);
    });
    const error = await failure(store.collectHighlight(snapshot, edit, target.path, options()));
    expect(error).toBeInstanceOf(PartialCollectionError);
    const partial = error as PartialCollectionError<NoteFile>;
    expect(partial.snapshot.body).toBe(hostedBody);
    expect(partial.snapshot.raw).toBe(await vault.read(source));
    expect(partial.cause).toBeInstanceOf(ChangedNote);
    expect(await vault.read(target)).toBe(`${targetRaw}\nNative target edit.\n`);
  });

  it('does not follow a destination identity replacement during the source write', async () => {
    const { vault, store, source, target, snapshot } = await fixture();
    const process = vault.process.bind(vault);
    let replacement: NoteFile | undefined;
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      const next = await process(file, update);
      if (file === source) {
        vault.files.delete(target.path);
        replacement = await vault.create(target.path, '---\nfileClass: Other\n---\nReplacement.');
      }
      return next;
    });
    await expect(
      store.collectHighlight(snapshot, edit, target.path, options()),
    ).rejects.toBeInstanceOf(PartialCollectionError);
    expect(await vault.read(replacement!)).toContain('Replacement.');
    expect(await vault.read(replacement!)).not.toContain('## Highlights');
  });

  it('exposes an honest saved snapshot if the destination write fails and permits an unchanged retry', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const process = vault.process.bind(vault);
    let failTarget = true;
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      if (file === target && failTarget) throw new Error('Destination disk failure');
      return process(file, update);
    });
    const error = await failure(store.collectHighlight(snapshot, edit, target.path, options()));
    expect(error).toBeInstanceOf(PartialCollectionError);
    const partial = error as PartialCollectionError<NoteFile>;
    expect(partial.message).toMatch(/source.*saved/i);
    expect(partial.message).toMatch(/not.*filed|not.*collected|not.*saved/i);
    expect(partial.snapshot.path).toBe(source.path);
    expect(partial.snapshot.properties.status).toBe('later');
    expect(await vault.read(target)).not.toContain('## Highlights');
    failTarget = false;
    const saved = await store.collectHighlight(partial.snapshot, edit, target.path, options());
    await store.collectHighlight(saved, edit, target.path, options());
    expect((await vault.read(target)).split(`> ${quoteMarkdown}`).length - 1).toBe(1);
  });

  it('does not append when retention cannot be saved', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    vault.failWrite = true;
    await expect(store.collectHighlight(snapshot, edit, target.path, options())).rejects.toThrow(
      'Disk full',
    );
    expect(await vault.read(source)).toBe(snapshot.raw);
    expect(await vault.read(target)).not.toContain('## Highlights');
  });

  it('reports a saved annotation when its Later move fails, without appending or rolling back', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const path = source.path;
    vault.failMove = true;
    const error = await failure(store.collectHighlight(snapshot, edit, target.path, options()));
    expect(error).toBeInstanceOf(PartialCollectionError);
    const partial = error as PartialCollectionError<NoteFile>;
    expect(partial.snapshot.path).toBe(path);
    expect(partial.snapshot.raw).toBe(await vault.read(source));
    expect(partial.snapshot.properties.status).toBe('later');
    expect(partial.snapshot.body).toBe(hostedBody);
    expect(await vault.read(target)).not.toContain('## Highlights');
    expect(vault.trashed).toEqual([]);
  });

  it('uses the actual postmove source path for both citation and newly created origin', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const before = source.path;
    const saved = await store.collectHighlight(snapshot, edit, target.path, {
      ...options(),
      created: true,
    });
    expect(source.path).toContain('Reading/Later/');
    expect(saved.path).toBe(source.path);
    const raw = await vault.read(target);
    expect(raw).not.toContain(`${before.replace(/\.md$/, '')}#^`);
    expect(readDocument(raw).properties.origin).toBe(
      `[[${source.path.replace(/\.md$/, '')}#^${blockId}]]`,
    );
    expect(raw).toContain(`[[${source.path.replace(/\.md$/, '')}#^${blockId}|Source title]]`);
  });

  it.each(['null', '""', '"[[Authored source]]"'])(
    'preserves a newly created target origin: %s',
    async (origin) => {
      const { vault, store, target, snapshot } = await fixture();
      vault.bytes.set(
        target,
        (await vault.read(target)).replace('custom:', `origin: ${origin}\ncustom:`),
      );
      const previous = readDocument(await vault.read(target)).properties.origin;
      await store.collectHighlight(snapshot, edit, target.path, { ...options(), created: true });
      expect(readDocument(await vault.read(target)).properties.origin).toEqual(previous);
    },
  );

  it('converts a mention without collecting the node name or inventing an existing origin', async () => {
    const { vault, store, target, snapshot } = await fixture();
    const raw = await vault.read(target);
    const mention = { ...edit, body: `\n[[Concepts/Trust|Clear rules]] ^${blockId}\n` };
    const saved = await store.collectHighlight(snapshot, mention, target.path, {
      ...options(),
      mode: 'mention',
    });
    expect(saved.body).toBe(mention.body);
    expect(await vault.read(target)).toBe(raw);
  });

  it('retains different quotations from one paragraph', async () => {
    const { vault, store, target, snapshot } = await fixture();
    const first = await store.collectHighlight(snapshot, edit, target.path, options());
    await store.collectHighlight(
      first,
      { ...edit, quoteMarkdown: 'A different selected phrase.' },
      target.path,
      options(),
    );
    const raw = await vault.read(target);
    expect(raw).toContain(`> ${quoteMarkdown}`);
    expect(raw).toContain('> A different selected phrase.');
    expect(raw.match(/#\^reader-a1\|/g)).toHaveLength(2);
  });

  it.each([
    { topics: ['[[Older note]]', 7, { authored: 'value' }] },
    { topics: 'An unusual old value' },
    { topics: null },
    { topics: { custom: 'mapping' } },
  ])('remembers typed choices without discarding authored topics: $topics', async ({ topics }) => {
    const { vault, store, source, target } = await fixture();
    vault.bytes.set(source, createDocument({ type: 'article', topics }, sourceBody));
    const saved = await store.collectHighlight(
      await store.read(source.path),
      edit,
      target.path,
      options(),
    );
    expect(saved.properties.topics).toEqual([
      ...(Array.isArray(topics) ? topics : [topics]),
      '[[Concepts/Trust]]',
    ]);
  });

  it('can skip remembering a destination without losing existing associations', async () => {
    const { vault, store, source, target } = await fixture();
    vault.bytes.set(
      source,
      createDocument({ type: 'article', topics: ['[[Older note]]'] }, sourceBody),
    );
    const saved = await store.collectHighlight(await store.read(source.path), edit, target.path, {
      ...options(),
      remember: false,
    });
    expect(saved.properties.topics).toEqual(['[[Older note]]']);
  });

  it('serializes simultaneous collections so both quotations reach a common destination', async () => {
    const { vault, store, target, snapshot } = await fixture();
    const second = await store.capture({
      url: 'https://example.com/second',
      title: 'Second',
      body: 'Another source.',
    });
    const secondSnapshot = await store.read(second.path);
    const entered = gate(),
      release = gate();
    const process = vault.process.bind(vault);
    let firstTarget = true;
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      if (file === target && firstTarget) {
        firstTarget = false;
        entered.resolve();
        await release.promise;
      }
      return process(file, update);
    });
    const first = store.collectHighlight(snapshot, edit, target.path, options());
    await entered.promise;
    const pendingSecond = store.collectHighlight(
      secondSnapshot,
      {
        body: `\n==Another source.== (※ [[Concepts/Trust]]) ^reader-b2\n`,
        quoteMarkdown: 'Another source.',
        blockId: 'reader-b2',
      },
      target.path,
      options(),
    );
    release.resolve();
    await Promise.all([first, pendingSecond]);
    expect(await vault.read(target)).toContain(`> ${quoteMarkdown}`);
    expect(await vault.read(target)).toContain('> Another source.');
  });

  it('checks preview buffers against exact durable source and target bytes before retention', async () => {
    for (const role of ['source', 'target'] as const) {
      const { vault, store, source, target, snapshot } = await fixture('Feed');
      const preview = role === 'source' ? source : target;
      const writable = vault.assertWritable.bind(vault);
      vi.spyOn(vault, 'assertWritable').mockImplementation((file: NoteFile, current?: string) => {
        writable(file);
        if (file === preview && current !== undefined)
          throw new Error('Preview buffer differs from disk');
      });
      await expect(store.collectHighlight(snapshot, edit, target.path, options())).rejects.toThrow(
        'Preview buffer differs',
      );
      expect(await vault.read(source)).toBe(snapshot.raw);
      expect(await vault.read(target)).not.toContain('## Highlights');
    }
  });

  it('traces retention, one combined annotation, relocation, then collection in that order', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const trace: string[] = [];
    const process = vault.process.bind(vault);
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) =>
      process(file, (raw) => {
        const next = update(raw);
        trace.push(
          file === source
            ? readDocument(next).body === hostedBody
              ? 'annotation'
              : 'retention'
            : 'collection',
        );
        if (file === source && readDocument(next).body === hostedBody)
          expect(readDocument(next).properties.topics).toEqual(['[[Concepts/Trust]]']);
        return next;
      }),
    );
    const move = vault.move.bind(vault);
    vi.spyOn(vault, 'move').mockImplementation(async (...args) => {
      trace.push('move');
      return move(...args);
    });
    await store.collectHighlight(snapshot, edit, target.path, options());
    expect(trace).toEqual(['retention', 'annotation', 'move', 'collection']);
  });

  it('reports retention honestly if saving the source annotation then fails', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const process = vault.process.bind(vault);
    let sourceWrites = 0;
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      if (file === source && ++sourceWrites === 2) throw new Error('Annotation failed');
      return process(file, update);
    });
    const error = await failure(store.collectHighlight(snapshot, edit, target.path, options()));
    expect(error).toBeInstanceOf(PartialCollectionError);
    const partial = error as PartialCollectionError<NoteFile>;
    expect(partial.annotationSaved).toBe(false);
    expect(partial.snapshot.properties.status).toBe('later');
    expect(partial.snapshot.body).toBe(snapshot.body);
    expect(partial.savedSnapshot).toBe(partial.snapshot);
    expect(partial.snapshot.raw).toBe(await vault.read(source));
    expect(await vault.read(target)).not.toContain('## Highlights');
  });

  it('retries an unchanged annotated source after move failure by completing its Later relocation', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    vault.failMove = true;
    const error = (await failure(
      store.collectHighlight(snapshot, edit, target.path, options()),
    )) as PartialCollectionError<NoteFile>;
    vault.failMove = false;
    const saved = await store.collectHighlight(error.snapshot, edit, target.path, options());
    expect(saved.path).toContain('Reading/Later/');
    expect(source.path).toBe(saved.path);
    expect(await vault.read(target)).toContain(
      `[[${saved.path.replace(/\.md$/, '')}#^${blockId}|Source title]]`,
    );
  });

  it('uses fresh target bytes after native source relocation rewrites existing citations', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const originalPath = source.path;
    vault.bytes.set(
      target,
      `${await vault.read(target)}\nEarlier [[${originalPath.replace(/\.md$/, '')}]].\n`,
    );
    const move = vault.move.bind(vault);
    vi.spyOn(vault, 'move').mockImplementation(async (file, path, guard) => {
      await move(file, path, guard);
      vault.bytes.set(
        target,
        (await vault.read(target)).replace(
          originalPath.replace(/\.md$/, ''),
          path.replace(/\.md$/, ''),
        ),
      );
    });
    const saved = await store.collectHighlight(snapshot, edit, target.path, options());
    expect(await vault.read(target)).toContain(`Earlier [[${saved.path.replace(/\.md$/, '')}]].`);
    expect(await vault.read(target)).toContain(`> ${quoteMarkdown}`);
  });

  it('protects a destination that becomes dirty after the source annotation saved', async () => {
    const { vault, store, source, target, snapshot } = await fixture();
    const process = vault.process.bind(vault);
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      const next = await process(file, update);
      if (file === source) vault.dirty.add(target);
      return next;
    });
    const error = await failure(store.collectHighlight(snapshot, edit, target.path, options()));
    expect(error).toBeInstanceOf(PartialCollectionError);
    expect((error as PartialCollectionError<NoteFile>).annotationSaved).toBe(true);
    expect(await vault.read(target)).not.toContain('## Highlights');
  });

  it('writes only origin when a mention destination is newly created', async () => {
    const { vault, store, source, target, snapshot } = await fixture();
    await store.collectHighlight(
      snapshot,
      { ...edit, body: `\n[[Concepts/Trust|Clear rules]] ^${blockId}\n` },
      target.path,
      {
        ...options(),
        created: true,
        mode: 'mention',
      },
    );
    const raw = await vault.read(target);
    expect(readDocument(raw).properties.origin).toBe(
      `[[${source.path.replace(/\.md$/, '')}#^${blockId}]]`,
    );
    expect(raw).not.toContain('## Highlights');
    expect(raw).not.toContain(`> ${quoteMarkdown}`);
  });

  it('settles reciprocal destinations without nested file-lane deadlocks', async () => {
    const { vault, store, source, snapshot } = await fixture();
    const second = await store.capture({
      url: 'https://example.com/reciprocal',
      title: 'Second',
      body: 'Second source.',
    });
    const secondSnapshot = await store.read(second.path);
    const outcomes = await Promise.allSettled([
      store.collectHighlight(snapshot, edit, second.path, options()),
      store.collectHighlight(
        secondSnapshot,
        {
          ...edit,
          body: `\n==Second source.== ^reader-b2\n`,
          quoteMarkdown: 'Second source.',
          blockId: 'reader-b2',
        },
        source.path,
        options(),
      ),
    ]);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe('rejected');
    if (outcomes[1].status === 'rejected') expect(outcomes[1].reason).toBeInstanceOf(ChangedNote);
    expect(await vault.read(second)).toContain(`> ${quoteMarkdown}`);
  });

  it('revalidates an unchanged retry rather than trusting its already present source associations', async () => {
    const { vault, store, source, target, snapshot } = await fixture();
    const saved = await store.collectHighlight(snapshot, edit, target.path, options());
    const raw = await vault.read(target);
    vault.bytes.set(source, `${saved.raw}\nNative source edit.\n`);
    await expect(
      store.collectHighlight(saved, edit, target.path, options()),
    ).rejects.toBeInstanceOf(ChangedNote);
    expect(await vault.read(target)).toBe(raw);
    expect(await vault.read(source)).toContain('Native source edit.');
  });

  it('stops collection if the typed provider reloads after annotation saved', async () => {
    const { vault, store, source, target, snapshot } = await fixture();
    let current = true;
    const process = vault.process.bind(vault);
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      const next = await process(file, update);
      if (file === source) current = false;
      return next;
    });
    const error = await failure(
      store.collectHighlight(snapshot, edit, target.path, {
        guard: () => {
          if (!current) throw new Error('Fileclass provider reloaded');
        },
      }),
    );
    expect(error).toBeInstanceOf(PartialCollectionError);
    expect((error as PartialCollectionError<NoteFile>).snapshot.raw).toBe(await vault.read(source));
    expect(await vault.read(target)).not.toContain('## Highlights');
  });

  it('rejects a source race at its native process boundary before retention writes', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const process = vault.process.bind(vault);
    vi.spyOn(vault, 'process').mockImplementation(async (file, update) => {
      if (file === source) vault.bytes.set(source, `${snapshot.raw}\nNative revision.\n`);
      return process(file, update);
    });
    await expect(
      store.collectHighlight(snapshot, edit, target.path, options()),
    ).rejects.toBeInstanceOf(ChangedNote);
    expect(readDocument(await vault.read(source)).properties.status).toBe('feed');
    expect(await vault.read(source)).toContain('Native revision.');
    expect(await vault.read(target)).not.toContain('## Highlights');
  });

  it('cites the collision-safe postmove filename and returns native-rewritten source bytes', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const occupied = source.path.replace('Reading/Stream/', 'Reading/Later/');
    await vault.create(occupied, '---\nfileClass: Existing\n---\nDo not overwrite.\n');
    const move = vault.move.bind(vault);
    vi.spyOn(vault, 'move').mockImplementation(async (file, path, guard) => {
      await move(file, path, guard);
      if (file === source)
        vault.bytes.set(
          source,
          (await vault.read(source)).replaceAll('[[Concepts/Trust]]', '[[Trust]]'),
        );
    });
    const saved = await store.collectHighlight(snapshot, edit, target.path, options());
    expect(saved.path).toBe(occupied.replace(/\.md$/, ' 2.md'));
    expect(saved.body).toContain('[[Trust]]');
    expect(saved.raw).toBe(await vault.read(source));
    expect(await vault.read(target)).toContain(
      `[[${saved.path.replace(/\.md$/, '')}#^${blockId}|Source title]]`,
    );
    expect(await vault.read(vault.file(occupied)!)).toContain('Do not overwrite.');
  });

  it('retains the known saved revision if native rename completes before reporting failure', async () => {
    const { vault, store, source, target, snapshot } = await fixture('Feed');
    const move = vault.move.bind(vault);
    vi.spyOn(vault, 'move').mockImplementation(async (...args) => {
      await move(...args);
      throw new Error('Rename reported failure');
    });
    const error = (await failure(
      store.collectHighlight(snapshot, edit, target.path, options()),
    )) as PartialCollectionError<NoteFile>;
    expect(error).toBeInstanceOf(PartialCollectionError);
    expect(error.annotationSaved).toBe(true);
    expect(error.snapshot.path).toBe(source.path);
    expect(source.path).toContain('Reading/Later/');
    expect(error.snapshot.raw).toBe(await vault.read(source));
    expect(await vault.read(target)).not.toContain('## Highlights');
  });

  it('denies source === destination before any mutation', async () => {
    const { vault, store, source, snapshot } = await fixture('Feed');
    await expect(store.collectHighlight(snapshot, edit, source.path, options())).rejects.toThrow(
      /same|itself|source.*destination/i,
    );
    expect(await vault.read(source)).toBe(snapshot.raw);
  });
});

describe('operation-scoped highlight Undo', () => {
  it('removes only a newly added quotation while preserving unrelated edits and the destination', async () => {
    const f = await fixture();
    const receipts: import('../src/core/store').QuotationReceipt[] = [];
    const saved = await f.store.collectHighlight(f.snapshot, edit, targetPath, {
      ...options(),
      onQuotationAdded: (r) => receipts.push(r),
    });
    expect(receipts).toHaveLength(1);
    await f.vault.process(f.target, (raw) => raw + '\nUser addition.\n');
    const result = await f.store.undoHighlight(saved, f.snapshot.body, receipts, () => {});
    expect(result.retained).toEqual([]);
    expect(result.snapshot.body).toBe(f.snapshot.body);
    expect(await f.vault.read(f.target)).toContain('User addition.');
    expect(await f.vault.read(f.target)).not.toContain('> Clear');
  });
  it('keeps edited quotations and reports incomplete cleanup', async () => {
    const f = await fixture();
    const receipts: import('../src/core/store').QuotationReceipt[] = [];
    const saved = await f.store.collectHighlight(f.snapshot, edit, targetPath, {
      ...options(),
      onQuotationAdded: (r) => receipts.push(r),
    });
    await f.vault.process(f.target, (raw) => raw.replace('> Clear', '> Edited'));
    const result = await f.store.undoHighlight(saved, f.snapshot.body, receipts, () => {});
    expect(result.retained).toEqual([targetPath]);
    expect(await f.vault.read(f.target)).toContain('> Edited');
  });
  it('issues no deletion receipt for an existing quotation', async () => {
    const f = await fixture();
    const saved = await f.store.collectHighlight(f.snapshot, edit, targetPath, options());
    const callback = vi.fn();
    await f.store.collectHighlight(saved, edit, targetPath, {
      ...options(),
      onQuotationAdded: callback,
    });
    expect(callback).not.toHaveBeenCalled();
  });
});
