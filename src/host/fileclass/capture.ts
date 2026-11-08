import { App, parseFrontMatterAliases, TFile } from 'obsidian';
import { logReaderError } from '../diagnostics';
import type { ClassInfo, FileclassBackend } from './fileclass-contract';
import { assertSession, createTypedNote, titleError, waitForBinding } from './creation';
import { completeRequiredFields } from './required-ui';
import type { NodeIndex } from './index';
import type { NodesSettings } from './settings';

export interface CreatedCapture {
  file: TFile;
  type: ClassInfo;
  classes: string[];
  aliases: string[];
}
export interface CaptureOptions {
  type?: string;
  suggestedTitle?: string;
  signal?: AbortSignal;
  sourcePath?: string;
  inline?: boolean;
  body?: string;
}
class LinkFailure extends Error {
  constructor(readonly original: unknown) {
    super('The created note could not be linked');
  }
}

/** Shared lifecycle for native commands, inline capture and Reader/API consumers. */
export class CaptureController {
  private active = true;
  private requests = new Set<AbortController>();
  constructor(
    private app: App,
    private backend: FileclassBackend,
    private index: NodeIndex,
    private settings: () => NodesSettings,
  ) {}
  cancelAll(): void {
    for (const controller of [...this.requests]) controller.abort();
  }
  dispose(): void {
    this.active = false;
    this.cancelAll();
  }
  run(
    options: CaptureOptions,
    afterCreate?: (record: CreatedCapture) => Promise<boolean | void> | boolean | void,
  ): Promise<CreatedCapture | null> {
    if (!this.active || options.signal?.aborted) return Promise.resolve(null);
    const controller = new AbortController();
    this.requests.add(controller);
    const forward = (): void => controller.abort();
    options.signal?.addEventListener('abort', forward, { once: true });
    return new Promise<CreatedCapture | null>((resolve, reject) => {
      let settled = false;
      const finish = (value: CreatedCapture | null, error?: unknown, failed = false): void => {
        if (settled) return;
        settled = true;
        this.requests.delete(controller);
        options.signal?.removeEventListener('abort', forward);
        controller.signal.removeEventListener('abort', cancelled);
        if (failed) reject(error);
        else resolve(value);
      };
      const cancelled = (): void => finish(null);
      controller.signal.addEventListener('abort', cancelled, { once: true });
      void this.perform(options, controller.signal, afterCreate).then(
        (value) => finish(value),
        (error) => finish(null, error, true),
      );
    });
  }
  private async perform(
    options: CaptureOptions,
    signal: AbortSignal,
    afterCreate?: (record: CreatedCapture) => Promise<boolean | void> | boolean | void,
  ): Promise<CreatedCapture | null> {
    let created: TFile | undefined;
    let record: CreatedCapture | undefined;
    let linked = false;
    try {
      const settings = { ...this.settings() };
      const token = this.backend.token();
      const guard = (): void => {
        assertSession(this.backend, token, signal);
        if (!this.active || JSON.stringify(settings) !== JSON.stringify(this.settings()))
          throw new Error('Reader typed-note settings changed; start again');
      };
      const classes = await this.backend.types();
      guard();
      if (!classes.length)
        throw new Error(
          'No Fileclasses are available yet. Enable Fileclass, wait for its index, and define a class.',
        );
      const chosen =
        options.type !== undefined
          ? classes.find((item) => item.name === options.type)
          : classes.length === 1
            ? classes[0]
            : await (
                await import('./capture-prompts')
              ).chooseClass(this.app, classes, options.suggestedTitle ?? '', signal);
      guard();
      if (!chosen) {
        if (options.type !== undefined) throw new Error(`Unknown Fileclass: ${options.type}`);
        return null;
      }
      let title = options.suggestedTitle ?? '';
      if (
        !options.inline ||
        titleError(title) ||
        this.app.vault.getAbstractFileByPath(`${settings.nodesFolder}/${title}.md`)
      ) {
        const selected = await (
          await import('./capture-prompts')
        ).chooseName(this.app, chosen.name, title, settings.nodesFolder, signal);
        guard();
        if (selected === null) return null;
        title = selected;
      }
      guard();
      created = await createTypedNote(
        this.app,
        this.backend,
        settings,
        chosen.name,
        title,
        options.body,
        signal,
      );
      guard();
      const resolved = await waitForBinding(
        this.app,
        this.backend,
        created,
        chosen.name,
        token,
        signal,
      );
      guard();
      // External creation hooks must not remove the selected body before its source is replaced.
      if (options.body && !(await this.app.vault.read(created)).includes(options.body))
        throw new Error(
          'The copied selection changed in the new note; source text was not replaced',
        );
      guard();
      if (this.app.vault.getAbstractFileByPath(created.path) !== created)
        throw new Error('Created note was replaced or deleted');
      const aliases =
        parseFrontMatterAliases(this.app.metadataCache.getFileCache(created)?.frontmatter ?? {}) ??
        [];
      record = {
        file: created,
        type: chosen,
        classes: [...resolved],
        aliases: aliases.filter((value) => value !== created!.basename),
      };
      this.index.remember(created, resolved);
      const createdPath = created.path;
      if (afterCreate) {
        try {
          const accepted = await afterCreate(record);
          if (accepted === false) return record; // Stale editor: keep note, never interrupt a different document.
          linked = !!options.sourcePath;
        } catch (error) {
          throw new LinkFailure(error);
        }
      }
      guard();
      if (
        created.path !== createdPath ||
        this.app.vault.getAbstractFileByPath(createdPath) !== created
      ) {
        throw new Error(
          'The created note moved, disappeared or was replaced during linking; required completion was skipped',
        );
      }
      // No form at all when every required value is satisfied. Optional fields never enter this UI.
      await completeRequiredFields(this.app, this.backend, created.path, signal);
      return signal.aborted ? null : record;
    } catch (error) {
      if (error instanceof LinkFailure) {
        if (created) logReaderError(`Created ${created.path}; linking failed. The note was kept.`);
        throw error.original;
      }
      if (created) {
        if (this.active) {
          const retained = this.app.vault.getAbstractFileByPath(created.path) === created;
          logReaderError(
            `${retained ? `Kept ${created.path}${linked ? ' and its link' : ''}` : 'The created note was moved, replaced or deleted'}. ${String(error)}`,
          );
        }
        return signal.aborted ? null : (record ?? null);
      }
      if (!signal.aborted && this.active) logReaderError(`Reader typed notes: ${String(error)}`);
      return null;
    }
  }
}
