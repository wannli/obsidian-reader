import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { bindNodesApi, nodesApi, type NodesApi } from '../src/host/nodes';

const api = (): NodesApi => ({
  version: 2,
  listTypes: vi.fn(() => []),
  searchNodes: vi.fn(() => []),
  getNode: vi.fn(() => null),
  createNode: vi.fn(async () => null),
});
const app = (value: unknown) => {
  const host = {} as App;
  bindNodesApi(host, () => value as NodesApi | undefined);
  return host;
};
const detect = (value: unknown) => nodesApi(app(value));

it('accepts the Reader-owned API without looking up Fileclass Inline', () => {
  const value = api(),
    host = app(value);
  expect(nodesApi(host)).toBe(value);
  for (const name of ['listTypes', 'searchNodes', 'getNode', 'createNode'] as const)
    expect(value[name]).not.toHaveBeenCalled();
});

it('accepts optional shared picker without calling either creation method', () => {
  const value = { ...api(), pickNodeForLink: vi.fn(async () => null) };
  expect(detect(value)).toBe(value);
  expect(value.createNode).not.toHaveBeenCalled();
  expect(value.pickNodeForLink).not.toHaveBeenCalled();
});

it('accepts optional linked creation without invoking it or requiring the shared picker', () => {
  const value = { ...api(), createNodeForLink: vi.fn(async () => null) };
  expect(detect(value)).toBe(value);
  expect(value.createNodeForLink).not.toHaveBeenCalled();
  expect(value.createNode).not.toHaveBeenCalled();
  delete (value as Partial<typeof value>).createNodeForLink;
  expect(detect(value)).toBe(value);
});

it.each([null, false, 'not a method'])(
  'rejects malformed optional linked creation (%s)',
  (value) => {
    expect(detect({ ...api(), createNodeForLink: value })).toBeUndefined();
  },
);

it('keeps Nodes optional when Reader is absent or disposed', () => {
  const host = {} as App;
  expect(nodesApi(host)).toBeUndefined();
  const unbind = bindNodesApi(host, api);
  expect(nodesApi(host)).toBeDefined();
  unbind();
  expect(nodesApi(host)).toBeUndefined();
  expect(detect(undefined)).toBeUndefined();
});

it.each([1, 3, '2', null, undefined])('rejects unsupported API version %s', (version) => {
  expect(detect({ ...api(), version })).toBeUndefined();
});

it.each(['listTypes', 'searchNodes', 'getNode', 'createNode'] as const)(
  'requires the mandatory %s capability even when shared picker exists',
  (name) => {
    for (const value of [undefined, null, false, 'not a method'])
      expect(
        detect({ ...api(), [name]: value, pickNodeForLink: async () => null }),
      ).toBeUndefined();
  },
);

it.each([null, false, 'not a method'])(
  'rejects malformed optional shared picker (%s), not a standalone fallback',
  (value) => {
    expect(detect({ ...api(), pickNodeForLink: value })).toBeUndefined();
  },
);
