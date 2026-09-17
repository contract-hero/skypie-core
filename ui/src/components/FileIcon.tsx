// File-type icon mapping via lucide-react.
//
// Glyphs carry SHAPE, never hue. The icon tables used to hold 86 hard-coded
// hex values borrowed from the VS Code / Seti convention — cool blue-greys and
// saturated brand colors that fought the design system on every surface at
// once (tree rows, tabs, quick open, the start page). Per DESIGN.md's Single
// Lamp Rule, warm ember is the only chromatic voice in the product, so every
// glyph now renders in `currentColor` and takes its value from CSS.
//
// One tonal channel survives, and it encodes product meaning rather than
// language trivia: the artifacts this app exists to read (`.html`, `.md`) are
// the SUBJECT tone and sit brighter than everything else in the tree.
import * as React from "react";
import {
  File,
  FileText,
  FileCode,
  FileJson,
  FileType,
  FileImage,
  FileArchive,
  FileVideo,
  FileAudio,
  FileLock,
  FileCog,
  Folder,
  FolderOpen,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { kindOf } from "../render/kind";

/** `subject` = an artifact this app is built to read. Everything else is `plain`. */
export type GlyphTone = "subject" | "plain";

const EXT_MAP: Record<string, LucideIcon> = {
  // Markup / docs
  ".md": FileText,
  ".markdown": FileText,
  ".txt": FileText,
  ".rst": FileText,
  ".pdf": FileText,

  // Web
  ".html": FileCode,
  ".htm": FileCode,
  ".css": FileCode,
  ".scss": FileCode,
  ".sass": FileCode,

  // JS/TS
  ".ts": FileCode,
  ".tsx": FileCode,
  ".js": FileCode,
  ".jsx": FileCode,
  ".mjs": FileCode,
  ".cjs": FileCode,

  // Systems languages
  ".rs": FileCode,
  ".move": FileCode,
  ".go": FileCode,
  ".py": FileCode,
  ".rb": FileCode,
  ".swift": FileCode,
  ".java": FileCode,
  ".kt": FileCode,
  ".c": FileCode,
  ".cpp": FileCode,
  ".h": FileCode,
  ".sh": FileCode,
  ".bash": FileCode,
  ".zsh": FileCode,
  ".sql": FileCode,

  // Data / config
  ".json": FileJson,
  ".jsonc": FileJson,
  ".yml": FileCog,
  ".yaml": FileCog,
  ".toml": FileCog,
  ".ini": FileCog,
  ".env": FileCog,
  ".conf": FileCog,
  ".xml": FileCode,

  // Images
  ".png": FileImage,
  ".jpg": FileImage,
  ".jpeg": FileImage,
  ".gif": FileImage,
  ".webp": FileImage,
  ".bmp": FileImage,
  ".svg": FileImage,
  ".ico": FileImage,

  // Media
  ".mp4": FileVideo,
  ".mov": FileVideo,
  ".webm": FileVideo,
  ".mp3": FileAudio,
  ".wav": FileAudio,
  ".flac": FileAudio,

  // Archives
  ".zip": FileArchive,
  ".tar": FileArchive,
  ".gz": FileArchive,
  ".tgz": FileArchive,
  ".bz2": FileArchive,
  ".7z": FileArchive,

  // Fonts
  ".ttf": FileType,
  ".otf": FileType,
  ".woff": FileType,
  ".woff2": FileType,

  // Locks
  ".lock": FileLock,
  ".lockb": FileLock,
};

const BASENAME_MAP: Record<string, LucideIcon> = {
  "package.json": FileJson,
  "package-lock.json": FileLock,
  "pnpm-lock.yaml": FileLock,
  "yarn.lock": FileLock,
  "Cargo.toml": Settings,
  "Cargo.lock": FileLock,
  "tsconfig.json": Settings,
  "tsconfig.node.json": Settings,
  "vite.config.ts": Settings,
  "tauri.conf.json": Settings,
  ".gitignore": FileCog,
  ".gitattributes": FileCog,
  "Move.toml": Settings,
  "Move.lock": FileLock,
  Dockerfile: Settings,
  Makefile: Settings,
  "README.md": FileText,
  LICENSE: FileText,
};

function lower(s: string): string {
  return s.toLowerCase();
}

// `dot > 0` (not `>= 0`), so a leading-dot basename like ".gitignore" has no
// extension here — kept as the SHAPE lookup below; kind.ts's own `extOf`
// uses `lastIndexOf(".") >= 0` for a different job (the Sky band's kind
// table) and the two never resolve a real extension differently, only the
// dotfile case, which both send to a shape/kind outside the tone-bearing set
// ("plain" here, "other" there) — so swapping the TONE source to `kindOf`
// below is behaviour-neutral even though the two helpers disagree on ".foo".
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? lower(name.slice(dot)) : null;
}

export function iconForFile(name: string): { Icon: LucideIcon; tone: GlyphTone } {
  const ext = extensionOf(name);
  // Tone carries product meaning (html/md are the artifacts this app reads),
  // so it comes from the single kind table rather than its own extension
  // set. The shape below stays on `EXT_MAP`/`BASENAME_MAP`, untouched.
  const k = kindOf(name);
  const tone: GlyphTone = k === "html" || k === "md" ? "subject" : "plain";

  // Exact basename match wins for the shape; the tone still follows the
  // extension, so README.md reads as an artifact like any other .md.
  const direct = BASENAME_MAP[name] || BASENAME_MAP[lower(name)];
  if (direct) return { Icon: direct, tone };

  if (ext) {
    const hit = EXT_MAP[ext];
    if (hit) return { Icon: hit, tone };
  }

  return { Icon: File, tone };
}

export function FileGlyph({ name, size = 17 }: { name: string; size?: number }): React.ReactElement {
  const { Icon, tone } = iconForFile(name);
  return (
    <Icon
      size={size}
      className={tone === "subject" ? "file-glyph is-subject" : "file-glyph"}
      strokeWidth={1.75}
      aria-hidden
    />
  );
}

export function FolderGlyph({
  open,
  size = 17,
}: {
  open: boolean;
  size?: number;
}): React.ReactElement {
  const Icon = open ? FolderOpen : Folder;
  return <Icon size={size} className="folder-glyph" strokeWidth={1.75} aria-hidden />;
}
