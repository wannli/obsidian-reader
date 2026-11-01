import { TFile, type App } from 'obsidian';
import {
  missingRequired,
  type ClassInfo,
  type ClassMember,
  type FieldChoice,
  type FileclassBackend,
  type RequiredField,
} from './fileclass-contract';
import {
  FILE_TYPES,
  SELECT_TYPES,
  freshRequired,
  unresolved,
  waitForMetadata,
  type PublicApi,
  type Session,
} from './fileclass-fields';

const METHODS = [
  'listFileClasses',
  'getSchema',
  'getFields',
  'getValue',
  'allowedValues',
  'fileCandidates',
  'explain',
  'setValue',
] as const;
type FileclassPlugin = { api?: unknown; settings?: { fileClassAlias?: unknown } };
type PluginHost = {
  plugins?: {
    getPlugin?: (id: string) => FileclassPlugin | null;
    plugins?: Record<string, FileclassPlugin>;
  };
};
type NoteTarget = { path: string; file: TFile };
type FieldBinding = { key: string; target: NoteTarget; api: PublicApi; written: boolean };

/** Public Fileclass v1 bridge. Every operation pins one raw API identity. */
export class FileclassBridge implements FileclassBackend {
  private readonly definitions = new WeakMap<RequiredField, FieldBinding>();

  constructor(private readonly app: App) {}

  token(): PublicApi {
    const host = (this.app as App & PluginHost).plugins;
    const plugin =
      typeof host?.getPlugin === 'function'
        ? host.getPlugin('fileclass')
        : host?.plugins?.fileclass;
    const api = plugin?.api;
    if (!api || typeof api !== 'object')
      throw new Error(
        'Fileclass is unavailable. Enable Fileclass with public API v1, then reopen the picker.',
      );
    const candidate = api as Partial<PublicApi>;
    if (
      typeof candidate.version !== 'string' ||
      !/^1\.\d+(?:\.\d+)?(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(candidate.version)
    ) {
      throw new Error(
        'Unsupported Fileclass API version. Reader requires Fileclass public API v1; update Fileclass, then reopen the picker.',
      );
    }
    if (METHODS.some((method) => typeof candidate[method] !== 'function')) {
      throw new Error(
        'Fileclass public API v1 is incomplete. Update Fileclass, then reopen the picker.',
      );
    }
    return api as PublicApi;
  }

  bindingProperty(fallback: string): string {
    const api = this.token();
    const host = (this.app as App & PluginHost).plugins;
    const plugin =
      typeof host?.getPlugin === 'function'
        ? host.getPlugin('fileclass')
        : host?.plugins?.fileclass;
    if (plugin?.api !== api) throw new Error('Fileclass changed or was reloaded; start again');
    // Compatibility boundary: public API v1 does not expose the global binding alias.
    // Read this one setting live; never mutate or retain Fileclass’s private settings.
    const alias = plugin.settings?.fileClassAlias;
    if (alias === undefined) return fallback;
    if (
      typeof alias !== 'string' ||
      !alias.trim() ||
      ['__proto__', 'prototype', 'constructor'].includes(alias)
    ) {
      throw new Error(
        'Fileclass’s fileClass alias is invalid. Check its settings before creating a note.',
      );
    }
    return alias;
  }

  private session(signal?: AbortSignal, target?: NoteTarget): Session {
    const api = this.token();
    const check = () => {
      if (signal?.aborted) throw new Error('Fileclass operation cancelled.');
      if (this.token() !== api)
        throw new Error('Fileclass disconnected or reloaded. Reopen the picker.');
      if (
        target &&
        (target.file.path !== target.path ||
          this.app.vault.getAbstractFileByPath(target.path) !== target.file)
      ) {
        throw new Error('The note was deleted, replaced, or renamed. Reopen the picker.');
      }
    };
    check();
    return {
      api,
      check,
      async read<T>(operation: () => Promise<T>): Promise<T> {
        check();
        try {
          return await operation();
        } finally {
          check();
        }
      },
    };
  }

  async types(): Promise<ClassInfo[]> {
    const session = this.session();
    const classes = await session.read(() => session.api.listFileClasses());
    session.check();
    return classes.map(({ name, icon }) => ({ name, ...(icon ? { icon } : {}) }));
  }

  async members(signal?: AbortSignal): Promise<ClassMember[]> {
    const session = this.session(signal);
    const files = [...new Set(this.app.vault.getMarkdownFiles())].map((file) => ({
      file,
      path: file.path,
    }));
    session.check();
    const members: (ClassMember & { file: TFile })[] = [];
    for (let i = 0; i < files.length; i++) {
      session.check();
      const { file, path } = files[i];
      const live = () => file.path === path && this.app.vault.getAbstractFileByPath(path) === file;
      if (live()) {
        try {
          const explanation = await session.read(() => session.api.explain(path));
          session.check();
          const classes = [...new Set(explanation?.fileClasses ?? [])];
          if (live() && classes.length) members.push({ path, classes, file });
        } catch (error) {
          session.check();
          if (live()) throw error; // A vanished file is not a failed bootstrap.
        }
      }
      if ((i + 1) % 40 === 0 && i + 1 < files.length) {
        // Yield the host thread; an unload can cancel even while Fileclass stays loaded.
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('Fileclass operation cancelled.'));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
          }, 0);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) {
            signal.removeEventListener('abort', abort);
            abort();
          }
        });
        session.check();
      }
    }
    return members
      .filter(
        ({ path, file }) =>
          file.path === path && this.app.vault.getAbstractFileByPath(path) === file,
      )
      .map(({ path, classes }) => ({ path, classes }));
  }

  async classesFor(path: string): Promise<string[]> {
    const session = this.session();
    const explanation = await session.read(() => session.api.explain(path));
    session.check();
    return [...new Set(explanation?.fileClasses ?? [])];
  }

  async requiredFields(path: string): Promise<RequiredField[]> {
    this.token();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('The note is unavailable. Reopen the picker.');
    const target = { path, file };
    const session = this.session(undefined, target);
    const prepared = await unresolved(session, path);
    session.check();
    return prepared.map(({ field, key }) => {
      this.definitions.set(field, { key, target, api: session.api, written: false });
      return field;
    });
  }

  private boundSession(
    path: string,
    field: RequiredField,
    signal?: AbortSignal,
  ): { session: Session; key: string; binding: FieldBinding } {
    const binding = this.definitions.get(field);
    if (!binding || binding.target.path !== path) {
      throw new Error('Use the original required field for this note. Reopen the picker.');
    }
    const session = this.session(signal, binding.target);
    if (session.api !== binding.api)
      throw new Error('Fileclass disconnected or reloaded. Reopen the picker.');
    return { session, key: binding.key, binding };
  }

  private async fieldChoices(
    session: Session,
    path: string,
    field: RequiredField,
  ): Promise<FieldChoice[]> {
    if (SELECT_TYPES.has(field.type)) {
      const values = await session.read(() => session.api.allowedValues(path, field.name));
      session.check();
      return values.map((value) => ({ value, label: value }));
    }
    if (FILE_TYPES.has(field.type)) {
      const candidates = await session.read(() => session.api.fileCandidates(path, field.name));
      session.check();
      return candidates.map(({ display, link }) => ({ value: link, label: display }));
    }
    return [];
  }

  async choices(path: string, field: RequiredField): Promise<FieldChoice[]> {
    const { session, key } = this.boundSession(path, field);
    await freshRequired(session, path, field, key);
    session.check();
    const choices = await this.fieldChoices(session, path, field);
    session.check();
    return choices;
  }

  async setValue(
    path: string,
    field: RequiredField,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const { session, key, binding } = this.boundSession(path, field, signal);
    if (!binding.written) {
      const current = await freshRequired(session, path, field, key);
      session.check();
      if (missingRequired(value)) throw new Error(`"${field.name}" is required; enter a value.`);
      const choices = await this.fieldChoices(session, path, current.field);
      session.check();
      if (FILE_TYPES.has(current.field.type) || choices.length) {
        const selected = Array.isArray(value) ? value : [value];
        if (selected.some((item) => !choices.some((choice) => choice.value === item))) {
          throw new Error(`Choose a current allowed value for "${field.name}".`);
        }
      }
      // Candidate queries can wait: recheck the effective definition and required presence.
      await freshRequired(session, path, field, current.key);
      session.check();
      const result = await session.read(async () => {
        const result = await session.api.setValue(path, field.name, value);
        // Remember success even if the following connection/cancellation check throws.
        if (result.ok) binding.written = true;
        return result;
      });
      session.check();
      if (!result.ok)
        throw new Error(result.message || `Fileclass could not save "${field.name}".`);
    }
    // Retrying this issued descriptor only observes metadata, never repeats its write.
    await waitForMetadata(session, path, field.name, signal);
    session.check();
  }
}
