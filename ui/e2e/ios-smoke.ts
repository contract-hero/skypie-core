// `pnpm -C ui e2e:ios-smoke` — boots the iPhone 17 Pro simulator if needed,
// installs and launches the REAL debug iOS build, evaluates `document.title`
// over the loopback E2E listener, takes a screenshot, and terminates. See
// ui/e2e/README.md — macOS has no equivalent of a window screenshot here, so
// this is the one smoke script that produces a visual artifact.
import { evalIn, quit } from "./lib/app";
import { launchIos } from "./lib/ios";

// Arbitrary, fixed: nothing else on this machine's loopback has a reason to
// claim it, and a fixed port means a stuck previous run is easy to spot
// (`lsof -i :17845`) instead of hunting through a random one.
const E2E_PORT = 17_845;

async function main(): Promise<void> {
  const app = await launchIos({ port: E2E_PORT });
  try {
    const title = await evalIn(app, "document.title");
    if (typeof title !== "string" || title.length === 0) {
      throw new Error(`expected a non-empty document.title, got ${JSON.stringify(title)}`);
    }
    console.log(`ok: document.title = ${JSON.stringify(title)}`);

    const shotPath = await app.screenshot("ios-smoke");
    console.log(`ok: screenshot written to ${shotPath}`);

    console.log("PASS");
  } finally {
    await quit(app);
  }
}

main().catch((err: unknown) => {
  console.error("FAIL", err);
  process.exitCode = 1;
});
