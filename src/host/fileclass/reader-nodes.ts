import { parseFrontMatterAliases, TFile, type App } from 'obsidian';
import { FileclassBridge } from './fileclass';
import { ReaderRelations } from './relations';
import { FileclassCache } from './fileclass-cache';
import { NodeIndex, type NodeEntry } from './index';
import { CaptureController, type CreatedCapture } from './capture';
import { DEFAULT_SETTINGS, validateSettings, type NodesSettings } from './settings';
import type { NodesApi, NodeResult } from '../nodes';

/** Reader-owned typed-note service; Fileclass's public v1 API remains the class authority. */
export class ReaderNodes {
  private readonly backend: FileclassBridge;
  private readonly relations: ReaderRelations;
  private readonly index: NodeIndex;
  private readonly cache: FileclassCache;
  private readonly capture: CaptureController;
  private facade?: NodesApi;
  private disposed = false;
  private settings: NodesSettings;

  constructor(
    private readonly app: App,
    settings: NodesSettings = DEFAULT_SETTINGS,
  ) {
    const invalid = validateSettings(settings);
    if (invalid) throw new Error(invalid);
    this.settings = { ...settings };
    this.backend = new FileclassBridge(app);
    this.relations = new ReaderRelations(app, () => !this.disposed && this.cache.available());
    this.index = new NodeIndex(app, () => this.backend.members());
    this.capture = new CaptureController(app, this.backend, this.index, () => this.settings);
    this.cache = new FileclassCache(app, this.backend, this.index, () => {
      this.facade = undefined;
      this.relations.dispose();
      this.capture.cancelAll();
    });
  }

  start(): void {
    this.cache.start();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.facade = undefined;
    this.relations.dispose();
    this.capture.dispose();
    this.cache.dispose();
    this.index.dispose();
  }
  configure(settings: NodesSettings): void {
    const invalid = validateSettings(settings);
    if (invalid) throw new Error(invalid);
    this.settings = { ...settings };
    this.capture.cancelAll();
  }
  /** Explicit reconciliation; first-load indexing remains asynchronous and read-only. */
  refresh(): Promise<void> {
    return this.cache.refresh();
  }
  api(): NodesApi | undefined {
    if (this.disposed || !this.cache.available()) return undefined;
    return (this.facade ??= this.createFacade());
  }
  private result(entry: NodeEntry): NodeResult {
    const icon = this.cache.typeInfo(entry.type)?.icon;
    return {
      path: entry.file.path,
      title: entry.file.basename,
      type: entry.type,
      classes: [...entry.classes],
      aliases: entry.labels.slice(1),
      ...(icon ? { icon } : {}),
    };
  }
  private created(record: CreatedCapture): NodeResult {
    const aliases =
      parseFrontMatterAliases(
        this.app.metadataCache.getFileCache(record.file)?.frontmatter ?? {},
      ) ?? [];
    return {
      path: record.file.path,
      title: record.file.basename,
      type: record.type.name,
      classes: [...record.classes],
      aliases: aliases.filter((value) => value !== record.file.basename),
      ...(record.type.icon ? { icon: record.type.icon } : {}),
    };
  }
  private createFacade(): NodesApi {
    const api: NodesApi = {
      version: 2,
      relations: {
        eligibleFields: (request, signal) => {
          if (this.api() !== api) throw new Error('Fileclass connection changed. Try again.');
          return this.relations.eligibleFields(request, signal);
        },
        assign: (request, signal) => {
          if (this.api() !== api) throw new Error('Fileclass connection changed. Try again.');
          return this.relations.assign(request, signal);
        },
      },
      listTypes: () =>
        this.api() === api
          ? this.cache
              .types()
              .map(({ name, icon }) => ({ type: name, label: name, ...(icon ? { icon } : {}) }))
          : [],
      searchNodes: (query) =>
        this.api() === api
          ? this.index.search(query, Infinity).map(({ entry }) => this.result(entry))
          : [],
      getNode: (path) => {
        if (this.api() !== api) return null;
        const entry = this.index.all().find((entry) => entry.file.path === path);
        return entry ? this.result(entry) : null;
      },
      createNode: async (options) => {
        if (this.api() !== api) return null;
        const record = await this.capture.run({ ...options, inline: false });
        return record &&
          this.api() === api &&
          !options.signal?.aborted &&
          this.app.vault.getAbstractFileByPath(record.file.path) === record.file
          ? this.created(record)
          : null;
      },
      createNodeForLink: async (options, link) => {
        if (this.api() !== api || options.signal?.aborted) return null;
        const source = this.app.vault.getAbstractFileByPath(options.sourcePath);
        if (!(source instanceof TFile)) return null;
        const record = await this.capture.run(
          { ...options, inline: options.acceptSuggestedTitle === true },
          async (created) => {
            if (
              this.api() !== api ||
              options.signal?.aborted ||
              source.path !== options.sourcePath ||
              this.app.vault.getAbstractFileByPath(options.sourcePath) !== source
            )
              return false;
            await link(this.created(created));
            return true;
          },
        );
        return record &&
          this.api() === api &&
          !options.signal?.aborted &&
          this.app.vault.getAbstractFileByPath(record.file.path) === record.file
          ? this.created(record)
          : null;
      },
    };
    return api;
  }
}
