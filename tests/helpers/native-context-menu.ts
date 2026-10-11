import { createRequire } from 'node:module';
import { expect } from 'vitest';

// Test-only browser-event adapter for pinned JSDOM 26.1.0. Public dispatchEvent
// clears isTrusted; use the same UA path as JSDOM's own browser-generated events.
// This still runs the real capture/bubble listeners. It does NOT emulate Boox's
// native handles or establish that a physical finger has been released.
const requireTest = createRequire(import.meta.url);
const { implForWrapper, wrapperForImpl } = requireTest('jsdom/lib/jsdom/living/generated/utils.js');
const { createAnEvent } = requireTest('jsdom/lib/jsdom/living/helpers/events.js');
const MouseEventInterface = requireTest('jsdom/lib/jsdom/living/generated/MouseEvent.js');

export function nativeContextMenu(
  target: EventTarget, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
): MouseEvent {
  const targetImpl = implForWrapper(target);
  if (!targetImpl) throw new Error('Expected a JSDOM EventTarget');
  const impl = createAnEvent('contextmenu', targetImpl._globalObject, MouseEventInterface,
    { bubbles: true, cancelable: true, composed: true, buttons: 0, ...init });
  const event = wrapperForImpl(impl) as MouseEvent;
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 }, pointerType: { value: init.pointerType ?? 'mouse' },
  });
  expect(event.isTrusted).toBe(true);
  targetImpl._dispatch(impl);
  expect(event.defaultPrevented).toBe(false);
  return event;
}
