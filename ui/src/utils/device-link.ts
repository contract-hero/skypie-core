// A `skypie://open?…&from=<this node>` link for one local file, and the one
// clipboard copy of it every entry point shares — the Share menu, the context
// menu and ⌘⇧C. Plain functions: only the Share menu renders feedback, so
// only it holds state.
import type { IpcSurface } from "../ipc";

export async function makeDeviceLink(ipc: IpcSurface, path: string): Promise<string> {
  if (!ipc.remoteShareLink) throw new Error("device links are not available in this build");
  return (await ipc.remoteShareLink(path)).link;
}

/** Copy the link; `true` when it landed on the clipboard. A failure is
 *  logged here once, so callers only decide what to show. */
export async function copyDeviceLink(ipc: IpcSurface, path: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(await makeDeviceLink(ipc, path));
    return true;
  } catch (e) {
    console.error("skypie: could not make a device link", e);
    return false;
  }
}
