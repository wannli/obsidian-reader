/** Visible slots only; all omitted article actions remain in More and on their shortcuts. */
export function articleActionKeys(feed: boolean, paged: boolean): readonly string[] {
  if (paged) return ['b', 'z', 'x', feed ? 't' : 'h'];
  return feed ? ['b', 'l', 'a', 't'] : ['b', 'h', 'r', 'a'];
}

export interface ArticleAction {
  key: string;
  label: string;
  icon: string;
  group: 'navigation' | 'reading' | 'disposition' | 'trash';
  disabled?: boolean;
  run(): void | Promise<void>;
}
