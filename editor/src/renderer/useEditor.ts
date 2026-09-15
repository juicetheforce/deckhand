import { useEffect, useState } from 'react';
import type { DaemonView, EditorSnapshot, StoreView } from '../shared/bridge.js';

/** The store and daemon views, kept current from the bridge's pushed events. */
export function useEditor(): EditorSnapshot | null {
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null);

  useEffect(() => {
    const api = window.deckhand;
    let alive = true;
    const stopStore = api.onStore((store: StoreView) => setSnapshot((s) => (s ? { ...s, store } : s)));
    const stopDaemon = api.onDaemon((daemon: DaemonView) => setSnapshot((s) => (s ? { ...s, daemon } : s)));
    // Subscribe first, then read, so no change falls between the two.
    void api.snapshot().then((first) => {
      if (alive) setSnapshot(first);
    });
    return () => {
      alive = false;
      stopStore();
      stopDaemon();
    };
  }, []);

  return snapshot;
}
