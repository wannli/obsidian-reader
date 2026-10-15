import { boundDom } from './bounds';

/** Restore only the empty-fallback React streaming shape, without interpreting scripts.
 * General hidden content remains hidden; this is used only before article extraction.
 */
export function restoreStreamedContent(root: DocumentFragment): void {
  const ids = new Map<string, Element | null>();
  for (const element of root.querySelectorAll('[id]'))
    ids.set(element.id, ids.has(element.id) ? null : element);

  for (const boundary of root.querySelectorAll<HTMLTemplateElement>('template[id]')) {
    const suffix = /^B:([\da-z]+)$/i.exec(boundary.id)?.[1];
    if (
      !suffix ||
      ids.get(boundary.id) !== boundary ||
      boundary.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
      boundary.tagName !== 'TEMPLATE' ||
      boundary.parentNode !== root ||
      [...boundary.attributes].some((attribute) => attribute.name !== 'id') ||
      boundary.content.childNodes.length
    )
      continue;
    const start = boundary.previousSibling,
      end = boundary.nextSibling,
      segment = ids.get(`S:${suffix}`);
    // Restrict support to an empty, unambiguous pending boundary and a top-level segment.
    // Reparenting a segment from inside another element could discard inherited hiding.
    if (
      start?.nodeType !== 8 ||
      start.nodeValue !== '$?' ||
      end?.nodeType !== 8 ||
      end.nodeValue !== '/$' ||
      segment?.tagName !== 'DIV' ||
      segment.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
      segment.parentNode !== root ||
      segment.getAttribute('hidden') !== '' ||
      [...segment.attributes].some((attribute) => !['id', 'hidden'].includes(attribute.name)) ||
      segment.contains(boundary)
    )
      continue;
    while (segment.firstChild) boundary.before(segment.firstChild);
    segment.remove();
    start.parentNode!.removeChild(start);
    end.parentNode!.removeChild(end);
    boundary.remove();
  }
  // Recheck the normalized tree before sanitization and extraction.
  boundDom(root);
}
