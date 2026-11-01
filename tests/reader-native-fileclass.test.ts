import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { ReaderNodes } from '../src/host/fileclass/reader-nodes';
import { FileclassBridge } from '../src/host/fileclass/fileclass';
import { connectNodes } from '../src/host/node-relations';
import type { PublicApi } from '../src/host/fileclass/fileclass-fields';
import { bindNodesApi, nodesApi } from '../src/host/nodes';

vi.mock('obsidian', () => {
  class TFile {
    extension = 'md';
    basename: string;
    constructor(public path: string) {
      this.basename = path.split('/').at(-1)!.replace(/\.md$/, '');
    }
  }
  class TFolder {
    constructor(public path: string) {}
  }
  class MarkdownView {
    constructor(
      public file: TFile,
      public editor: { getValue(): string },
    ) {}
    getMode() {
      return 'source';
    }
  }
  return {
    TFile,
    TFolder,
    MarkdownView,
    Notice: class {},
    parseFrontMatterAliases: (frontmatter: { aliases?: string[] }) => frontmatter?.aliases ?? [],
    prepareFuzzySearch: (query: string) => (candidate: string) =>
      candidate.toLowerCase().includes(query.toLowerCase()) ? { score: -1 } : null,
    stringifyYaml: (data: Record<string, unknown>) =>
      Object.entries(data)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n') + '\n',
  };
});

function events() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    on(name: string, fn: (...args: any[]) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      return { name, fn };
    },
    offref(ref: { name: string; fn: (...args: any[]) => void }) {
      listeners.get(ref.name)?.delete(ref.fn);
    },
    fire(name: string, ...args: any[]) {
      for (const fn of listeners.get(name) ?? []) fn(...args);
    },
  };
}

function fixture() {
  const files = new Map<string, any>();
  const folders = new Map<string, any>();
  const frontmatter = new Map<string, Record<string, unknown>>();
  const bytes = new Map<string, string>();
  const vaultEvents = events(),
    metadataEvents = events(),
    workspaceEvents = events();
  const leaves: { view: unknown }[] = [];
  const api = {
    version: '1.0',
    listFileClasses: vi.fn(async () => [{ name: 'topic', icon: 'hash' }]),
    getSchema: vi.fn<PublicApi['getSchema']>(async () => ({
      name: 'topic',
      ancestors: [],
      options: {},
      fields: [],
    })),
    getFields: vi.fn<PublicApi['getFields']>(async () => []),
    getValue: vi.fn<PublicApi['getValue']>(async () => undefined),
    allowedValues: vi.fn(async () => []),
    fileCandidates: vi.fn<PublicApi['fileCandidates']>(async () => []),
    explain: vi.fn(async (path: string) =>
      frontmatter.get(path)?.fileClass === 'topic'
        ? { fileClasses: ['topic'] }
        : { fileClasses: [] },
    ),
    setValue: vi.fn<PublicApi['setValue']>(async () => ({ ok: true })),
  };
  const plugin = { api, settings: { fileClassAlias: 'fileClass' } };
  const getPlugin = vi.fn((id: string) => (id === 'fileclass' ? plugin : undefined));
  const app = {
    vault: {
      ...vaultEvents,
      getMarkdownFiles: () => [...files.values()],
      read: vi.fn(async (file: { path: string }) => bytes.get(file.path) ?? ''),
      getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path) ?? null,
      createFolder: vi.fn(async (path: string) => {
        folders.set(path, new ((await import('obsidian')).TFolder as any)(path));
      }),
      create: vi.fn(async (path: string, raw: string) => {
        if (files.has(path)) throw new Error('Duplicate file');
        const file = new ((await import('obsidian')).TFile as any)(path);
        files.set(path, file);
        bytes.set(path, raw);
        frontmatter.set(path, { fileClass: raw.match(/^fileClass: (.*)$/m)?.[1] });
        vaultEvents.fire('create', file);
        metadataEvents.fire('changed', file);
        return file;
      }),
    },
    metadataCache: {
      ...metadataEvents,
      getFirstLinkpathDest: (link: string) => files.get(link + '.md') ?? null,
      getFileCache: (file: { path: string }) => ({ frontmatter: frontmatter.get(file.path) ?? {} }),
    },
    workspace: {
      ...workspaceEvents,
      iterateAllLeaves: (visit: (leaf: unknown) => void) => leaves.forEach(visit),
    },
    plugins: { getPlugin },
  } as unknown as App;
  return { app, files, frontmatter, bytes, leaves, api, plugin, getPlugin };
}

const active: ReaderNodes[] = [];
afterEach(() => {
  for (const service of active.splice(0)) service.dispose();
});
async function reader(app: App) {
  const service = new ReaderNodes(app);
  active.push(service);
  const unbind = bindNodesApi(app, () => service.api());
  service.start();
  await service.refresh();
  return { service, unbind };
}

describe('Reader-owned Fileclass bridge', () => {
  it('indexes public Fileclass members without contacting Fileclass Inline or changing notes', async () => {
    const f = fixture();
    const typed = await f.app.vault.create('Ideas/Existing.md', '---\nfileClass: topic\n---\n');
    f.frontmatter.get(typed.path)!.aliases = ['Alias'];
    const { service } = await reader(f.app);
    const provider = nodesApi(f.app)!;
    expect(provider.listTypes()).toEqual([{ type: 'topic', label: 'topic', icon: 'hash' }]);
    expect(provider.searchNodes('alias')).toEqual([
      {
        path: typed.path,
        title: 'Existing',
        type: 'topic',
        classes: ['topic'],
        aliases: ['Alias'],
        icon: 'hash',
      },
    ]);
    expect(f.getPlugin).toHaveBeenCalledWith('fileclass');
    expect(f.getPlugin).not.toHaveBeenCalledWith('fileclass-inline');
    expect(f.app.vault.create).toHaveBeenCalledTimes(1);
    service.dispose();
    expect(nodesApi(f.app)).toBeUndefined();
  });

  it('creates a bound note and commits the source before required completion, retaining a failed link target', async () => {
    const f = fixture();
    await f.app.vault.create('Reading/A.md', 'article');
    const { service } = await reader(f.app);
    const provider = nodesApi(f.app)!;
    const linked: string[] = [];
    const node = await provider.createNodeForLink!(
      {
        type: 'topic',
        suggestedTitle: 'New idea',
        sourcePath: 'Reading/A.md',
        acceptSuggestedTitle: true,
      },
      async (created) => {
        linked.push(created.path);
      },
    );
    expect(node?.path).toBe('Nodes/New idea.md');
    expect(linked).toEqual([node?.path]);
    expect(f.frontmatter.get(node!.path)).toMatchObject({ fileClass: 'topic' });
    expect(f.api.getFields).toHaveBeenCalledWith(node!.path);
    const failure = new Error('Source changed');
    await expect(
      provider.createNodeForLink!(
        {
          type: 'topic',
          suggestedTitle: 'Keep me',
          sourcePath: 'Reading/A.md',
          acceptSuggestedTitle: true,
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(f.app.vault.getAbstractFileByPath('Nodes/Keep me.md')).not.toBeNull();
    expect(service.api()).toBe(provider);
  });

  it('uses Fileclass’s live binding alias and rejects unsafe aliases before creation', async () => {
    const f = fixture();
    await f.app.vault.create('Reading/A.md', 'article');
    const { service } = await reader(f.app);
    f.plugin.settings.fileClassAlias = '__proto__';
    expect(
      await nodesApi(f.app)!.createNodeForLink!(
        {
          type: 'topic',
          suggestedTitle: 'Unsafe',
          sourcePath: 'Reading/A.md',
          acceptSuggestedTitle: true,
        },
        async () => {},
      ),
    ).toBeNull();
    expect(f.app.vault.getAbstractFileByPath('Nodes/Unsafe.md')).toBeNull();
    expect(service.api()).toBeDefined();
  });

  it('asks Fileclass only for unresolved required values and does not repeat a successful write', async () => {
    const f = fixture();
    await f.app.vault.create('Nodes/Required.md', '---\nfileClass: topic\n---\n');
    const fieldValues = new Map<string, unknown>([
      ['Complete', false],
      ['Count', 0],
    ]);
    const fields = [
      { name: 'Complete', id: 'one', type: 'Boolean', options: { required: true }, path: '' },
      { name: 'Count', id: 'two', type: 'Number', options: { required: true }, path: '' },
      { name: 'Missing', id: 'three', type: 'Input', options: { required: true }, path: '' },
      { name: 'Optional', id: 'four', type: 'Input', options: {}, path: '' },
    ];
    f.api.getSchema.mockResolvedValue({ name: 'topic', ancestors: [], options: {}, fields });
    f.api.getFields.mockResolvedValue(
      fields.map(({ name, type, path }) => ({ name, type, owner: 'topic', path, isRoot: true })),
    );
    f.api.getValue.mockImplementation(async (_path: string, name: string) => fieldValues.get(name));
    f.api.setValue.mockImplementation(async (_path: string, name: string, value: unknown) => {
      fieldValues.set(name, value);
      return { ok: true };
    });
    const bridge = new FileclassBridge(f.app);
    const missing = await bridge.requiredFields('Nodes/Required.md');
    expect(missing.map((field) => field.name)).toEqual(['Missing']);
    await bridge.setValue('Nodes/Required.md', missing[0], 'Saved');
    await bridge.setValue('Nodes/Required.md', missing[0], 'Saved');
    expect(f.api.setValue).toHaveBeenCalledOnce();
    expect(await bridge.requiredFields('Nodes/Required.md')).toEqual([]);
  });

  it('matches Fileclass candidates and saves only the chosen destination field', async () => {
    const f = fixture();
    const source = await f.app.vault.create('People/Ada.md', '---\nfileClass: topic\n---\n');
    const destination = await f.app.vault.create('Books/Book.md', '---\nfileClass: topic\n---\n');
    const definitions = ['author', 'editor'].map((name) => ({
      name,
      id: `${name}-id`,
      type: 'File',
      options: {},
      path: '',
    }));
    f.api.getSchema.mockResolvedValue({
      name: 'topic',
      ancestors: [],
      options: {},
      fields: definitions,
    });
    f.api.getFields.mockResolvedValue(
      definitions.map(({ name, type, path }) => ({
        name,
        type,
        owner: 'topic',
        path,
        isRoot: true,
      })),
    );
    f.api.fileCandidates.mockResolvedValue([{ display: 'Ada', link: '[[People/Ada]]' }]);
    const values = new Map<string, unknown>();
    f.api.getValue.mockImplementation(async (_path, name) => values.get(name));
    f.api.setValue.mockImplementation(async (_path, name, value) => {
      values.set(name, value);
      return { ok: true };
    });
    const { service } = await reader(f.app);
    const provider = service.api()!.relations!;
    const request = { sourcePath: source.path, destinationPath: destination.path };
    const outcome = await connectNodes(provider, request, {
      chooseField: async () => 'editor',
      confirmReplace: async () => true,
    });
    expect(outcome).toEqual({ kind: 'saved', changed: true, message: 'Book · editor → Ada' });
    expect(f.api.setValue).toHaveBeenCalledExactlyOnceWith(
      destination.path,
      'editor',
      '[[People/Ada]]',
    );
    expect(values.get('author')).toBeUndefined();
    expect(
      (await provider.eligibleFields(request)).find((field) => field.id === 'editor')
        ?.containsSource,
    ).toBe(true);
  });

  it('rejects changed bytes, stale values and candidates before calling Fileclass setValue', async () => {
    const f = fixture();
    const source = await f.app.vault.create('People/Ada.md', '---\nfileClass: topic\n---\n');
    const destination = await f.app.vault.create('Books/Book.md', '---\nfileClass: topic\n---\n');
    const definition = { name: 'author', id: 'id', type: 'File', options: {}, path: '' };
    f.api.getSchema.mockResolvedValue({
      name: 'topic',
      ancestors: [],
      options: {},
      fields: [definition],
    });
    f.api.getFields.mockResolvedValue([
      { name: 'author', type: 'File', owner: 'topic', path: '', isRoot: true },
    ]);
    f.api.fileCandidates.mockResolvedValue([{ display: 'Ada', link: '[[People/Ada]]' }]);
    let current: unknown;
    f.api.getValue.mockImplementation(async () => current);
    const { service } = await reader(f.app);
    const provider = service.api()!.relations!;
    const request = { sourcePath: source.path, destinationPath: destination.path };
    let [field] = await provider.eligibleFields(request);
    f.bytes.set(destination.path, 'changed');
    await expect(
      provider.assign({
        ...request,
        fieldId: field.id,
        revision: field.revision,
        replaceOccupied: false,
      }),
    ).rejects.toThrow('changed');
    f.bytes.set(destination.path, '---\nfileClass: topic\n---\n');
    [field] = await provider.eligibleFields(request);
    current = '[[People/Grace]]';
    await expect(
      provider.assign({
        ...request,
        fieldId: field.id,
        revision: field.revision,
        replaceOccupied: false,
      }),
    ).rejects.toThrow('changed');
    current = undefined;
    [field] = await provider.eligibleFields(request);
    f.api.fileCandidates.mockResolvedValue([]);
    await expect(
      provider.assign({
        ...request,
        fieldId: field.id,
        revision: field.revision,
        replaceOccupied: false,
      }),
    ).rejects.toThrow('changed');
    expect(f.api.setValue).not.toHaveBeenCalled();
  });

  it('refuses to change a typed note open in a Markdown editor', async () => {
    const f = fixture();
    const source = await f.app.vault.create('People/Ada.md', '---\nfileClass: topic\n---\n');
    const destination = await f.app.vault.create('Books/Book.md', '---\nfileClass: topic\n---\n');
    const definition = { name: 'author', id: 'id', type: 'File', options: {}, path: '' };
    f.api.getSchema.mockResolvedValue({
      name: 'topic',
      ancestors: [],
      options: {},
      fields: [definition],
    });
    f.api.getFields.mockResolvedValue([
      { name: 'author', type: 'File', owner: 'topic', path: '', isRoot: true },
    ]);
    f.api.fileCandidates.mockResolvedValue([{ display: 'Ada', link: '[[People/Ada]]' }]);
    const { service } = await reader(f.app);
    const provider = service.api()!.relations!;
    const request = { sourcePath: source.path, destinationPath: destination.path };
    const [field] = await provider.eligibleFields(request);
    const { MarkdownView } = await import('obsidian');
    f.leaves.push({ view: new MarkdownView({} as any) });
    (f.leaves[0].view as any).file = destination;
    await expect(
      provider.assign({
        ...request,
        fieldId: field.id,
        revision: field.revision,
        replaceOccupied: false,
      }),
    ).rejects.toThrow('Markdown editor');
    expect(f.api.setValue).not.toHaveBeenCalled();
  });

  it('appends a unique MultiFile link and refuses a stale provider after reload', async () => {
    const f = fixture();
    const source = await f.app.vault.create('People/Ada.md', '---\nfileClass: topic\n---\n');
    const destination = await f.app.vault.create('Books/Book.md', '---\nfileClass: topic\n---\n');
    const definition = { name: 'authors', id: 'id', type: 'MultiFile', options: {}, path: '' };
    f.api.getSchema.mockResolvedValue({
      name: 'topic',
      ancestors: [],
      options: {},
      fields: [definition],
    });
    f.api.getFields.mockResolvedValue([
      { name: 'authors', type: 'MultiFile', owner: 'topic', path: '', isRoot: true },
    ]);
    f.api.fileCandidates.mockResolvedValue([{ display: 'Ada', link: '[[People/Ada]]' }]);
    let current: unknown = ['[[People/Grace]]'];
    f.api.getValue.mockImplementation(async () => current);
    f.api.setValue.mockImplementation(async (_path, _name, value) => {
      current = value;
      return { ok: true };
    });
    const { service } = await reader(f.app);
    const old = service.api()!.relations!;
    const request = { sourcePath: source.path, destinationPath: destination.path };
    const [field] = await old.eligibleFields(request);
    expect(field).toMatchObject({ occupied: true, containsSource: false, cardinality: 'many' });
    expect(
      await old.assign({
        ...request,
        fieldId: field.id,
        revision: field.revision,
        replaceOccupied: false,
      }),
    ).toMatchObject({ changed: true });
    expect(current).toEqual(['[[People/Grace]]', '[[People/Ada]]']);
    const [duplicate] = await old.eligibleFields(request);
    expect(duplicate.containsSource).toBe(true);
    expect(
      await old.assign({
        ...request,
        fieldId: duplicate.id,
        revision: duplicate.revision,
        replaceOccupied: false,
      }),
    ).toMatchObject({ changed: false });
    expect(f.api.setValue).toHaveBeenCalledOnce();
    f.plugin.api = { ...f.api };
    await service.refresh();
    expect(() => old.eligibleFields(request)).toThrow('connection changed');
  });

  it('invalidates a provider on Fileclass reload; old API cannot create', async () => {
    const f = fixture();
    const { service } = await reader(f.app);
    const old = nodesApi(f.app)!;
    f.plugin.api = { ...f.api };
    expect(nodesApi(f.app)).toBeUndefined();
    await service.refresh();
    expect(nodesApi(f.app)).toBeDefined();
    expect(nodesApi(f.app)).not.toBe(old);
    expect(await old.createNode({ type: 'topic', suggestedTitle: 'Nope' })).toBeNull();
    expect(f.app.vault.getAbstractFileByPath('Nodes/Nope.md')).toBeNull();
  });
});
