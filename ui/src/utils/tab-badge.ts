// The one badge a tab may wear, beside the address bar. Three kinds, one
// span, and a fixed precedence: where a file CAME FROM is the interesting
// fact, so a pulled file says its device and a beamed file says "beamed",
// before "external" (merely outside the workspace) gets a look in.
import { isUnderRoot } from "./path";
import { parseRemoteAddress } from "./remote-address";

export type TabBadge =
  | { kind: "from"; label: string; title: string }
  | { kind: "beamed"; label: "beamed"; title: string }
  | { kind: "external"; label: "external"; title: string };

export function tabBadge(
  path: string,
  external: boolean,
  receivedDir: string | null,
  /** `RemoteActionsValue.deviceLabel`: the device name, or its short id. */
  deviceLabel: (peer: string) => string,
): TabBadge | null {
  const remote = parseRemoteAddress(path);
  if (remote) {
    const device = deviceLabel(remote.peer);
    return {
      kind: "from",
      label: `from ${device}`,
      title: `Opened from ${device} — a read-only copy in this app's cache`,
    };
  }
  if (receivedDir && isUnderRoot(path, receivedDir)) {
    return { kind: "beamed", label: "beamed", title: "Received via Beam from another Sky Pie" };
  }
  if (external) {
    return { kind: "external", label: "external", title: "This file is outside the workspace root" };
  }
  return null;
}
