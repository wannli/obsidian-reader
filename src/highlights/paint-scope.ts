const scopes = new WeakMap<HTMLElement, { users: number; restore: () => void }>();

/** Keep fallback paint in the Reader stacking context, never above host dialogs. */
export function acquireScope(host: HTMLElement): () => void {
  let scope = scopes.get(host);
  if (!scope) {
    const changed: { property: string; previous: string; priority: string; applied: string }[] = [];
    const computed = host.ownerDocument.defaultView!.getComputedStyle(host);
    function apply(property: string, value: string) {
      changed.push({ property, previous: host.style.getPropertyValue(property),
        priority: host.style.getPropertyPriority(property), applied: value });
      host.style.setProperty(property, value);
    }
    if (!computed.position || computed.position === 'static') apply('position', 'relative');
    if (computed.isolation !== 'isolate') apply('isolation', 'isolate');
    scope = { users: 0, restore: () => {
      for (const change of changed) {
        // Do not overwrite a parent-owned style change made while paint was active.
        if (host.style.getPropertyValue(change.property) !== change.applied ||
            host.style.getPropertyPriority(change.property)) continue;
        if (change.previous) host.style.setProperty(change.property, change.previous, change.priority);
        else host.style.removeProperty(change.property);
      }
    } };
    scopes.set(host, scope);
  }
  scope.users++;
  return () => {
    if (--scope!.users === 0) { scope!.restore(); scopes.delete(host); }
  };
}
