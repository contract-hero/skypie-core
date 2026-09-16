// The toast a rejected `skypie://` link earns. One rejection is worth a
// sentence of its own: a link from a device this app is not paired with,
// which the user can fix in one place. Everything else keeps the backend's
// own reason.
import type { DeepLinkErrorPayload } from "../hooks/useDeepLink";

export function deepLinkNotice({ reason, url, unpaired_from }: DeepLinkErrorPayload): string {
  if (unpaired_from) {
    return (
      `This link comes from a device you haven't paired (${unpaired_from}…). ` +
      "Pair it in Settings → Devices, then open the link again."
    );
  }
  return `Deep link rejected: ${reason} (${url})`;
}
