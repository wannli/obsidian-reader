import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { nodesApi, type NodesApi } from '../src/host/nodes';

const api = (): NodesApi => ({
  version: 2,
  listTypes: vi.fn(() => []),
  searchNodes: vi.fn(() => []),
  getNode: vi.fn(() => null),
  createNode: vi.fn(async () => null),
});
const app = (value: unknown) => ({ plugins: { getPlugin: vi.fn(() => ({ api: value })) } });
const detect = (value: unknown) => nodesApi(app(value) as unknown as App);

it('accepts the public version-2 API without linked capture and uses only the public plugin ID', () => {
  const value = api(),
    host = app(value);
  expect(nodesApi(host as unknown as App)).toBe(value);
  expect(host.plugins.getPlugin).toHaveBeenCalledExactlyOnceWith('obsidian-nodes');
  for (const name of ['listTypes', 'searchNodes', 'getNode', 'createNode'] as const)
    expect(value[name]).not.toHaveBeenCalled();
});

it('accepts optional linked capture without calling either creation method', () => {
  const value = { ...api(), createNodeForLink: vi.fn(async () => null) };
  expect(detect(value)).toBe(value);
  expect(value.createNode).not.toHaveBeenCalled();
  expect(value.createNodeForLink).not.toHaveBeenCalled();
});

it('keeps Nodes optional when the plugin or plugin manager is absent', () => {
  expect(nodesApi({} as App)).toBeUndefined();
  expect(nodesApi({ plugins: { getPlugin: () => undefined } } as unknown as App)).toBeUndefined();
  expect(detect(undefined)).toBeUndefined();
});

it.each([1, 3, '2', null, undefined])('rejects unsupported API version %s', (version) => {
  expect(detect({ ...api(), version })).toBeUndefined();
});

it.each(['listTypes', 'searchNodes', 'getNode', 'createNode'] as const)(
  'requires the mandatory %s capability even when linked capture exists',
  (name) => {
    for (const value of [undefined, null, false, 'not a method'])
      expect(
        detect({ ...api(), [name]: value, createNodeForLink: async () => null }),
      ).toBeUndefined();
  },
);

it.each([null, false, 'not a method'])(
  'rejects malformed optional linked capture (%s), not a standalone fallback',
  (value) => {
    expect(detect({ ...api(), createNodeForLink: value })).toBeUndefined();
  },
);
