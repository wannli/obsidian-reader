import type { FileStore } from '../types';

const failure = (detail: string) => new Error('Queue move deferred: ' + detail + '. Review the links before retrying.');
const lower = (value: string) => value.normalize('NFC').toLowerCase();
const stem = (path: string) => path.replace(/\.md$/i, '');
function decode(value: string): string { try { return decodeURIComponent(value); } catch { return value; } }
function matches(target: string, owner: string, paths: readonly string[]): string[] {
  target = decode(target.split('|')[0].split('#')[0]).trim();
  if (!target) return [];
  if (/^\.{1,2}\//.test(target)) {
    const parts = owner.split('/').slice(0, -1);
    for (const part of target.split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); }
    target = parts.join('/');
    return paths.filter(path => lower(stem(path)) === lower(stem(target)));
  }
  const key = lower(stem(target.replace(/^\//, '')));
  return paths.filter(path => lower(stem(path)) === key || lower(stem(path)).endsWith('/' + key));
}
// Deliberately narrow: other Markdown destinations (escapes, entities, fragments,
// titles, attachments, etc.) still require review. Consider both vault/suffix and
// owner-relative interpretations so accepting a bare path cannot hide a shadow.
function markdownTargets(target: string, owner: string, paths: readonly string[]): string[] {
  const relative = matches(/^\.{1,2}\//.test(target) ? target : './' + target, owner, paths);
  return /^\.{1,2}\//.test(target) ? relative : [...new Set([...matches(target, owner, paths), ...relative])];
}
function stripStableMarkdownLinks(raw: string, from: string, to: string, paths: string[], after: string[]): string {
  return raw.replace(/\]\((?:<([\p{L}\p{M}\p{N}_ .\/-]+\.md)>|([\p{L}\p{M}\p{N}_.\/-]+\.md))\)/gu, (syntax, bracketed: string | undefined, bare: string | undefined) => {
    const target = bracketed ?? bare!;
    // Only explicit directory-relative or folder-qualified paths; do not guess
    // at basename resolution, absolute paths or normalization of internal dots.
    const tail = target.replace(/^(?:\.\.?\/)+/, '');
    if (!target.includes('/') || target.startsWith('/') || tail.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part)) return syntax;
    const parents = target.match(/\.\.\//g)?.length ?? 0;
    if (parents > Math.min(from.split('/').length, to.split('/').length) - 1) return syntax;
    const beforeTargets = markdownTargets(target, from, paths), afterTargets = markdownTargets(target, to, after);
    return beforeTargets.length === 1 && afterTargets.length === 1 &&
      (beforeTargets[0] === from ? to : beforeTargets[0]) === afterTargets[0] ? ']' : syntax;
  });
}
/** Conservative incoming-reference check before recoverable Stream removal. */
export function referencesArticle(raw: string, owner: string, target: string, paths: readonly string[]): boolean {
  for (const match of raw.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
    if (matches(match[1], owner, paths).includes(target)) return true;
  }
  for (const match of raw.matchAll(/(?:\]\(\s*|^ {0,3}\[[^\]\r\n]+\]:\s*)<?([^\s)>]+)>?/gm)) {
    if (matches(match[1], owner, paths).includes(target)) return true;
  }
  // Include Markdown destinations and reference-style definitions; false positives retain safely.
  const decoded = lower(decode(raw));
  return decoded.includes(lower(target)) || decoded.includes(lower(target.split('/').pop()!));
}
/** Prove unchanged ordinary links retain their meaning. Historical journal
 * backlinks are user-owned references, with no generated-copy exemption. */
export async function assertMoveLinks(store: FileStore, from: string, to: string, source: string, paths: string[]): Promise<void> {
  const after = paths.map(path => path === from ? to : path);
  for (const path of paths.filter(path => /\.md$/i.test(path))) {
    const raw = path === from ? source : await store.read(path);
    if (lower(decode(raw)).includes(lower(stem(from)))) throw failure('an explicit source-path reference in ' + path + ' requires review');
    for (const match of raw.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
      const beforeTargets = matches(match[1], path, paths), afterTargets = matches(match[1], path === from ? to : path, after);
      const target = decode(match[1].split('|')[0].split('#')[0]).trim();
      if (path === from && /^\.{1,2}\//.test(target) && (!beforeTargets.length || !afterTargets.length))
        throw failure('an unresolved directory-relative source link cannot be proven safe');
      // An unrelated relative or ambiguous link must not block every move in the vault.
      if (path !== from && !beforeTargets.includes(from) && !afterTargets.includes(to)) continue;
      if (beforeTargets.length > 1 || afterTargets.length > 1 ||
          (beforeTargets[0] === from ? to : beforeTargets[0]) !== afterTargets[0])
        throw failure('a wikilink in ' + path + ' would change or ambiguously resolve its target');
    }
    if (path === from) {
      const stripped = stripStableMarkdownLinks(raw, from, to, paths, after).replace(/\]\(\s*(?:<(?:[a-z][a-z0-9+.-]*:|#)[^<>\r\n]*>|(?:[a-z][a-z0-9+.-]*:|#)[^\s)]+)(?:\s+["'][^\r\n]*?["'])?\s*\)/gi, ']');
      if (/\]\s*\(|^ {0,3}\[[^\]\r\n]+\]:|<(?:a|img|audio|video|source)\b/im.test(stripped) || /\]\s*\[/m.test(raw))
        throw failure('relative or unsupported source links require review');
    } else {
      const withoutWiki = raw.replace(/\[\[[^\]\r\n]+\]\]/g, '');
      if (lower(decode(withoutWiki)).includes(lower(from.split('/').pop()!)))
        throw failure('a possible non-wikilink backlink in ' + path + ' requires review');
    }
  }
}
