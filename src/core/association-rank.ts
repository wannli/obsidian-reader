export interface AssociationRank {
  /** Distinct typed articles containing an explicit vault link to this path. */
  count: number;
  /** Weak recency proxy: newest mtime of an article containing that link, not selection time. */
  edited: number;
}

/** Only empty-query suggestions use association ranking; stable name/path fallback is caller-owned. */
export function compareAssociations(
  a: string,
  b: string,
  ranks: ReadonlyMap<string, AssociationRank>,
): number {
  const left = ranks.get(a),
    right = ranks.get(b);
  return (right?.count ?? 0) - (left?.count ?? 0) || (right?.edited ?? 0) - (left?.edited ?? 0);
}
