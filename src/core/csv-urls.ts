import { webUrl } from './model';

/** Read URL-only CSV, or the URL column of a CSV with a header. */
export function csvUrls(source: string): string[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  const field = () => {
    row.push(cell.trim());
    cell = '';
    closed = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else cell += char;
    } else if (char === '"' && !cell.trim() && !closed) {
      quoted = true;
    } else if (char === ',' || char === ';') {
      field();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      field();
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else if (closed && !/\s/.test(char)) {
      throw new Error('Invalid CSV: text after a quoted field.');
    } else if (char === '"') {
      throw new Error('Invalid CSV: unexpected quote.');
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('Invalid CSV: unclosed quoted field.');
  field();
  if (row.some(Boolean)) rows.push(row);
  const header = rows[0]?.map((value) => value.replace(/^\uFEFF/, '').toLowerCase());
  const column = header?.indexOf('url') ?? -1;
  const values = column < 0 ? rows.flat() : rows.slice(1).map((fields) => fields[column] ?? '');
  const urls = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    try {
      urls.add(webUrl(value.replace(/^\uFEFF/, '')));
    } catch {
      throw new Error(`Invalid article URL: ${value}`);
    }
  }
  if (!urls.size) throw new Error('No article URLs found in the CSV.');
  return [...urls];
}
