// Process and socket plumbing shared by both launchers (`./app` for macOS,
// `./ios` for the simulator). They differ in what they start and what they
// dial; they do not differ in how they run a build step or how they wait for
// a listener to answer, so those live here once.
import { execFileSync } from "node:child_process";
import * as net from "node:net";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a step, streaming its output — a silent multi-minute build is
 *  indistinguishable from a hang. Throws on a non-zero exit. */
export function run(cmd: string, args: string[], cwd?: string): void {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

/**
 * Poll until `connect()` produces a socket that actually connects, or throw
 * once `timeoutMs` passes. `connect` is a thunk because each attempt needs a
 * fresh socket, and because the two transports differ only in how one is
 * made (a unix path here, a loopback port there). `label` names the thing
 * being waited for in the failure message.
 */
export async function waitUntilConnectable(
  connect: () => net.Socket,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await canConnect(connect)) return;
    if (Date.now() > deadline) {
      throw new Error(`${label} never answered within ${timeoutMs}ms`);
    }
    await sleep(200);
  }
}

function canConnect(connect: () => net.Socket): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      // One place closes the socket, whichever way this attempt settled —
      // a poll loop that leaks one socket per attempt runs out of
      // descriptors long before its own deadline. A connected probe is
      // ended politely (the app is mid-reply on it and a reset shows up in
      // its log); an unanswered one is torn down.
      if (ok) s.end();
      else s.destroy();
      resolve(ok);
    };
    // A SYN nothing answers (a port a firewall drops, a simulator still
    // booting) would otherwise hold this socket for the OS default, once
    // per poll, for the whole wait.
    s.setTimeout(1_000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
