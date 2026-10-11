import { localDay, pluginId } from './sandbox.mjs';

export const seedTitle = 'The quiet library — Reader synthetic seed';
export const seedQuote = 'Small observations become durable knowledge when we leave room to read.';
export const seedBody = `# ${seedTitle}\n\n${seedQuote}\n\nThis is a synthetic article for the dedicated Reader test vault. It does not contain personal data or need a network connection.\n\n## A place for attention\n\nSelect a passage to mark it inline with ordinary Markdown. Keep the surrounding words and this source snapshot intact. Daily journals remain unchanged.\n`;
export const feedTitle = 'Reader synthetic offline feed';
const feedPath = 'Reading/Wires/Reader synthetic feed.md';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function markdown(fields, body) {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`;
}

// One authoritative Markdown note; compatibility is tested against the repository.
function managedNote(path, fields, body) {
  return { [path]: markdown(fields, body) };
}

export function seedFiles(day = localDay()) {
  const added = day.replaceAll('-', '').slice(2);
  const files = {
    '.obsidian/app.json': json({}),
    '.obsidian/community-plugins.json': json([pluginId]),
    '.obsidian/core-plugins.json': json(['daily-notes']),
    '.obsidian/daily-notes.json': json({ folder: 'Daily', format: 'YYYY-MM-DD', template: '', autorun: false }),
    [`.obsidian/plugins/${pluginId}/data.json`]: json({
      feedsFolder: 'Reading/Wires', pollMinutes: 30, maxFeedItems: 50,
    }),
    'Welcome.md': '# Reader Test Vault\n\nThis vault is exclusively for synthetic Reader development and testing. Never put personal notes here.\n\nOpen Reader with the Open Reader command, then choose The quiet library. Highlights use ==ordinary inline Markdown== inside each article, and state stays in YAML frontmatter. Links are ordinary inline links. Reader does not maintain daily copies or require JSON sidecars; existing journal text stays untouched.\n\nThe sample feed is disabled and offline. Setup preserves every existing file. Plugin updates back up and replace only the three plugin distribution files.\n\nNative Obsidian, QuickAdd, device behavior, and sync require manual acceptance; unit tests do not prove them.\n',
    ...managedNote(`Reading/Inbox/${added} ${seedTitle}.md`, {
      type: 'article', url: 'https://example.invalid/reader/quiet-library',
      'test-note': 'Preserve this unknown property',
    }, seedBody),
    ...managedNote(feedPath, {
      type: 'feed', id: 'feed-reader-synthetic-seed', title: feedTitle,
      url: 'https://example.invalid/reader/feed.xml', prefix: 'Synthetic', enabled: false,
    }, '# Reader synthetic offline feed\n\nThis feed is disabled so tests never depend on an external service.\n'),
    // No publication date is known for this fictional RSS item: added-day fallback only.
    ...managedNote(`Reading/Stream/${added} Synthetic - A paper lantern — Reader synthetic feed item.md`, {
      type: 'article', url: 'https://example.invalid/reader/paper-lantern', feed: `[[${feedPath.replace(/\.md$/, '')}]]`,
    }, '# A paper lantern\n\nAn offline synthetic feed item makes the Stream list visible without requesting the internet.\n'),
    ...managedNote(`Reading/Later/${added} Reader synthetic later item.md`, {
      type: 'article',
    }, '# A future page\n\nThis synthetic sample waits in Later.\n'),
    ...managedNote(`Reading/Treasury/${added} Reader synthetic treasury item.md`, {
      type: 'article',
    }, '# A saved page\n\nThis synthetic sample is kept in Treasury.\n'),
    [`Daily/${day}.md`]: markdown({ date: day }, `# ${day}\n\n## Plans\n\n- Preserve this existing synthetic daily note and its unrelated text.\n\n## Reading\n\n## Evening\n\nReader leaves this journal and its unrelated text intact.\n`),
  };
  return files;
}
