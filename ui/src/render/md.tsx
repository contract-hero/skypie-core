// Markdown renderer — marked + lazy shiki for code highlighting + lazy mermaid.
// Markdown may come from anywhere (address bar, deep links, external tabs),
// so raw HTML passthrough is sanitized before entering the host DOM. The
// parsed HTML is injected via DOMParser → importNode (no innerHTML
// assignment).
import * as React from "react";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";
import { useTheme } from "../hooks/useTheme";
import { sanitizeTree } from "./sanitize";
import { blockLines } from "./md-blocks";

// Module-level Marked instance with the KaTeX extension registered once.
// $inline$ and $$block$$ math both render; throwOnError off so a bad
// expression degrades to red TeX source instead of breaking the document.
const md = new Marked(markedKatex({ throwOnError: false, nonStandard: true }));

export interface MdRendererProps {
  source: string;
  path?: string;
  /** Fired after the markdown DOM lands (before async shiki/mermaid passes)
   *  so the host can restore scroll position. */
  onRendered?: () => void;
}

export default function MdRenderer({ source, path, onRendered }: MdRendererProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [shikiReady, setShikiReady] = React.useState(false);
  const theme = useTheme();

  // Intercept link clicks. Markdown renders into the host DOM (not a sandboxed
  // iframe like the HTML renderer), so an un-intercepted click would navigate
  // the whole webview away from the app. Both branches funnel through the same
  // postMessage channels App listens on (mirroring html.tsx's intercept), so
  // the open-in-OS-browser policy stays in one place (App + the opener
  // capability):
  //   - http(s)/mailto → `skypie:openExternal` → OS default browser (Finicky → Chrome)
  //   - file://, absolute, or relative path → `skypie:navigate` → open in-app.
  // `#`/`javascript:` anchors keep their default in-page behavior.
  const onClickCapture = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const raw = a.getAttribute("href") ?? "";
      // Only in-page `#` anchors keep their default behavior. Everything else
      // (including `javascript:`) is intercepted — this renders into the host
      // DOM, so an un-prevented `javascript:` href would execute in the
      // privileged webview, not a sandbox.
      if (!raw || raw.startsWith("#")) return;

      if (/^(https?:|mailto:)/i.test(raw)) {
        e.preventDefault();
        window.postMessage({ type: "skypie:openExternal", url: raw }, "*");
        return;
      }

      const clickMods = {
        meta: e.metaKey || e.ctrlKey,
        shift: e.shiftKey,
        middle: e.button === 1,
      };

      // Any other scheme would otherwise blow away the host webview — block the
      // default and try to resolve it to a local file we can open in-place.
      e.preventDefault();
      let resolved: string | null = null;
      try {
        if (raw.startsWith("file://")) {
          resolved = decodeURIComponent(new URL(raw).pathname);
        } else if (path) {
          const dir = path.slice(0, path.lastIndexOf("/") + 1);
          const u = new URL(raw, `file://${dir}`);
          if (u.protocol === "file:") resolved = decodeURIComponent(u.pathname);
        }
      } catch {
        resolved = null;
      }
      if (resolved) {
        window.postMessage({ type: "skypie:navigate", path: resolved, ...clickMods }, "*");
      }
    },
    [path],
  );

  // Initial render: parse markdown to HTML, then inject via DOMParser+importNode.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;

    // Parsed block by block rather than in one call, so each top-level block
    // can carry the SOURCE line it starts on (`data-source-line`). That
    // attribute is the line-number gutter, the comment tool's target, and
    // the way a stored `line=N` finds its pixel again. The lexer runs once
    // over the whole source — link references resolve globally — and the
    // parser is fed one token at a time with the shared link table.
    //
    // The HTML is then assembled and handled ONCE: one DOMParser, one
    // sanitize walk, one insertion into the live tree. Doing those per block
    // cost a whole Document allocation and a whole tree walk per paragraph,
    // on every live reload of a file that may hold thousands of them.
    const tokens = md.lexer(source, { gfm: true, breaks: false });
    const blocks = blockLines(tokens, source);
    // A COMMENT marker, not a wrapper element. marked emits raw HTML as
    // several tokens — `<details>` opens in one and closes in another — so
    // wrapping each token in a `<div>` closed the element inside the wrong
    // wrapper: the disclosure's body escaped it and rendered always-visible,
    // and a `<table>` split this way swallowed every later block. A comment
    // node nests inside nothing and changes no parse, so the markup the
    // author wrote is assembled exactly as one whole-document parse sees it.
    const html = blocks
      .map(({ token, line }) => {
        const one = Object.assign([token], { links: tokens.links });
        return `<!--vl:${line}-->${md.parser(one)}`;
      })
      .join("");

    const doc = new DOMParser().parseFromString(html, "text/html");
    // Markdown lands in the PRIVILEGED host DOM (Tauri IPC is in scope
    // here), and marked passes raw HTML through unsanitized. DOMParser
    // neuters <script>, but inline `onerror=` handlers and `javascript:`
    // URLs still fire once nodes go live — strip them before importNode
    // below. Same walker the inline-SVG renderer uses.
    sanitizeTree(doc.body);

    // Built off-document: a fragment takes one insertion instead of one per
    // node, so the layout engine sees the whole document once. Each marker
    // names the source line of everything after it until the next marker,
    // and the markers themselves are dropped rather than imported.
    const fragment = document.createDocumentFragment();
    let line = "";
    for (const child of Array.from(doc.body.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        const mark = /^vl:(\d+)$/.exec(child.nodeValue ?? "");
        if (mark) {
          line = mark[1];
          continue;
        }
      }
      const live = document.importNode(child, true);
      if (live instanceof Element && line) live.setAttribute("data-source-line", line);
      fragment.appendChild(live);
    }
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(fragment);

    // Content is in the DOM — let the host restore scroll position.
    onRendered?.();

    (async () => {
      // Shiki async pass for code blocks.
      try {
        const { codeToHtml } = await import("shiki");
        const codeBlocks = Array.from(el.querySelectorAll("pre > code"));
        for (const code of codeBlocks) {
          const lang = (code.className.match(/language-(\w+)/)?.[1] ?? "text").toLowerCase();
          if (lang === "mermaid") continue;
          const raw = code.textContent ?? "";
          try {
            const shikiTheme = theme === "light" ? "github-light" : "github-dark";
            const highlighted = await codeToHtml(raw, { lang, theme: shikiTheme });
            if (cancelled) return;
            const replaced = new DOMParser().parseFromString(highlighted, "text/html").body.firstChild;
            if (replaced && code.parentElement) {
              code.parentElement.replaceWith(document.importNode(replaced, true));
            }
          } catch {
            // unknown language — leave raw.
          }
        }
      } catch {
        // shiki not available; leave raw.
      }

      // Mermaid async pass for ```mermaid``` fences.
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const nodes = Array.from(el.querySelectorAll('pre > code.language-mermaid'));
        for (let i = 0; i < nodes.length; i++) {
          const code = nodes[i];
          const src = code.textContent ?? "";
          try {
            const { svg } = await mermaid.render(`mermaid-${Date.now()}-${i}`, src);
            if (cancelled) return;
            const wrapper = document.createElement("div");
            wrapper.className = "mermaid";
            const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
            // The diagram source is artifact-controlled, so the SVG mermaid
            // hands back is too — a label or a node id can carry markup
            // through. Same walker, same reason as the fragment above and as
            // the inline-SVG renderer: this tree is about to go live in the
            // PRIVILEGED host DOM.
            sanitizeTree(parsed);
            wrapper.appendChild(document.importNode(parsed, true));
            code.parentElement?.replaceWith(wrapper);
          } catch {
            const fallback = document.createElement("pre");
            fallback.setAttribute("data-mermaid-error", "true");
            fallback.textContent = src;
            code.parentElement?.replaceWith(fallback);
          }
        }
      } catch {
        // mermaid not available; leave raw.
      }

      if (!cancelled) setShikiReady(true);
    })();

    return () => { cancelled = true; };
  }, [source, theme]);

  return (
    <div
      data-testid="md-outer"
      style={{ width: "100%" }}
      onClickCapture={onClickCapture}
    >
      {/* The box (width, margin, padding, leading) is in the stylesheet, not
          here: the line-number gutter has to widen the left padding, and an
          inline style would have forced it to shout `!important` over this. */}
      <div
        ref={containerRef}
        data-shiki-ready={shikiReady ? "true" : "false"}
        data-testid="md-content"
      />
    </div>
  );
}
