/**
 * Native highlight bounds are not Range rects and cannot be capability-tested with them:
 * https://drafts.csswg.org/css-pseudo-4/#highlight-bounds
 * WebKit's line-leading/selection geometry is also affected by bug 325241:
 * https://bugs.webkit.org/show_bug.cgi?id=325241
 * Prefer controlled bands there, except above occluding source backgrounds;
 * keep the established native path on other engines.
 */
export function prefersHighlightOverlay(userAgent: string): boolean {
  if (!/AppleWebKit\//u.test(userAgent)) return false;
  // iOS browser brands still use WebKit (including desktop-mode iPad Safari).
  if (/CriOS\/|FxiOS\/|EdgiOS\//u.test(userAgent)) return true;
  return !/Chrome\/|Chromium\/|Android/u.test(userAgent);
}
