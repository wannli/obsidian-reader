import { addInlineLink, setInlineHighlightLink, removeInlineHighlight, setInlineLink, removeInlineLink, type InlineSelection } from '../inline';
import { setInlineNodeLink } from '../inline/edit';
import { NODE_COLORS } from '../nodes-api';
import { TypedNodeBatch } from './typed-nodes';
import { StorageContext } from './context';
import { annotationSource, replaceAnnotationSource } from './annotation-source';
import type { AcquisitionWriteOptions } from './preconditions';

async function edit(context: StorageContext, path: string, change: (source: ReturnType<typeof annotationSource>) => string, options: AcquisitionWriteOptions): Promise<void> {
  await context.mutate(path, 'article', note => replaceAnnotationSource(note, path, change(annotationSource(note, path))), options);
}
export async function setHighlightLink(context: StorageContext, path: string, id: string, target: string, options: AcquisitionWriteOptions = {}): Promise<void> {
  return edit(context, path, source => setInlineHighlightLink(source.markdown, id, target, source.options), options);
}
export async function setNodeLink(context: StorageContext, path: string, id: string, node: import('../nodes-api').NodeResult | null, options: AcquisitionWriteOptions = {}, guard: () => void = () => {}): Promise<void> {
  const batch = new TypedNodeBatch(context.store, guard);
  let dispatched = false;
  try {
    guard();
    if (node) await batch.prepare(node.path, node.type);
    await context.mutate(path, 'article', note => {
      guard(); batch.assert();
      const source = annotationSource(note, path);
      const changed = replaceAnnotationSource(note, path, setInlineNodeLink(source.markdown, id, node?.path ?? null, node?.color ? NODE_COLORS[node.color] : '', source.options));
      dispatched = changed; return changed;
    }, options);
    await batch.verify(); guard();
  } catch (error) {
    if (dispatched) throw new Error('Could not verify node and highlight together. The link may already be saved; reopen the article. Nodes are kept. ' + String(error));
    throw error;
  } finally { batch.dispose(); }
}

export function deleteHighlight(context: StorageContext, path: string, id: string, options: AcquisitionWriteOptions = {}, removeLinked = false): Promise<void> {
  // A frontmatter-only typed note may be authored. There is no provenance proof:
  // never delete a node when removing its highlight or link.
  return edit(context, path, source => removeInlineHighlight(source.markdown, id, source.options, removeLinked), options);
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

export async function validateNodeHighlight(context: StorageContext, path: string, id: string): Promise<void> {
  await context.mutate(path, 'article', note => {
    const source = annotationSource(note, path);
    setInlineNodeLink(source.markdown, id, null, '', source.options);
    return false;
  });
}
