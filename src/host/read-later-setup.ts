import { Modal, Setting, type App, type Vault } from 'obsidian';
import type { ReaderFolders } from '../core/folders';

export const readLaterTemplatePath = 'Templates/Reader Read later.md';
export const readLaterTemplate = '---\ntype: article\nurl: >-\n  {{content}}\n---\n';

/** Explicit, create-only setup: never edits an existing template or native settings. */
export async function installReadLaterTemplate(
  vault: Vault,
  folders: ReaderFolders,
  signal: AbortSignal,
): Promise<void> {
  const guard = () => {
    if (signal.aborted) throw new Error('Read later setup was cancelled.');
  };
  guard();
  for (const folder of Object.values(folders)) {
    const path = readLaterTemplatePath.toLowerCase(),
      role = folder.toLowerCase();
    if (path === role || path.startsWith(`${role}/`) || role.startsWith(`${path}/`))
      throw new Error(
        'The template location overlaps a Reader folder. Choose a template location outside Reader queues manually.',
      );
  }
  if (vault.getAbstractFileByPath(readLaterTemplatePath))
    throw new Error(
      `${readLaterTemplatePath} already exists; it was not changed. Select the existing template or create one manually.`,
    );
  if (!vault.getAbstractFileByPath('Templates')) await vault.createFolder('Templates');
  guard();
  await vault.create(readLaterTemplatePath, readLaterTemplate);
}

export function showReadLaterSetup(app: App, folders: ReaderFolders, signal: AbortSignal): void {
  const lifetime = new AbortController();
  class Setup extends Modal {
    onOpen(): void {
      this.setTitle('Set up native Read later');
      this.contentEl.createEl('p', {
        text: 'Use Obsidian’s native Quick Capture with a template. Requires Obsidian 1.14+ and iOS/iPadOS 26+. No QuickAdd community plugin or custom URI is needed. Reader cannot configure Apple Shortcuts or native capture locations for you.',
      });
      this.contentEl.createEl('p', {
        text: `Create-only template: ${readLaterTemplatePath}. Existing files are never overwritten.`,
      });
      this.contentEl.createEl('pre', { text: readLaterTemplate });
      const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
      new Setting(this.contentEl).addButton((button) =>
        button
          .setButtonText('Install Quick Capture template')
          .setCta()
          .onClick(async () => {
            if (lifetime.signal.aborted || signal.aborted) return;
            button.setDisabled(true);
            try {
              await installReadLaterTemplate(this.app.vault, folders, lifetime.signal);
              if (!lifetime.signal.aborted)
                status.textContent = `Created ${readLaterTemplatePath}.`;
            } catch (error) {
              if (lifetime.signal.aborted) return;
              status.textContent = error instanceof Error ? error.message : String(error);
              button.setDisabled(false);
            }
          }),
      );
      const steps = this.contentEl.createEl('ol');
      for (const text of [
        'Open native Quick Capture, tap its capture location, then + to create a location named Read later.',
        `Choose New note in this vault, folder ${folders.inbox}, and template Templates/Reader Read later.`,
        'Enable Open Note after Capture so Obsidian opens the saved article and Reader starts extraction. Save the location.',
        'In Apple Shortcuts, add Obsidian’s Quick Capture action and choose the Read later location. Or assign that location to a Quick Capture widget.',
        'Capture exactly one plain https:// or http:// URL. Do not include a title, Markdown link, quotation marks, or multiple lines. The template puts that URL in frontmatter and leaves the article body empty for safe extraction.',
      ])
        steps.createEl('li', { text });
      this.contentEl.createEl('p', {
        text: 'Defuddle runs when Reader is active and online, not inside the background Quick Capture extension. Keep Obsidian open until extraction finishes. Offline captures retain their URL for foreground recovery. Native capture creates a new note each time; unlike Reader’s Add URL, it does not deduplicate URLs or apply Reader’s filenames.',
      });
      this.contentEl.createEl('p', {
        text: 'For Safari Share Sheet capture instead (Obsidian 1.13+, iOS 18+), create a separate New note location in Inbox with Full Text enabled and a template using url: {{url}} instead of {{content}}. The native Share Sheet appends the captured text itself; Reader preserves it rather than replacing it. URL-only body text is also protected, so use Full Text for that workflow.',
      });
      new Setting(this.contentEl).addButton((button) =>
        button.setButtonText('Done').onClick(() => this.close()),
      );
    }
    onClose(): void {
      lifetime.abort();
      signal.removeEventListener('abort', abort);
      this.contentEl.empty();
    }
  }
  const modal = new Setup(app),
    abort = () => modal.close();
  if (signal.aborted) return;
  signal.addEventListener('abort', abort, { once: true });
  modal.open();
}
