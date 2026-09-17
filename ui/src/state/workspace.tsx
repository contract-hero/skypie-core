// WorkspaceContext — single owner of the workspace root (previously buried in
// Sidebar's local state + localStorage reads scattered across files).
import * as React from "react";
import type { IpcSurface } from "../ipc";

// Exported so a caller that must set the root from OUTSIDE this module —
// the E2E harness (ui/e2e/lib), which drives the app by evaluating JS in its
// real webview rather than clicking the native folder picker — writes and
// signals the exact same key `setRoot` does, instead of guessing a shape.
export const WORKSPACE_ROOT_KEY = "skypie.workspaceRoot";

export function readSavedWorkspaceRoot(): string | null {
  try {
    return globalThis.localStorage?.getItem(WORKSPACE_ROOT_KEY) ?? null;
  } catch {
    return null;
  }
}

export interface WorkspaceContextValue {
  root: string | null;
  setRoot: (path: string) => void;
  clearRoot: () => void;
}

const WorkspaceContext = React.createContext<WorkspaceContextValue>({
  root: null,
  setRoot: () => {},
  clearRoot: () => {},
});

export function useWorkspace(): WorkspaceContextValue {
  return React.useContext(WorkspaceContext);
}

export interface WorkspaceProviderProps {
  ipc: IpcSurface;
  children: React.ReactNode;
}

export function WorkspaceProvider({ ipc, children }: WorkspaceProviderProps): React.ReactElement {
  const [root, setRootState] = React.useState<string | null>(readSavedWorkspaceRoot);

  // The native `storage` event never fires in the document that MADE the
  // change (per spec, it is for other browsing contexts only) — so this is
  // dead weight for a real second window today, and inert for anything
  // running inside a rendered artifact's iframe (cross-origin by default;
  // same-origin trusted content already has full `window.parent` access
  // regardless of this listener, per the sandbox policy in render/html.tsx).
  // It exists so something with a legitimate reason to run JS in THIS page
  // — today, only the E2E harness's `evalIn` — can move the root the exact
  // way `setRoot` below does, by writing `WORKSPACE_ROOT_KEY` and dispatching
  // a `StorageEvent` itself, rather than a bespoke test-only API surface.
  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === WORKSPACE_ROOT_KEY && e.newValue) setRootState(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setRoot = React.useCallback(
    (path: string) => {
      // TauriIpc.setWorkspaceRoot persists to localStorage as a side effect.
      ipc.setWorkspaceRoot?.(path);
      setRootState(path);
    },
    [ipc],
  );

  const clearRoot = React.useCallback(() => {
    try {
      globalThis.localStorage?.removeItem(WORKSPACE_ROOT_KEY);
    } catch {
      // ignore
    }
    setRootState(null);
  }, []);

  const value = React.useMemo(
    () => ({ root, setRoot, clearRoot }),
    [root, setRoot, clearRoot],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
