export interface Line { text: string; start: number; end: number; code: boolean; }
export interface Heading { title: string; level: number; start: number; end: number; }

/** Structural Markdown only: never treat fenced/indented code as headings or IDs. */
function structure(body: string): { lines: Line[]; openFence?: number } {
  const lines: Line[] = [];
  let fence: { char: string; length: number; start: number } | undefined;
  const pattern = /[^\n]*(?:\n|$)/g;
  for (const match of body.matchAll(pattern)) {
    if (!match[0]) continue;
    const text = match[0].replace(/\r?\n$/, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text) ??
      (!fence ? /^ {0,3}(?:[-+*]|\d+[.)])\s+(`{3,}|~{3,})(.*)$/.exec(text) : null);
    let code = !!fence || /^( {4}|\t)/.test(text);
    if (delimiter) {
      if (fence) {
        if (delimiter[1][0] === fence.char && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      } else if (delimiter[1][0] !== '`' || !delimiter[2].includes('`')) {
        fence = { char: delimiter[1][0], length: delimiter[1].length, start: match.index! };
      }
      code = true;
    }
    lines.push({ text, start: match.index!, end: match.index! + match[0].length, code });
  }
  return { lines, openFence: fence?.start };
}

export function linesOf(body: string): Line[] { return structure(body).lines; }

export function headings(body: string): Heading[] {
  const lines = linesOf(body), result: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.code) continue;
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.+?)|[ \t]*)$/.exec(line.text);
    if (atx) result.push({ title: (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim(), level: atx[1].length, start: line.start, end: line.end });
    else if (line.text.trim() && !/^\s*[>\-+*]/.test(line.text) && lines[i + 1] && !lines[i + 1].code) {
      const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[i + 1].text);
      if (underline) { result.push({ title: line.text.trim(), level: underline[1][0] === '=' ? 1 : 2, start: line.start, end: lines[++i].end }); }
    }
  }
  return result;
}

export function headingSpec(value: string): { title: string; level: number; explicit: boolean } {
  if (!value.trim() || /[\r\n]/.test(value)) throw new Error('Daily heading must be a single nonempty line');
  const match = /^(#{1,6})\s+(.+)$/.exec(value.trim());
  const title = (match?.[2] ?? value.trim()).replace(/\s+#+$/, '').trim();
  if (!title) throw new Error('Daily heading must have a title');
  return { title, level: match?.[1].length ?? 2, explicit: !!match };
}

export function gap(text: string): string {
  if (!text || /\r?\n\r?\n$/.test(text)) return '';
  return /\n$/.test(text) ? '\n' : '\n\n';
}

export function appendSection(body: string, heading: string, block: string, snapshotSeparators = false): string {
  const spec = headingSpec(heading), all = headings(body);
  const found = all.find(h => h.title === spec.title && (!(spec.explicit || snapshotSeparators) || h.level === spec.level));
  // Never append inside an unfinished user code fence. Insert before it instead.
  const safeEnd = structure(body).openFence ?? body.length;
  const end = found ? Math.min(all.find(h => h.start > found.start && h.level <= found.level)?.start ?? body.length, safeEnd) : safeEnd;
  const before = body.slice(0, end), after = body.slice(end);
  const title = found ? '' : '#'.repeat(spec.level) + ' ' + spec.title + '\n\n';
  // Fixed article separators are reversible without storing body lengths or hidden markers.
  return before + (snapshotSeparators ? '\n\n' : gap(before)) + title + block + (after ? '\n\n' : '\n') + after;
}

export function blockquote(quote: string): string { return quote.split('\n').map(line => '> ' + line).join('\n'); }
