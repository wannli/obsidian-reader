export const MAX_HTML_BYTES = 2_000_000;
export const MAX_DOM_NODES = 20_000;
export const MAX_DOM_DEPTH = 64;

export function bounded(value: string, limit = MAX_HTML_BYTES): string {
  if (value.length > limit || new TextEncoder().encode(value).length > limit)
    throw new Error('Content is too large.');
  return value;
}

/** Conservative allocation preflight; the DOM check also counts text and comments. */
export function boundMarkup(markup: string): void {
  bounded(markup);
  let count = 0;
  for (const _match of markup.matchAll(/<[^\s/<>]/gu)) {
    if (++count > MAX_DOM_NODES) throw new Error('Content exceeds the node limit.');
  }
}

/** Iterative, bounded-memory traversal, including inert (possibly nested) templates. */
export function boundDom(root: Node): void {
  const stack: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > MAX_DOM_NODES) throw new Error('Content exceeds the node limit.');
    if (depth > MAX_DOM_DEPTH) throw new Error('Content exceeds the depth limit.');
    if (node !== root && node.nextSibling) stack.push({ node: node.nextSibling, depth });
    if (node.firstChild) stack.push({ node: node.firstChild, depth: depth + 1 });
    if (node.nodeType === 1 && (node as Element).localName === 'template') {
      const content = (node as HTMLTemplateElement).content;
      if (content) stack.push({ node: content, depth: depth + 1 });
    }
  }
}

/** Never attach untrusted HTML to a live reading surface. Check before any conversion. */
export function parseHtml(html: string): HTMLTemplateElement {
  boundMarkup(html);
  const template = document.createElement('template');
  template.innerHTML = html;
  boundDom(template.content);
  return template;
}
