export interface NodeChoiceType {
  type: string;
  label: string;
  icon?: string;
}

export interface TypedNodeChoice {
  path: string;
  title: string;
  classes: readonly string[];
  aliases: readonly string[];
}

function normalized(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

/** Bound only the initial suggestion; the user remains free to enter a different search/title. */
export function nodeChoiceSeed(text: string | undefined, limit = 80): string {
  const words = (text ?? '').replace(/\s+/gu, ' ').trim();
  const characters = Array.from(words);
  if (characters.length <= limit) return words;
  const prefix = characters.slice(0, Math.max(0, limit)).join('');
  const boundary = prefix.lastIndexOf(' ');
  return (boundary >= prefix.length * 0.6 ? prefix.slice(0, boundary) : prefix).trim();
}

/** Fileclass membership, never a primary type or a route to arbitrary vault files. */
export function hasNodeClass(
  node: TypedNodeChoice,
  types: readonly NodeChoiceType[],
  filter = '',
): boolean {
  return (
    typeof node.path === 'string' &&
    /\.md$/i.test(node.path) &&
    typeof node.title === 'string' &&
    Array.isArray(node.classes) &&
    Array.isArray(node.aliases) &&
    (filter
      ? types.some(({ type }) => type === filter) && node.classes.includes(filter)
      : types.some(({ type }) => node.classes.includes(type)))
  );
}

export function nodeChoiceMatch(
  node: TypedNodeChoice,
  query: string,
): 'Exact title' | 'Exact alias' | 'Related match' | undefined {
  const term = normalized(query);
  if (!term) return undefined;
  if (normalized(node.title) === term) return 'Exact title';
  if (node.aliases.some((alias) => typeof alias === 'string' && normalized(alias) === term))
    return 'Exact alias';
  return 'Related match';
}

/** Keep the provider's fuzzy candidates; rank exact matches first without ever choosing one. */
export function nodeChoices<T extends TypedNodeChoice>(
  nodes: readonly T[],
  types: readonly NodeChoiceType[],
  options: { query?: string; type?: string; preferredPaths?: readonly string[] } = {},
): T[] {
  const preferred = new Map(options.preferredPaths?.map((path, index) => [path, index]));
  const term = normalized(options.query ?? '');
  const rank = (node: T): number => {
    const match = nodeChoiceMatch(node, term);
    if (match === 'Exact title') return 0;
    if (match === 'Exact alias') return 1;
    if (preferred.has(node.path)) return 2;
    if (term && normalized(node.title).includes(term)) return 3;
    return 4;
  };
  const unique = new Map<string, T>();
  for (const node of nodes)
    if (hasNodeClass(node, types, options.type) && !unique.has(node.path))
      unique.set(node.path, node);
  return [...unique.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (preferred.get(a.path) ?? Infinity) - (preferred.get(b.path) ?? Infinity) ||
      (term ? 0 : a.title.localeCompare(b.title) || a.path.localeCompare(b.path)),
  );
}
