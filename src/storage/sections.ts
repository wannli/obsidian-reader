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

export function gap(text: string): string {
  if (!text || /\r?\n\r?\n$/.test(text)) return '';
  return /\n$/.test(text) ? '\n' : '\n\n';
}
