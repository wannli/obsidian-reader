import { TypedNodeBatch } from './typed-nodes';
import { parseInlineMarkdown } from '../inline/parser';
import { setInlineHighlightType } from '../inline/edit';
import { typedNodeTarget, validateHighlightTypes, type TypedHighlightType } from '../typed-highlights';
import { StorageContext } from './context';
import { annotationSource, replaceAnnotationSource } from './annotation-source';
import { parseNote } from './markdown';
import { pathGeneration } from './path-generation';
import type { AcquisitionWriteOptions } from './preconditions';

export async function setHighlightType(context: StorageContext, path: string, id: string, type: TypedHighlightType, options: AcquisitionWriteOptions): Promise<void> {
  validateHighlightTypes([type]);
  if (!validateHighlightTypes(context.settings.typedHighlightTypes).some(item => item.name === type.name && item.color === type.color))
    throw new Error('Highlight types changed. Reopen the highlight menu.');
  const guard = () => {
    context.assertActive();
    if (options.expectedGeneration !== undefined && pathGeneration(context.store, path) !== options.expectedGeneration)
      throw new Error('Article moved or changed. Reopen the highlight.');
  };
  await context.assertWritable(path); guard();
  let target = '';
  const validateSource = (current: string) => {
    guard(); const note = parseNote(current);
    if (!context.isArticle(note, path)) throw new Error('The source is no longer an article.');
    const source = annotationSource(note, path);
    // Validate source/revision/format before creating any node, including native buffers.
    setInlineHighlightType(source.markdown, id, type, source.options);
    target = typedNodeTarget(parseInlineMarkdown(source.markdown, source.options).highlights.find(item => item.id === id)!.quote) + '.md';
  };
  if (context.store.inspect) await context.store.inspect(path, validateSource);
  else validateSource(await context.store.read(path));
  const nodes = new TypedNodeBatch(context.store, guard);
  let dispatched = false;
  try {
    await nodes.prepare(target, type.name, true);
    await context.mutate(path, 'article', note => {
      // mutate performs async scans first: check the target again INSIDE the
      // article's synchronous disk callback / native editor transaction boundary.
      nodes.assert();
      const source = annotationSource(note, path);
      const changed = replaceAnnotationSource(note, path, setInlineHighlightType(source.markdown, id, type, source.options));
      dispatched = changed;
      return changed;
    }, options);
    // Cross-note writes cannot be atomic. Detect changes while a native save was
    // pending, without overwriting the node or rolling back someone else's edits.
    await nodes.verify();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (dispatched) throw new Error(`Could not verify node and highlight together. The highlight may already be saved; inspect ${target} and reopen the article. Cross-note writes are not atomic. ${reason}`);
    if (nodes.created.length) throw new Error(`Created ${target}, but the highlight was not saved. The node was kept; reopen the highlight and retry. ${reason}`);
    throw error;
  } finally { nodes.dispose(); }
}
