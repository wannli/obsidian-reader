import type { App, TFile } from 'obsidian';
import { ObsidianVault } from './vault';
import type { DiagnosticStorage } from './diagnostics';

/** Ordinary Vault writes are indexed and eligible for Markdown sync, unlike hidden adapter files. */
export function diagnosticStorage(app: App, active: () => boolean): DiagnosticStorage {
  const vault = new ObsidianVault(app, active);
  const observed = new Map<string, { file: TFile; raw: string }>();
  return {
    exists: async (path) => vault.exists(path),
    mkdir: async (path) => vault.folder(path),
    stat: async (path) => {
      const file = vault.file(path);
      if (!file && vault.exists(path)) throw new Error('Diagnostic path is occupied.');
      return file ? { size: file.stat.size } : null;
    },
    read: async (path) => {
      const file = vault.file(path);
      if (!file) throw new Error('Diagnostic file is unavailable.');
      const raw = await vault.read(file);
      observed.set(path, { file, raw });
      return raw;
    },
    write: async (path, content) => {
      const file = vault.file(path);
      const expected = observed.get(path);
      if (!file) {
        if (expected) throw new Error('Diagnostic file changed.');
        const created = await vault.create(path, content);
        observed.set(path, { file: created, raw: content });
        return;
      }
      if (!expected || expected.file !== file) throw new Error('Diagnostic file changed.');
      await vault.process(file, (current) => {
        if (current !== expected.raw) throw new Error('Diagnostic file changed.');
        return content;
      });
      observed.set(path, { file, raw: content });
    },
  };
}
