// The JSON-line request/response protocol both of skypie-ipc's transports
// speak (crates/skypie-ipc/src/lib.rs): one line out, one line in, then the
// connection closes. This file is the TypeScript side of that contract —
// there is no code shared with the Rust crate (a Node driver has no business
// linking a Rust one), just the same wire shape kept in sync by hand.
import type { Socket } from "node:net";

export interface Request {
  op: string;
  [key: string]: unknown;
}

export type Response =
  | ({ status: "ok" } & Record<string, unknown>)
  | { status: "err"; message: string };

/**
 * Connect (via `connect`), write one JSON line, read one JSON line, close —
 * matching the "one request per connection" contract on both the macOS unix
 * socket and the iOS TCP listener. `connect` is a factory rather than an
 * open socket because a fresh connection is part of the contract, not
 * incidental — reusing one would leave a half-read connection behind on any
 * caller that does not immediately await the reply.
 */
export function request(
  connect: () => Socket,
  req: Request,
  timeoutMs = 20_000,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = connect();
    let buf = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(new Error(`timed out waiting for a reply to "${req.op}" (${timeoutMs}ms)`));
      });
    }, timeoutMs);

    function finish(run: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    }

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return; // the line isn't complete yet
      const line = buf.slice(0, nl);
      finish(() => {
        socket.end();
        try {
          resolve(JSON.parse(line) as Response);
        } catch {
          reject(new Error(`malformed reply line: ${line}`));
        }
      });
    });

    socket.on("error", (err) => finish(() => reject(err)));
    socket.on("close", () => {
      finish(() => reject(new Error(`connection closed before a reply to "${req.op}"`)));
    });
  });
}
