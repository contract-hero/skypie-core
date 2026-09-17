// The iOS half of the harness. macOS has `app.sock`; the simulator has
// none (`app/src/ipc_server.rs` is `cfg(target_os = "macos")`), so the app
// listens on a loopback TCP port instead when `SKYPIE_E2E_PORT` is set
// (`app/src/e2e.rs::start_tcp_if_configured`) — same JSON-line protocol,
// narrowed to `E2eEval` and `Status`. `xcrun simctl launch` forwards env
// vars prefixed `SIMCTL_CHILD_` into the launched process, which is how the
// port reaches the app without a config file.
import { execFileSync, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { promisify } from "node:util";
import { CORE_DIR, SHELL_DIR } from "./app";
import type { AppHandle } from "./app";

const execFileAsync = promisify(execFile);

/** Fixed per STATUS.md's own iOS E2E history — the one simulator this
 *  machine's harness targets. */
export const SIMULATOR_UDID = "AF4CB22E-8E9F-4E83-ADFC-0FFF70B657FE";
export const BUNDLE_ID = "ai.skypie.SkyPie";

/** `core` (skypie-desktop's submodule) → the sibling `skypie-ios` repo. */
export const IOS_SHELL_DIR = path.resolve(SHELL_DIR, "..", "skypie-ios");
export const IOS_CORE_DIR = path.join(IOS_SHELL_DIR, "core");
export const IOS_APP_PATH = path.join(
  IOS_SHELL_DIR,
  "src-tauri/gen/apple/build/arm64-sim/Sky Pie.app",
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd: string, args: string[], cwd?: string): void {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

/**
 * Point `skypie-ios/core` (a separate checkout — the iOS shell has its own
 * `Cargo.toml` path dependency on it, same as `skypie-desktop/src-tauri`
 * has its own) at the SAME commit this checkout is on, over the `local`
 * git remote the two repos already carry for each other. Building against
 * anything else would test code that isn't ours.
 */
function syncIosCoreToThisCommit(): string {
  const sha = execFileSync("git", ["-C", CORE_DIR, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["-C", CORE_DIR, "status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  if (dirty) {
    console.warn(
      "skypie: e2e: this checkout has uncommitted changes — the iOS build will " +
        `test HEAD (${sha}), not the working tree. Commit first for a true test.`,
    );
  }
  run("git", ["-C", IOS_CORE_DIR, "fetch", "local"]);
  run("git", ["-C", IOS_CORE_DIR, "checkout", sha]);
  return sha;
}

export interface LaunchIosOptions {
  port: number;
  /** Skip the build (core sync + `build-ios-sim.sh`) — the caller already
   *  did it. Default: build. */
  skipBuild?: boolean;
  /** Extra env vars for the launched app, e.g. `{ SKYPIE_STATE_DIR: dir }`
   *  to point a real simulator run at a seeded scratch state dir —
   *  forwarded the same way the port already is, via `xcrun simctl
   *  launch`'s `SIMCTL_CHILD_` prefix convention (this file's own header
   *  comment). `skypie_ipc::state_dir()` reads `SKYPIE_STATE_DIR`
   *  unconditionally on every target_os, so this works on the simulator
   *  exactly as it does on the desktop debug binary (`launchDesktop`). */
  env?: Record<string, string>;
}

export interface LaunchedIosApp extends AppHandle {
  readonly port: number;
  /** `xcrun simctl io <udid> screenshot` into `ui/e2e/out/<name>.png`
   *  (gitignored) and return the written path. */
  screenshot(name: string): Promise<string>;
}

export async function launchIos(opts: LaunchIosOptions): Promise<LaunchedIosApp> {
  if (!opts.skipBuild) {
    syncIosCoreToThisCommit();
    run(path.join(IOS_SHELL_DIR, "scripts", "build-ios-sim.sh"), [], IOS_SHELL_DIR);
  }
  if (!fs.existsSync(IOS_APP_PATH)) {
    throw new Error(`built, but the bundle is not at ${IOS_APP_PATH}`);
  }

  await ensureBooted();
  run("xcrun", ["simctl", "install", "booted", IOS_APP_PATH]);

  const extraEnv = Object.fromEntries(
    Object.entries(opts.env ?? {}).map(([k, v]) => [`SIMCTL_CHILD_${k}`, v]),
  );
  console.log(`$ xcrun simctl launch --terminate-running-process booted ${BUNDLE_ID} (port ${opts.port})`);
  await execFileAsync(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", "booted", BUNDLE_ID],
    { env: { ...process.env, SIMCTL_CHILD_SKYPIE_E2E_PORT: String(opts.port), ...extraEnv } },
  );

  await waitForPort(opts.port, 30_000);

  const app: LaunchedIosApp = {
    port: opts.port,
    connect: () => net.createConnection({ host: "127.0.0.1", port: opts.port }),
    quit: async () => {
      try {
        execFileSync("xcrun", ["simctl", "terminate", "booted", BUNDLE_ID], { stdio: "ignore" });
      } catch {
        // Already not running — nothing to terminate.
      }
    },
    screenshot: (name) => screenshot(name),
  };
  return app;
}

async function ensureBooted(): Promise<void> {
  try {
    execFileSync("xcrun", ["simctl", "boot", SIMULATOR_UDID], { stdio: "pipe" });
  } catch (e) {
    // "Unable to boot device in current state: Booted" is the expected
    // outcome most of the time on a dev machine — anything else is real.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("current state: Booted")) throw e;
  }
  execFileSync("xcrun", ["simctl", "bootstatus", SIMULATOR_UDID], { stdio: "inherit" });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await canConnect(port)) return;
    if (Date.now() > deadline) {
      throw new Error(`the simulator app never opened TCP :${port} within ${timeoutMs}ms`);
    }
    await sleep(200);
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.end();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

const OUT_DIR = path.resolve(CORE_DIR, "ui", "e2e", "out");

async function screenshot(name: string): Promise<string> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = path.join(OUT_DIR, `${name}.png`);
  run("xcrun", ["simctl", "io", SIMULATOR_UDID, "screenshot", dest]);
  return dest;
}
