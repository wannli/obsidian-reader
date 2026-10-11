import { Document, isMap, parseDocument } from 'yaml';

export interface Note {
  doc: Document;
  body: string;
  header: string;
  newline: string;
  bom: string;
}

export function parseNote(text: string): Note {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = text.slice(bom.length);
  const opening = /^---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!opening) return { doc: new Document({}), body: source, header: '', newline: '\n', bom };
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(source);
  if (!end) throw new Error('Malformed frontmatter: missing closing delimiter');
  const doc: Document = parseDocument(source.slice(opening[0].length, end.index), { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('Malformed frontmatter: ' + (doc.errors[0] ?? doc.warnings[0]).message);
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new Error('Frontmatter must be a YAML mapping');
  // Resolve once with an alias limit to reject cyclic/excessive YAML safely.
  doc.toJS({ maxAliasCount: 50 });
  return {
    doc, body: source.slice(end.index + end[0].length), header: source.slice(0, end.index + end[0].length),
    newline: opening[0].includes('\r') ? '\r\n' : '\n', bom,
  };
}

export function writeNote(note: Note, metadataChanged = true): string {
  if (!metadataChanged) return note.bom + note.header + (note.header && note.body && !note.header.endsWith('\n') ? note.newline : '') + note.body;
  const yaml = note.doc.toString({ lineWidth: 0 }).replace(/\n/g, note.newline);
  return note.bom + '---' + note.newline + yaml + '---' + note.newline + note.body;
}

export function newNote(properties: Record<string, unknown>, body = ''): Note {
  return { doc: new Document(properties), body, header: '', newline: '\n', bom: '' };
}

export function stringField(note: Note, key: string): string | undefined {
  const value = note.doc.get(key);
  return typeof value === 'string' ? value : undefined;
}

export function noteType(note: Note): string | undefined { return stringField(note, 'type'); }
export function expectType(note: Note, type: 'article' | 'feed'): void {
  if (noteType(note) !== type) throw new Error('Expected a ' + type + ' note');
}
export function titleOf(note: Note, path: string): string {
  const explicit = stringField(note, 'title');
  if (explicit) return explicit;
  const filename = path.split('/').pop()!.replace(/\.md$/i, '');
  // Dated article filenames are for sorting, not for the displayed title.
  return noteType(note) === 'article' ? filename.replace(/^\d{6} (?=\S)/, '') : filename;
}
