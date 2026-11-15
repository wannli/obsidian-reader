import { describe, expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { MemoryVault } from './helpers/memory-vault';

const specimen = `---\nfileClass: Notebook\nunknown: keep # comment\n---\nAuthored introduction.\n\n> [!quote] Passage\n> **Source:** [[Reading/Example|Example]]\n>\n> **URL:** <https://example.org/article>\n>\n> **Collected:** [[2026-11-15]]\n>\n> **Before:** Earlier visible words\\.\n>\n> **After:** Later visible words\\.\n>\n> ---\n>\n> Exact **selected words** with [publisher links](https://example.org/report).\n>\n> ---\n>\n> #### Connections\n>\n> - [[Notebook#^comment-one]] — Contrasts with\n\n^passage-one\n\nAuthored ending.\n`;

describe('native Thinking records through the vault seam', () => {
  it('reopens the approved passage, preserving its snapshot and directed owned connection', async () => {
    const vault = new MemoryVault();
    await vault.create('Notebook.md', specimen);
    const document = await new ThinkingStore(vault).read('Notebook.md');
    expect(document.issues).toEqual([]);
    expect(document.records).toHaveLength(1);
    expect(document.records[0]).toMatchObject({
      kind: 'passage',
      blockId: 'passage-one',
      readOnly: false,
      body: 'Exact **selected words** with [publisher links](https://example.org/report).',
      before: 'Earlier visible words.',
      after: 'Later visible words.',
      source: { path: 'Reading/Example', label: 'Example' },
      connections: [
        { target: { path: 'Notebook', blockId: 'comment-one' }, label: 'Contrasts with' },
      ],
    });
    expect(document.raw).toBe(specimen);
  });
});
