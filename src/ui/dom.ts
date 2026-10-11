export function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el;
}
export function button(label: string, action: () => unknown, cls = ''): HTMLButtonElement {
  const el = element('button', cls, label); el.type = 'button'; el.addEventListener('click', () => { void action(); }); return el;
}
export function hostname(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Local article'; } }
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function hashText(text: string): string { let n = 2166136261; for (const char of text) n = Math.imul(n ^ char.codePointAt(0)!, 16777619); return (n >>> 0).toString(16); }
