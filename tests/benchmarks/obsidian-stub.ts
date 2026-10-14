import assert from 'node:assert/strict';
import type { RequestUrlParam } from 'obsidian';

let respond: ((url: string) => string) | undefined;
let requests = 0,
  bytes = 0,
  active = 0,
  peak = 0;
export function configure(handler: (url: string) => string): void {
  respond = handler;
}
export function transportCounts() {
  return { stubRequests: requests, stubResponseBytes: bytes };
}
export function peakRequests(): number {
  return peak;
}
export async function requestUrl(options: RequestUrlParam | string) {
  assert(respond, 'Feed transport not configured');
  assert(typeof options !== 'string', 'Unexpected string request');
  assert(!options.method || options.method === 'GET', 'Unexpected request method');
  assert.equal(options.body, undefined);
  assert.equal(
    options.headers?.Accept,
    'application/rss+xml, application/atom+xml, application/xml, text/xml',
  );
  const text = respond(options.url); // Handler must reject every URL outside the exact fixture allowlist.
  requests++;
  bytes += Buffer.byteLength(text);
  active++;
  peak = Math.max(peak, active);
  try {
    await Promise.resolve(); // Allow real WorkQueue concurrency without sleeps or sockets.
    return {
      status: 200,
      text,
      headers: { 'content-type': 'application/rss+xml' },
      json: {},
      arrayBuffer: new ArrayBuffer(0),
    };
  } finally {
    active--;
  }
}
