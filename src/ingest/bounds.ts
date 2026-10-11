export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export const MAX_ARTICLE_BYTES = 4 * 1024 * 1024;
export const MAX_DOM_NODES = 20_000;
export const MAX_DOM_DEPTH = 64;
export const MAX_FEED_ENTRIES = 1000;
export const INGEST_TIMEOUT_MS = 20_000;

export function boundText(text: string, limit: number, label: string): void {
  if (typeof text !== 'string' || text.length > limit || new TextEncoder().encode(text).length > limit) {
    throw new Error(`${label} exceeds the ${limit} byte payload limit.`);
  }
}

/** Conservative preflight prevents huge node allocations before native DOM parsing. */
export function boundMarkup(text: string): void {
  let count = 0;
  for (const _match of text.matchAll(/<[^\s/<>]/gu)) {
    if (++count > MAX_DOM_NODES) throw new Error('Document exceeds the node limit (markup preflight).');
  }
}

/** Iterative traversal also counts text/comments and inert nested template contents. */
export function boundDom(root: Node): void {
  const stack: Array<[Node, number]> = [[root, 0]];
  let count = 0;
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (++count > MAX_DOM_NODES) throw new Error('Document exceeds the node limit.');
    if (depth > MAX_DOM_DEPTH) throw new Error('Document exceeds the nesting depth limit.');
    for (const child of node.childNodes) stack.push([child, depth + 1]);
    if (node.nodeType === 1 && (node as Element).localName === 'template') {
      const content = (node as HTMLTemplateElement).content;
      if (content) stack.push([content, depth + 1]);
    }
  }
}

/** Parse into a template in an inert DOMParser document; never attach source HTML to a live DOM. */
export function parseHtml(html: string): Document {
  boundText(html, MAX_ARTICLE_BYTES, 'Article');
  boundMarkup(html);
  const doc = new DOMParser().parseFromString('', 'text/html');
  const template = doc.createElement('template');
  template.innerHTML = html;
  boundDom(template.content);
  doc.body.append(template.content);
  return doc;
}

export function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new Error('Article extraction timed out.');
}

/** HttpGet has no AbortSignal: settle once and ignore late responses; transport owns cancellation. */
export async function withDeadline<T>(task: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Article request timed out.')), Math.max(0, deadline - Date.now()));
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
