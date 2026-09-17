// The JSON-line request/response protocol both of skypie-ipc's transports
// speak (crates/skypie-ipc/src/lib.rs): one line out, one line in, then the
// connection closes. This file is the TypeScript side of that contract —
// there is no code shared with the Rust crate (a Node driver has no business
// linking a Rust one), just the same wire shape kept in sync by hand.
import type { Socket } from "node:net";

/** The verbs the harness sends. Spelled out rather than `{ op: string }`,
 *  so a typo is a compile error here instead of a "malformed message" reply
 *  from the app. Mirrors `skypie_ipc::Request`. */
export type Request =
  | { op: "e2e_eval"; js: string }
  | { op: "status" }
  /** M5 (agent reach): what an agent client sends. `pie` is a name or an id;
   *  an unmatched NAME creates the pie. Mirrors `Request::AddToPie`. */
  | {
      op: "add_to_pie";
      pie: string;
      path: string;
      origin?: { session_id?: string; prompt_id?: string; cwd?: string };
    };

/** The `Reply::AddedToPie` fields, flattened into the ok arm below. Optional
 *  there rather than a separate arm keyed on `kind`, because the generic ok
 *  arm already carries an open `kind: string` and TypeScript cannot narrow a
 *  literal against it — a caller checks `kind === "added_to_pie"` itself and
 *  then reads these. */
interface AddedToPie {
  pie: string;
  pie_id: string;
  path: string;
  members: number;
  created: boolean;
  added: boolean;
}

/** Mirrors `skypie_ipc::Response`: tagged by `status`, with `Reply`
 *  flattened into the ok arm (hence `kind` and the reply's own fields).
 *  A discriminated union, not an index signature: an index signature makes
 *  a reply with no `status` at all pass the cast, and `evalIn` would then
 *  return `undefined` as a success. */
export type Response =
  | ({ status: "ok"; kind: string; value?: unknown } & Partial<AddedToPie>)
  | { status: "err"; message: string };

/** Accept only the two shapes above. A reply that is neither is the app
 *  speaking a protocol this file does not know, which must be an error, not
 *  a silent `undefined`. */
function parseResponse(line: string): Response {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`reply is not an object: ${line}`);
  }
  const { status, message } = parsed as { status?: unknown; message?: unknown };
  if (status === "ok") return parsed as Response;
  if (status === "err" && typeof message === "string") return { status: "err", message };
  throw new Error(`reply has no known status: ${line}`);
}

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
  // Longer than the app's own `READY_TIMEOUT` (60 s, app/src/e2e.rs): a
  // request that races the page load is held that long on purpose, and
  // giving up first would replace the app's specific answer with a bare
  // client timeout.
  timeoutMs = 70_000,
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
          resolve(parseResponse(line));
        } catch (e) {
          reject(new Error(`malformed reply line: ${line} (${String(e)})`));
        }
      });
    });

    socket.on("error", (err) => finish(() => reject(err)));
    socket.on("close", () => {
      finish(() => reject(new Error(`connection closed before a reply to "${req.op}"`)));
    });
  });
}
