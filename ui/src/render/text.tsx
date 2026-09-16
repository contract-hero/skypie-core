// Text/code renderer — shiki highlighting for known extensions; raw for unknown.
import * as React from "react";
import ShikiBlock from "./shiki-block";

const SHIKI_EXTS: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript",
  ".jsx": "javascript", ".json": "json", ".rs": "rust", ".move": "rust",
  ".toml": "toml", ".yml": "yaml", ".yaml": "yaml", ".css": "css",
  ".html": "html", ".sh": "bash", ".py": "python", ".go": "go",
  ".md": "markdown", ".markdown": "markdown",
};

function langOf(path: string): string | null {
  const i = path.lastIndexOf(".");
  if (i < 0) return null;
  return SHIKI_EXTS[path.slice(i).toLowerCase()] ?? null;
}

export interface TextRendererProps {
  source: string;
  path: string;
}

export default function TextRenderer({ source, path }: TextRendererProps): React.ReactElement {
  const lang = langOf(path);
  if (lang) {
    return <ShikiBlock code={source} lang={lang} />;
  }
  return (
    <pre data-fallback="monospace" style={{ fontFamily: "var(--font-mono)" }}>
      <code>{lineSpans(source)}</code>
    </pre>
  );
}

/**
 * One `<span class="line">` per line, the shape shiki emits, so the gutter
 * and the comment tool treat an unknown file type exactly like a known one.
 */
export function lineSpans(source: string): React.ReactElement[] {
  const lines = source.split("\n");
  // A trailing newline is the end of the last line, not an extra blank one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  // The newline sits BESIDE the span, not inside it. That is the shape shiki
  // emits, and `.line` is `display: inline-block; width: 100%` — a newline
  // inside the box would break the line within it and double every row's
  // height. Callers memoise this; a large file is thousands of elements.
  return lines.map((text, i) => (
    <React.Fragment key={i}>
      <span className="line">{text}</span>
      {"\n"}
    </React.Fragment>
  ));
}
