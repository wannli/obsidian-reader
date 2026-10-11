import type { Editor, EditorPosition, EditorTransaction } from 'obsidian';
export class EditorWriteDeferredError extends Error {
  readonly code = 'READER_EDITOR_DEFERRED';
  constructor(message = 'Reader deferred this write. Save the note or close conflicting editable views, then retry.') { super(message); this.name = 'EditorWriteDeferredError'; }
}
export interface TextEdit { from: number; to: number; text: string; }
interface Line { text: string; offset: number; }
function lines(text: string): Line[] {
  const result: Line[] = []; let offset = 0;
  for (const value of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) { result.push({ text: value, offset }); offset += value.length; }
  return result;
}
/** Patience anchors keep unchanged Markdown sections out of editor replacements. */
export function editorEdits(before: string, after: string): TextEdit[] {
  const result: TextEdit[] = [];
  function visit(a: string, b: string, base: number, depth: number) {
    if (a === b) return;
    if (depth > 32) throw new EditorWriteDeferredError('Reader deferred an editor change that could not be safely split.');
    let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
    a = a.slice(prefix, a.length - suffix); b = b.slice(prefix, b.length - suffix); base += prefix;
    if (!a || !b) { result.push({ from: base, to: base + a.length, text: b }); return; }
    const left = lines(a), right = lines(b), old = new Map<string, number>(), next = new Map<string, number>();
    left.forEach((line, i) => old.set(line.text, old.has(line.text) ? -1 : i));
    right.forEach((line, i) => next.set(line.text, next.has(line.text) ? -1 : i));
    const pairs: { a: number; b: number; previous: number }[] = [], tails: number[] = [];
    left.forEach((line, i) => {
      const j = next.get(line.text); if (old.get(line.text) !== i || j === undefined || j < 0) return;
      let low = 0, high = tails.length;
      while (low < high) { const mid = (low + high) >>> 1; if (pairs[tails[mid]].b < j) low = mid + 1; else high = mid; }
      pairs.push({ a: i, b: j, previous: low ? tails[low - 1] : -1 }); tails[low] = pairs.length - 1;
    });
    if (!tails.length) { result.push({ from: base, to: base + a.length, text: b }); return; }
    const anchors: typeof pairs = []; let index = tails[tails.length - 1];
    while (index >= 0) { anchors.push(pairs[index]); index = pairs[index].previous; } anchors.reverse();
    let x = 0, y = 0;
    for (const anchor of anchors) {
      const first = left[anchor.a], second = right[anchor.b]; visit(a.slice(x, first.offset), b.slice(y, second.offset), base + x, depth + 1);
      x = first.offset + first.text.length; y = second.offset + second.text.length;
    }
    visit(a.slice(x), b.slice(y), base + x, depth + 1);
  }
  visit(before, after, 0, 0); return result;
}
function position(text: string, offset: number): EditorPosition {
  const prefix = text.slice(0, offset); return { line: (prefix.match(/\n/g) ?? []).length, ch: offset - prefix.lastIndexOf('\n') - 1 };
}
function mapped(offset: number, edits: TextEdit[], bias: number): number {
  let shift = 0;
  for (const edit of edits) {
    if (offset < edit.from || (offset === edit.from && bias < 0)) break;
    if (offset >= edit.to && edit.to !== edit.from) { shift += edit.text.length - (edit.to - edit.from); continue; }
    if (offset > edit.to) { shift += edit.text.length; continue; }
    return edit.from + shift + (bias < 0 ? 0 : edit.text.length);
  }
  return offset + shift;
}
export function editorTransaction(editor: Editor, after: string, edits: TextEdit[]): EditorTransaction {
  const selections = editor.listSelections().map(selection => {
    const anchor = editor.posToOffset(selection.anchor), head = editor.posToOffset(selection.head);
    // A caret stays before external insertions at its position (e.g. appending Highlights after Comments).
    return { from: position(after, mapped(anchor, edits, anchor < head ? 1 : -1)), to: position(after, mapped(head, edits, head < anchor ? 1 : -1)) };
  });
  return { changes: edits.map(edit => ({ from: editor.offsetToPos(edit.from), to: editor.offsetToPos(edit.to), text: edit.text })), selections };
}
/** A newer native-save snapshot may add typing, but must retain this operation's edits. */
export function retainsEditorPatch(expected: string, current: string, edits: TextEdit[]): boolean {
  if (expected === current) return true;
  if (!edits.length) return false;
  let shift = 0;
  const changed = edits.map(edit => { const start = edit.from + shift; shift += edit.text.length - (edit.to - edit.from); return { start, end: start + edit.text.length }; });
  return editorEdits(expected, current).every(edit => changed.every(span => span.start === span.end
    ? edit.to < span.start || edit.from > span.end : edit.to <= span.start || edit.from >= span.end));
}
