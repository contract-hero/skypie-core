// A throwaway workspace of one file per rendered kind (html/md/ts/txt/png/
// json — see ui/src/render/router.tsx), for a driver that needs SOMETHING
// real to open without depending on the developer's own ~/workspace.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evalIn, waitFor } from "./app";
import type { AppHandle } from "./app";

// The smallest possible PNG (1×1, transparent) — enough to exercise the
// image render path without shipping a binary fixture in the repo.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * One row per rendered kind: the file name, and the bytes to write. The
 * table is the single source of both the `files` map's shape and the writes
 * below, so adding a kind is one line and cannot half-land.
 */
const FIXTURES = {
  html:
    "<!doctype html>\n<html><head><title>Fixture report</title></head>" +
    "<body><h1>Fixture report</h1></body></html>\n",
  md: "# Fixture notes\n\nSome *fixture* text.\n",
  ts: "export const fixtureAnswer: number = 42;\n",
  txt: "plain fixture text\n",
  png: Buffer.from(PNG_1X1_BASE64, "base64"),
  json: `${JSON.stringify({ fixture: true }, null, 2)}\n`,
} as const satisfies Record<string, string | Buffer>;

/** The file name each kind lands under. Separate from the contents only
 *  because a scenario reads a name (`report.html` in quick-open) back. */
const FIXTURE_NAMES = {
  html: "report.html",
  md: "notes.md",
  ts: "script.ts",
  txt: "readme.txt",
  png: "pixel.png",
  json: "data.json",
} as const satisfies Record<keyof typeof FIXTURES, string>;

export interface FixtureWorkspace {
  dir: string;
  /** Absolute path per kind, typed from `FIXTURES` so the two never drift. */
  files: Record<keyof typeof FIXTURES, string>;
}

/** Write the fixture files into a fresh temp directory. Does not touch the
 *  running app — call `setWorkspaceRoot` separately once it's launched. */
export function makeFixtureWorkspace(prefix = "skypie-e2e-"): FixtureWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const files = {} as FixtureWorkspace["files"];
  for (const [kind, contents] of Object.entries(FIXTURES) as [
    keyof typeof FIXTURES,
    (typeof FIXTURES)[keyof typeof FIXTURES],
  ][]) {
    const file = path.join(dir, FIXTURE_NAMES[kind]);
    fs.writeFileSync(file, contents);
    files[kind] = file;
  }
  return { dir, files };
}

/**
 * Set `dir` as the running app's workspace root — THROUGH THE APP'S OWN
 * code path, not a re-implementation of it. `state/workspace.tsx`'s
 * `setRoot` persists the root (`ipc.setWorkspaceRoot`'s side effect) and
 * updates React state, which is what makes `WatcherProvider` call the real
 * `set_workspace_root` Tauri command.
 *
 * A `KeyboardEvent` reaches the app's keyboard registry from outside because
 * it is dispatched on `document`; there is no such DOM primitive for "a
 * React context changed". So `App.tsx`'s `E2eSeam` publishes `setRoot` on
 * `window.__skypieE2e` — but only once the bridge armed, which a release
 * build never does. The seam mounts on its own React tick, which can land
 * after the first evaluation, so this waits for it rather than assuming.
 */
export async function setWorkspaceRoot(app: AppHandle, dir: string): Promise<void> {
  await waitFor(app, "window.__skypieE2e !== undefined", 10_000);
  const js = `(function(){
    window.__skypieE2e.setWorkspaceRoot(${JSON.stringify(dir)});
    return true;
  })()`;
  await evalIn(app, js);
}

export async function cleanupFixtureWorkspace(fixture: FixtureWorkspace): Promise<void> {
  await fs.promises.rm(fixture.dir, { recursive: true, force: true });
}
