import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { onNavigate } from './routes';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Run an async loader whenever `deps` change; stale responses are ignored. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: undefined, loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    loadRef.current().then(
      (data) => live && setState({ data, error: undefined, loading: false }),
      (error: unknown) => live && setState({ data: undefined, error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Current location (pathname + search), updated on navigate() and back/forward. */
export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(
    (cb) => onNavigate(cb),
    () => window.location.pathname + window.location.search,
  );
  const q = href.indexOf('?');
  return q === -1 ? { pathname: href, search: '' } : { pathname: href.slice(0, q), search: href.slice(q) };
}
