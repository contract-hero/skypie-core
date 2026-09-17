// useFileMenu — builds the standard right-click menu for a file path:
// open in new tab / reveal in Finder / copy path / copy device link / beam /
// bookmark toggle. Used by tree rows, bookmark rows and tabs.
//
// Deliberately NO "Open in Default App": that requires the broad
// `opener:allow-open-path` capability, which would hand arbitrary program
// launch to anything that can reach IPC from the webview — too big a grant
// for a convenience reachable via Reveal in Finder + double-click.
import * as React from "react";
import {
  Copy,
  FilePlus2,
  Folder,
  Link2,
  PieChart,
  Star,
  StarOff,
  Zap,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { MenuSection } from "../components/ContextMenu";
import { tauriIpc } from "../ipc";
import { useBookmarksContext } from "../state/bookmarks-context";
import { usePiesContext } from "../state/pies-context";
import { useBeamActions } from "../state/beam";
import { usePlatform } from "../state/platform";
import type { OpenFileOptions } from "../state/TabsProvider";
import { copyDeviceLink } from "../utils/device-link";

export function useFileMenu(
  onOpenFile?: (path: string, opts?: OpenFileOptions) => void,
): (path: string) => MenuSection[] {
  const { isBookmarked, toggle } = useBookmarksContext();
  const { openPicker } = usePiesContext();
  const { beginSend } = useBeamActions();
  // Finder and sharing are macOS/desktop affordances — iOS is a read-only
  // companion that owns no files to reveal or re-share (PRODUCT.md,
  // Operating Context).
  const { isMacos } = usePlatform();

  return React.useCallback(
    (path: string): MenuSection[] => {
      const bookmarked = isBookmarked(path);
      return [
        [
          {
            label: "Open in New Tab",
            icon: <FilePlus2 size={13} strokeWidth={2} />,
            onSelect: () => onOpenFile?.(path, { newTab: true, background: false }),
          },
          {
            label: "Add to Pie…",
            icon: <PieChart size={13} strokeWidth={2} />,
            onSelect: () => openPicker(path),
          },
        ],
        [
          ...(isMacos
            ? [
                {
                  label: "Reveal in Finder",
                  icon: <Folder size={13} strokeWidth={2} />,
                  onSelect: () => void revealItemInDir(path).catch(() => {}),
                },
              ]
            : []),
          {
            label: "Copy Path",
            icon: <Copy size={13} strokeWidth={2} />,
            onSelect: () => void navigator.clipboard?.writeText(path).catch(() => {}),
          },
          ...(isMacos
            ? [
                {
                  label: "Copy Link for My Devices",
                  icon: <Link2 size={13} strokeWidth={2} />,
                  onSelect: () => void copyDeviceLink(tauriIpc, path),
                },
                {
                  label: "Beam to Anyone…",
                  icon: <Zap size={13} strokeWidth={2} />,
                  onSelect: () => beginSend(path),
                },
              ]
            : []),
        ],
        [
          bookmarked
            ? {
                label: "Remove Bookmark",
                icon: <StarOff size={13} strokeWidth={2} />,
                onSelect: () => void toggle(path),
              }
            : {
                label: "Bookmark",
                icon: <Star size={13} strokeWidth={2} />,
                onSelect: () => void toggle(path),
              },
        ],
      ];
    },
    [isBookmarked, toggle, onOpenFile, isMacos, beginSend, openPicker],
  );
}
