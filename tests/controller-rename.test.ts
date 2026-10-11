import { expect, it, vi } from 'vitest';
import { ReaderController } from '../src/controller';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';

it('awaits sidecar relocation before notifying readers or scheduling acquisition', async () => {
  const settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(new MemoryStore(), settings);
  const controller = new ReaderController(repo, vi.fn<HttpGet>(), settings);
  let finish!: () => void;
  const rename = vi.spyOn(repo, 'articleRenamed').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const changed = vi.fn(), schedule = vi.spyOn(controller, 'scheduleAcquisition'); controller.subscribe(changed);
  const pending = controller.articleRenamed('Reading/Stream/Old.md', 'Reading/Inbox/New.md');
  expect(rename).toHaveBeenCalledExactlyOnceWith('Reading/Stream/Old.md', 'Reading/Inbox/New.md');
  expect(changed).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled();
  finish(); await pending;
  expect(changed).toHaveBeenCalledTimes(1); expect(schedule).toHaveBeenCalledTimes(1);
  await controller.shutdown();
});
it('propagates sidecar rename failure without announcing successful relocation', async () => {
  const settings = { ...DEFAULT_SETTINGS }, repo = new ReaderRepository(new MemoryStore(), settings);
  const controller = new ReaderController(repo, vi.fn<HttpGet>(), settings);
  vi.spyOn(repo, 'articleRenamed').mockRejectedValue(new Error('Sidecar relocation failed'));
  const changed = vi.fn(), schedule = vi.spyOn(controller, 'scheduleAcquisition'); controller.subscribe(changed);
  await expect(controller.articleRenamed('Old.md', 'New.md')).rejects.toThrow('Sidecar relocation failed');
  expect(changed).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled(); await controller.shutdown();
});
