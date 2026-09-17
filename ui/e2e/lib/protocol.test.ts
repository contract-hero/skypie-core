// The framing this harness depends on, proved against a real socket rather
// than reasoned about: a reply arrives as bytes, not as a line, and TCP is
// free to split it anywhere. `request` buffers until the newline, so a reply
// cut mid-JSON must still parse — and a connection that closes without one
// must reject instead of hanging until the (70 s) timeout.
//
// Node environment on purpose: this is `node:net`, not DOM.
// @vitest-environment node
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { request } from "./protocol";

const servers: net.Server[] = [];

/** A one-shot server: hand it what to do with the accepted socket, get back
 *  the `connect` thunk `request` takes. */
async function serverThat(onConn: (socket: net.Socket) => void): Promise<() => net.Socket> {
  const server = net.createServer(onConn);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return () => net.createConnection({ host: "127.0.0.1", port });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("request", () => {
  it("reassembles a reply split mid-JSON", async () => {
    const line = `${JSON.stringify({ status: "ok", kind: "e2e_result", value: { n: 2 } })}\n`;
    const connect = await serverThat((socket) => {
      socket.on("data", () => {
        // Deliberately inside the JSON: the first half is not parseable and
        // carries no newline.
        socket.write(line.slice(0, 18));
        setTimeout(() => socket.end(line.slice(18)), 10);
      });
    });

    const res = await request(connect, { op: "e2e_eval", js: "1+1" });
    expect(res).toEqual({ status: "ok", kind: "e2e_result", value: { n: 2 } });
  });

  it("rejects when the connection closes without a reply", async () => {
    const connect = await serverThat((socket) => {
      socket.on("data", () => socket.end());
    });

    await expect(request(connect, { op: "status" })).rejects.toThrow(
      /connection closed before a reply/,
    );
  });

  it("rejects a reply whose status it does not know", async () => {
    const connect = await serverThat((socket) => {
      socket.on("data", () => socket.end(`${JSON.stringify({ kind: "e2e_result" })}\n`));
    });

    await expect(request(connect, { op: "status" })).rejects.toThrow(/no known status/);
  });
});
