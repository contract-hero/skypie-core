// kind.ts — the single file-kind table for the Sky band and its pies.
// Pure, no React import: router.tsx (renderer selection) and FileIcon.tsx
// (glyph tone) both import from here, so the app has exactly one notion of
// "what kind of file is this" instead of three tables that can drift.
//
// Membership is explicit, per the spec (section 9), not derived from
// router.tsx's TEXT_EXTS / IMAGE_EXTS: those two sets overlap on `.svg`
// (which must resolve to "image", the way renderByExtension routes it), and
// `.htm` is accepted by router.tsx's `isHtmlPath` without being a member of
// TEXT_EXTS at all. A single flat table sidesteps both traps by construction
// — each extension lives in exactly one set below.

export type FileKind = "html" | "md" | "code" | "text" | "image" | "data" | "other";

/** Compass order: html always starts at north, then clockwise. Bearings
 *  never change — only the angle each one occupies does (DESIGN.md, "Sky
 *  band"). Every consumer that lays out wedges iterates this array, never a
 *  Set, so the order is never accidentally re-sorted. */
export const BEARINGS: FileKind[] = ["html", "md", "code", "text", "image", "data", "other"];

/** Kinds under this share of a pie's files merge into "other" — the haze
 *  rule that keeps a pie legible instead of a ring of slivers. */
export const HAZE_THRESHOLD = 0.04;

const HTML_EXTS = new Set([".html", ".htm"]);
const MD_EXTS = new Set([".md", ".markdown"]);
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".move", ".rs", ".css", ".sh", ".py", ".go",
]);
const TEXT_EXTS = new Set([".txt"]);
// .svg lands here, not in TEXT_EXTS or CODE_EXTS — it renders as an image
// (renderByExtension routes it to ImageRenderer), so its kind agrees.
const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
]);
const DATA_EXTS = new Set([".json", ".yml", ".yaml", ".toml", ".xml"]);

/** Lowercased extension including the dot (`".html"`), or `""` when there
 *  is none — never throws.
 *
 *  `dot > 0`, not `>= 0`: a leading-dot basename (".gitignore", ".md") is a
 *  NAME, not an extension, which is the rule FileIcon.tsx's glyph lookup
 *  has always used. One parser, so the kind table and the glyph table can
 *  never answer differently for the same filename.
 *
 *  The rule is applied to the BASENAME, not to the whole string: every
 *  caller in derived-pies.ts passes an absolute path, so parsing the whole
 *  path made "/Users/me/.md" report the extension ".md" (a leading-dot NAME)
 *  and "/Users/me/site.v2/README" report ".v2/readme" (a dot in a DIRECTORY
 *  segment). */
export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot).toLowerCase();
}

export function kindOf(path: string): FileKind {
  const ext = extOf(path);
  if (HTML_EXTS.has(ext)) return "html";
  if (MD_EXTS.has(ext)) return "md";
  if (CODE_EXTS.has(ext)) return "code";
  if (TEXT_EXTS.has(ext)) return "text";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (DATA_EXTS.has(ext)) return "data";
  return "other";
}
