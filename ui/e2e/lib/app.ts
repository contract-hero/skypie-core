// The E2E harness's core driver: launch the REAL debug desktop app, talk to
// it over its `app.sock` (the same socket `skypie-mcp` uses), and script its
// actual webview via `Request::E2eEval` (crates/skypie-ipc, app/src/e2e.rs)
// rather than re-implementing the UI's behaviour in the test.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "./protocol";
import { run, sleep, waitUntilConnectable } from "./proc";
import { parseCombo } from "../../src/keyboard/shortcuts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `ui/e2e/lib` → `ui`. */
export const UI_DIR = path.resolve(HERE, "../..");
/** `ui` → the skypie-core checkout. */
export const CORE_DIR = path.resolve(UI_DIR, "..");
/** `core` → the skypie-desktop shell repo (core is its `core` git submodule). */
export const SHELL_DIR = path.resolve(CORE_DIR, "..");
export const DESKTOP_BIN = path.join(SHELL_DIR, "target", "debug", "skypie");

/**
 * What `evalIn`/`keys`/`click`/`text`/`waitFor`/`quit` need. Both launchers
 * in this directory satisfy it — `launchDesktop` here (over the unix
 * socket), `launchIos` in `./ios` (over the loopback TCP listener) — so
 * every one of those functions works unmodified against either platform.
 */
export interface AppHandle {
  /** Open one fresh connection to the app's control socket. */
  connect(): net.Socket;
  /** Stop the app (and, for iOS, wait for the simulator to settle). */
  quit(): Promise<void>;
}

export interface LaunchedApp extends AppHandle {
  readonly proc: ChildProcess;
  readonly stateDir: string;
}

export interface LaunchDesktopOptions {
  /** Scratch `SKYPIE_STATE_DIR` — isolates `app.sock`, `state.json`,
   *  `identity.key` etc. from the developer's real install. */
  stateDir: string;
  /** Skip `cargo build` — the caller already did it (or is iterating on
   *  the UI only, which needs no build at all). Default: build. */
  skipBuild?: boolean;
}

/** Where the dev-profile binary loads its page from: `build.devUrl` in the
 *  shell's tauri.conf.json. */
const DEV_URL = "http://localhost:1420";

/**
 * Build (unless `skipBuild`) and launch the DEBUG desktop app over a scratch
 * state dir, and wait for it to bind `app.sock`.
 *
 * A dev-profile Tauri binary (`cargo build` without `--release`, which is
 * what sets `cfg(dev)`) does NOT render the embedded `dist/`: it loads
 * `build.devUrl` from the shell's tauri.conf.json, exactly as `tauri dev`
 * would. So the harness runs the Vite dev server rather than a frontend
 * build — which is also what makes the loop fast: a UI change is live on
 * the next launch with no rebuild at all. Only a Rust change needs
 * `cargo build`. A Vite server already listening on the port (a developer's
 * own `pnpm dev`) is reused and left running.
 */
export async function launchDesktop(opts: LaunchDesktopOptions): Promise<LaunchedApp> {
  // The dev server and `cargo build` need nothing from each other, and both
  // take real time — so the server boots while the crate compiles.
  const devServerStarting = ensureDevServer();
  try {
    if (!opts.skipBuild) {
      run(
        "cargo",
        ["build", "--manifest-path", path.join(SHELL_DIR, "src-tauri", "Cargo.toml")],
        SHELL_DIR,
      );
    }
    if (!fs.existsSync(DESKTOP_BIN)) {
      throw new Error(`built, but the binary is not at ${DESKTOP_BIN}`);
    }
  } catch (e) {
    // The build failed, but the server may already be up: stop it rather
    // than leave an orphan behind (and never leave the promise unhandled).
    const stray = await devServerStarting.catch(() => null);
    if (stray) await quitProcess(stray, { group: true });
    throw e;
  }
  const devServer = await devServerStarting;

  fs.mkdirSync(opts.stateDir, { recursive: true });
  const sockPath = path.join(opts.stateDir, "app.sock");
  // A stale socket from a previous crashed run would make the wait below
  // connect to nothing and hang for the full timeout instead of the fresh
  // one `claim_socket` is about to bind.
  if (fs.existsSync(sockPath)) fs.rmSync(sockPath);

  console.log(`$ ${DESKTOP_BIN}  (SKYPIE_STATE_DIR=${opts.stateDir})`);
  const proc = spawn(DESKTOP_BIN, [], {
    env: { ...process.env, SKYPIE_STATE_DIR: opts.stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[skypie] ${d}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[skypie] ${d}`));
  proc.on("exit", (code, signal) => {
    console.log(`[skypie] exited (code=${code}, signal=${signal})`);
  });

  // Two things can go wrong from here, and both used to be silent.
  // (1) The app exits at start (a missing dylib, a panic in `setup`): the
  //     socket never appears and the only report would be a 30 s timeout,
  //     so the child's own exit races the wait and wins with its code.
  // (2) Either way, `proc` and a dev server THIS call started would be left
  //     running — and the next run would "reuse" that orphan dev server and
  //     test against it. So the failure path stops both before it rethrows.
  const death = exited(proc);
  // The loser of the race stays pending; a rejection nobody is awaiting is
  // an unhandled rejection in node, so it is claimed here once.
  void death.catch(() => undefined);
  try {
    await Promise.race([
      waitUntilConnectable(() => net.createConnection(sockPath), `app.sock at ${sockPath}`, 30_000),
      death,
    ]);
  } catch (e) {
    await quitProcess(proc);
    if (devServer) await quitProcess(devServer, { group: true });
    throw e;
  }
  death.settle();

  const app: LaunchedApp = {
    proc,
    stateDir: opts.stateDir,
    connect: () => net.createConnection(sockPath),
    quit: async () => {
      await quitProcess(proc);
      if (devServer) await quitProcess(devServer, { group: true });
    },
  };
  return app;
}

/** Start `pnpm dev` unless something already answers on `DEV_URL`. Returns
 *  the child when this call started it (so `quit` can stop it), `null`
 *  when an existing server is being reused. */
async function ensureDevServer(): Promise<ChildProcess | null> {
  if (await isUp(DEV_URL)) {
    console.log(`reusing the Vite dev server at ${DEV_URL}`);
    return null;
  }
  console.log(`$ pnpm -C ${UI_DIR} dev`);
  const proc = spawn("pnpm", ["-C", UI_DIR, "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so SIGTERM reaches the vite child pnpm spawns
    // and not only pnpm itself.
    detached: true,
  });
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[vite] ${d}`));
  const deadline = Date.now() + 30_000;
  while (!(await isUp(DEV_URL))) {
    if (Date.now() > deadline) {
      proc.kill("SIGTERM");
      throw new Error(`the Vite dev server never answered at ${DEV_URL} within 30s`);
    }
    await sleep(200);
  }
  return proc;
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Rejects when `proc` exits, and never resolves. Raced against a wait, so
 *  a process that dies at start is reported as what it is rather than as
 *  whatever the wait was going to time out on. */
function exited(proc: ChildProcess): Promise<never> & { settle(): void } {
  let launched = false;
  const p = new Promise<never>((_resolve, reject) => {
    proc.once("exit", (code, signal) => {
      // A normal `quit` later in the run is not a launch failure.
      if (launched) return;
      reject(new Error(`the app exited before it bound its socket (code=${code}, signal=${signal})`));
    });
  }) as Promise<never> & { settle(): void };
  p.settle = () => {
    launched = true;
  };
  return p;
}

/** Terminate a child process and wait for it to exit (SIGKILL after a
 *  grace period, so a hung process never leaves a script hanging).
 *
 *  `group` signals the whole process group instead of the process. Only
 *  the dev server wants it: it is spawned `detached`, so it leads its own
 *  group and vite dies with pnpm. A plain child does NOT lead a group — it
 *  sits in the runner's — so signalling `-pid` there would either throw
 *  `ESRCH` or, worse, SIGKILL an unrelated group that happens to carry
 *  that id. */
async function quitProcess(
  proc: ChildProcess,
  opts: { group?: boolean } = {},
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const signal = (sig: NodeJS.Signals) => {
    if (opts.group && proc.pid !== undefined) {
      try {
        process.kill(-proc.pid, sig);
        return;
      } catch {
        // The group is already gone; fall through to the process itself.
      }
    }
    proc.kill(sig);
  };
  signal("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal("SIGKILL");
      resolve();
    }, 5_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Evaluate `js` — a single JS EXPRESSION, which may `await` — in the app's
 * main webview, and return whatever it resolves to. `js` throwing, or the
 * webview never reporting back within the app's own timeout, rejects.
 */
export async function evalIn(app: AppHandle, js: string): Promise<unknown> {
  const res = await request(app.connect, { op: "e2e_eval", js });
  if (res.status === "err") {
    throw new Error(`evalIn failed: ${res.message}\n  js: ${js}`);
  }
  return res.value;
}

/**
 * Dispatch a `keydown` KeyboardEvent on `document` matching `combo` (e.g.
 * `"mod+p"`, `"mod+shift+bracketright"`) — the same syntax
 * `src/keyboard/shortcuts.ts` bindings use, parsed with its own
 * `parseCombo` so this can never drift from what the app's registry
 * actually matches on (`e.code`, not `e.key`).
 *
 * `key` below is filled with the CODE, since the combo syntax carries no
 * key value. So a component handler that reads `e.key` matches only where
 * the two spellings coincide; a letter combo (`mod+p` → code `KeyP`) does
 * not reach one. The app's own registry reads `e.code`, which is why this
 * is enough for it.
 */
export async function keys(app: AppHandle, combo: string): Promise<void> {
  const p = parseCombo(combo);
  const init = {
    code: p.code,
    key: p.code,
    metaKey: p.mod,
    ctrlKey: p.ctrl,
    shiftKey: p.shift,
    altKey: p.alt,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const js = `(function(){ document.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify(init)})); return true; })()`;
  await evalIn(app, js);
}

/** Click the first element matching `selector`, via the real
 *  `HTMLElement.click()`. The event bubbles, so React's delegated handlers
 *  run exactly as they would for a person — but it carries
 *  `isTrusted === false`, so a handler that checks that flag is NOT
 *  exercised here. Throws if nothing matches. */
export async function click(app: AppHandle, selector: string): Promise<void> {
  const js = `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`;
  const clicked = await evalIn(app, js);
  if (!clicked) throw new Error(`click: no element matches ${selector}`);
}

/** `textContent` of the first element matching `selector`, or `null` when
 *  nothing matches. */
export async function text(app: AppHandle, selector: string): Promise<string | null> {
  const js = `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.textContent : null;
  })()`;
  return (await evalIn(app, js)) as string | null;
}

/**
 * Poll `predicateJs` (a JS expression, evaluated the same way `evalIn`
 * does) until it returns a truthy value, or throw once `timeoutMs` passes.
 * A predicate that itself throws (e.g. `document.querySelector` on
 * something not yet mounted) counts as "not yet" rather than a hard
 * failure, so a caller can write straightforward DOM assertions.
 */
export async function waitFor(
  app: AppHandle,
  predicateJs: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (await evalIn(app, predicateJs)) return;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > deadline) {
      const detail = lastError ? `\n  last error: ${String(lastError)}` : "";
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${predicateJs}${detail}`);
    }
    await sleep(150);
  }
}

/**
 * Open `absPath` through the app's own ⌘P quick-open palette, and wait for
 * the resulting tab to become active. Typed on `AppHandle`, not on
 * `LaunchedApp`, so an iOS scenario can drive it too.
 *
 * Shared here rather than copied per scenario: populating a scenario's
 * Recent history is the common setup step for every Sky/pie checkpoint.
 */
export async function openViaQuickOpen(app: AppHandle, absPath: string): Promise<void> {
  await keys(app, "mod+p");
  await waitFor(app, `document.querySelector('[data-testid="quick-open"]') !== null`, 10_000);
  const rowSelector = `li[title=${JSON.stringify(absPath)}]`;
  await waitFor(app, `document.querySelector(${JSON.stringify(rowSelector)}) !== null`, 10_000);
  await click(app, rowSelector);
  await waitFor(app, `document.querySelector(".tab.active .tab-label") !== null`, 10_000);
}

/** Stop the app. Desktop kills the child process; `launchIos`'s handle
 *  terminates the simulator process instead — each `AppHandle` knows its
 *  own shutdown, this just calls it. */
export async function quit(app: AppHandle): Promise<void> {
  await app.quit();
}
