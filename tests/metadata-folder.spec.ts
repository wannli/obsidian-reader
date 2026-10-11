import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('retired sidecar styling hides no native folders', async ({ page }) => {
  await page.setContent(`<div class="workspace-leaf-content" data-type="file-explorer">
    <div class="nav-folder" id="metadata"><div class="nav-folder-title" data-path="Reading/Metadata">Metadata</div><div>JSON files</div></div>
    <div class="nav-folder" id="other"><div class="nav-folder-title" data-path="Projects/Metadata">Metadata</div></div>
    <div class="nav-folder" id="reading"><div class="nav-folder-title" data-path="Reading">Reading</div></div>
  </div><div class="workspace-leaf-content" data-type="bookmarks">
    <div class="nav-folder" id="bookmark"><div class="nav-folder-title" data-path="Reading/Metadata">Metadata bookmark</div></div>
  </div>`);
  await page.addStyleTag({ content: readFileSync('styles.css', 'utf8') });
  for (const id of ['metadata', 'other', 'reading', 'bookmark']) await expect(page.locator('#' + id)).toBeVisible();
});
