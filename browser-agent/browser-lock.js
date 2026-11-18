export function createOperationGate() {
  let active = null;
  let sequence = 0;

  return {
    acquire(label) {
      if (active) return null;
      active = {
        id: ++sequence,
        label: String(label || "browser operation").slice(0, 100),
        startedAt: Date.now()
      };
      return { id: active.id, label: active.label, startedAt: active.startedAt };
    },
    release(lease) {
      if (!lease || !active || active.id !== lease.id) return false;
      active = null;
      return true;
    },
    forceRelease() {
      const previous = active ? { ...active } : null;
      active = null;
      return previous;
    },
    snapshot() {
      return active ? { ...active, elapsedMs: Date.now() - active.startedAt } : null;
    },
    get busy() {
      return active !== null;
    }
  };
}
