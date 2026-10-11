export const HIGHLIGHT_COLORS = ['🟡', '🟠', '🔵', '🟢', '🟣', '🔴'] as const;
export type HighlightColor = typeof HIGHLIGHT_COLORS[number];
export interface TypedHighlightType { name: string; color: HighlightColor; }
export const DEFAULT_HIGHLIGHT_TYPES: TypedHighlightType[] = [
  { name: 'person', color: '🟡' }, { name: 'location', color: '🔵' }, { name: 'topic', color: '🟢' },
];
export function validateHighlightTypes(value: unknown): TypedHighlightType[] {
  if (!Array.isArray(value)) throw new Error('Highlight types must be a list.');
  const names = new Set<string>();
  return value.map(item => {
    if (!item || typeof item.name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(item.name) || ['article', 'feed'].includes(item.name))
      throw new Error('Type names must start with a lowercase letter and use lowercase letters, digits, - or _. Article and feed are reserved.');
    if (names.has(item.name)) throw new Error('Highlight type names must be unique.');
    if (!HIGHLIGHT_COLORS.includes(item.color)) throw new Error('Choose one of the six highlight colors.');
    names.add(item.name); return { name: item.name, color: item.color };
  });
}
/** Reject rather than normalizing: the exact words become both filename and label. */
export function typedNodeTarget(text: string): string {
  if (!text || text !== text.trim() || text.normalize('NFC') !== text || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f/\\:*?"<>|#^\[\]%`~&=]/u.test(text) ||
      /\s/u.test(text.replace(/ /g, '')) || / {2}/.test(text) || /[. ]$|^\./.test(text) || /\.md$/i.test(text) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text) || new TextEncoder().encode(text).length > 180)
    throw new Error('These highlighted words are unsafe or ambiguous as a node filename. Edit the highlight in Markdown; no node was created.');
  return `Nodes/${text}`;
}
