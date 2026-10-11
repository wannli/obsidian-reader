import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))!;
const releaseWorkflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'))!;
const releaseConfig = JSON.parse(readFileSync('release-please-config.json', 'utf8'));
const releaseManifest = JSON.parse(readFileSync('.release-please-manifest.json', 'utf8'));

describe('GitHub CI and Release Please boundaries', () => {
  it('keeps full CI on pull requests and manual runs without tag publication', () => {
    expect(ci.on).toHaveProperty('pull_request');
    expect(ci.on).toHaveProperty('workflow_dispatch');
    expect(ci.on).not.toHaveProperty('push');
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(ci.jobs).not.toHaveProperty('release');
    const commands = ci.jobs.check.steps.filter((step: { run?: string }) => step.run).map((step: { run: string }) => step.run);
    for (const command of ['npm ci', 'npm test', 'npm run typecheck', 'npm run test:tooling', 'npm run build', 'npm run test:browser:ci'])
      expect(commands).toContain('mise exec -- ' + command);
  });

  it('prepares releases only from main pushes or an explicit manual run', () => {
    expect(releaseWorkflow.on.push).toEqual({ branches: ['main'] });
    expect(releaseWorkflow.on).toHaveProperty('workflow_dispatch');
    expect(releaseWorkflow.on).not.toHaveProperty('pull_request_target');
    expect(releaseWorkflow.permissions).toEqual({ contents: 'write', 'pull-requests': 'write', issues: 'write' });
    const steps = releaseWorkflow.jobs.release.steps;
    expect(steps.some((step: { uses?: string }) => step.uses === 'actions/checkout@v7')).toBe(true);
    expect(steps.some((step: { uses?: string }) => step.uses === 'actions/setup-node@v7')).toBe(true);
    const prepare = steps.find((step: { uses?: string }) => step.uses === 'googleapis/release-please-action@v5');
    expect(prepare.id).toBe('release');
    const buildIndex = steps.findIndex((step: { name?: string }) => step.name === 'Build and verify');
    const prepareIndex = steps.indexOf(prepare);
    expect(buildIndex).toBeLessThan(prepareIndex);
    expect(steps[buildIndex].run).toContain('npm ci');
    expect(steps[buildIndex].run).toContain('npm run build');
  });

  it('publishes only a Release Please-created draft with installable assets', () => {
    const publish = releaseWorkflow.jobs.release.steps.find((step: { name?: string }) => step.name === 'Upload and publish Obsidian release');
    expect(publish.if).toBe('${{ steps.release.outputs.release_created }}');
    expect(publish.env.TAG).toBe('${{ steps.release.outputs.tag_name }}');
    expect(publish.run).toContain('test "$VERSION" = "$TAG"');
    expect(publish.run).toContain('dist/main.js');
    expect(publish.run).toContain('dist/manifest.json');
    expect(publish.run).toContain('if [[ -f dist/styles.css ]]');
    expect(publish.run).toContain('gh release upload "$TAG"');
    expect(publish.run).toContain('gh release edit "$TAG" --draft=false');
    expect(publish.run).not.toContain('--clobber');
  });

  it('uses numeric tags, draft releases, concise sections, and the published baseline', () => {
    expect(releaseConfig['release-type']).toBe('node');
    expect(releaseConfig['bump-minor-pre-major']).toBe(true);
    expect(releaseConfig['include-v-in-tag']).toBe(false);
    expect(releaseConfig['include-component-in-tag']).toBe(false);
    expect(releaseConfig.draft).toBe(true);
    expect(releaseConfig['force-tag-creation']).toBe(true);
    expect(releaseConfig.packages['.']['extra-files']).toEqual([
      { type: 'json', path: 'manifest.json', jsonpath: '$.version' },
    ]);
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    expect(releaseManifest).toEqual({ '.': manifest.version });
    expect(releaseConfig['changelog-sections'].filter((section: { hidden?: boolean }) => !section.hidden).map((section: { section: string }) => section.section))
      .toEqual(['Added', 'Fixed', 'Improved']);
  });

  it('reserves npm run dev for Obsidian hot reload and preview for browser tests', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.dev).toContain('scripts/dev.mjs');
    expect(pkg.scripts.preview).toContain('vite');
    for (const path of ['playwright.config.ts', 'playwright.ci.config.ts', 'playwright.inline.config.ts', 'playwright.eink.config.ts', 'playwright.reading-position.config.ts']) {
      const config = readFileSync(path, 'utf8');
      expect(config).toContain('npm run preview');
      expect(config).not.toContain('npm run dev');
    }
    expect(readFileSync('.gitignore', 'utf8')).toContain('.hotreload');
  });
});
