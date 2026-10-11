export function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el;
}
export function button(label: string, action: () => unknown, cls = ''): HTMLButtonElement {
  const el = element('button', cls, label); el.type = 'button'; el.addEventListener('click', () => { void action(); }); return el;
}
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
