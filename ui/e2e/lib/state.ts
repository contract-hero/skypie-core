// Helpers every pies scenario (m2, m3, and whatever M4/M5 add) needs: the
// two DOM-input primitives the band and the plate are driven with, and the
// on-disk `pies` document poller. They lived as a copy per scenario, which
// meant two versions of `typeIntoInput` with different error text and two
// `waitForPersistedPies` with different timeouts — the sort of drift a
// shared file exists to prevent. Scenario-SPECIFIC helpers still stay in
// the scenario that uses them.
import * as fs from "node:fs";
import * as path from "node:path";
import { evalIn } from "./app";
import type { AppHandle } from "./app";
import { sleep } from "./proc";

/** Type into a React-controlled `<input>` the native-setter way — a bare
 *  `el.value = "…"` never fires React's own change handler, since React
 *  patches the DOM property setter itself (see ui/e2e/README.md). */
export async function typeIntoInput(app: AppHandle, selector: string, value: string): Promise<void> {
  const js = `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
  const ok = await evalIn(app, js);
  if (!ok) throw new Error(`typeIntoInput: no element matches ${selector}`);
}

/** Dispatch a keydown on `document.activeElement` — component-level key
 *  handling (the band's own onKeyDown, the plate's radiogroup) is driven
 *  this way, not via `keys()`, which dispatches on `document` where only
 *  App's global window-capture registry sees it.
 *
 *  Targets `document.activeElement` rather than a selector because the
 *  harness drives a window that does not hold OS focus: the `:focus`
 *  pseudo-class matches nothing even while `document.activeElement` is the
 *  right element. */
export async function keyOnActiveElement(app: AppHandle, key: string): Promise<void> {
  const js = `(function(){
    var el = document.activeElement;
    if (!el) return false;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true }));
    return true;
  })()`;
  const ok = await evalIn(app, js);
  if (!ok) throw new Error("keyOnActiveElement: document.activeElement is null");
}

/** The slice of `state.json` these scenarios assert on. Deliberately
 *  narrower than the real document: a scenario should fail because a pie
 *  is wrong, not because an unrelated key changed shape. */
export interface OnDiskPies {
  pies?: {
    v?: number;
    pies?: { id: string; name: string; seen_at?: number; members: { path: string }[] }[];
  };
}

export function readStateJson(stateDir: string): OnDiskPies | null {
  const p = path.join(stateDir, "state.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    // A torn read of the debounced writer's tmp+rename is expected and the
    // poll below just retries — but a document that never parses would
    // otherwise time out with no hint of why.
    console.warn(`readStateJson: ${p} did not parse: ${String(err)}`);
    return null;
  }
}

/** Poll the on-disk state document (the debounced writer, ~250ms) until
 *  `predicate` is true of the parsed `pies` document. */
export async function waitForPersistedPies(
  stateDir: string,
  predicate: (doc: NonNullable<OnDiskPies["pies"]>) => boolean,
  timeoutMs = 10_000,
): Promise<NonNullable<OnDiskPies["pies"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const doc = readStateJson(stateDir)?.pies;
    if (doc && predicate(doc)) return doc;
    if (Date.now() > deadline) {
      throw new Error(`state.json's "pies" key never matched within ${timeoutMs}ms (last: ${JSON.stringify(doc)})`);
    }
    await sleep(150);
  }
}
