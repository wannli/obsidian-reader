import { isAlias, isScalar, isSeq } from 'yaml';
import type { StorageContext } from './context';
import { noteType, parseNote, stringField, type Note } from './markdown';
import { safePath } from './safety';
import { pathGeneration } from './path-generation';
import type { AcquisitionWriteOptions } from './preconditions';
import { relationshipRevision, topicLink, topicPath, topicValues, type RelationshipProperty } from './topic-links';
import { typedNodeTarget } from '../typed-highlights';
import { TypedNodeBatch } from './typed-nodes';
import { writeRelationship } from './relationship-markdown';
export interface NodeOption { path: string; title: string; }
export interface RelationshipDelta { add?: string[]; remove?: string[]; create?: string[]; }
export interface RelationshipExpectation extends AcquisitionWriteOptions { revision?: string; current?: () => boolean; }
export const relationshipType = (property: RelationshipProperty) => property === 'authors' ? 'person' : 'topic';
export async function listRelationshipNodes(context: StorageContext, property: RelationshipProperty): Promise<NodeOption[]> {
  const result: NodeOption[] = [];
  for (const path of await context.store.list()) {
    if (!/\.md$/i.test(path)) continue;
    try {
      safePath(path, true);
      if (noteType(parseNote(await context.store.read(path))) === relationshipType(property))
        result.push({ path, title: path.split('/').pop()!.replace(/\.md$/i, '') });
    } catch { /* Malformed/unreadable nodes are not silently classified. */ }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function applyDelta(note: Note, path: string, property: RelationshipProperty, files: readonly string[], add: string[], remove: Set<string>): boolean {
  const existing = note.doc.get(property), values = topicValues(note, property);
  if (note.doc.has(property) && !isSeq(existing)) throw new Error(`Existing ${property} must be a YAML list; preserved without changes`);
  if (property === 'authors' && values.some(value => !topicPath(value, path, files)))
    throw new Error('Existing authors contains legacy or unsupported values. Preserved without migration; edit Markdown explicitly.');
  const removed = values.map((value, index) => ({ path: topicPath(value, path, files), index }))
    .filter(item => item.path !== undefined && remove.has(item.path)).map(item => item.index);
  const retained = values.filter((_, index) => !removed.includes(index));
  const known = new Set(retained.map(value => topicPath(value, path, files)).filter(Boolean));
  const additions = add.filter(target => !known.has(target));
  if (!removed.length && !additions.length) return false;
  if (isSeq(existing) && existing.anchor) throw new Error(`${property} use a shared YAML anchor; preserved without changes`);
  if (isSeq(existing) && removed.some(index => {
    const node = existing.items[index];
    return node && !isAlias(node) && typeof node === 'object' && 'anchor' in node && !!node.anchor;
  })) throw new Error(`A ${property} value defines a YAML anchor; preserved without changes`);
  if (!existing) {
    const sequence = note.doc.createNode([]);
    if (!isSeq(sequence)) throw new Error('Could not create relationship list');
    sequence.flow = true; note.doc.set(property, sequence);
  }
  const sequence = note.doc.get(property);
  if (!isSeq(sequence)) throw new Error(`Existing ${property} must be a YAML list`);
  for (const index of removed.sort((a, b) => b - a)) sequence.items.splice(index, 1);
  for (const target of additions) {
    const value = note.doc.createNode(topicLink(target));
    if (isScalar(value)) value.type = 'QUOTE_DOUBLE';
    sequence.add(value);
  }
  if (!sequence.items.length) note.doc.delete(property);
  return true;
}
export async function updateRelationships(context: StorageContext, path: string, property: RelationshipProperty, delta: RelationshipDelta, options: RelationshipExpectation = {}): Promise<void> {
  safePath(path, true);
  const creations = new Set((delta.create ?? []).map(name => typedNodeTarget(name) + '.md'));
  const add = [...new Set([...(delta.add ?? []), ...creations])], remove = new Set(delta.remove ?? []);
  for (const target of [...add, ...remove]) safePath(target, true);
  if (add.some(target => remove.has(target))) throw new Error('A node cannot be both added and removed in one change');
  const hasChanges = add.length > 0 || remove.size > 0;
  const guard = () => {
    context.assertActive();
    if (options.current?.() === false || (options.expectedGeneration !== undefined && pathGeneration(context.store, path) !== options.expectedGeneration))
      throw new Error('Article changed. Reopen the assignment dialog.');
  };
  await context.assertWritable(path); guard();
  const files = await context.store.list();
  if ((options.revision !== undefined || creations.size) && !context.store.indexedPaths)
    throw new Error('This store cannot safely guard relationship link resolution.');
  const currentFiles = () => context.store.indexedPaths?.() ?? files;
  let expectedId = options.expectedId, revision = options.revision;
  const validate = (note: Note, paths: readonly string[] = currentFiles()) => {
    guard();
    if (!context.isArticle(note, path)) throw new Error('The source is no longer an article.');
    const id = stringField(note, 'id') ?? '';
    expectedId ??= id;
    if (creations.size) revision ??= relationshipRevision(note, property, path, paths);
    if (id !== expectedId || (revision !== undefined && relationshipRevision(note, property, path, paths) !== revision))
      throw new Error(`Article ${property} changed or its links resolve differently. Reopen the assignment dialog.`);
  };
  const inspect = (raw: string) => {
    const note = parseNote(raw), paths = currentFiles(); validate(note, paths);
    // Our own staged creates must not silently retarget an existing bare link either.
    const plannedPaths = [...new Set([...paths, ...creations])]; validate(note, plannedPaths);
    const other = () => JSON.stringify(Object.fromEntries(Object.entries(note.doc.toJS({ maxAliasCount: 50 })).filter(([key]) => key !== property)));
    const before = other(), changed = applyDelta(note, path, property, plannedPaths, add, remove);
    if (other() !== before) throw new Error('Shared YAML aliases would change unrelated properties; preserved the note');
    if (changed) {
      const verified = parseNote(writeRelationship(raw, note, property));
      if (verified.body !== note.body || JSON.stringify(verified.doc.toJS({ maxAliasCount: 50 })) !== JSON.stringify(note.doc.toJS({ maxAliasCount: 50 })))
        throw new Error('Cannot safely update relationship YAML; preserved the note');
    }
  };
  if (context.store.inspect) await context.store.inspect(path, inspect); else inspect(await context.store.read(path));
  if (!hasChanges) return;
  const nodes = new TypedNodeBatch(context.store, guard); let dispatched = false;
  let written: Note | undefined, writtenRevision: string | undefined;
  try {
    for (const target of add) await nodes.prepare(target, relationshipType(property), creations.has(target));
    await context.mutateRelationship(path, property, note => {
      const paths = currentFiles(); validate(note, paths); nodes.assert();
      const changed = applyDelta(note, path, property, paths, add, remove);
      written = note; writtenRevision = relationshipRevision(note, property, path, paths);
      dispatched = changed; return changed;
    }, { ...options, expectedId });
    await nodes.verify();
    if (written && relationshipRevision(written, property, path, currentFiles()) !== writtenRevision)
      throw new Error(`Article ${property} link resolution changed during save.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const retained = nodes.created.length ? ` Created nodes were kept: ${nodes.created.join(', ')}. Retry reuses them.` : '';
    if (dispatched) throw new Error(`Could not verify ${property} and nodes together. Assignments may already be saved; reopen the article. Cross-note writes are not atomic.${retained} ${reason}`);
    if (nodes.created.length) throw new Error(`Assignments were not saved.${retained} ${reason}`);
    throw error;
  } finally { nodes.dispose(); }
}
