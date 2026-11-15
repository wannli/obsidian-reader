import { expect, it } from 'vitest';
import { ThinkingProtection } from '../src/core/thinking';

it('never authorizes deletion until a complete current native-reference observation is published', () => {
  const protection = new ThinkingProtection();
  const unknown = protection.authority('Source.md');
  expect(unknown.coverage).toBe('unknown');
  expect(unknown.protected).toBe(true);
  expect(() => unknown.assertUnprotected()).toThrow();
  const revision = protection.invalidate();
  expect(
    protection.publish(
      revision,
      [{ path: 'Book.md', sourcePaths: [], complete: true }],
      ['Book.md'],
    ),
  ).toBe(true);
  const clear = protection.authority('Source.md');
  expect(clear.coverage).toBe('complete');
  expect(clear.protected).toBe(false);
  expect(() => clear.assertUnprotected()).not.toThrow();
});
it.each([
  'native edit',
  'move',
  'trash',
  'type loss',
  'malformed record',
  'stale metadata',
] as const)('revokes negative authority synchronously on %s before new asynchronous reads', () => {
  const protection = new ThinkingProtection();
  protection.publish(
    protection.revision,
    [{ path: 'Book.md', sourcePaths: [], complete: true }],
    ['Book.md'],
  );
  const old = protection.authority('Source.md');
  protection.invalidate();
  expect(() => old.assertUnprotected()).toThrow();
  expect(protection.authority('Source.md').protected).toBe(true);
});
it('rejects a stale scan result and uncertain formerly known containers remain possible evidence', () => {
  const protection = new ThinkingProtection();
  const original = protection.revision;
  protection.invalidate();
  expect(
    protection.publish(
      original,
      [{ path: 'Book.md', sourcePaths: [], complete: true }],
      ['Book.md'],
    ),
  ).toBe(false);
  expect(protection.authority('Source.md').protected).toBe(true);
  expect(
    protection.publish(
      protection.revision,
      [{ path: 'Book.md', sourcePaths: [], complete: false }],
      ['Book.md'],
    ),
  ).toBe(false);
  expect(protection.authority('Source.md').coverage).toBe('unknown');
});
it('protects current incoming sources and refuses a scan missing one required native observation', () => {
  const protection = new ThinkingProtection();
  expect(
    protection.publish(
      protection.revision,
      [{ path: 'Book.md', sourcePaths: ['Source.md'], complete: true }],
      ['Book.md', 'Explore.md'],
    ),
  ).toBe(false);
  expect(protection.authority('Other.md').protected).toBe(true);
  expect(
    protection.publish(
      protection.revision,
      [
        { path: 'Book.md', sourcePaths: ['Source.md'], complete: true },
        { path: 'Explore.md', sourcePaths: ['Other.md'], complete: true },
      ],
      ['Book.md', 'Explore.md'],
    ),
  ).toBe(true);
  expect(protection.authority('Source.md').protected).toBe(true);
  expect(protection.authority('Other.md').protected).toBe(true);
  expect(() => protection.authority('Source.md').assertUnprotected()).toThrow();
});
it('a newer positive reference invalidates a previously granted final trash capability', () => {
  const protection = new ThinkingProtection();
  protection.publish(protection.revision, [], []);
  const before = protection.authority('Source.md');
  protection.publish(
    protection.revision,
    [{ path: 'Explore.md', sourcePaths: ['Source.md'], complete: true }],
    ['Explore.md'],
  );
  expect(() => before.assertUnprotected()).toThrow();
  expect(protection.authority('Source.md').protected).toBe(true);
});
