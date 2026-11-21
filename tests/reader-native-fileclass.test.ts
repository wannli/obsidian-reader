import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { ReaderNodes } from '../src/host/fileclass/reader-nodes';
import { FileclassBridge } from '../src/host/fileclass/fileclass';
import { connectNodes } from '../src/host/node-relations';
import type { PublicApi } from '../src/host/fileclass/fileclass-fields';
import { bindNodesApi, nodesApi } from '../src/host/nodes';
import { ReaderClippings } from '../src/host/clippings';
import { ArticleStore, type VaultPort } from '../src/core/store';
import { createDocument, readDocument } from '../src/core/document';
import { clippingMarkdown } from '../src/core/clippings';
import type { TFile } from 'obsidian';

vi.mock('obsidian', () => {
  class TFile {
    extension = 'md';
    stat = { ctime: 1, mtime: 1, size: 0 };
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
        file.stat.size = raw.length;
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
  return {
    app,
    files,
    frontmatter,
    bytes,
    leaves,
    api,
    plugin,
    getPlugin,
    vaultEvents,
    metadataEvents,
  };
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

async function clippingAdapterFixture(before?: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  const file = await f.app.vault.create(
    'Articles/Source.md',
    createDocument({ type: 'article', status: 'inbox' }, 'Saved words. ^source'),
  );
  await before?.(f);
  const vault: VaultPort<TFile> = {
    file: (path) => f.files.get(path),
    resolveLink: (path) => f.files.get(path) ?? f.files.get(path + '.md'),
    read: (file) => f.app.vault.read(file),
    create: async (path, raw, guard) => {
      await guard?.();
      return f.app.vault.create(path, raw);
    },
    process: async (file, update) => {
      const raw = update(await f.app.vault.read(file));
      f.bytes.set(file.path, raw);
      f.frontmatter.set(file.path, readDocument(raw).properties);
      f.vaultEvents.fire('modify', file);
      f.metadataEvents.fire('changed', file);
      return raw;
    },
    move: async () => {
      throw new Error('Unexpected move');
    },
    trash: async () => {
      throw new Error('Unexpected trash');
    },
    assertWritable() {},
  };
  const store = new ArticleStore(vault);
  store.catalog.update(file.path, readDocument(await vault.read(file)).properties);
  const nodes = new ReaderNodes(f.app);
  active.push(nodes);
  nodes.configure(
    await nodes.prepareClippingSettings({
      nodesFolder: 'Nodes',
      classProperty: 'fileClass',
      clippingType: 'topic',
    }),
  );
  const lifetime = new AbortController(),
    clippings = new ReaderClippings(f.app, store, nodes, lifetime.signal);
  let source = await store.read(file.path);
  return {
    ...f,
    store,
    nodes,
    lifetime,
    clippings,
    get source() {
      return source;
    },
    keep: () =>
      clippings.keep(
        source,
        { quote: 'Saved words.' },
        lifetime.signal,
        () => {},
        (saved) => {
          source = saved;
        },
      ),
  };
}

describe('clipping Fileclass compatibility', () => {
  it('keeps passages despite an ordinary note with an unresolved origin, but preserves deletion protection', async () => {
    const f = await clippingAdapterFixture(async (f) => {
      const raw = createDocument({ origin: '[[Missing source]]' }, 'Unrelated personal writing.');
      await f.app.vault.create('Ordinary/Unrelated.md', raw);
      f.frontmatter.set('Ordinary/Unrelated.md', readDocument(raw).properties);
    });
    try {
      const before = f.bytes.get('Ordinary/Unrelated.md');
      expect((await f.clippings.scan(f.source, f.lifetime.signal)).complete).toBe(false);
      await expect(f.keep()).resolves.toMatchObject({ created: true });
      await expect(f.keep()).resolves.toMatchObject({ created: false });
      expect(f.bytes.get('Ordinary/Unrelated.md')).toBe(before);
      expect(await f.store.trash(f.source)).toBe('archived-protected');
    } finally {
      f.lifetime.abort();
    }
  });

  it('still blocks capture for a clipping with an unresolved source', async () => {
    const f = await clippingAdapterFixture(async (f) => {
      const raw = clippingMarkdown(
        { property: 'fileClass', type: 'topic' },
        '[[Missing source#^source]]',
        'Saved words.',
      );
      await f.app.vault.create('Cards/Unresolved.md', raw);
      f.frontmatter.set('Cards/Unresolved.md', readDocument(raw).properties);
    });
    try {
      const before = f.bytes.get(f.source.path);
      await expect(f.keep()).rejects.toThrow(/Could not resolve origin in.*Cards\/Unresolved/);
      expect(f.bytes.get(f.source.path)).toBe(before);
      expect(f.files.has('Nodes/Saved words.md')).toBe(false);
    } finally {
      f.lifetime.abort();
    }
  });
  it('creates and verifies a card through the real host adapter and public Fileclass bridge', async () => {
    const f = await clippingAdapterFixture();
    try {
      const kept = await f.keep();
      expect(kept.path).toBe('Nodes/Saved words.md');
      expect(readDocument(f.bytes.get(kept.path)!).properties).toEqual({
        fileClass: 'topic',
        origin: '[[Articles/Source#^source]]',
      });
      expect((await f.clippings.scan(f.source, f.lifetime.signal)).items).toHaveLength(1);
      expect((await f.keep()).created).toBe(false);
    } finally {
      f.lifetime.abort();
    }
  });

  it('creates a clipping after adding a paragraph reference to a large source article', async () => {
    const f = await clippingAdapterFixture(async (f) => {
      const file = f.files.get('Articles/Source.md');
      const raw = createDocument(
        { type: 'article', status: 'inbox' },
        'Saved words.\n\n' + 'Background text. '.repeat(13_000),
      );
      f.bytes.set(file.path, raw);
      file.stat.size = raw.length;
      f.frontmatter.set(file.path, readDocument(raw).properties);
    });
    try {
      const saved = await f.keep();
      expect(saved.created).toBe(true);
      expect(f.source.body).toMatch(/Saved words\. \^reader-/u);
      expect(f.files.has(saved.path)).toBe(true);
      expect((await f.keep()).created).toBe(false);
    } finally {
      f.lifetime.abort();
    }
  });

  it('creates a clipping when delayed source metadata arrives during the post-write lookup', async () => {
    const f = await clippingAdapterFixture(async (f) => {
      const file = f.files.get('Articles/Source.md');
      const raw = createDocument({ type: 'article', status: 'inbox' }, 'Saved words.');
      f.bytes.set(file.path, raw);
      file.stat.size = raw.length;
      f.frontmatter.set(file.path, readDocument(raw).properties);
      const reference = createDocument(
        { fileClass: 'Other', origin: '[[Articles/Source]]' },
        'An existing reference, not a clipping.',
      );
      await f.app.vault.create('Cards/Reference.md', reference);
      f.frontmatter.set('Cards/Reference.md', readDocument(reference).properties);
    });
    const scan = f.clippings.scan.bind(f.clippings);
    let scans = 0;
    vi.spyOn(f.clippings, 'scan').mockImplementation(async (...args) => {
      if (++scans === 2) {
        const read = f.app.vault.read.bind(f.app.vault);
        vi.mocked(f.app.vault.read).mockImplementationOnce(async (file) => {
          f.metadataEvents.fire('changed', f.source.file);
          return read(file);
        });
      }
      return scan(...args);
    });
    try {
      const saved = await f.keep();
      expect(saved.created).toBe(true);
      expect(f.source.body).toMatch(/Saved words\. \^reader-/u);
      expect(f.files.has(saved.path)).toBe(true);
    } finally {
      f.lifetime.abort();
    }
  });

  it('reports the last native event when repeated changes prevent a stable capture check', async () => {
    const f = await clippingAdapterFixture();
    const validate = f.store.validate.bind(f.store);
    vi.spyOn(f.store, 'validate').mockImplementation(async (source) => {
      await validate(source);
      f.metadataEvents.fire('changed', source.file);
    });
    try {
      await expect(f.keep()).rejects.toThrow(
        /changed during all 3 lookup attempts.*Last change: metadata in "Articles\/Source\.md"/,
      );
      expect(f.files.has('Nodes/Saved words.md')).toBe(false);
    } finally {
      f.lifetime.abort();
    }
  });

  it('scopes bounded discovery to the source, rather than reading every clipping in the vault', async () => {
    const f = await clippingAdapterFixture(async (f) => {
      for (let i = 0; i < 210; i++) {
        const raw = clippingMarkdown(
          { property: 'fileClass', type: 'topic' },
          `[[Articles/Other ${i}#^a]]`,
          'Other words.',
        );
        await f.app.vault.create(`Cards/${i}.md`, raw);
        f.frontmatter.set(`Cards/${i}.md`, readDocument(raw).properties);
      }
    });
    try {
      vi.mocked(f.app.vault.read).mockClear();
      expect((await f.clippings.scan(f.source, f.lifetime.signal)).complete).toBe(true);
      expect(f.app.vault.read).not.toHaveBeenCalled();
      expect((await f.keep()).created).toBe(true);
    } finally {
      f.lifetime.abort();
    }
  });

  it.each(['many', 'large'] as const)(
    'keeps passages with %s fully indexed ordinary notes without frontmatter',
    async (size) => {
      const f = await clippingAdapterFixture(async (f) => {
        const count = size === 'many' ? 210 : 1;
        for (let i = 0; i < count; i++) {
          await f.app.vault.create(
            `Ordinary/${i}.md`,
            size === 'large' ? 'Personal writing.\n'.repeat(15_000) : 'Personal writing.',
          );
        }
      });
      // Native Obsidian supplies a cache object without frontmatter for these notes.
      const cache = f.app.metadataCache.getFileCache.bind(f.app.metadataCache);
      vi.spyOn(f.app.metadataCache, 'getFileCache').mockImplementation((file) =>
        file.path.startsWith('Ordinary/') ? { sections: [] } : cache(file),
      );
      try {
        vi.mocked(f.app.vault.read).mockClear();
        await expect(f.keep()).resolves.toMatchObject({ created: true });
        expect(
          vi
            .mocked(f.app.vault.read)
            .mock.calls.some(([file]) => file.path.startsWith('Ordinary/')),
        ).toBe(false);
        expect((await f.keep()).created).toBe(false);
      } finally {
        f.lifetime.abort();
      }
    },
  );

  it('still blocks capture when an oversized note genuinely has no metadata cache', async () => {
    const f = await clippingAdapterFixture(async (f) => {
      await f.app.vault.create('Unindexed.md', 'Unknown content.\n'.repeat(15_000));
    });
    const cache = f.app.metadataCache.getFileCache.bind(f.app.metadataCache);
    vi.spyOn(f.app.metadataCache, 'getFileCache').mockImplementation((file) =>
      file.path === 'Unindexed.md' ? null : cache(file),
    );
    try {
      const before = f.bytes.get(f.source.path);
      await expect(f.keep()).rejects.toThrow(/Clipping lookup is incomplete/);
      expect(f.bytes.get(f.source.path)).toBe(before);
      expect(f.files.has('Nodes/Saved words.md')).toBe(false);
    } finally {
      f.lifetime.abort();
    }
  });

  it.each(['unindexed', 'modified'] as const)(
    'discovers an existing clipping in a %s note rather than creating a duplicate',
    async (state) => {
      const f = await clippingAdapterFixture(async (f) => {
        await f.app.vault.create('Cards/Existing.md', 'Ordinary writing.');
      });
      const cache = f.app.metadataCache.getFileCache.bind(f.app.metadataCache);
      vi.spyOn(f.app.metadataCache, 'getFileCache').mockImplementation((file) =>
        file.path === 'Cards/Existing.md'
          ? state === 'unindexed'
            ? null
            : { sections: [] }
          : cache(file),
      );
      const card = f.files.get('Cards/Existing.md');
      const raw = clippingMarkdown(
        { property: 'fileClass', type: 'topic' },
        '[[Articles/Source#^source]]',
        'Saved words.',
      );
      f.bytes.set(card.path, raw);
      card.stat.size = raw.length;
      if (state === 'modified') f.vaultEvents.fire('modify', card);
      try {
        expect(await f.keep()).toMatchObject({ created: false, path: card.path });
        expect((await f.keep()).created).toBe(false);
        expect(f.files.has('Nodes/Saved words.md')).toBe(false);
      } finally {
        f.lifetime.abort();
      }
    },
  );

  it('does not trust a stale origin cache after native modification, and retains fresh discovery evidence', async () => {
    const f = await clippingAdapterFixture(async (f) => {
      const raw = clippingMarkdown(
        { property: 'fileClass', type: 'topic' },
        '[[Articles/Other#^a]]',
        'Saved words.',
      );
      await f.app.vault.create('Cards/Existing.md', raw);
      f.frontmatter.set('Cards/Existing.md', readDocument(raw).properties);
    });
    try {
      const card = f.files.get('Cards/Existing.md');
      f.bytes.set(
        card.path,
        clippingMarkdown(
          { property: 'fileClass', type: 'topic' },
          '[[Articles/Source#^source]]',
          'Saved words.',
        ),
      );
      f.vaultEvents.fire('modify', card);
      const scan = await f.clippings.scan(f.source, f.lifetime.signal);
      expect(scan.items.map((item) => item.path)).toEqual(['Cards/Existing.md']);
      expect((await f.clippings.scan(f.source, f.lifetime.signal)).items).toHaveLength(1);
      expect((await f.keep()).created).toBe(false);
    } finally {
      f.lifetime.abort();
    }
  });

  it('revokes negative reference coverage when a folder moves without child-file events', async () => {
    const f = await clippingAdapterFixture();
    try {
      const read = f.app.vault.read.bind(f.app.vault);
      vi.mocked(f.app.vault.read).mockImplementationOnce(async (file) => {
        f.vaultEvents.fire('rename', { path: 'Moved folder' }, 'Original folder');
        return read(file);
      });
      await expect(f.store.trash(f.source)).rejects.toThrow(/references changed/);
      expect(f.files.has(f.source.path)).toBe(true);
    } finally {
      f.lifetime.abort();
    }
  });

  it('requires deliberate setup and records the actual binding without creating or migrating notes', async () => {
    const f = fixture();
    const { service } = await reader(f.app);
    await expect(service.prepareClipping(new AbortController().signal)).rejects.toThrow(
      /default clipping/,
    );
    const next = await service.prepareClippingSettings({
      nodesFolder: 'Nodes',
      classProperty: 'fileClass',
      clippingType: 'topic',
    });
    expect(next.clippingBindings).toEqual([{ property: 'fileClass', type: 'topic' }]);
    service.configure(next);
    const prepared = await service.prepareClipping(new AbortController().signal);
    expect(prepared.binding).toEqual({ property: 'fileClass', type: 'topic' });
    expect(f.files.size).toBe(0);
  });

  it('rejects required topics before capture and never changes the schema or invents a value', async () => {
    const f = fixture();
    f.api.getSchema.mockResolvedValue({
      name: 'topic',
      ancestors: [],
      options: {},
      fields: [{ id: 'topic', name: 'Topic', type: 'File', path: '', options: { required: true } }],
    });
    const { service } = await reader(f.app);
    await expect(
      service.prepareClippingSettings({
        nodesFolder: 'Nodes',
        classProperty: 'fileClass',
        clippingType: 'topic',
      }),
    ).rejects.toThrow(/requires "Topic"/);
    expect(f.files.size).toBe(0);
    expect(f.api.setValue).not.toHaveBeenCalled();
  });

  it('checks inherited requirements, while allowing optional topics', async () => {
    const f = fixture();
    f.api.getSchema.mockImplementation(async (name) => ({
      name,
      ancestors: name === 'topic' ? ['Parent'] : [],
      options: {},
      fields:
        name === 'Parent'
          ? [{ id: 'x', name: 'Project', type: 'File', path: '', options: { required: true } }]
          : [],
    }));
    const bridge = new FileclassBridge(f.app);
    await expect(bridge.assertClippingType('topic', 'fileClass')).rejects.toThrow(/Project/);
    f.api.getSchema.mockResolvedValue({
      name: 'topic',
      ancestors: [],
      options: {},
      fields: [{ id: 'x', name: 'Topic', type: 'File', path: '', options: { required: false } }],
    });
    await expect(bridge.assertClippingType('topic', 'fileClass')).resolves.toBeUndefined();
  });

  it('keeps past binding aliases for discovery without rewriting existing notes', async () => {
    const f = fixture();
    const { service } = await reader(f.app);
    const first = await service.prepareClippingSettings({
      nodesFolder: 'Nodes',
      classProperty: 'fileClass',
      clippingType: 'topic',
    });
    service.configure(first);
    f.plugin.settings.fileClassAlias = 'kind';
    await expect(service.prepareClipping(new AbortController().signal)).rejects.toThrow(
      /binding changed/,
    );
    const second = await service.prepareClippingSettings(first);
    expect(second.clippingBindings).toEqual([
      { property: 'fileClass', type: 'topic' },
      { property: 'kind', type: 'topic' },
    ]);
    service.configure(second);
    expect((await service.prepareClipping(new AbortController().signal)).binding.property).toBe(
      'kind',
    );
    expect(f.files.size).toBe(0);
  });

  it('rechecks the live schema and API identity after setup', async () => {
    const f = fixture();
    const { service } = await reader(f.app);
    service.configure(
      await service.prepareClippingSettings({
        nodesFolder: 'Nodes',
        classProperty: 'fileClass',
        clippingType: 'topic',
      }),
    );
    const session = await service.prepareClipping(new AbortController().signal);
    f.api.getSchema.mockResolvedValue({
      name: 'topic',
      ancestors: [],
      options: {},
      fields: [{ id: 'x', name: 'Topic', type: 'File', path: '', options: { required: true } }],
    });
    await expect(session.validate()).rejects.toThrow(/requires/);
    f.plugin.api = { ...f.api };
    expect(session.check).toThrow(/changed/);
    expect(f.files.size).toBe(0);
  });
});
