import { App, stringifyYaml, TFile, TFolder } from 'obsidian';
import type { FileclassBackend } from './fileclass-contract';
import { validateSettings, type NodesSettings } from './settings';

export function titleError(title: string): string | null {
  if (!title.trim() || title !== title.trim() || title === '.' || title === '..')
    return 'Enter a filename without surrounding spaces';
  if (/[\\/:*?"<>|\x00-\x1f]/.test(title) || /[. ]$/.test(title))
    return 'Name contains invalid filename characters';
  return null;
}
export function assertSession(
  backend: FileclassBackend,
  token: object,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw new Error('Creation cancelled');
  if (backend.token() !== token) throw new Error('Fileclass changed or was reloaded; start again');
}
export function renderTypedNote(
  className: string,
  title: string,
  binding: string,
  body?: string,
): string {
  const properties: Record<string, unknown> = Object.create(null);
  properties[binding] = className;
  return `---\n${stringifyYaml(properties).trimEnd()}\n---\n# ${title}\n${body ? `\n${body}\n` : ''}`;
}

/** Convention-only creation: no Fileclass private code, templates, optional values or pruning. */
export async function createTypedNote(
  app: App,
  backend: FileclassBackend,
  settings: NodesSettings,
  className: string,
  title: string,
  body?: string,
  signal?: AbortSignal,
): Promise<TFile> {
  const token = backend.token();
  const guard = (): void => assertSession(backend, token, signal);
  guard();
  const invalid = validateSettings(settings) ?? titleError(title);
  if (invalid) throw new Error(invalid);
  const classes = await backend.types();
  guard();
  if (!classes.some((item) => item.name === className))
    throw new Error('That Fileclass is no longer available');
  const path = `${settings.nodesFolder}/${title}.md`;
  if (app.vault.getAbstractFileByPath(path))
    throw new Error(`A file already exists at ${path}; choose it or use another name`);
  const parts = settings.nodesFolder.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join('/');
    guard();
    const existing = app.vault.getAbstractFileByPath(folder);
    if (existing && !(existing instanceof TFolder))
      throw new Error(`${folder} is a file, not a folder`);
    if (!existing) {
      try {
        await app.vault.createFolder(folder);
      } catch (error) {
        if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw error;
      }
      guard();
    }
  }
  // A schema can disappear while creating folders. Recheck immediately before the write.
  const current = await backend.types();
  guard();
  if (!current.some((item) => item.name === className))
    throw new Error('That Fileclass is no longer available');
  if (app.vault.getAbstractFileByPath(path)) throw new Error(`A file already exists at ${path}`);
  // Resolve the live alias after all async work so a settings change is respected.
  const binding = backend.bindingProperty?.(settings.classProperty) ?? settings.classProperty;
  guard();
  // Vault.create refuses racing duplicates. Never modify an existing file.
  return app.vault.create(path, renderTypedNote(className, title, binding, body));
}

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Creation cancelled');
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const cancel = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new Error('Creation cancelled'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Fileclass resolves the real note, not the source editor or a fake draft file. */
export async function waitForBinding(
  app: App,
  backend: FileclassBackend,
  file: TFile,
  className: string,
  token: object,
  signal?: AbortSignal,
  timeoutMs = 2500,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const originalPath = file.path;
  do {
    assertSession(backend, token, signal);
    if (file.path !== originalPath || app.vault.getAbstractFileByPath(originalPath) !== file)
      throw new Error('Created note moved, disappeared or was replaced; no link was inserted');
    const classes = await backend.classesFor(originalPath);
    assertSession(backend, token, signal);
    if (file.path !== originalPath || app.vault.getAbstractFileByPath(originalPath) !== file)
      throw new Error('Created note changed while Fileclass was resolving it');
    if (classes.includes(className)) return classes;
    if (Date.now() >= deadline) break;
    await pause(50, signal);
  } while (true);
  throw new Error(
    'Fileclass has not recognized the created note. Check Fileclass’s alias and indexing status; the note has been kept',
  );
}
