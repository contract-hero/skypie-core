// The iOS half of the harness. macOS has `app.sock`; the simulator has
// none (`app/src/ipc_server.rs` is `cfg(target_os = "macos")`), so the app
// listens on a loopback TCP port instead when `SKYPIE_E2E_PORT` is set
// (`app/src/e2e.rs::start_tcp_if_configured`) — same JSON-line protocol and
// the same dispatcher, but the listener is handed `Transport::E2eOnly`
// (`app/src/ipc_server.rs`), so this unauthenticated loopback port answers
// the harness and feedback verbs and REFUSES every sharing and pairing verb
// the 0600 unix socket serves. `xcrun simctl launch` forwards env
// vars prefixed `SIMCTL_CHILD_` into the launched process, which is how the
// port reaches the app without a config file.
import { execFileSync, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { promisify } from "node:util";
import { CORE_DIR, SHELL_DIR } from "./app";
import type { AppHandle } from "./app";
import { run, waitUntilConnectable } from "./proc";

const execFileAsync = promisify(execFile);

/** The simulator model the harness targets. `SKYPIE_E2E_SIM` names another
 *  one (`xcrun simctl list devices` prints the names). */
const SIMULATOR_NAME = process.env.SKYPIE_E2E_SIM ?? "iPhone 17 Pro";

/** The last known-good udid on the machine this harness was written on.
 *  Reached only when the listing itself failed (no Xcode, unreadable
 *  output) — a listing that simply lacks the device is a naming problem,
 *  and guessing a udid there would run the tests somewhere unintended. */
const FALLBACK_UDID = "AF4CB22E-8E9F-4E83-ADFC-0FFF70B657FE";

/** Resolve `SIMULATOR_NAME` to a udid, so the harness follows a machine's
 *  own simulator set instead of a literal that only ever matched one Mac.
 *  Memoised and called on demand, not at import: importing this module (as
 *  `tsc` and any tooling does) must not shell out to `xcrun`. */
let cachedUdid: string | null = null;

export function simulatorUdid(): string {
  if (cachedUdid !== null) return cachedUdid;
  let names: string[];
  try {
    const raw = execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" });
    const parsed = JSON.parse(raw) as {
      devices: Record<string, { udid: string; name: string; isAvailable?: boolean }[]>;
    };
    const available = Object.values(parsed.devices)
      .flat()
      .filter((d) => d.isAvailable !== false);
    const hit = available.find((d) => d.name === SIMULATOR_NAME);
    if (hit) {
      cachedUdid = hit.udid;
      return cachedUdid;
    }
    names = available.map((d) => d.name);
  } catch {
    // No Xcode, or an unreadable listing — nothing was learned about this
    // machine's simulators, so the literal is as good a guess as exists.
    console.warn(`cannot list simulators; using ${FALLBACK_UDID}`);
    cachedUdid = FALLBACK_UDID;
    return cachedUdid;
  }
  throw new Error(
    `no available simulator named "${SIMULATOR_NAME}". Available: ${names.join(", ") || "(none)"}. ` +
      "Set SKYPIE_E2E_SIM to one of these.",
  );
}
export const BUNDLE_ID = "ai.skypie.SkyPie";

/** `core` (skypie-desktop's submodule) → the sibling `skypie-ios` repo.
 *  `SKYPIE_IOS_SHELL` overrides it for a checkout kept somewhere else. */
export const IOS_SHELL_DIR =
  process.env.SKYPIE_IOS_SHELL ?? path.resolve(SHELL_DIR, "..", "skypie-ios");
export const IOS_CORE_DIR = path.join(IOS_SHELL_DIR, "core");
export const IOS_APP_PATH = path.join(
  IOS_SHELL_DIR,
  "src-tauri/gen/apple/build/arm64-sim/Sky Pie.app",
);

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

/** `SKYPIE_E2E_SKIP_BUILD=1` — reuse the simulator bundle already built,
 *  skipping the `skypie-ios/core` sync and `build-ios-sim.sh`. An iOS build
 *  is minutes, and iterating on a scenario's ASSERTIONS rebuilds nothing
 *  that matters. Read here, once, so every `launchIos` scenario honours the
 *  same variable instead of each inventing its own. NEVER default on: a
 *  normal run must test HEAD, not whatever was last left in the bundle. */
export const SKIP_BUILD = process.env.SKYPIE_E2E_SKIP_BUILD === "1";

export interface LaunchIosOptions {
  port: number;
  /** Skip the build (core sync + `build-ios-sim.sh`). DEFAULTS to
   *  `SKIP_BUILD` above, so a scenario that never mentions the variable
   *  still honours it — passing it per scenario let a new one ignore the
   *  documented switch silently. Pass `false` to force a build. */
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
  const skipBuild = opts.skipBuild ?? SKIP_BUILD;
  if (!skipBuild) {
    syncIosCoreToThisCommit();
    run(path.join(IOS_SHELL_DIR, "scripts", "build-ios-sim.sh"), [], IOS_SHELL_DIR);
  }
  if (!fs.existsSync(IOS_APP_PATH)) {
    throw new Error(
      skipBuild
        ? `SKYPIE_E2E_SKIP_BUILD is set, but there is no bundle to reuse at ${IOS_APP_PATH}. ` +
          "Run once without it."
        : `built, but the bundle is not at ${IOS_APP_PATH}`,
    );
  }
  if (skipBuild) {
    // A skipped build leaves no other trace in the log, so a run that
    // silently tested a week-old bundle read exactly like a real one. The
    // mtime is the one fact that says WHICH code is under test.
    const built = fs.statSync(IOS_APP_PATH).mtime.toISOString();
    console.warn(
      `skypie: e2e: SKIPPING the iOS build — reusing the bundle built at ${built}. ` +
        "This run does NOT test HEAD.",
    );
  }

  // One device for every step below. `booted` is not a device: with two
  // simulators up, simctl resolves it to whichever one it likes, so an
  // install, a launch and a screenshot could each land on a different
  // device.
  const udid = simulatorUdid();
  await ensureBooted(udid);
  run("xcrun", ["simctl", "install", udid, IOS_APP_PATH]);

  const extraEnv = Object.fromEntries(
    Object.entries(opts.env ?? {}).map(([k, v]) => [`SIMCTL_CHILD_${k}`, v]),
  );
  console.log(`$ xcrun simctl launch --terminate-running-process ${udid} ${BUNDLE_ID} (port ${opts.port})`);
  await execFileAsync(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", udid, BUNDLE_ID],
    { env: { ...process.env, SIMCTL_CHILD_SKYPIE_E2E_PORT: String(opts.port), ...extraEnv } },
  );

  await waitUntilConnectable(
    () => net.createConnection({ host: "127.0.0.1", port: opts.port }),
    `the simulator app's TCP :${opts.port}`,
    30_000,
  );

  const app: LaunchedIosApp = {
    port: opts.port,
    connect: () => net.createConnection({ host: "127.0.0.1", port: opts.port }),
    quit: async () => {
      try {
        execFileSync("xcrun", ["simctl", "terminate", udid, BUNDLE_ID], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (e) {
        // "found nothing to terminate" is the app already being gone, which
        // is what `quit` wanted. Anything else — a device that vanished, a
        // simctl fault — would otherwise leave the app running and the next
        // run guessing.
        const detail = e instanceof Error && "stderr" in e ? String(e.stderr) : String(e);
        if (!detail.includes("found nothing to terminate")) {
          console.warn(`simctl terminate failed: ${detail.trim()}`);
          // A terminate that failed may have left the app alive and still
          // listening. The next scenario would then connect to the OLD
          // process on this fixed port and test a bundle nobody built —
          // passing for the wrong reason. Better to stop here.
          if (await portIsBound(opts.port)) {
            throw new Error(
              `simctl terminate failed and :${opts.port} is still bound — the previous app is ` +
                "still running. Kill it before the next run.",
            );
          }
        }
      }
    },
    screenshot,
  };
  return app;
}

/** Is anything still listening on the harness port? One short connect
 *  attempt — the port is loopback and the answer is immediate either way. */
function portIsBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (bound: boolean): void => {
      socket.destroy();
      resolve(bound);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

async function ensureBooted(udid: string): Promise<void> {
  try {
    execFileSync("xcrun", ["simctl", "boot", udid], { stdio: "pipe" });
  } catch (e) {
    // "Unable to boot device in current state: Booted" is the expected
    // outcome most of the time on a dev machine — anything else is real.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("current state: Booted")) throw e;
    // Already booted, so it has already finished booting: `bootstatus` would
    // only add seconds of polling to a device that is ready right now.
    return;
  }
  execFileSync("xcrun", ["simctl", "bootstatus", udid], { stdio: "inherit" });
}

const OUT_DIR = path.resolve(CORE_DIR, "ui", "e2e", "out");

async function screenshot(name: string): Promise<string> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = path.join(OUT_DIR, `${name}.png`);
  run("xcrun", ["simctl", "io", simulatorUdid(), "screenshot", dest]);
  return dest;
}
