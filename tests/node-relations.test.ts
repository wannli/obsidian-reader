import { describe, expect, it, vi } from 'vitest';
import {
  connectNodes,
  type RelationField,
  type RelationProvider,
  type RelationPrompts,
} from '../src/host/node-relations';

const request = { sourcePath: 'People/Ada.md', destinationPath: 'Books/Book.md' };
const author: RelationField = {
  id: 'author-id',
  revision: 'opaque-snapshot',
  label: 'author',
  cardinality: 'one',
  occupied: false,
  containsSource: false,
};
const prompts: RelationPrompts = {
  chooseField: vi.fn(async () => 'author-id'),
  confirmReplace: vi.fn(async () => true),
};
function provider(fields: RelationField[]) {
  const assign = vi.fn<RelationProvider['assign']>(async () => ({
    fieldLabel: 'author',
    destinationLabel: 'Book',
    sourceLabel: 'Ada',
    changed: true,
  }));
  return { eligibleFields: vi.fn(async () => fields), assign };
}

describe('typed note relations', () => {
  it('leaves notes unchanged when the provider finds no eligible fields', async () => {
    const api = provider([]);
    expect(await connectNodes(api, request, prompts)).toEqual({ kind: 'unavailable' });
    expect(api.assign).not.toHaveBeenCalled();
  });

  it('uses the only eligible field on the destination and reports the direction', async () => {
    const api = provider([author]);
    expect(await connectNodes(api, request, prompts)).toEqual({
      kind: 'saved',
      changed: true,
      message: 'Book · author → Ada',
    });
    expect(api.assign).toHaveBeenCalledWith(
      { ...request, fieldId: 'author-id', revision: 'opaque-snapshot', replaceOccupied: false },
      undefined,
    );
  });

  it('asks which relation to use and never substitutes a stale or invalid choice', async () => {
    const api = provider([author, { ...author, id: 'editor-id', label: 'editor' }]);
    const chooseField = vi.fn(async () => 'editor-id');
    await connectNodes(api, request, { ...prompts, chooseField });
    expect(api.assign).toHaveBeenCalledWith(
      { ...request, fieldId: 'editor-id', revision: 'opaque-snapshot', replaceOccupied: false },
      undefined,
    );
    chooseField.mockResolvedValueOnce('missing-id');
    await expect(connectNodes(api, request, { ...prompts, chooseField })).rejects.toThrow(
      'unavailable',
    );
    expect(api.assign).toHaveBeenCalledTimes(1);
  });

  it('does not write duplicates, and confirms replacement of an occupied single field', async () => {
    const api = provider([{ ...author, containsSource: true }]);
    expect((await connectNodes(api, request, prompts)).kind).toBe('already-linked');
    expect(api.assign).not.toHaveBeenCalled();
    api.eligibleFields.mockResolvedValueOnce([{ ...author, occupied: true }]);
    expect(
      await connectNodes(api, request, { ...prompts, confirmReplace: async () => false }),
    ).toEqual({ kind: 'cancelled' });
    expect(api.assign).not.toHaveBeenCalled();
    api.eligibleFields.mockResolvedValueOnce([{ ...author, occupied: true }]);
    await connectNodes(api, request, prompts);
    expect(api.assign).toHaveBeenCalledWith(
      { ...request, fieldId: 'author-id', revision: 'opaque-snapshot', replaceOccupied: true },
      undefined,
    );
  });

  it('passes multi-link additions to the provider without requesting replacement', async () => {
    const api = provider([{ ...author, cardinality: 'many', occupied: true }]);
    await connectNodes(api, request, prompts);
    expect(api.assign).toHaveBeenCalledWith(
      { ...request, fieldId: 'author-id', revision: 'opaque-snapshot', replaceOccupied: false },
      undefined,
    );
  });

  it('rejects ambiguous provider identities and cancellation before mutation', async () => {
    const api = provider([author, { ...author, label: 'other' }]);
    await expect(connectNodes(api, request, prompts)).rejects.toThrow('ambiguous');
    expect(api.assign).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(connectNodes(api, request, prompts, controller.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(api.eligibleFields).toHaveBeenCalledTimes(1);
  });

  it('reports a completed save even if cancellation arrives during dispatch', async () => {
    const controller = new AbortController();
    const api = provider([author]);
    api.assign.mockImplementationOnce(async () => {
      controller.abort();
      return { changed: true, fieldLabel: 'author', destinationLabel: 'Book', sourceLabel: 'Ada' };
    });
    expect((await connectNodes(api, request, prompts, controller.signal)).kind).toBe('saved');
  });
});
