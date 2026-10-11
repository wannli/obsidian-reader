import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { articleSubpath } from '../src/routing/subpath';
// Mocked SDK only: no Obsidian process, vault, file creation or device evidence.
function fixture(targetPath = 'Folder/Target.md') {
  const file = { path: targetPath }, files = new Map([[targetPath, file]]);
  const openFile = vi.fn(async () => {}), getLeaf = vi.fn(() => ({ openFile }));
  const getFirstLinkpathDest = vi.fn((_path: string, _source: string) => file as typeof file | null);
  const create = vi.fn(), openLinkText = vi.fn();
  const app = { vault: { getFileByPath: vi.fn((path: string) => files.get(path) ?? null), create }, metadataCache: { getFirstLinkpathDest }, workspace: { getLeaf, openLinkText } };
  const sdk = { Plugin: class {}, FileView: class {}, parseLinktext: (target: string) => {
    const hash = target.indexOf('#'); return hash < 0 ? { path: target, subpath: '' } : { path: target.slice(0, hash), subpath: target.slice(hash) };
  } };
  const js = ts.transpileModule(readFileSync('src/main.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {}; new Function('require', 'exports', js)((name: string) => name === 'obsidian' ? sdk : {}, exports);
  const open = (target: string, source?: string) => exports.openExistingNote(app, target, source) as Promise<void>;
  const noCreation = () => { expect(create).not.toHaveBeenCalled(); expect(openLinkText).not.toHaveBeenCalled(); };
  return { app, file, files, openFile, getLeaf, getFirstLinkpathDest, open, noCreation };
}
it.each(['Target', './Target', '../Target', 'Folder/Target.md'])('opens a resolved TFile for %s using source-aware metadata resolution', async target => {
  const f = fixture(); await f.open(target, 'Folder/Source.md');
  expect(f.getFirstLinkpathDest).toHaveBeenCalledWith(target, 'Folder/Source.md');
  expect(f.getLeaf).toHaveBeenCalledWith(true); expect(f.openFile).toHaveBeenCalledWith(f.file, { active: true }); f.noCreation();
});
it.each(['#Heading with spaces', '#^legacy-block'])('forwards %s unchanged through SDK ephemeral state and routing extraction', async subpath => {
  const f = fixture(); await f.open('../Target' + subpath, 'Folder/Source.md');
  expect(f.getFirstLinkpathDest).toHaveBeenCalledWith('../Target', 'Folder/Source.md');
  expect(f.openFile).toHaveBeenCalledWith(f.file, { active: true, eState: { subpath } });
  expect(articleSubpath({ subpath }, null)).toBe(subpath); f.noCreation();
});
it.each(['#Heading', '#^block'])('resolves current-note %s via the source file object', async subpath => {
  const f = fixture('Folder/Source.md'); await f.open(subpath, 'Folder/Source.md');
  expect(f.getFirstLinkpathDest).not.toHaveBeenCalled(); expect(f.openFile).toHaveBeenCalledWith(f.file, { active: true, eState: { subpath } }); f.noCreation();
});
it('refuses unresolved names before allocating a leaf and never delegates to openLinkText', async () => {
  const f = fixture(); f.getFirstLinkpathDest.mockReturnValue(null);
  await expect(f.open('Missing#Heading', 'Folder/Source.md')).rejects.toThrow('Linked note does not exist');
  expect(f.getLeaf).not.toHaveBeenCalled(); expect(f.openFile).not.toHaveBeenCalled(); f.noCreation();
});
it.each([undefined, 'Missing.md'])('refuses current-note subpaths without an existing source: %s', async source => {
  const f = fixture(); await expect(f.open('#^block', source)).rejects.toThrow('Linked note does not exist');
  expect(f.getLeaf).not.toHaveBeenCalled(); f.noCreation();
});
it.each(['deleted', 'replacement'])('rejects a stale metadata result whose file was %s', async kind => {
  const f = fixture(); f.files.delete(f.file.path); if (kind === 'replacement') f.files.set(f.file.path, { path: f.file.path });
  await expect(f.open('Target')).rejects.toThrow('changed or was deleted'); expect(f.getLeaf).not.toHaveBeenCalled(); f.noCreation();
});
it('rechecks identity after leaf allocation before dispatching openFile', async () => {
  const f = fixture(); f.getLeaf.mockImplementation(() => { f.files.delete(f.file.path); return { openFile: f.openFile }; });
  await expect(f.open('Target')).rejects.toThrow('changed or was deleted'); expect(f.openFile).not.toHaveBeenCalled(); f.noCreation();
});
it.each(['deleted', 'renamed', 'replacement'])('reports a target %s during openFile without falling back to creation', async kind => {
  const f = fixture(); f.openFile.mockImplementation(async () => {
    f.files.delete(f.file.path);
    if (kind === 'renamed') f.file.path = 'Moved.md';
    if (kind === 'replacement') f.files.set(f.file.path, { path: f.file.path });
  });
  await expect(f.open('Target#Heading')).rejects.toThrow('changed or was deleted'); expect(f.openFile).toHaveBeenCalledTimes(1); f.noCreation();
});
it('propagates native openFile failure for visible caller reporting without a creation fallback', async () => {
  const f = fixture(); f.openFile.mockRejectedValue(new Error('Native file unavailable'));
  await expect(f.open('Target')).rejects.toThrow('Native file unavailable'); f.noCreation();
});
