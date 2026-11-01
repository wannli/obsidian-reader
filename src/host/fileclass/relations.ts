import { TFile, type App } from 'obsidian';
import { ObsidianVault } from '../vault';
import { nativeLinkPath } from '../note-links';
import type { RelationField, RelationProvider, RelationRequest } from '../node-relations';
import { FileclassBridge } from './fileclass';
import {
  effectiveFields,
  fingerprint,
  type EffectiveField,
  type PublicApi,
} from './fileclass-fields';

interface Binding {
  api: PublicApi;
  source: TFile;
  destination: TFile;
  sourceRaw: string;
  destinationRaw: string;
  field: EffectiveField;
  value: unknown;
  link: string;
}

/** Reader supplements Fileclass v1; only Fileclass writes the selected field.
 * Fileclass v1 cannot make the candidate check and its setValue one transaction.
 * Fail closed on every observed race; never claim cross-plugin or Sync atomicity. */
export class ReaderRelations implements RelationProvider {
  private readonly bridge: FileclassBridge;
  private hostVault?: ObsidianVault;
  private get vault(): ObsidianVault {
    return (this.hostVault ??= new ObsidianVault(this.app, this.active));
  }
  private readonly bindings = new Map<string, Binding>();
  private next = 0;
  constructor(
    private readonly app: App,
    private readonly active: () => boolean,
  ) {
    this.bridge = new FileclassBridge(app);
  }
  dispose(): void {
    this.bindings.clear();
  }
  private check(signal?: AbortSignal): void {
    if (!this.active() || signal?.aborted) throw new Error('Relation cancelled.');
  }
  private live(file: TFile, path: string): void {
    if (file.path !== path || this.vault.file(path) !== file)
      throw new Error('A relation note was renamed, deleted or replaced. Choose it again.');
  }
  private async snapshot(file: TFile, signal?: AbortSignal): Promise<string> {
    this.check(signal);
    const path = file.path;
    this.live(file, path);
    const raw = await this.vault.read(file);
    this.check(signal);
    this.live(file, path);
    this.vault.assertWritable(file, raw);
    return raw;
  }
  private async fields(api: PublicApi, path: string): Promise<EffectiveField[]> {
    return effectiveFields(
      {
        api,
        check: () => {
          if (this.bridge.token() !== api) throw new Error('Fileclass reloaded. Try again.');
        },
        read: async <T>(operation: () => Promise<T>) => operation(),
      },
      path,
    );
  }
  private candidate(link: string, destinationPath: string): TFile | undefined {
    const wiki = /^\[\[([^|\]#]+)(?:#[^|\]]*)?(?:\|[^\]]*)?\]\]$/.exec(link)?.[1];
    const markdown =
      /^\[[^\]]*\]\(<([^>]+)>\)$/.exec(link)?.[1] ?? /^\[[^\]]*\]\(([^)]+)\)$/.exec(link)?.[1];
    const text = wiki ?? (markdown ? nativeLinkPath(markdown.split('#')[0]) : undefined);
    return text ? this.vault.resolveLink(text, destinationPath) : undefined;
  }
  private async linkFor(
    api: PublicApi,
    source: TFile,
    destination: TFile,
    name: string,
  ): Promise<string | undefined> {
    const candidates = await api.fileCandidates(destination.path, name);
    // Fileclass's generated link is authoritative. An ambiguous or missing candidate
    // never authorizes a write, even if filenames or class names happen to match.
    const matches = candidates.filter(
      ({ link }) => this.candidate(link, destination.path) === source,
    );
    return matches.length === 1 ? matches[0].link : undefined;
  }
  async eligibleFields(request: RelationRequest, signal?: AbortSignal): Promise<RelationField[]> {
    this.check(signal);
    const source = this.vault.file(request.sourcePath);
    const destination = this.vault.file(request.destinationPath);
    if (!source || !destination || source === destination)
      throw new Error('Choose two distinct, existing typed notes.');
    const api = this.bridge.token();
    const [sourceRaw, destinationRaw] = await Promise.all([
      this.snapshot(source, signal),
      this.snapshot(destination, signal),
    ]);
    const [sourceClasses, destinationClasses] = await Promise.all([
      api.explain(source.path),
      api.explain(destination.path),
    ]);
    if (!sourceClasses?.fileClasses.length || !destinationClasses?.fileClasses.length)
      throw new Error('Both notes must still belong to a Fileclass.');
    const fields = await this.fields(api, destination.path);
    const results: RelationField[] = [];
    this.bindings.clear();
    for (const field of fields) {
      const { info } = field;
      if (!info.isRoot || info.path || !['File', 'MultiFile'].includes(info.type)) continue;
      const link = await this.linkFor(api, source, destination, info.name);
      this.check(signal);
      if (!link) continue;
      const value = await api.getValue(destination.path, info.name);
      this.check(signal);
      // A malformed existing value needs repair in Fileclass; never coerce it.
      if (info.type === 'MultiFile' && value != null && !Array.isArray(value)) continue;
      if (info.type === 'File' && value != null && typeof value !== 'string') continue;
      const current = value == null ? [] : Array.isArray(value) ? value : [value];
      if (current.some((item) => typeof item !== 'string')) continue;
      const revision = String(++this.next);
      this.bindings.set(revision, {
        api,
        source,
        destination,
        sourceRaw,
        destinationRaw,
        field,
        value,
        link,
      });
      results.push({
        id: info.name,
        revision,
        label: info.name,
        cardinality: info.type === 'File' ? 'one' : 'many',
        occupied: current.length > 0 && current.some(Boolean),
        ...(info.type === 'File' && current.length && current[0]
          ? { currentLabel: this.candidate(current[0], destination.path)?.basename ?? current[0] }
          : {}),
        containsSource: current.some((item) => this.candidate(item, destination.path) === source),
      });
    }
    this.check(signal);
    if (
      this.bridge.token() !== api ||
      (await this.snapshot(source, signal)) !== sourceRaw ||
      (await this.snapshot(destination, signal)) !== destinationRaw
    )
      throw new Error('A relation note changed. Choose the connection again.');
    return results;
  }
  async assign(
    request: RelationRequest & { fieldId: string; revision: string; replaceOccupied: boolean },
    signal?: AbortSignal,
  ): Promise<{
    fieldLabel: string;
    destinationLabel: string;
    sourceLabel: string;
    changed: boolean;
  }> {
    const binding = this.bindings.get(request.revision);
    this.bindings.delete(request.revision); // One-shot: retries must start with fresh reads.
    if (
      !binding ||
      binding.source.path !== request.sourcePath ||
      binding.destination.path !== request.destinationPath ||
      binding.field.info.name !== request.fieldId
    )
      throw new Error('Relation choice expired. Choose it again.');
    this.check(signal);
    const { api, source, destination, field, link, value } = binding;
    if (this.bridge.token() !== api)
      throw new Error('Fileclass reloaded. Choose the connection again.');
    const fail = () => {
      throw new Error('A note, field or candidate changed. Choose the connection again.');
    };
    this.live(source, request.sourcePath);
    this.live(destination, request.destinationPath);
    const [sourceRaw, destinationRaw] = await Promise.all([
      this.snapshot(source, signal),
      this.snapshot(destination, signal),
    ]);
    if (sourceRaw !== binding.sourceRaw || destinationRaw !== binding.destinationRaw) fail();
    const [sourceClass, destinationClass] = await Promise.all([
      api.explain(source.path),
      api.explain(destination.path),
    ]);
    if (!sourceClass?.fileClasses.length || !destinationClass?.fileClasses.length) fail();
    const currentField = (await this.fields(api, destination.path)).find(
      ({ info }) => info.name === field.info.name && info.isRoot && !info.path,
    );
    if (!currentField || fingerprint(currentField) !== fingerprint(field)) fail();
    const candidate = await this.linkFor(api, source, destination, field.info.name);
    const current = await api.getValue(destination.path, field.info.name);
    if (candidate !== link || fingerprint(current) !== fingerprint(value)) fail();
    const existing = current == null ? [] : Array.isArray(current) ? current : [current];
    if (existing.some((item) => typeof item !== 'string')) fail();
    const present = existing.some((item) => this.candidate(item, destination.path) === source);
    if (
      !present &&
      field.info.type === 'File' &&
      existing.some(Boolean) &&
      !request.replaceOccupied
    )
      fail();
    const next = field.info.type === 'MultiFile' ? [...existing, link] : link;
    this.check(signal);
    if (
      this.bridge.token() !== api ||
      (await this.snapshot(source, signal)) !== sourceRaw ||
      (await this.snapshot(destination, signal)) !== destinationRaw
    )
      fail();
    const names = {
      fieldLabel: field.info.name,
      destinationLabel: destination.basename,
      sourceLabel: source.basename,
    };
    if (present) return { ...names, changed: false };
    // No awaits between final guards and invoking Fileclass's write. Fileclass v1 does
    // not support conditional setValue; an external concurrent writer can still race.
    this.check(signal);
    this.live(source, request.sourcePath);
    this.live(destination, request.destinationPath);
    this.vault.assertWritable(source, sourceRaw);
    this.vault.assertWritable(destination, destinationRaw);
    if (this.bridge.token() !== api) fail();
    let result: Awaited<ReturnType<PublicApi['setValue']>>;
    try {
      result = await api.setValue(destination.path, field.info.name, next);
    } catch (error) {
      throw new Error(
        `Fileclass write outcome is uncertain; inspect ${destination.path} before trying again.`,
        { cause: error },
      );
    }
    if (!result.ok) throw new Error(result.message || 'Fileclass could not save the relation.');
    return { ...names, changed: true };
  }
}
