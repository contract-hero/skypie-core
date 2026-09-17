// `pnpm -C ui e2e:smoke` — drives the REAL debug macOS app over a scratch
// state dir: launch it, set a fixture workspace as its root (through the
// app's own reactivity, not a re-implementation of it), assert the toolbar
// renders, open a fixture HTML file through the app's own ⌘P palette, assert
// the resulting tab's title, then quit. See ui/e2e/README.md.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { click, keys, launchDesktop, quit, text, waitFor } from "./lib/app";
import { cleanupFixtureWorkspace, makeFixtureWorkspace, setWorkspaceRoot } from "./lib/fixtureWorkspace";

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skypie-e2e-state-"));
  const fixture = makeFixtureWorkspace();
  console.log(`fixture workspace: ${fixture.dir}`);
  console.log(`scratch state dir: ${stateDir}`);

  const app = await launchDesktop({ stateDir });
  try {
    // Generous: the first attempt or two can land before the page has
    // loaded from the dev server and mounted the bridge; `waitFor` retries.
    await waitFor(app, `document.querySelector(".toolbar") !== null`, 60_000);
    console.log("ok: toolbar renders");

    await setWorkspaceRoot(app, fixture.dir);

    await keys(app, "mod+p");
    await waitFor(app, `document.querySelector('[data-testid="quick-open"]') !== null`, 10_000);
    console.log("ok: ⌘P opens quick-open (the fixture root reached the React tree)");

    const rowSelector = `li[title=${JSON.stringify(`${fixture.dir}/report.html`)}]`;
    await waitFor(app, `document.querySelector(${JSON.stringify(rowSelector)}) !== null`, 10_000);
    await click(app, rowSelector);
    console.log("ok: clicked report.html in quick-open");

    await waitFor(app, `document.querySelector(".tab.active .tab-label") !== null`, 10_000);
    const title = await text(app, ".tab.active .tab-label");
    if (title !== "report.html") {
      throw new Error(`expected the active tab's title to be "report.html", got ${JSON.stringify(title)}`);
    }
    console.log(`ok: active tab title is "${title}"`);

    console.log("PASS");
  } finally {
    await quit(app);
    await cleanupFixtureWorkspace(fixture);
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error("FAIL", err);
  process.exitCode = 1;
});
