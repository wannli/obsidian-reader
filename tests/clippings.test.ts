import { describe, expect, it, vi } from 'vitest';
import {
  readClipping,
  clippingMarkdown,
  planClipping,
  locateClipping,
  clippingTitle,
} from '../src/core/clippings';
import { ClippingStore, type ClippingPort } from '../src/core/clipping-store';
import { ArticleStore, type NoteFile } from '../src/core/store';
import { createDocument, readDocument, patchProperties } from '../src/core/document';
import { MemoryVault, gate } from './helpers/memory-vault';
const binding = { property: 'fileClass', type: 'Clipping' };
class ClipVault extends MemoryVault {
  resolveLink(path: string) {
    return this.file(path) ?? this.file(path + '.md');
  }
  override async create(path: string, raw: string, guard: () => void | Promise<void> = () => {}) {
    await guard();
    return super.create(path, raw);
  }
}
async function fixture(body = 'Streets shape our choices.', status = 'inbox') {
  const vault = new ClipVault(),
    articles = new ArticleStore(vault);
  const file = await vault.create(
    'Articles/City.md',
    createDocument({ type: 'article', status, published: '2020-01-01' }, body),
  );
  articles.catalog.update(file.path, readDocument(await vault.read(file)).properties);
  let revision = 0;
  const verify = vi.fn(async () => {}),
    validate = vi.fn(async () => {}),
    check = vi.fn(() => {});
  const port: ClippingPort<NoteFile> = {
    bindings: () => [binding],
    revision: () => revision,
    candidates: () =>
      [...vault.files.values()]
        .filter((item) => item !== file)
        .map((item) => ({ file: item, path: item.path, bytes: vault.bytes.get(item)!.length })),
    prepare: vi.fn(async () => ({ binding, folder: 'Nodes', check, validate, verify })),
  };
  const clippings = new ClippingStore(articles, port),
    controller = new AbortController();
  let snapshot = await articles.read(file.path);
  const keep = (quote = 'Streets shape our choices.') =>
    clippings.keep(
      snapshot,
      { quote },
      controller.signal,
      () => {},
      (saved) => {
        snapshot = saved;
      },
    );
  return {
    vault,
    articles,
    file,
    port,
    clippings,
    controller,
    keep,
    verify,
    validate,
    check,
    get snapshot() {
      return snapshot;
    },
    bump: () => revision++,
  };
}
describe('explicit clipping deletion', () => {
  it('trashes the whole confirmed card including personal writing, without changing its article or another card', async () => {
    const f = await fixture();
    const kept = await f.keep();
    const card = f.vault.file(kept.path)!;
    f.vault.bytes.set(card, (await f.vault.read(card)) + '\nMy personal writing.\n');
    const otherRaw = await f.vault.read(card);
    const other = await f.vault.create('Nodes/Other clipping.md', otherRaw);
    const sourceRaw = await f.vault.read(f.file);
    const deletion = await f.clippings.prepareDelete(f.snapshot, card.path, f.controller.signal);
    expect(f.vault.trashed).toEqual([]);
    await deletion.trash(() => {});
    expect(f.vault.trashed).toEqual([kept.path]);
    expect(await f.vault.read(f.file)).toBe(sourceRaw);
    expect(await f.vault.read(other)).toBe(otherRaw);
    expect(
      (await f.clippings.scan(f.snapshot, f.controller.signal)).items.map((item) => item.path),
    ).toEqual([other.path]);
    expect(f.port.prepare).toHaveBeenCalledTimes(1);
  });
  it('rejects arbitrary notes and the article itself', async () => {
    const f = await fixture();
    const note = await f.vault.create(
      'Nodes/Personal.md',
      createDocument({ fileClass: 'Clipping', origin: '[[Other#^x]]' }, '> Words'),
    );
    await expect(
      f.clippings.prepareDelete(f.snapshot, note.path, f.controller.signal),
    ).rejects.toThrow('no longer a clipping');
    await expect(
      f.clippings.prepareDelete(f.snapshot, f.file.path, f.controller.signal),
    ).rejects.toThrow('safely inspected');
    expect(f.vault.trashed).toEqual([]);
  });
  it.each(['edit', 'replace', 'rename', 'dirty', 'cancel', 'rebind'] as const)(
    'preserves a card on %s after confirmation was prepared',
    async (change) => {
      const f = await fixture();
      const kept = await f.keep();
      const card = f.vault.file(kept.path)!;
      const deletion = await f.clippings.prepareDelete(f.snapshot, card.path, f.controller.signal);
      if (change === 'edit') f.vault.bytes.set(card, (await f.vault.read(card)) + '\nNew writing');
      if (change === 'replace') {
        const raw = f.vault.bytes.get(card)!;
        f.vault.files.delete(card.path);
        await f.vault.create(card.path, raw);
      }
      if (change === 'rename') await f.vault.move(card, 'Nodes/Renamed.md');
      if (change === 'dirty') f.vault.dirty.add(card);
      if (change === 'cancel') f.controller.abort();
      if (change === 'rebind') f.port.bindings = () => [];
      await expect(deletion.trash(() => {})).rejects.toThrow();
      expect(f.vault.trashed).toEqual([]);
    },
  );
  it('rechecks bytes, cancellation and source identity at final trash dispatch', async () => {
    for (const change of ['bytes', 'cancel', 'source']) {
      const f = await fixture();
      const kept = await f.keep();
      const card = f.vault.file(kept.path)!;
      const deletion = await f.clippings.prepareDelete(f.snapshot, card.path, f.controller.signal);
      f.vault.beforeTrash = async () => {
        if (change === 'bytes')
          f.vault.bytes.set(card, (await f.vault.read(card)) + '\nConcurrent writing');
        if (change === 'cancel') f.controller.abort();
        if (change === 'source') f.vault.files.set(f.file.path, { path: f.file.path });
      };
      await expect(deletion.trash(() => {})).rejects.toThrow();
      expect(f.vault.trashed).toEqual([]);
    }
  });
});

describe('clipping Markdown contract', () => {
  it('saves only provider binding and origin metadata, with a rich multiline blockquote', () => {
    const quote = '**Important** [words](https://example.org).\n\nAnother sentence.';
    const raw = clippingMarkdown(binding, '[[Articles/City#^streets]]', quote);
    expect(readDocument(raw).properties).toEqual({
      fileClass: 'Clipping',
      origin: '[[Articles/City#^streets]]',
    });
    expect(raw).toContain('>\n> Another');
    expect(readClipping(raw, [binding])?.quoteMarkdown).toBe(quote);
  });
  it('takes the first structural quotation, leaving personal writing and later quotes alone', () => {
    const raw =
      clippingMarkdown(binding, '[[City#^streets]]', 'Original words.') +
      '\nMy [[thought]].\n\n> Other words.\n';
    expect(readClipping(raw, [binding])?.quote).toBe('Original words.');
  });
  it('does not classify an untyped note, a missing origin or a fenced quote as a clipping', () => {
    expect(
      readClipping('---\norigin: "[[City#^streets]]"\n---\n> Words', [binding]),
    ).toBeUndefined();
    expect(readClipping('---\nfileClass: Clipping\n---\n> Words', [binding])).toBeUndefined();
    expect(
      readClipping(
        '---\nfileClass: Clipping\norigin: "[[City#^streets]]"\n---\n```md\n> Words\n```',
        [binding],
      ),
    ).toBeUndefined();
  });
  it('ignores quotation-looking text inside Obsidian comments', () => {
    const header = '---\nfileClass: Clipping\norigin: "[[City#^streets]]"\n---\n';
    expect(readClipping(header + '%%\n> Hidden quotation.\n%%\n', [binding])).toBeUndefined();
    expect(
      readClipping(header + '%%\n> Hidden quotation.\n%%\n\n> Real quotation.\n', [binding])?.quote,
    ).toBe('Real quotation.');
  });
  it('uses native paragraph anchors without highlight markup or reverse citations', () => {
    const body = 'Clear **rules** build [trust](https://example.org).';
    const plan = planClipping(body, { quote: 'rules build trust' });
    expect(plan.quoteMarkdown).toBe('**rules** build [trust](https://example.org)');
    expect(plan.body).toBe(body + ' ^' + plan.blockId);
    expect(planClipping(plan.body, { quote: 'rules build trust' }).body).toBe(plan.body);
  });
  it('shares paragraph references, preserves other paragraphs, and rejects duplicate anchors', () => {
    const body = 'First words. Second words. ^existing\n\nUnchanged paragraph.';
    expect(planClipping(body, { quote: 'First words.' }).body).toBe(body);
    expect(planClipping(body, { quote: 'Second words.' }).blockId).toBe('existing');
    expect(() => planClipping(body + '\n\nAnother ^existing', { quote: 'First words.' })).toThrow(
      /duplicated/,
    );
  });
  it('never claims an exact match after edits, missing anchors or repeated words', () => {
    expect(locateClipping('Other words. ^a', 'a', 'Original words.')).toBeUndefined();
    expect(locateClipping('Original words.', 'a', 'Original words.')).toBeUndefined();
    expect(locateClipping('same same ^a', 'a', 'same')).toBeUndefined();
  });
  it('bounds and sanitises opening-word filenames without date or AI metadata', () => {
    expect(clippingTitle('Streets shape our choices.')).toBe('Streets shape our choices');
    expect(clippingTitle('[[unsafe]] / title: here')).not.toMatch(/[\[\]\/\:]/);
    expect([...clippingTitle('Long '.repeat(50))].length).toBeLessThanOrEqual(100);
  });
});
describe('guarded clipping capture', () => {
  it('creates one independent card and preserves source bytes except its native paragraph address', async () => {
    const f = await fixture();
    const before = await f.vault.read(f.file);
    const result = await f.keep();
    expect(result.created).toBe(true);
    expect(result.path).toBe('Nodes/Streets shape our choices.md');
    expect(f.snapshot.raw.replace(/ \^reader-[a-z0-9-]+/u, '')).toBe(before);
    const raw = await f.vault.read(f.vault.file(result.path)!);
    expect(raw).not.toContain('topics:');
    expect(raw).not.toContain('created-by');
    expect(raw).not.toContain('==');
    expect(readClipping(raw, [binding])?.origin).toMatch(/^\[\[Articles\/City#\^reader-/);
    expect(f.verify).toHaveBeenCalledWith(result.path);
  });
  it('retains Feed before creation, including when the paragraph address already exists', async () => {
    const f = await fixture('Streets shape our choices. ^existing', 'feed');
    const create = vi.spyOn(f.vault, 'create');
    create.mockImplementationOnce(async (path, raw, guard) => {
      expect(readDocument(await f.vault.read(f.file)).properties.status).toBe('later');
      await guard?.();
      return MemoryVault.prototype.create.call(f.vault, path, raw);
    });
    const result = await f.keep();
    expect(result.snapshot.properties.status).toBe('later');
    expect(result.snapshot.path).toBe('Articles/City.md');
    expect(result.snapshot.body).toBe('Streets shape our choices. ^existing');
  });
  it('reuses a card after moves, renames and added personal writing', async () => {
    const f = await fixture();
    const first = await f.keep();
    const card = f.vault.file(first.path)!;
    await f.vault.process(card, (raw) => raw + '\nA thought about [[Cities]].\n');
    await f.vault.move(card, 'Elsewhere/Renamed.md');
    const result = await f.keep();
    expect(result.created).toBe(false);
    expect(result.path).toBe('Elsewhere/Renamed.md');
    expect(f.vault.files.size).toBe(2);
  });
  it('suffixes unrelated filename collisions rather than overwriting or asking for a title', async () => {
    const f = await fixture();
    const occupied = await f.vault.create(
      'Nodes/Streets shape our choices.md',
      '---\nfileClass: Other\n---\nAuthored content',
    );
    expect((await f.keep()).path).toBe('Nodes/Streets shape our choices 2.md');
    expect(await f.vault.read(occupied)).toContain('Authored content');
  });
  it('preserves a retained source and unused reference when card creation fails', async () => {
    const f = await fixture(undefined, 'feed');
    vi.spyOn(f.vault, 'create').mockRejectedValueOnce(new Error('Disk full'));
    await expect(f.keep()).rejects.toThrow(/Source retained/);
    expect(f.snapshot.properties.status).toBe('later');
    expect(f.snapshot.body).toContain('^reader-');
    const anchored = f.snapshot.body;
    await f.keep();
    expect(f.snapshot.body).toBe(anchored);
  });
  it('blocks invalid selections and dirty source editors before any write', async () => {
    const f = await fixture('First paragraph.\n\nSecond paragraph.');
    const raw = f.snapshot.raw;
    await expect(f.keep('First paragraph. Second paragraph.')).rejects.toThrow();
    expect(await f.vault.read(f.file)).toBe(raw);
    f.vault.dirty.add(f.file);
    await expect(f.keep('First paragraph.')).rejects.toThrow(/unfinished/);
    expect(f.vault.files.size).toBe(1);
  });
  it('does not block capture because an unrelated ordinary note has no frontmatter', async () => {
    const f = await fixture();
    await f.vault.create('Ordinary.md', 'My personal writing, with no YAML.');
    expect((await f.keep()).created).toBe(true);
  });
  it('rejects unsafe source link paths before retaining Feed or adding an address', async () => {
    const f = await fixture(undefined, 'feed');
    await f.vault.move(f.file, 'Articles/Unsafe#title.md');
    const snapshot = await f.articles.read(f.file.path);
    await expect(
      f.clippings.keep(
        snapshot,
        { quote: 'Streets shape our choices.' },
        f.controller.signal,
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/paragraph wikilink/);
    expect(await f.vault.read(f.file)).toBe(snapshot.raw);
    expect(snapshot.properties.status).toBe('feed');
  });
  it('does not infer a unique original occurrence from repeated words', async () => {
    const f = await fixture('same same');
    await expect(f.keep('same')).rejects.toThrow();
    expect(f.vault.files.size).toBe(1);
  });
  it('holds the write slot until a cancelled uncooperative provider actually settles', async () => {
    const f = await fixture();
    const held = gate();
    const prepare = f.port.prepare;
    vi.spyOn(f.port, 'prepare').mockImplementationOnce(async (signal) => {
      await held.promise;
      return prepare(signal);
    });
    const pending = f.keep();
    f.controller.abort();
    await expect(f.keep()).rejects.toThrow(/still settling/);
    held.resolve();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(f.vault.files.size).toBe(1);
  });
  it('treats unverified creation as possibly saved, retaining the card and deduplicating a later retry', async () => {
    const f = await fixture();
    f.verify.mockRejectedValueOnce(new Error('Metadata pending'));
    await expect(f.keep()).rejects.toThrow(/may already be saved/);
    expect(f.vault.files.size).toBe(2);
    expect((await f.keep()).created).toBe(false);
  });
  it('does not overwrite a clipping if it changes before readback', async () => {
    const f = await fixture();
    const create = f.vault.create.bind(f.vault);
    vi.spyOn(f.vault, 'create').mockImplementationOnce(async (...args) => {
      const file = await create(...args);
      f.vault.bytes.set(file, 'User replaced this note');
      return file;
    });
    await expect(f.keep()).rejects.toThrow(/may already be saved/);
    expect([...f.vault.bytes.values()]).toContain('User replaced this note');
  });
  it('blocks new capture on incomplete coverage and never interprets the scan limit as absence', async () => {
    const f = await fixture();
    for (let i = 0; i < 201; i++)
      await f.vault.create(`Other/${i}.md`, '---\nfileClass: Other\n---\nText');
    expect((await f.clippings.scan(f.snapshot, f.controller.signal)).complete).toBe(false);
    await expect(f.keep()).rejects.toThrow(/200-note scan limit.*Other\/200\.md/);
    expect(f.snapshot.body).not.toContain('^reader-');
  });
  it.each([
    ['oversized', '200 KB note-size limit'],
    ['unreadable', 'Could not read note'],
    ['invalid-yaml', 'Could not parse frontmatter'],
    ['unresolved-origin', 'Could not resolve origin'],
    ['moved', 'Note moved, was replaced, or was deleted'],
  ] as const)('reports the file and condition blocking capture: %s', async (kind, reason) => {
    const f = await fixture();
    const path = `Other/${kind}.md`;
    const raw =
      kind === 'oversized'
        ? 'x'.repeat(200_001)
        : kind === 'invalid-yaml'
          ? '---\nfileClass: [\n---\nPrivate body'
          : kind === 'unresolved-origin'
            ? clippingMarkdown(binding, '[[Missing#^source]]', 'Private quotation')
            : 'Ordinary text';
    const file = await f.vault.create(path, raw);
    const read = f.vault.read.bind(f.vault);
    vi.spyOn(f.vault, 'read').mockImplementation(async (candidate) => {
      if (candidate === file && kind === 'unreadable')
        throw new Error('Private error details must not be exposed');
      const result = await read(candidate);
      if (candidate === file && kind === 'moved') candidate.path = 'Other/Moved.md';
      return result;
    });
    const before = f.snapshot.raw;
    const error = await f.keep().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(reason);
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).not.toMatch(/Private|indexing settles/);
    expect(await f.vault.read(f.file)).toBe(before);
    expect(f.vault.file('Nodes/Streets shape our choices.md')).toBeUndefined();
  });

  it('reports the bounded read budget and the first file it cannot inspect', async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) await f.vault.create(`Other/${i}.md`, 'x'.repeat(180_000));
    await expect(f.keep()).rejects.toThrow(/1 MB scan-size limit.*Other\/5\.md/);
    expect(f.snapshot.body).not.toContain('^reader-');
  });

  it('bounds diagnostics to three file examples without exposing note contents', async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++)
      await f.vault.create(`Other/${i}.md`, '---\nfileClass: [\n---\nPrivate body');
    const error = await f.keep().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Other/0.md');
    expect(message).toContain('Other/2.md');
    expect(message).not.toContain('Other/3.md');
    expect(message).toContain('3 additional lookup problems');
    expect(message).not.toContain('Private body');
  });

  it('includes lookup diagnostics when the source was saved but no card was created', async () => {
    const f = await fixture();
    f.validate.mockImplementationOnce(async () => {
      await f.vault.create('Other/Too large.md', 'x'.repeat(200_001));
    });
    await expect(f.keep()).rejects.toThrow(
      /Source retained, but clipping lookup is incomplete.*200 KB note-size limit.*Other\/Too large\.md/,
    );
    expect(f.snapshot.body).toContain('^reader-');
    expect(f.vault.file('Nodes/Streets shape our choices.md')).toBeUndefined();
  });

  it('rechecks invalidated post-write coverage and reuses a concurrently created clipping', async () => {
    const f = await fixture('Streets shape our choices. ^existing', 'feed');
    const scan = f.clippings.scan.bind(f.clippings);
    const process = vi.spyOn(f.vault, 'process');
    let scans = 0;
    vi.spyOn(f.clippings, 'scan').mockImplementation(async (...args) => {
      const result = await scan(...args);
      if (++scans === 2) {
        await f.vault.create(
          'Cards/Concurrent.md',
          clippingMarkdown(binding, '[[Articles/City#^existing]]', 'Streets shape our choices.'),
        );
        f.bump();
      }
      return result;
    });
    expect(await f.keep()).toMatchObject({ created: false, path: 'Cards/Concurrent.md' });
    expect(scans).toBe(3);
    expect(process).toHaveBeenCalledOnce();
    expect(f.vault.files.size).toBe(2);
  });

  it('bounds post-write reconciliation when the vault keeps changing and never replays the source write', async () => {
    const f = await fixture();
    const scan = f.clippings.scan.bind(f.clippings);
    const process = vi.spyOn(f.vault, 'process');
    let scans = 0;
    vi.spyOn(f.clippings, 'scan').mockImplementation(async (...args) => {
      const result = await scan(...args);
      if (++scans > 1) f.bump();
      return result;
    });
    await expect(f.keep()).rejects.toThrow(/changed during all 3 lookup attempts/);
    expect(scans).toBe(4); // One preflight, then at most three post-write attempts.
    expect(process).toHaveBeenCalledOnce();
    expect(f.snapshot.body).toContain('^reader-');
    expect(f.vault.files.size).toBe(1);
  });

  it('rejects real source edits during reconciliation instead of creating from stale words', async () => {
    const f = await fixture();
    const scan = f.clippings.scan.bind(f.clippings);
    let scans = 0;
    vi.spyOn(f.clippings, 'scan').mockImplementation(async (...args) => {
      const result = await scan(...args);
      if (++scans === 2) {
        await f.vault.process(f.file, (raw) => raw.replace('Streets', 'Edited streets'));
        f.bump();
      }
      return result;
    });
    await expect(f.keep()).rejects.toThrow(/note changed/i);
    expect(await f.vault.read(f.file)).toContain('Edited streets');
    expect(f.vault.files.size).toBe(1);
  });

  it('never installs old source evidence when a change races source validation', async () => {
    const f = await fixture();
    const validate = f.articles.validate.bind(f.articles);
    f.port.observed = vi.fn();
    vi.spyOn(f.articles, 'validate').mockImplementationOnce(async (snapshot) => {
      await validate(snapshot);
      await f.vault.process(f.file, (raw) => raw.replace('Streets', 'Edited streets'));
      f.bump();
    });
    await expect(f.keep()).rejects.toThrow(/note changed/i);
    expect(f.port.observed).not.toHaveBeenCalled();
    expect(await f.vault.read(f.file)).toContain('Edited streets');
    expect(f.vault.files.size).toBe(1);
  });

  it('cancels reconciliation without another lookup or card creation', async () => {
    const f = await fixture();
    const scan = f.clippings.scan.bind(f.clippings);
    let scans = 0;
    vi.spyOn(f.clippings, 'scan').mockImplementation(async (...args) => {
      const result = await scan(...args);
      if (++scans === 2) {
        f.bump();
        f.controller.abort();
      }
      return result;
    });
    await expect(f.keep()).rejects.toThrow(/cancelled/);
    expect(scans).toBe(2);
    expect(f.snapshot.body).toContain('^reader-');
    expect(f.vault.files.size).toBe(1);
  });

  it('archives a clipping-referenced source on Reader Delete even after its card loses its type or quotation', async () => {
    const f = await fixture();
    const kept = await f.keep(),
      card = f.vault.file(kept.path)!;
    await f.vault.process(
      card,
      (raw) => patchProperties(raw, { fileClass: 'Other' }).split('>')[0] + 'User writing',
    );
    expect(await f.articles.trash(f.snapshot)).toBe('archived-protected');
    expect(f.vault.file(card.path)).toBe(card);
    expect(f.vault.file(f.file.path)).toBe(f.file);
    expect(f.vault.trashed).toEqual([]);
  });
  it('protects origin references even without any configured clipping binding', async () => {
    const f = await fixture();
    await f.keep();
    vi.spyOn(f.port, 'bindings').mockReturnValue([]);
    expect(await f.articles.trash(f.snapshot)).toBe('archived-protected');
    expect(f.vault.trashed).toEqual([]);
  });
  it('refuses deletion on uncertain origin resolution independently of schema membership or setup', async () => {
    const f = await fixture();
    const kept = await f.keep();
    await f.vault.process(f.vault.file(kept.path)!, (raw) =>
      patchProperties(raw, { fileClass: 'Other' }),
    );
    vi.spyOn(f.port, 'bindings').mockReturnValue([]);
    vi.spyOn(f.vault, 'resolveLink').mockReturnValue(undefined);
    expect((await f.clippings.scan(f.snapshot, f.controller.signal)).complete).toBe(false);
    await expect(f.articles.trash(f.snapshot)).rejects.toThrow(
      /Could not verify related clipping references/,
    );
    expect((await f.articles.read(f.file.path)).properties.status).toBe('inbox');
    expect(f.vault.trashed).toEqual([]);
  });
  it.each(['inbox', 'feed', 'later', 'archive'])(
    'leaves %s untouched when an unrelated orphan makes clipping coverage incomplete',
    async (status) => {
      const f = await fixture('Plain publisher text.', status);
      await f.vault.create(
        'Other/Orphan.md',
        '---\nfileClass: Other\norigin: "[[Missing]]"\n---\nPrivate authored text',
      );
      const before = f.snapshot.raw;
      const scan = await f.clippings.scan(f.snapshot, f.controller.signal);
      expect(scan).toMatchObject({ referenced: false, complete: false });
      await expect(f.articles.trash(f.snapshot)).rejects.toThrow(
        /Could not verify related clipping references.*not deleted or archived/u,
      );
      expect(await f.vault.read(f.file)).toBe(before);
      expect(f.articles.catalog.article(f.file.path)?.queue).toBe(
        status === 'inbox'
          ? 'Inbox'
          : status === 'feed'
            ? 'Feed'
            : status === 'later'
              ? 'Later'
              : 'Archive',
      );
      expect(f.vault.trashed).toEqual([]);
    },
  );
  it('archives a confirmed reference even when an unrelated origin prevents complete coverage', async () => {
    const f = await fixture('Plain publisher text.', 'feed');
    await f.vault.create('Other/Linked.md', '---\norigin: "[[Articles/City]]"\n---\n');
    await f.vault.create('Other/Orphan.md', '---\norigin: "[[Missing]]"\n---\n');
    expect(await f.clippings.scan(f.snapshot, f.controller.signal)).toMatchObject({
      referenced: true,
      complete: false,
    });
    expect(await f.articles.trash(f.snapshot)).toBe('archived-protected');
    expect((await f.articles.read(f.file.path)).properties.status).toBe('archive');
    expect(f.vault.trashed).toEqual([]);
  });
  it('still archives an expired Feed article when unrelated clipping coverage is incomplete', async () => {
    const f = await fixture('Plain publisher text.', 'feed');
    await f.vault.create('Other/Orphan.md', '---\norigin: "[[Missing]]"\n---\n');
    expect(await f.articles.expire(new Date('2026-11-20'))).toEqual({
      deleted: 0,
      retained: 0,
      promoted: 1,
    });
    expect((await f.articles.read(f.file.path)).properties.status).toBe('archive');
    expect(f.vault.trashed).toEqual([]);
  });
  it('archives an expired Feed source with a clipping origin rather than trashing it', async () => {
    const f = await fixture('Streets shape our choices. ^existing', 'feed');
    await f.vault.create(
      'Elsewhere/Card.md',
      clippingMarkdown(binding, '[[Articles/City#^existing]]', 'Streets shape our choices.'),
    );
    const result = await f.articles.expire(new Date('2026-11-20'));
    expect(result.promoted).toBe(1);
    expect(result.deleted).toBe(0);
    expect(f.vault.trashed).toEqual([]);
  });
  it('revokes negative reference coverage at final trash dispatch', async () => {
    const f = await fixture();
    f.vault.beforeTrash = async () => {
      f.bump();
    };
    await expect(f.articles.trash(f.snapshot)).rejects.toThrow(/references changed/);
    expect(f.vault.trashed).toEqual([]);
  });
  it('does not create another card when matching quotation words have an unresolved old reference', async () => {
    const f = await fixture();
    await f.vault.create(
      'Cards/Existing.md',
      clippingMarkdown(binding, '[[Articles/City#^missing]]', 'Streets shape our choices.'),
    );
    await expect(f.keep()).rejects.toThrow(/existing clipping.*unresolved/iu);
    expect(f.vault.files.size).toBe(2);
    expect(f.snapshot.body).not.toContain('^reader-');
  });
  it('does not arbitrarily deduplicate multiple cards at the same original passage', async () => {
    const f = await fixture();
    const first = await f.keep();
    await f.vault.create('Cards/Copy.md', await f.vault.read(f.vault.file(first.path)!));
    await expect(f.keep()).rejects.toThrow(/Several clipping cards.*Cards\/Copy.md/u);
    expect(f.vault.files.size).toBe(3);
  });
  it('does not cascade deletion or silently restore edited quotation snapshots', async () => {
    const f = await fixture();
    const kept = await f.keep(),
      card = f.vault.file(kept.path)!;
    await f.vault.process(card, (raw) =>
      raw.replace('Streets shape our choices.', 'My rewritten quotation.'),
    );
    const scan = await f.clippings.scan(f.snapshot, f.controller.signal);
    expect(scan.items[0].location).toBeUndefined();
    await f.vault.trash(f.file);
    expect(await f.vault.read(card)).toContain('My rewritten quotation.');
  });
});
