import type { CachedMetadata } from 'obsidian';

/** Preserve an explicit native subpath. Some Markdown link opens expose the
 * resolved source location instead; match only an exact cached block start,
 * never an arbitrary scroll position or a nearby highlight.
 */
export function articleSubpath(state: Record<string, unknown>, cache: CachedMetadata | null): string | undefined {
  if (typeof state.subpath === 'string' && state.subpath.startsWith('#')) return state.subpath;
  const start = state.startLoc;
  const line = start && typeof start === 'object' && 'line' in start ? start.line : state.line;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) return undefined;
  const blocks = Object.values(cache?.blocks ?? {}).filter(block => block.position.start.line === line);
  return blocks.length === 1 ? '#^' + blocks[0].id : undefined;
}
