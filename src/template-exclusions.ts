import type { App } from 'obsidian';
import type { ArticleTemplateExclusions } from './storage/classifier';
import { safePath } from './storage/safety';
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function relative(value: string, file: boolean): string | undefined {
  if (!value.trim() || /^\/+$/u.test(value)) return undefined; // Never exclude a vault root.
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts[0] === '' || parts.some(part => part === '..')) throw new Error('Invalid template path');
  const path = parts.filter(part => part !== '' && part !== '.').join('/');
  if (!path) return undefined; safePath(path, file); return path;
}
/** Only documented/configured native Template choices; no macros or inferred folders. */
export function templateExclusionsFromConfig(core: unknown, quickAdd: unknown): ArticleTemplateExclusions {
  const folders = new Set<string>(), files = new Set<string>();
  if (core !== undefined) {
    if (!record(core) || (core.folder !== undefined && typeof core.folder !== 'string')) throw new Error('Malformed native Templates configuration');
    const folder = typeof core.folder === 'string' ? relative(core.folder, false) : undefined; if (folder) folders.add(folder);
  }
  if (quickAdd !== undefined) {
    if (!record(quickAdd) || (quickAdd.choices !== undefined && !Array.isArray(quickAdd.choices))) throw new Error('Malformed native QuickAdd configuration');
    const visit = (choices: unknown[], depth = 0) => {
      if (depth > 32) throw new Error('QuickAdd choice nesting is too deep to establish template safety');
      for (const choice of choices) {
        if (!record(choice)) throw new Error('Malformed native QuickAdd choice');
        if (choice.type === 'Template') {
          if (typeof choice.templatePath !== 'string') throw new Error('Malformed native Template choice');
          const path = relative(choice.templatePath, true); if (path) files.add(path);
        } else if (choice.type === 'Multi') {
          if (!Array.isArray(choice.choices)) throw new Error('Malformed native Multi choice');
          visit(choice.choices, depth + 1);
        }
      }
    }; visit((quickAdd.choices ?? []) as unknown[]);
  }
  return { folders: [...folders], files: [...files] };
}
/** Public vault adapter only. Absence is safe; unreadable/partial config is NOT absence. */
export async function readTemplateExclusions(app: App): Promise<ArticleTemplateExclusions> {
  async function read(name: string): Promise<unknown> {
    try { const path = app.vault.configDir + '/' + name; return await app.vault.adapter.exists(path) ? JSON.parse(await app.vault.adapter.read(path)) : undefined; }
    catch { throw new Error('Reader paused: native template configuration could not be read safely. Repair the configuration and retry.'); }
  }
  try { const [core, quickAdd] = await Promise.all([read('templates.json'), read('plugins/quickadd/data.json')]); return templateExclusionsFromConfig(core, quickAdd); }
  catch { throw new Error('Reader paused: native template configuration is unreadable or malformed. No acquisition was started.'); }
}
