import type { FileStore } from '../types';
import type { StorageContext } from './context';
import { parseNote } from './markdown';
import { sidecarPath } from './sidecar-format';
import { safePath } from './safety';

const metadataFile = (path: string): boolean => {
  const folded = path.toLowerCase();
  return ['reading/metadata/', 'reading/pullman metadata/'].some(prefix => folded.startsWith(prefix) && folded.slice(prefix.length).endsWith('.json'));
};
const atPath = (file: string, note: string) => {
  const folded = file.toLowerCase();
  return folded === sidecarPath(note).toLowerCase() ||
    folded === sidecarPath(note).replace('Reading/Metadata/', 'Reading/Pullman Metadata/').toLowerCase();
};

interface LegacyEvidence { owners: Set<string>; detail: string; }
async function inspectLegacyRecord(store: FileStore, file: string, paths: string[]): Promise<LegacyEvidence> {
  const owners = new Set(paths.filter(path => /\.md$/i.test(path) && atPath(file, path)));
  let detail = 'legacy JSON sidecar requires manual review';
  try {
    const raw = await store.read(file);
    // Preserve explicit path evidence even if duplicate keys or malformed JSON prevent parsing.
    for (const match of raw.matchAll(/"(?:path|from|to|retiredTo)"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
      try { owners.add(safePath(JSON.parse(match[1]), true)); } catch { /* do not invent malformed paths */ }
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('malformed legacy JSON; preserve its exact bytes for review'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unknown legacy JSON record; preserve it for review');
    const record = value as Record<string, unknown>;
    if (typeof record.path === 'string') {
      const owner = safePath(record.path, true);
      owners.add(owner);
      if (!atPath(file, owner)) throw new Error('legacy JSON owner does not match its hashed path; preserve it for review');
      const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown> : {};
      const move = metadata.queueMove && typeof metadata.queueMove === 'object' ? metadata.queueMove as Record<string, unknown> : undefined;
      for (const candidate of [move?.from, move?.to, (record.relocation as Record<string, unknown> | undefined)?.from, record.retiredTo]) {
        if (typeof candidate === 'string') {
          try { owners.add(safePath(candidate, true)); } catch { /* malformed target cannot identify another path */ }
        }
      }
      if (!await store.exists(owner)) throw new Error('orphaned sidecar has no current Markdown owner; do not reuse its path before review');
    }
    throw new Error(detail);
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  return { owners, detail };
}

/** Refuse a new Markdown path named by legacy JSON or a pending YAML queue move. */
export async function assertNoLegacyOwnership(store: FileStore, path: string): Promise<void> {
  const target = safePath(path, true), paths = await store.list();
  for (const candidate of [sidecarPath(target), sidecarPath(target).replace('Reading/Metadata/', 'Reading/Pullman Metadata/')])
    if (await store.exists(candidate)) throw new Error(candidate + ': legacy JSON sidecar owns this path; preserve it for manual review');
  for (const file of paths.filter(metadataFile)) {
    if (atPath(file, target)) throw new Error(file + ': legacy JSON sidecar owns this path; preserve it for manual review');
    const evidence = await inspectLegacyRecord(store, file, paths);
    if (evidence.owners.has(target)) throw new Error(file + ': ' + evidence.detail);
  }
  for (const file of paths.filter(value => /\.md$/i.test(value))) {
    try {
      const note = parseNote(await store.read(file));
      const move = note.doc.toJS({ maxAliasCount: 50 }).queueMove as Record<string, unknown> | undefined;
      if (!move || typeof move !== 'object') continue;
      for (const endpoint of [move.from, move.to]) {
        if (typeof endpoint !== 'string') continue;
        let normalized: string;
        try { normalized = safePath(endpoint, true); }
        catch { continue; } // A malformed endpoint must not hide a valid one.
        if (normalized === target)
          throw new Error(file + ': pending YAML queueMove owns this path; preserve both paths for review');
      }
    } catch (error) {
      if (error instanceof Error && /owns this path/.test(error.message)) throw error;
      // Malformed and unrelated notes cannot safely claim a specific path.
    }
  }
}

/** Inventory unsupported records without adopting or mutating their contents. */
export async function discoverLegacyBlocks(context: StorageContext, paths: string[]): Promise<string[]> {
  const errors: string[] = [];
  for (const file of paths.filter(metadataFile)) {
    const evidence = await inspectLegacyRecord(context.store, file, paths);
    errors.push(file + ': ' + evidence.detail);
    for (const path of evidence.owners) context.blockLegacy(path, evidence.detail);
  }
  return errors;
}
