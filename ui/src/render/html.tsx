// HTML renderer — iframe rendering, scripts ON, full inline CSS/JS/SVG
// support. A `<base href="file://…">` tag is injected so any relative
// links/images/stylesheets resolve against the source file's directory.
//
// The injected script speaks a postMessage protocol with the host. The host
// cannot read into the sandbox, so everything it knows about the rendered
// page arrives this way:
//   iframe → host:  skypie:navigate {path, meta, shift, middle}
//                   skypie:openExternal {url}
//                   skypie:scroll {x, y}           (rAF-throttled)
//                   skypie:keydown {code, key, …}  (global-chord forwarding)
//                   skypie:documentText {text}     (once the page laid out)
//                   skypie:elementPick {css, tag, exact, start, text, …}
//                   skypie:imagePin {css, src, alt, x, y}
//                   skypie:located [{id, top}]     (per scroll frame)
//   host → iframe:  skypie:restoreScroll {x, y}
//                   skypie:setZoom {zoom}
//                   skypie:tool {on}               (the comment tool)
//                   skypie:locate {items}          (anchors to keep located)
//                   skypie:showAnchor {id, css, exact, region, scroll|clear}

import * as React from "react";
import { useTheme } from "../hooks/useTheme";
import { useScrollMemory } from "../state/scroll-memory";

export interface HtmlRendererProps {
  /// Raw HTML source (file bytes decoded as UTF-8).
  source: string;
  /// File path (used to build the <base> tag for relative resources).
  path: string;
  /// Content zoom factor (applied to the iframe's documentElement).
  zoom?: number;
  /// Scroll-memory key; when set, scroll position survives reloads and
  /// tab switches.
  scrollKey?: string;
  /// Untrusted provenance (a beamed / received artifact — authored by
  /// whoever minted the ticket, not the local user). When true the frame is
  /// hardened: the sandbox drops `allow-same-origin` so the content runs in
  /// an opaque origin it cannot escape into the host webview (and thus Tauri
  /// IPC), and no `<base href="file://…">` is injected — remote v1 artifacts
  /// are single-file and have no local resources to resolve. The postMessage
  /// host bridge works unchanged from an opaque origin.
  isolate?: boolean;
}

// Small theme stylesheet injected into the iframe so the iframe's own root
// background follows the host theme. User-authored HTML stays untouched —
// most pages set their own background and the injected rule loses to author
// CSS by specificity (we keep it scoped to `html` with no !important).
function themeStyle(theme: "dark" | "light"): string {
  // Must track --iframe-bg in styles.css: dark is the canvas the reading
  // field sits on, light is white.
  const bg = theme === "dark" ? "#010102" : "#ffffff";
  // The comment anchor and the tool's hover are painted by two fixed boxes
  // the bridge script appends to <html>, outside <body>: the artifact's own
  // tree is never mutated to show feedback on it.
  return `<style>html { background: ${bg}; }</style>`;
}

// Intercepts in-iframe link clicks (the sandboxed iframe can navigate to
// neither file:// nor external http(s)), reports scroll for position memory,
// applies host-driven zoom, and forwards global-shortcut chords the host
// would otherwise never see once the iframe has focus.
const HOST_BRIDGE_SCRIPT = `
<script>
(function () {
  function handler(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var raw = a.getAttribute('href') || '';
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) {
      return;
    }
    var resolved;
    try { resolved = new URL(a.href); } catch (_) { return; }
    if (resolved.protocol === 'file:') {
      e.preventDefault();
      var path;
      try { path = decodeURIComponent(resolved.pathname); } catch (_) { path = resolved.pathname; }
      window.parent.postMessage({
        type: 'skypie:navigate',
        path: path,
        meta: !!(e.metaKey || e.ctrlKey),
        shift: !!e.shiftKey,
        middle: e.button === 1
      }, '*');
    } else if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      e.preventDefault();
      window.parent.postMessage({ type: 'skypie:openExternal', url: resolved.href }, '*');
    }
  }
  document.addEventListener('click', handler, true);
  document.addEventListener('auxclick', handler, true);

  // Scroll reporting (rAF-throttled) for host-side position memory.
  var scrollScheduled = false;
  window.addEventListener('scroll', function () {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(function () {
      scrollScheduled = false;
      window.parent.postMessage({ type: 'skypie:scroll', x: window.scrollX, y: window.scrollY }, '*');
    });
  }, { passive: true });

  // Host-driven scroll restore + zoom.
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'skypie:restoreScroll') {
      window.scrollTo(d.x || 0, d.y || 0);
      // Late layout (images/fonts) can shift content; re-apply once.
      setTimeout(function () { window.scrollTo(d.x || 0, d.y || 0); }, 120);
    } else if (d.type === 'skypie:setZoom') {
      document.documentElement.style.zoom = String(d.zoom || 1);
    }
  });

  // Forward global-shortcut chords to the host. Only tab/nav/zoom/view-mode
  // codes are intercepted (the host ignores anything else — see
  // IFRAME_FORWARDABLE in App.tsx), so in-page ⌘C/⌘V/⌘A keep working and
  // dialog-opening chords (⌘O/⌘L/⌘P) can't be synthesized by page content.
  var FORWARD = {
    KeyT: 1, KeyW: 1, KeyR: 1, KeyB: 1,
    BracketLeft: 1, BracketRight: 1, Equal: 1, Minus: 1,
    Digit0: 1, Digit1: 1, Digit2: 1, Digit3: 1, Digit4: 1,
    Digit5: 1, Digit6: 1, Digit7: 1, Digit8: 1, Digit9: 1
  };
  // ── Comments: the tool, the anchors, and where they are ───────────────
  // The host cannot read into this frame, so three jobs live here: report
  // the rendered text once it is laid out (existing comments re-anchor
  // against it); when the comment tool is on, outline the block under the
  // pointer and report the one the user clicks, with a CSS path only this
  // frame can compute; and keep telling the host where each stored anchor
  // sits on screen, so the margin notes outside the frame stay level with
  // the lines inside it. Offsets are into the RENDERED text
  // (document.body.innerText), not the HTML source: that is the text a
  // human pointed at and the text a re-anchor pass will search.
  function reportDocumentText() {
    window.parent.postMessage({
      type: 'skypie:documentText',
      text: document.body.innerText || ''
    }, '*');
  }
  if (document.readyState === 'complete') reportDocumentText();
  else window.addEventListener('load', reportDocumentText);

  var ACCENT = '#5e6ad2';
  function makeBox(alpha) {
    var el = document.createElement('div');
    el.setAttribute('data-skypie-overlay', '');
    var st = el.style;
    st.position = 'fixed'; st.pointerEvents = 'none'; st.display = 'none';
    st.boxSizing = 'border-box'; st.borderRadius = '4px';
    st.border = '1.5px solid ' + ACCENT;
    st.background = 'rgba(94, 106, 210, ' + alpha + ')';
    st.zIndex = '2147483647';
    document.documentElement.appendChild(el);
    return el;
  }
  var hoverBox = null, anchorBox = null;
  function placeBox(box, rect) {
    if (!rect || rect.width <= 0 && rect.height <= 0) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.style.left = (rect.left - 2) + 'px';
    box.style.top = (rect.top - 2) + 'px';
    box.style.width = (rect.width + 4) + 'px';
    box.style.height = (rect.height + 4) + 'px';
  }

  // The block a click means. Inline runs (a <strong>, a link) belong to the
  // block around them; a replaced element (an image, a drawing) is its own
  // target. Our overlay boxes are never a target.
  var REPLACED = { IMG: 1, SVG: 1, CANVAS: 1, VIDEO: 1 };
  function pickTarget(start) {
    var node = start;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.nodeType === 1) {
        if (node.hasAttribute && node.hasAttribute('data-skypie-overlay')) return null;
        var tag = node.tagName.toUpperCase();
        if (REPLACED[tag]) return node;
        var disp = getComputedStyle(node).display;
        if (disp !== 'inline' && disp !== 'contents') return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  // A path from <body> down, tag:nth-of-type(n) per step, cut short at the
  // nearest unique id. Stable across a re-render that keeps the structure;
  // the quote stored beside it covers the case where it does not.
  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      var tag = node.tagName.toLowerCase();
      var id = node.getAttribute('id');
      if (id && window.CSS && CSS.escape) {
        var sel = '#' + CSS.escape(id);
        try { if (document.querySelectorAll(sel).length === 1) { parts.unshift(sel); break; } } catch (_) {}
      }
      var n = 1, sib = node;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === node.tagName) n++; }
      parts.unshift(tag + ':nth-of-type(' + n + ')');
      node = node.parentNode;
    }
    return parts.join(' > ');
  }

  // Character offset of an element's text in body.innerText: the nearest
  // occurrence to where the element sits in document order.
  function offsetOf(el, exact, text) {
    var before = document.createRange();
    before.setStart(document.body, 0);
    before.setEndBefore(el);
    var approx = before.toString().length;
    if (!exact) return approx;
    var best = -1, from = 0, at;
    while ((at = text.indexOf(exact, from)) !== -1) {
      if (best === -1 || Math.abs(at - approx) < Math.abs(best - approx)) best = at;
      from = at + 1;
    }
    return best === -1 ? approx : best;
  }

  var toolOn = false, hovered = null;
  function setTool(on) {
    toolOn = !!on;
    document.documentElement.style.cursor = toolOn ? 'crosshair' : '';
    if (!toolOn) { hovered = null; if (hoverBox) hoverBox.style.display = 'none'; }
  }
  // rAF-throttled: pickTarget walks ancestors asking for getComputedStyle,
  // and a mousemove fires far more often than the screen repaints.
  var hoverPending = null, hoverScheduled = false;
  function settleHover() {
    hoverScheduled = false;
    if (!toolOn || !hoverPending) return;
    var t = pickTarget(hoverPending);
    hoverPending = null;
    if (t === hovered) return;
    hovered = t;
    if (!hoverBox) hoverBox = makeBox(0.10);
    placeBox(hoverBox, t ? t.getBoundingClientRect() : null);
  }
  window.addEventListener('mousemove', function (e) {
    if (!toolOn) return;
    hoverPending = e.target;
    if (hoverScheduled) return;
    hoverScheduled = true;
    requestAnimationFrame(settleHover);
  }, true);
  // Capture on window, ahead of the page's own handlers and of the link
  // interceptor above: a click with the tool on makes a comment, never a
  // navigation. Only clicks with the tool on are swallowed.
  window.addEventListener('click', function (e) {
    if (!toolOn) return;
    e.preventDefault();
    e.stopPropagation();
    var t = pickTarget(e.target);
    if (!t) return;
    var css = cssPath(t);
    var rect = t.getBoundingClientRect();
    if (t.tagName.toUpperCase() === 'IMG') {
      if (rect.width <= 0 || rect.height <= 0) return;
      window.parent.postMessage({
        type: 'skypie:imagePin',
        css: css,
        src: t.getAttribute('src') || '',
        alt: t.getAttribute('alt') || '',
        x: ((e.clientX - rect.left) / rect.width) * 100,
        y: ((e.clientY - rect.top) / rect.height) * 100
      }, '*');
      return;
    }
    var text = document.body.innerText || '';
    var exact = (t.innerText || t.textContent || '').trim().slice(0, 240);
    window.parent.postMessage({
      type: 'skypie:elementPick',
      css: css,
      tag: t.tagName,
      exact: exact,
      start: offsetOf(t, exact, text),
      text: text,
      top: rect.top,
      height: rect.height
    }, '*');
  }, true);

  // ── Finding a stored anchor again ─────────────────────────────────────
  // The CSS path first, while the structure holds and the element still
  // says roughly what it said; then the quote, found by walking text nodes.
  // Returns an element, a Range, or null.
  function probeOf(exact) { return exact ? exact.replace(/\s+/g, ' ').trim().slice(0, 40) : ''; }
  function resolveAnchor(key) {
    var probe = probeOf(key.exact);
    if (key.css) {
      var el = null;
      try { el = document.querySelector(key.css); } catch (_) { el = null; }
      if (el) {
        if (!probe) return el;
        var own = (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
        if (own.indexOf(probe) !== -1) return el;
      }
    }
    if (!probe) return null;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var value = node.nodeValue || '';
      var at = value.indexOf(probe);
      if (at === -1) { at = value.replace(/\s+/g, ' ').indexOf(probe); if (at === -1) continue; at = Math.min(at, value.length); }
      var r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, Math.min(value.length, at + probe.length));
      return r;
    }
    return null;
  }
  function rectOf(found, region) {
    if (!found) return null;
    var rect = found.getBoundingClientRect();
    // A hidden element measures 0x0 at the origin. Reporting that top as a
    // position would glue the note to the top of the margin and keep it
    // there while the reader scrolls; "not on this page" is the truth, and
    // the host already has a place to show those.
    if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) return null;
    if (region && found.tagName) {
      // A pin: a point inside the image, as a small square around it.
      var x = rect.left + rect.width * (region.x / 100);
      var y = rect.top + rect.height * (region.y / 100);
      return { left: x - 6, top: y - 6, width: 12, height: 12 };
    }
    return rect;
  }

  // Resolving is the expensive half — a querySelector, an innerText read
  // (which forces layout), and on a miss a walk of every text node in the
  // document. The host asks for locations on every scroll frame, where the
  // DOM has not changed at all and only the rects have moved, so each
  // anchor's node is cached and re-resolved only once the document under it
  // actually changes. A miss is cached too: a walk that found nothing costs
  // the most and would otherwise repeat every frame.
  var domGen = 0;
  // documentElement, NOT body: this script runs inside <head>, where
  // document.body is still null and observe() would throw into the catch —
  // leaving domGen frozen at 0 and every cached MISS permanent, so an
  // artifact that builds its body from its own script would strand every
  // comment on it in the unplaced stack forever.
  try {
    new MutationObserver(function () { domGen++; scheduleLocate(); })
      .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } catch (_) {}
  var resolved = {};
  function connected(node) {
    if (!node) return false;
    if (node.nodeType === 1) return node.isConnected;
    return !!(node.startContainer && node.startContainer.isConnected);
  }
  // The id alone is not the key. Annotation ids are unique per target, but
  // the host reuses one id for the target being composed, so a second pick
  // in the same DOM generation would have been answered with the first one's
  // node — the composer level with the wrong paragraph, outlining it too.
  function sigOf(key) {
    return (key.css || '') + '\\u0000' + (key.exact || '') + '\\u0000' +
      (key.region ? key.region.x + ',' + key.region.y : '');
  }
  function anchorNode(key) {
    var sig = sigOf(key);
    var hit = resolved[key.id];
    if (hit && hit.gen === domGen && hit.sig === sig && (hit.node === null || connected(hit.node))) {
      return hit.node;
    }
    var found = resolveAnchor(key);
    resolved[key.id] = { gen: domGen, sig: sig, node: found };
    return found;
  }

  var watched = [];
  var painted = null;
  var locateScheduled = false;
  function reportLocations() {
    locateScheduled = false;
    // Nothing to answer about. The observer above fires throughout the
    // initial parse, and reporting an empty set then would blank the host's
    // positions and flick every note into the unplaced stack until the
    // host's own request arrives.
    if (watched.length === 0 && !painted) return;
    var items = [];
    for (var i = 0; i < watched.length; i++) {
      var w = watched[i];
      var rect = rectOf(anchorNode(w), w.region);
      items.push({ id: w.id, top: rect ? rect.top : null });
    }
    window.parent.postMessage({ type: 'skypie:located', items: items }, '*');
    if (painted) {
      if (!anchorBox) anchorBox = makeBox(0.16);
      placeBox(anchorBox, rectOf(anchorNode(painted), painted.region));
    }
  }
  function scheduleLocate() {
    if (locateScheduled) return;
    locateScheduled = true;
    requestAnimationFrame(reportLocations);
  }
  window.addEventListener('scroll', scheduleLocate, { passive: true });
  window.addEventListener('resize', scheduleLocate);
  window.addEventListener('load', scheduleLocate);

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'skypie:tool') {
      setTool(d.on);
    } else if (d.type === 'skypie:locate') {
      watched = Array.isArray(d.items) ? d.items : [];
      scheduleLocate();
    } else if (d.type === 'skypie:showAnchor') {
      if (d.clear) { painted = null; if (anchorBox) anchorBox.style.display = 'none'; return; }
      painted = { id: d.id, css: d.css, exact: d.exact, region: d.region };
      var found = anchorNode(painted);
      if (found && d.scroll !== false) {
        var el = found.nodeType === 1 ? found : (found.startContainer && found.startContainer.parentElement);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      }
      scheduleLocate();
    }
  });

  window.addEventListener('keydown', function (e) {
    var isChord = e.metaKey || e.ctrlKey;
    // Bare Escape is the one modifier-less key that crosses the bridge. The
    // host binds it only while reader mode or the comment tool is on, and
    // both handlers only leave a mode — neither destroys anything the user
    // typed — so the worst a page-synthesized Escape achieves is putting a
    // mode down. Don't preventDefault: the page may have its own Escape
    // behavior (close a dialog) that should still run.
    if (!isChord) {
      if (e.code !== 'Escape') return;
      window.parent.postMessage({
        type: 'skypie:keydown',
        code: e.code, key: e.key,
        metaKey: false, ctrlKey: false,
        shiftKey: e.shiftKey, altKey: e.altKey
      }, '*');
      return;
    }
    // KeyF only with shift (⇧⌘F reader mode) — plain ⌘F stays with the page.
    var forward = FORWARD[e.code] ||
      (e.code === 'Tab' && e.ctrlKey) ||
      (e.code === 'KeyF' && e.shiftKey);
    if (!forward) return;
    e.preventDefault();
    window.parent.postMessage({
      type: 'skypie:keydown',
      code: e.code,
      key: e.key,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey
    }, '*');
  }, true);
})();
</script>`;

function injectBase(
  html: string,
  basePath: string,
  theme: "dark" | "light",
  includeBase = true,
): string {
  // Strip filename → directory path. Trailing slash matters for <base href>.
  const lastSlash = basePath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? basePath.slice(0, lastSlash + 1) : "";
  // Isolated (remote) content gets NO base tag: an opaque-origin frame cannot
  // load file:// subresources anyway, and v1 beams are single-file.
  const baseTag = includeBase ? `<base href="file://${dir}">` : "";
  const style = themeStyle(theme);
  // Order matters: <base> first (so relative URLs resolve), then theme style
  // (low-specificity background fallback), then the host-bridge script.
  const headPrelude = `${baseTag}\n${style}\n${HOST_BRIDGE_SCRIPT}`;
  const headPreludeNoBase = `${style}\n${HOST_BRIDGE_SCRIPT}`;

  if (/<head[^>]*>/i.test(html)) {
    const inj = !includeBase || /<base\b/i.test(html) ? headPreludeNoBase : headPrelude;
    return html.replace(/(<head[^>]*>)/i, `$1\n${inj}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, `$1\n<head>${headPrelude}</head>`);
  }
  return `<!DOCTYPE html><html><head>${headPrelude}</head><body>${html}</body></html>`;
}

export default function HtmlRenderer({
  source,
  path,
  zoom = 1,
  scrollKey,
  isolate = false,
}: HtmlRendererProps): React.ReactElement {
  const theme = useTheme();
  const memory = useScrollMemory();
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const srcdoc = injectBase(source, path, theme, !isolate);

  // Track the latest zoom/scrollKey without re-running the load listener.
  const zoomRef = React.useRef(zoom);
  zoomRef.current = zoom;
  const scrollKeyRef = React.useRef(scrollKey);
  scrollKeyRef.current = scrollKey;

  // Save scroll positions reported by THIS iframe (source-filtered — stale
  // iframes from closed tabs can still message during teardown).
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { type?: unknown; x?: unknown; y?: unknown };
      if (d?.type === "skypie:scroll" && scrollKeyRef.current) {
        memory.save(scrollKeyRef.current, {
          x: typeof d.x === "number" ? d.x : 0,
          y: typeof d.y === "number" ? d.y : 0,
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [memory]);

  // On every (re)load of the srcdoc: restore scroll + re-apply zoom.
  const onLoad = React.useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    if (zoomRef.current !== 1) {
      win.postMessage({ type: "skypie:setZoom", zoom: zoomRef.current }, "*");
    }
    const key = scrollKeyRef.current;
    const pos = key ? memory.get(key) : undefined;
    if (pos && (pos.x || pos.y)) {
      win.postMessage({ type: "skypie:restoreScroll", x: pos.x, y: pos.y }, "*");
    }
  }, [memory]);

  // Live zoom changes (⌘+/−/0 while the page is showing).
  React.useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "skypie:setZoom", zoom }, "*");
  }, [zoom]);

  // Browser-like sandbox: scripts, popups, forms, modals. `allow-same-origin`
  // on a srcdoc frame keeps the PARENT's origin rather than forcing an opaque
  // one, so the frame is NOT isolated from the host webview — a hostile
  // artifact can reach the parent's globals (and via them, Tauri IPC). That
  // is acceptable for the user's OWN local artifacts, but NOT for untrusted
  // remote content: an isolated frame drops it, running the content in an
  // opaque origin it cannot escape. The postMessage bridge works either way.
  const BASE_SANDBOX =
    "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads";
  const sandbox = isolate ? BASE_SANDBOX : `${BASE_SANDBOX} allow-same-origin`;

  return (
    <div data-testid="html-renderer">
      <iframe
        ref={iframeRef}
        sandbox={sandbox}
        srcDoc={srcdoc}
        title="HTML preview"
        onLoad={onLoad}
      />
    </div>
  );
}
