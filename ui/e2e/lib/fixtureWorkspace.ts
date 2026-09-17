// A throwaway workspace of one file per rendered kind (html/md/ts/txt/png/
// json — see ui/src/render/router.tsx), for a driver that needs SOMETHING
// real to open without depending on the developer's own ~/workspace.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evalIn } from "./app";
import type { LaunchedApp } from "./app";

// The smallest possible PNG (1×1, transparent) — enough to exercise the
// image render path without shipping a binary fixture in the repo.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export interface FixtureWorkspace {
  dir: string;
  files: {
    html: string;
    md: string;
    ts: string;
    txt: string;
    png: string;
    json: string;
  };
}

/** Write the fixture files into a fresh temp directory. Does not touch the
 *  running app — call `setWorkspaceRoot` separately once it's launched. */
export function makeFixtureWorkspace(prefix = "skypie-e2e-"): FixtureWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const files: FixtureWorkspace["files"] = {
    html: path.join(dir, "report.html"),
    md: path.join(dir, "notes.md"),
    ts: path.join(dir, "script.ts"),
    txt: path.join(dir, "readme.txt"),
    png: path.join(dir, "pixel.png"),
    json: path.join(dir, "data.json"),
  };
  fs.writeFileSync(
    files.html,
    "<!doctype html>\n<html><head><title>Fixture report</title></head>" +
      "<body><h1>Fixture report</h1></body></html>\n",
  );
  fs.writeFileSync(files.md, "# Fixture notes\n\nSome *fixture* text.\n");
  fs.writeFileSync(files.ts, "export const fixtureAnswer: number = 42;\n");
  fs.writeFileSync(files.txt, "plain fixture text\n");
  fs.writeFileSync(files.png, Buffer.from(PNG_1X1_BASE64, "base64"));
  fs.writeFileSync(files.json, `${JSON.stringify({ fixture: true }, null, 2)}\n`);
  return { dir, files };
}

/**
 * Set `dir` as the running app's workspace root — THROUGH THE APP'S OWN
 * code path, not a re-implementation of it. `state/workspace.tsx`'s
 * `setRoot` does two things on a real folder pick: persist
 * `WORKSPACE_ROOT_KEY` to localStorage (`ipc.setWorkspaceRoot`'s side
 * effect) and update React state, which is what makes `WatcherProvider`
 * call the real `set_workspace_root` Tauri command. A `KeyboardEvent` can
 * reach the app's keyboard registry from outside because it is dispatched
 * on `document`; there is no such DOM primitive for "a React context
 * changed", so `WorkspaceProvider` listens for a `StorageEvent` instead —
 * see its comment for why a permanent listener there costs nothing.
 */
export async function setWorkspaceRoot(app: LaunchedApp, dir: string): Promise<void> {
  const js = `(function(){
    var path = ${JSON.stringify(dir)};
    localStorage.setItem("skypie.workspaceRoot", path);
    window.dispatchEvent(new StorageEvent("storage", {
      key: "skypie.workspaceRoot", newValue: path, storageArea: localStorage,
    }));
    return true;
  })()`;
  await evalIn(app, js);
}

export async function cleanupFixtureWorkspace(fixture: FixtureWorkspace): Promise<void> {
  await fs.promises.rm(fixture.dir, { recursive: true, force: true });
}
