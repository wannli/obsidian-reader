import type { CompactAnchor } from '../types';
import { addInlineHighlight } from '../inline';
import { StorageContext } from './context';
import type { AcquisitionWriteOptions } from './preconditions';
import { annotationSource, replaceAnnotationSource } from './annotation-source';

export interface HighlightInput { quote: string; anchor?: CompactAnchor; revision?: string; }

export async function addHighlight(context: StorageContext, path: string, input: HighlightInput, options: AcquisitionWriteOptions = {}): Promise<void> {
  await context.mutate(path, 'article', note => {
    const source = annotationSource(note, path);
    return replaceAnnotationSource(note, path, addInlineHighlight(source.markdown, input, source.options));
  }, options);
}
