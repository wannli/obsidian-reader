import { addInlineLink, setInlineHighlightLink, removeInlineHighlight, setInlineLink, removeInlineLink, type InlineSelection } from '../inline';
import { setInlineHighlightTypedLink } from '../inline/edit';
import { TypedNodeBatch } from './typed-nodes';
import { noteType, parseNote } from './markdown';
import { topicPath } from './topic-links';
import { pathGeneration } from './path-generation';
import { StorageContext } from './context';
import { annotationSource, replaceAnnotationSource } from './annotation-source';
import type { AcquisitionWriteOptions } from './preconditions';

async function edit(context: StorageContext, path: string, change: (source: ReturnType<typeof annotationSource>) => string, options: AcquisitionWriteOptions): Promise<void> {
  await context.mutate(path, 'article', note => replaceAnnotationSource(note, path, change(annotationSource(note, path))), options);
}
export async function setHighlightLink(context: StorageContext, path: string, id: string, target: string, options: AcquisitionWriteOptions = {}): Promise<void> {
  const paths = await context.store.list();
  const resolved = /^https?:\/\//i.test(target) ? undefined : topicPath(`[[${target}]]`, path, paths);
  const node = resolved && paths.includes(resolved) ? resolved : undefined;
  let nodeType: string | undefined;
  if (node) {
    const inspect = (raw: string) => { nodeType = noteType(parseNote(raw)); };
    if (context.store.inspect) await context.store.inspect(node, inspect);
    else inspect(await context.store.read(node));
  }
  const type = node && context.settings.typedHighlightTypes.find(type => type.name === nodeType);
  if (!node || !type) return edit(context, path, source => setInlineHighlightLink(source.markdown, id, target, source.options), options);
  const batch = new TypedNodeBatch(context.store, () => {
    context.assertActive();
    if (options.expectedGeneration !== undefined && pathGeneration(context.store, path) !== options.expectedGeneration)
      throw new Error('Article moved or changed. Reopen the highlight.');
  });
  let dispatched = false;
  try {
    await batch.prepare(node, type.name);
    await context.mutate(path, 'article', note => {
      batch.assert();
      const source = annotationSource(note, path);
      const changed = replaceAnnotationSource(note, path, setInlineHighlightTypedLink(source.markdown, id, type, node.slice(0, -3), source.options));
      dispatched = changed;
      return changed;
    }, options);
    await batch.verify();
  } catch (error) {
    if (dispatched) throw new Error(`Could not verify node and highlight together. The highlight may already be saved; reopen the article. Cross-note writes are not atomic. ${String(error)}`);
    throw error;
  } finally { batch.dispose(); }
}
export function deleteHighlight(context: StorageContext, path: string, id: string, options: AcquisitionWriteOptions = {}): Promise<void> {
  // A frontmatter-only typed note may be authored. There is no provenance proof:
  // never delete a node when removing its highlight or link.
  return edit(context, path, source => removeInlineHighlight(source.markdown, id, source.options), options);
}
export function addLink(context: StorageContext, path: string, selection: InlineSelection, target: string, options: AcquisitionWriteOptions = {}): Promise<void> {
  return edit(context, path, source => addInlineLink(source.markdown, selection, target, source.options), options);
}
export function setLink(context: StorageContext, path: string, id: string, target: string, options: AcquisitionWriteOptions = {}): Promise<void> {
  return edit(context, path, source => setInlineLink(source.markdown, id, target, source.options), options);
}
export function deleteLink(context: StorageContext, path: string, id: string, options: AcquisitionWriteOptions = {}): Promise<void> {
  return edit(context, path, source => removeInlineLink(source.markdown, id, source.options), options);
}
