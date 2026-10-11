import { expect, it } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { sidecarPath } from './sidecar-helpers';

const source = 'Reading/Inbox/Move source.md';
const destination = 'Reading/Inbox/Move destination.md';
const destinationNote = '---\ntype: article\nid: destination-id\npullmanFormat: inline-v1\nextractor: manual\ncontent: ready\n---\nDestination text.\n';

it('reports conflicting JSON ownership and blocks referenced Markdown paths', async () => {
  const jsonPath = 'Reading/Metadata/old-record.json';
  const json = JSON.stringify({ path: source, metadata: { queueMove: { from: source, to: destination } } });
  const store = new MemoryStore({ [destination]: destinationNote, [jsonPath]: json });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors.length).toBeGreaterThan(0);

  await expect(repo.setArticleError(destination, 'must preserve the referenced destination')).rejects.toThrow(/blocked|legacy/i);
  expect(await store.read(jsonPath)).toBe(json);
  expect(await store.read(destination)).toBe(destinationNote);
});

it('rejects destination writes if YAML queueMove ownership arrives during the awaited operation', async () => {
  class RacingStore extends MemoryStore {
    private injected = false;
    constructor(initial: Record<string, string>, private readonly evidence: string) { super(initial); }
    override async process(path: string, update: (current: string) => string): Promise<void> {
      if (path === destination && !this.injected) {
        this.injected = true;
        await this.create(source, this.evidence);
      }
      return super.process(path, update);
    }
  }

  const evidence = '---\ntype: article\npullmanFormat: inline-v1\nqueueMove:\n  from: ' + source + '\n  to: ' + destination + '\n---\nSource text.\n';
  const store = new RacingStore({ [destination]: destinationNote }, evidence);
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors).toEqual([]);

  await expect(repo.setArticleError(destination, 'must not overwrite a newly implicated destination'))
    .rejects.toThrow(/vault changed|ownership review|legacy/i);
  expect(await store.read(destination)).toBe(destinationNote);
  expect(await store.read(source)).toBe(evidence);
});

it('rejects destination writes if JSON queueMove ownership arrives during the awaited operation', async () => {
  const owner = 'Reading/Inbox/Late JSON owner.md', jsonPath = sidecarPath(owner);
  const json = JSON.stringify({ path: owner, metadata: { queueMove: { from: owner, to: destination } } });
  class RacingJsonStore extends MemoryStore {
    private injected = false;
    override async process(path: string, update: (current: string) => string): Promise<void> {
      if (path === destination && !this.injected) { this.injected = true; await this.create(jsonPath, json); }
      return super.process(path, update);
    }
  }
  const store = new RacingJsonStore({ [destination]: destinationNote }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors).toEqual([]);
  await expect(repo.setArticleError(destination, 'must preserve late JSON-owned destination')).rejects.toThrow(/vault changed|ownership review|legacy/i);
  expect(await store.read(destination)).toBe(destinationNote);
  expect(await store.read(jsonPath)).toBe(json);
});

it('rejects create if JSON queueMove ownership arrives during awaited path preparation', async () => {
  const owner = 'Reading/Inbox/Late JSON create owner.md';
  class RacingJsonCreateStore extends MemoryStore {
    destination = '';
    private injected = false;
    override async create(path: string, content: string, options?: { guard?: () => void }): Promise<void> {
      if (path.endsWith('JSON create race.md') && !this.injected) {
        this.injected = true; this.destination = path;
        const jsonPath = sidecarPath(owner), json = JSON.stringify({ path: owner, metadata: { queueMove: { from: owner, to: path } } });
        await super.create(jsonPath, json);
      }
      return super.create(path, content, options);
    }
  }
  const store = new RacingJsonCreateStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors).toEqual([]);
  await expect(repo.createArticle({ title: 'JSON create race', url: '', body: 'Must not create.' }))
    .rejects.toThrow(/orphaned|legacy|ownership/i);
  expect(store.destination).not.toBe('');
  expect(await store.exists(store.destination)).toBe(false);
  expect(await store.read(sidecarPath(owner))).toContain(store.destination);
});

it('rejects move if JSON queueMove ownership arrives during rename preflight', async () => {
  const from = 'Reading/Inbox/JSON move race.md', to = 'Reading/Later/JSON move race.md', owner = 'Reading/Inbox/Late JSON move owner.md';
  const raw = '---\ntype: article\nurl: https://example.com/json-race\nstatus: inbox\nextractor: manual\ncontent: ready\npullmanFormat: inline-v1\n---\nMove source.\n';
  class RacingJsonRenameStore extends MemoryStore {
    private injected = false;
    override async rename(sourcePath: string, destinationPath: string, options: { expectedContent: string; guard?: () => void }): Promise<void> {
      if (destinationPath === to && !this.injected) {
        this.injected = true;
        const jsonPath = sidecarPath(owner), json = JSON.stringify({ path: owner, metadata: { queueMove: { from: owner, to } } });
        await this.create(jsonPath, json);
      }
      return super.rename(sourcePath, destinationPath, options);
    }
  }
  const store = new RacingJsonRenameStore({ [from]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors).toEqual([]);
  await expect(repo.setStatus(from, 'later')).rejects.toThrow(/vault changed|ownership review|legacy/i);
  expect(await store.read(from)).toBe(raw);
  expect(await store.exists(to)).toBe(false);
  expect(await store.read(sidecarPath(owner))).toContain(to);
});

it('rejects create if YAML queueMove ownership arrives during awaited path preparation', async () => {
  const owner = 'Reading/Inbox/Late owner.md';
  class RacingCreateStore extends MemoryStore {
    destination = '';
    private injected = false;
    override async create(path: string, content: string, options?: { guard?: () => void }): Promise<void> {
      if (path.endsWith('Create race.md') && !this.injected) {
        this.injected = true; this.destination = path;
        const evidence = '---\ntype: article\npullmanFormat: inline-v1\nqueueMove:\n  from: ' + owner + '\n  to: ' + path + '\n---\nOwnership evidence.\n';
        await super.create(owner, evidence);
      }
      return super.create(path, content, options);
    }
  }
  const store = new RacingCreateStore(), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors).toEqual([]);

  await expect(repo.createArticle({ title: 'Create race', url: '', body: 'New article.' }))
    .rejects.toThrow(/vault changed|ownership review|legacy/i);
  expect(store.destination).not.toBe('');
  expect(await store.exists(store.destination)).toBe(false);
  expect((await store.read(owner)).includes('to: ' + store.destination)).toBe(true);
});

it('rejects move into a destination if YAML queueMove ownership arrives during move preflight', async () => {
  const from = 'Reading/Inbox/Move race.md', to = 'Reading/Later/Move race.md', owner = 'Reading/Inbox/Late owner.md';
  const raw = '---\ntype: article\nurl: https://example.com/race\nstatus: inbox\nextractor: manual\ncontent: ready\npullmanFormat: inline-v1\n---\nMove source.\n';
  class RacingRenameStore extends MemoryStore {
    private injected = false;
    override async rename(sourcePath: string, destinationPath: string, options: { expectedContent: string; guard?: () => void }): Promise<void> {
      if (destinationPath === to && !this.injected) {
        this.injected = true;
        const evidence = '---\ntype: article\npullmanFormat: inline-v1\nqueueMove:\n  from: ' + owner + '\n  to: ' + to + '\n---\nOwnership evidence.\n';
        await this.create(owner, evidence);
      }
      return super.rename(sourcePath, destinationPath, options);
    }
  }
  const store = new RacingRenameStore({ [from]: raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors).toEqual([]);

  await expect(repo.setStatus(from, 'later')).rejects.toThrow(/vault changed|ownership review|legacy/i);
  expect(await store.read(from)).toBe(raw);
  expect(await store.exists(to)).toBe(false);
  expect((await store.read(owner)).includes('to: ' + to)).toBe(true);
});

it('refreshes late-arriving YAML queueMove ownership before position writes to its destination', async () => {
  const store = new MemoryStore({ [destination]: destinationNote });
  const repo = new ReaderRepository(store, DEFAULT_SETTINGS);
  expect((await repo.prepareStorage()).errors).toEqual([]);

  const sourceNote = '---\ntype: article\npullmanFormat: inline-v1\nqueueMove:\n  from: ' + source + '\n  to: ' + destination + '\n---\nSource text.\n';
  await store.create(source, sourceNote);
  const before = store.snapshot();

  await expect(repo.saveReadingPosition(destination, { marker: 'Destination' }, 'destination-id'))
    .rejects.toThrow(/legacy|blocked|queueMove/i);
  expect(store.snapshot()).toEqual(before);
});
