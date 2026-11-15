import { describe, expect, it, vi } from 'vitest';
import { pluginFixture, mocks } from './helpers/reader-view-fixture';
import { bindNodesApi, type NodesApi, type NodeResult } from '../src/host/nodes';
import { patchProperties, readDocument } from '../src/core/document';
import { gate } from './helpers/memory-vault';

async function setupFixture() {
  const f = await pluginFixture();
  const notebook = await f.note('Notes/Notebook.md', 'My authored preface.', 'notebook');
  const raw = await f.vault.process(notebook, (raw) =>
    patchProperties(raw, { category: 'Notebook' }),
  );
  f.cache.get(notebook).frontmatter = readDocument(raw).properties;
  const node: NodeResult = {
    path: notebook.path,
    title: 'Notebook',
    type: 'Notebook',
    classes: ['Notebook'],
    aliases: [],
  };
  const api: NodesApi = {
    version: 2,
    listTypes: () => [
      { type: 'Notebook', label: 'Notebook' },
      { type: 'Exploration', label: 'Exploration' },
    ],
    getNode: (path) => (path === notebook.path ? node : null),
    searchNodes: () => [node],
    createNode: vi.fn(async () => null),
  };
  bindNodesApi(f.app, () => api);
  const publicApi = Object.fromEntries(
    [
      'listFileClasses',
      'getSchema',
      'getFields',
      'getValue',
      'allowedValues',
      'fileCandidates',
      'explain',
      'setValue',
    ].map((name) => [name, vi.fn()]),
  );
  const provider = {
    api: { version: '1.0.0', ...publicApi },
    settings: { fileClassAlias: 'category' },
  };
  (f.app as any).plugins = { getPlugin: (id: string) => (id === 'fileclass' ? provider : null) };
  let stored: any = { unrelated: { preserve: true } };
  f.pluginProbe.loadData = async () => stored;
  f.pluginProbe.saveData = async (next: unknown) => {
    stored = next;
  };
  return { ...f, api, notebook, node, stored: () => stored };
}

describe('Reader explicit one-time Fileclass setup', () => {
  it('chooses existing provider roles and persists a normal notebook link without touching unknown settings or type installation', async () => {
    const f = await setupFixture();
    mocks.commands.get('configure-saved-thinking')!.callback!();
    const notebook = document.querySelector<HTMLSelectElement>('[aria-label="Capture notebook"]')!;
    expect(notebook).not.toBeNull();
    notebook.value = f.notebook.path;
    document.querySelector<HTMLSelectElement>('[aria-label="Exploration type"]')!.value =
      'Exploration';
    const modal = notebook.closest('[aria-label="Configure saved thinking"]')!;
    [...modal.querySelectorAll('button')]
      .find((button) => button.textContent === 'Use this notebook')!
      .click();
    await vi.waitFor(() =>
      expect(f.stored().thinking).toEqual({
        notebook: '[[Notes/Notebook.md]]',
        notebookType: 'Notebook',
        explorationType: 'Exploration',
        bindingProperty: 'category',
      }),
    );
    expect(f.stored().unrelated).toEqual({ preserve: true });
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect(await f.vault.read(f.notebook)).toContain('My authored preface.');
    f.plugin.onunload();
  });
  it('allows navigation and cancellation while a provider ignores abort, preserving a late-created notebook', async () => {
    const f = await setupFixture();
    const held = gate();
    let late: NodeResult | null = null;
    f.api.createNode = async () => {
      await held.promise;
      return late;
    };
    mocks.commands.get('configure-saved-thinking')!.callback!();
    const modal = document.querySelector('[aria-label="Configure saved thinking"]')!;
    [...modal.querySelectorAll('button')]
      .find((button) => button.textContent === 'Create notebook through Fileclass')!
      .click();
    await f.view.readingList();
    [...modal.querySelectorAll('button')]
      .find((button) => button.textContent === 'Cancel')!
      .click();
    const created = await f.note('Notes/Late.md', 'Provider-created writing.', 'notebook');
    late = { ...f.node, path: created.path };
    held.resolve();
    await Promise.resolve();
    expect(f.vault.file(created.path)).toBe(created);
    expect(f.stored().thinking).toBeUndefined();
    expect(document.querySelector('[aria-label="Configure saved thinking"]')).toBeNull();
    f.plugin.onunload();
  });
});
