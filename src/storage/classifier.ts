import { normalizeUrl } from '../ingest/url';
import { isAcquisitionUrl } from '../acquisition-url';
import { safePath } from './safety';

export interface TemplateExclusions { folders?: readonly string[]; files?: readonly string[]; }
export type TemplateExclusionsSource = TemplateExclusions | (() => TemplateExclusions | undefined);
// Preserve the already-published aliases while UI/routing adopt the canonical names.
export type ArticleTemplateExclusions = TemplateExclusions;
export type ArticleTemplateExclusionsSource = TemplateExclusionsSource;

export function isArticleTemplatePath(path: string, exclusions: ArticleTemplateExclusions = {}): boolean {
  if (exclusions.files?.includes(path)) return true;
  return !!exclusions.folders?.some(value => {
    const folder = value.replace(/\/+$/, '');
    if (!folder.trim()) return false;
    try { safePath(folder); } catch { return false; }
    return path.startsWith(folder + '/');
  });
}

/** Generic identity-placeholder detection; no QuickAdd runtime dependency. */
export function hasUnresolvedArticleTemplate(frontmatter: Readonly<Record<string, unknown>> | null | undefined): boolean {
  if (!frontmatter) return false;
  return ['type', 'url', 'title', 'id', 'status', 'published'].some(key => {
    const value = frontmatter[key];
    return typeof value === 'string' && /\{\{[\s\S]*?\}\}|<%[\s\S]*?%>|\$\{[^}]*\}/.test(value);
  });
}

/**
 * Pure shared identification policy for repository discovery and native routing.
 * Pass actual parsed frontmatter. No fields are added, normalized, or removed.
 */
export function isArticleNote(
  path: string,
  frontmatter: Readonly<Record<string, unknown>> | null | undefined,
  templateExclusions: TemplateExclusions = {},
): boolean {
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return false;
  try { safePath(path, true); } catch { return false; }
  if (isArticleTemplatePath(path, templateExclusions) || hasUnresolvedArticleTemplate(frontmatter)) return false;
  const url = Object.prototype.hasOwnProperty.call(frontmatter, 'url') ? frontmatter.url : undefined;
  const urlAbsent = url === undefined || url === null || (typeof url === 'string' && !url.trim());
  if (!urlAbsent) {
    if (!isAcquisitionUrl(url)) return false;
    try { normalizeUrl(url); } catch { return false; }
  }
  // Article identity is explicit; URLs and queue folders never infer a type.
  return Object.prototype.hasOwnProperty.call(frontmatter, 'type') && frontmatter.type === 'article';
}
