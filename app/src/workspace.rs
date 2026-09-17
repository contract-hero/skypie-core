// Workspace scanner — enumerates directory entries with lazy expansion.
//
// Public API has two enumeration functions:
//   - `list_workspace_roots`: dirs-only (sidebar's project list view).
//   - `list_dir`: directories and files (project-tree view).
// Both share the same ordering / hidden-grouping / default-ignore semantics.
// (The Scanner keeps per-directory readdir/skip COUNTERS for tests — it does
// not cache directory contents.)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One directory entry returned by the scanner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// File or directory name (final path component, not the full path).
    pub name: String,
    /// Absolute, canonical path to the entry.
    pub path: PathBuf,
    /// True iff the entry resolves to a directory (after following symlinks).
    pub is_dir: bool,
    /// True iff the entry name starts with '.'.
    pub is_hidden: bool,
}

#[derive(Default)]
struct ScannerInner {
    readdir_counts: HashMap<PathBuf, usize>,
    /// C2 (CF3): number of per-entry errors logged-and-skipped during the
    /// most recent `list_dir` against each canonical directory.
    skip_counts: HashMap<PathBuf, usize>,
}

/// Stateful scanner that caches readdir results by canonical absolute path.
pub struct Scanner {
    inner: Mutex<ScannerInner>,
}

impl Scanner {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ScannerInner::default()),
        }
    }

    /// Enumerate the workspace root's *directory* children only. Files at the
    /// workspace root are skipped (the sidebar surfaces projects only).
    pub fn list_workspace_roots(&self, dir: &Path) -> Result<Vec<Entry>, ScanError> {
        let all = self.list_dir(dir)?;
        Ok(all.into_iter().filter(|e| e.is_dir).collect())
    }

    /// List the immediate (depth-1) children of `dir`.
    pub fn list_dir(&self, dir: &Path) -> Result<Vec<Entry>, ScanError> {
        let canonical = canonicalize(dir)?;

        let meta = std::fs::metadata(&canonical).map_err(|source| ScanError::Io {
            path: canonical.clone(),
            reason: source.to_string(),
        })?;
        if !meta.is_dir() {
            return Err(ScanError::NotADirectory(canonical));
        }

        let read_iter = std::fs::read_dir(&canonical).map_err(|source| ScanError::Io {
            path: canonical.clone(),
            reason: source.to_string(),
        })?;

        let mut entries = Vec::new();
        let mut skip_count = 0usize;

        for raw in read_iter {
            // CF3: log and skip per-entry I/O errors instead of aborting.
            let raw = match raw {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("skypie: list_dir skip error in {:?}: {}", canonical, e);
                    skip_count += 1;
                    continue;
                }
            };

            let name = raw.file_name().to_string_lossy().into_owned();

            if DEFAULT_IGNORED.contains(&name.as_str()) {
                continue;
            }

            let entry_path = raw.path();
            let is_hidden = name.starts_with('.');

            let resolved_meta = std::fs::metadata(&entry_path);

            // CF3: skip entries whose metadata is unreadable (e.g. chmod 000 dirs).
            let is_dir = match &resolved_meta {
                Ok(m) => m.is_dir(),
                Err(e) => {
                    eprintln!("skypie: list_dir skip entry {:?}: {}", entry_path, e);
                    skip_count += 1;
                    continue;
                }
            };

            let canonical_path = entry_path
                .canonicalize()
                .unwrap_or_else(|_| entry_path.clone());

            entries.push(Entry {
                name,
                path: canonical_path,
                is_dir,
                is_hidden,
            });
        }

        entries.sort_by(|a, b| match (a.is_hidden, b.is_hidden) {
            (false, true) => std::cmp::Ordering::Less,
            (true, false) => std::cmp::Ordering::Greater,
            _ => a
                .name
                .to_lowercase()
                .cmp(&b.name.to_lowercase()),
        });

        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        *inner.readdir_counts.entry(canonical.clone()).or_insert(0) += 1;
        inner.skip_counts.insert(canonical, skip_count);

        Ok(entries)
    }

    /// Number of `readdir` calls issued for `dir` so far in this session.
    pub fn readdir_count_for(&self, dir: &Path) -> usize {
        let canonical = canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        *self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .readdir_counts
            .get(&canonical)
            .unwrap_or(&0)
    }

    /// C2 (CF3): number of per-entry errors logged-and-skipped during the
    /// most recent `list_dir` against `dir`. Used by T-013.
    pub fn last_skip_count_for(&self, dir: &Path) -> usize {
        let canonical = canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        *self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .skip_counts
            .get(&canonical)
            .unwrap_or(&0)
    }
}

impl Default for Scanner {
    fn default() -> Self {
        Self::new()
    }
}

fn canonicalize(path: &Path) -> Result<PathBuf, ScanError> {
    path.canonicalize().map_err(|source| ScanError::Io {
        path: path.to_path_buf(),
        reason: source.to_string(),
    })
}

#[derive(Debug, thiserror::Error, Serialize, Deserialize)]
pub enum ScanError {
    /// C2 (CF6): Io variant carries a `String` so the type is `Serialize`
    /// — `std::io::Error` is not `Serialize`.
    #[error("io error at {path:?}: {reason}")]
    Io {
        path: PathBuf,
        reason: String,
    },
    #[error("not a directory: {0:?}")]
    NotADirectory(PathBuf),
}

/// Default-ignored directory names filtered out during expansion. Defined in
/// `skypie-remote` and re-exported here so one list serves the local scanner
/// and the crate that owns it; two copies would drift.
pub use skypie_remote::DEFAULT_IGNORED;

/// Cap on entries returned by `list_files_recursive`. BFS order means the
/// shallowest paths survive truncation — better quick-open hits.
pub const MAX_INDEX_ENTRIES: usize = 20_000;

/// Flat recursive file index for the quick-open (⌘P) palette.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileIndex {
    /// Canonical root the entries are relative to.
    pub root: PathBuf,
    /// '/'-separated paths relative to `root`, in BFS (shallow-first) order.
    pub files: Vec<String>,
    /// True iff the walk stopped at the entry cap.
    pub truncated: bool,
}

/// Walk `root` breadth-first and return every file as a root-relative path.
/// Skips `DEFAULT_IGNORED` names, hidden *directories* (dot-dirs are
/// machinery), and symlinks (loop safety); keeps hidden *files* (dotfiles
/// are often artifacts). Per-entry I/O errors are logged and skipped.
pub fn list_files_recursive(root: &Path) -> Result<FileIndex, ScanError> {
    walk_files(root, MAX_INDEX_ENTRIES)
}

fn walk_files(root: &Path, cap: usize) -> Result<FileIndex, ScanError> {
    let canonical = canonicalize(root)?;
    let mut files = Vec::new();
    let truncated = bfs_walk(&canonical, cap, &mut |entry| {
        let path = entry.path();
        let rel = path
            .strip_prefix(&canonical)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string_lossy().into_owned());
        files.push(rel);
        true
    });

    Ok(FileIndex {
        root: canonical,
        files,
        truncated,
    })
}

/// The per-entry walk policy shared by `list_files_recursive` (⌘P's flat
/// index) and `pie_census` (M3's folder layers): `DEFAULT_IGNORED` skip,
/// hidden-*directory* skip (hidden *files* are kept — dotfiles are often
/// artifacts), symlinks never followed (loop safety — a symlinked artifact
/// can still be opened via ⌘O), per-entry I/O errors logged and skipped
/// rather than aborting the walk, BFS order (shallowest paths survive
/// truncation). `root` must already be resolved the way the caller needs
/// (canonical for `list_files_recursive`, a pie member's already-canonical
/// path for `pie_census`) — this function does not canonicalize it.
///
/// `visit` is called once per FILE found, in BFS order, and is handed the
/// raw `DirEntry` so it can decide for itself what it needs: the quick-open
/// index reads only `entry.path()`, while the census also calls
/// `entry.metadata()` for mtime/size. Handing over the entry rather than a
/// pre-`stat`ed `Metadata` is what keeps `list_files_recursive` at ONE
/// syscall per file — a second `stat` on all 20,000 quick-open entries was
/// pure waste for a caller that never looks at the result.
///
/// `visit` returns whether the entry COUNTED against `cap`: the census
/// answers `false` for a path it drops as a duplicate, so the budget always
/// measures files actually reported, never work merely attempted. Returns
/// `true` iff the walk stopped because `cap` was reached — i.e. some entries
/// under `root` were never visited.
fn bfs_walk(root: &Path, cap: usize, visit: &mut impl FnMut(&std::fs::DirEntry) -> bool) -> bool {
    use std::collections::VecDeque;

    let mut queue: VecDeque<PathBuf> = VecDeque::from([root.to_path_buf()]);
    let mut count = 0usize;
    let mut truncated = false;

    'walk: while let Some(dir) = queue.pop_front() {
        let read_iter = match std::fs::read_dir(&dir) {
            Ok(it) => it,
            Err(e) => {
                eprintln!("skypie: walk skip dir {dir:?}: {e}");
                continue;
            }
        };
        for raw in read_iter {
            let raw = match raw {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("skypie: walk skip entry in {dir:?}: {e}");
                    continue;
                }
            };
            let name = raw.file_name().to_string_lossy().into_owned();
            if DEFAULT_IGNORED.contains(&name.as_str()) {
                continue;
            }
            // file_type() does NOT follow symlinks — skip them entirely for
            // loop safety (a symlinked artifact can still be opened via ⌘O).
            let file_type = match raw.file_type() {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("skypie: walk skip entry {:?}: {e}", raw.path());
                    continue;
                }
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if !name.starts_with('.') {
                    queue.push_back(raw.path());
                }
                continue;
            }
            if count >= cap {
                truncated = true;
                break 'walk;
            }
            if visit(&raw) {
                count += 1;
            }
        }
    }

    truncated
}

/// One file found while walking a pie's members (M3, spec sections 6/9).
/// Deliberately carries NO `kind` — `kindOf` (`ui/src/render/kind.ts`)
/// stays the single kind table; the TS layer (`pie-census.ts`) adds `kind`
/// when it adapts this into a `DerivedPieFile`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CensusFile {
    pub path: PathBuf,
    /// `metadata.modified()` converted to ms epoch — every timestamp `Pie`/
    /// `PieMember` (`pies.rs`) carries is already ms, so mtime matches on
    /// the same clock.
    pub mtime: u64,
    pub size: u64,
    /// The folder MEMBER this file was found under — always that member's
    /// own (already-canonical) path, never an intermediate subdirectory.
    /// `None` for a direct FILE member. `skip_serializing_if` (the same
    /// convention `pies.rs`'s `PieMember::source`/`origin` use) so the wire
    /// OMITS the key rather than sending `null` — the TS side declares this
    /// `folder?: string`, and an omitted key is what `?:` actually means.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<PathBuf>,
}

/// The result of walking one pie's members (spec section 9's `PieCensus`,
/// with `outside_root` added — the spec text predates M3's "not live"
/// caption for members outside the workspace root, spec section 6).
///
/// The spec also lists a `fresh` count, which this deliberately does NOT
/// serve. Freshness is `mtime > seen_at`, and the CLIENT moves `seen_at`
/// before the backend does: `usePies.touchPieSeen` bumps it to `Date.now()`
/// optimistically the instant a plate opens, which is what clears the pill
/// with no round trip. A server-computed count is therefore measured
/// against whatever `seen_at` was true when the census ran, and can already
/// be wrong by the time it is rendered — so `pie-census.ts`'s `freshCount`
/// recomputes it from `files` against the pie's CURRENT `seen_at`, and one
/// authority beats two that disagree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PieCensus {
    pub files: Vec<CensusFile>,
    /// Member paths (file or folder) that no longer resolve: a deleted
    /// file, or a folder that is gone or no longer a directory. A renamed
    /// folder lands here too — the watcher sees a rename as `Remove` for
    /// the OLD path only (`watcher.rs`), so from the census's point of view
    /// a renamed folder member is indistinguishable from a deleted one;
    /// both read as "folder not found" in the plate (Locate…/Forget).
    pub missing: Vec<PathBuf>,
    /// Member paths not under the canonical workspace root — captioned
    /// "not live" in the plate (spec section 6): these only refresh on sky
    /// show / plate open, never from the live watcher, which is
    /// `NonRecursive` and only covers individually-opened external files.
    /// Every member is outside_root when `root` is `None` (no workspace
    /// open) — nothing can be "live" with no workspace root to be live
    /// against.
    pub outside_root: Vec<PathBuf>,
    pub truncated: bool,
    /// Index into the `members` slice of the member that was cut by the
    /// 20,000 cap — the member being walked when the budget ran out, or
    /// the first member never reached at all when an earlier member
    /// exactly filled the budget. `None` unless `truncated`; omitted on
    /// the wire rather than sent as `null` (see `CensusFile::folder`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated_at: Option<usize>,
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `path` is under `root` on a SEGMENT boundary — `Path::strip_prefix`
/// already compares by component rather than by raw string, so `/foo/bar`
/// is not "under" `/foo/barbaz`. `path` is a member's already-canonical
/// path (`pies::add_member` canonicalizes on the way in); `root` must be
/// canonical too (the caller resolves it before calling this). No root at
/// all means nothing can be "under" it.
fn is_under_root(path: &Path, root: Option<&Path>) -> bool {
    match root {
        Some(root) => path == root || path.strip_prefix(root).is_ok(),
        None => false,
    }
}

/// Walk a pie's members and report every file — spec sections 6 and 9
/// (freshness is the client's, see `PieCensus`). Members are walked in
/// STORED order; a folder member's
/// contents come from `bfs_walk` (the same per-entry policy
/// `list_files_recursive` uses), so `DEFAULT_IGNORED`/hidden-dir/symlink
/// rules are identical between ⌘P's index and a pie's folder layers. `root`
/// is the current workspace root (or `None` when no workspace is open) —
/// used only to classify `outside_root`, never to refuse walking a member;
/// a folder outside the root is still walked, just captioned differently by
/// the UI (spec section 6: "not live", refreshed on show/plate-open only).
pub fn pie_census(members: &[crate::pies::PieMember], root: Option<&Path>) -> PieCensus {
    census_with_cap(members, root, MAX_INDEX_ENTRIES)
}

/// `pie_census` with an injectable cap — `census_tests` below exercises the
/// cap/`truncated_at` behavior against a handful of fixture files rather
/// than actually writing 20,000 of them.
fn census_with_cap(
    members: &[crate::pies::PieMember],
    root: Option<&Path>,
    cap: usize,
) -> PieCensus {
    let canonical_root = root.and_then(|r| r.canonicalize().ok());

    let mut files: Vec<CensusFile> = Vec::new();
    let mut missing: Vec<PathBuf> = Vec::new();
    let mut outside_root: Vec<PathBuf> = Vec::new();
    let mut truncated = false;
    let mut truncated_at: Option<usize> = None;

    // Every path already reported. One pie can reach the same file by more
    // than one route, and this set is the only thing that keeps it to ONE
    // row: a file that is both a direct FILE member and inside a FOLDER
    // member of the same pie, and two OVERLAPPING folder members (a pie
    // holding both `/x` and its own subfolder `/x/y` — `pies::add_member`
    // dedupes exact member paths only), which no member-vs-member
    // comparison catches because the second route is a nested directory,
    // not a member. A duplicate double-counted the plate readout and
    // collided two rows onto one navigation slot in the UI. The FIRST
    // route to reach a file wins, so the row is tagged with the member the
    // stored order reaches first.
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    for (idx, member) in members.iter().enumerate() {
        if !is_under_root(&member.path, canonical_root.as_deref()) {
            outside_root.push(member.path.clone());
        }

        // Checked BEFORE processing this member (file or folder) — the cap
        // is a TOTAL across the whole pie, and once it is reached no later
        // member is walked at all (spec section 6).
        if files.len() >= cap {
            truncated = true;
            truncated_at = Some(idx);
            break;
        }

        match member.kind {
            crate::pies::PieMemberKind::File => {
                if seen.contains(&member.path) {
                    // An earlier folder member's walk already reported it —
                    // skip entirely (not `missing`, not `files`).
                    continue;
                }
                match std::fs::metadata(&member.path) {
                    Ok(meta) if meta.is_file() => {
                        seen.insert(member.path.clone());
                        files.push(CensusFile {
                            path: member.path.clone(),
                            mtime: mtime_ms(&meta),
                            size: meta.len(),
                            folder: None,
                        });
                    }
                    _ => missing.push(member.path.clone()),
                }
            }
            crate::pies::PieMemberKind::Folder => match std::fs::metadata(&member.path) {
                Ok(meta) if meta.is_dir() => {
                    // > 0: the cap check above already returned early when
                    // `files.len() >= cap`, so there is always budget left
                    // here.
                    let budget = cap - files.len();
                    let folder_path = member.path.clone();
                    let hit_cap = bfs_walk(&member.path, budget, &mut |entry| {
                        let path = entry.path();
                        if seen.contains(&path) {
                            // Another member already reported this file —
                            // `false` so it does not spend the budget either.
                            return false;
                        }
                        // The census is the only caller that needs more
                        // than the path, so it is the only one that pays
                        // for the extra stat.
                        let meta = match entry.metadata() {
                            Ok(m) => m,
                            Err(e) => {
                                eprintln!("skypie: census skip entry {path:?}: {e}");
                                return false;
                            }
                        };
                        files.push(CensusFile {
                            path: path.clone(),
                            mtime: mtime_ms(&meta),
                            size: meta.len(),
                            folder: Some(folder_path.clone()),
                        });
                        seen.insert(path);
                        true
                    });
                    if hit_cap {
                        truncated = true;
                        truncated_at = Some(idx);
                        break;
                    }
                }
                _ => missing.push(member.path.clone()),
            },
        }
    }

    PieCensus {
        files,
        missing,
        outside_root,
        truncated,
        truncated_at,
    }
}

#[cfg(test)]
mod walk_tests {
    use super::*;
    use tempfile::TempDir;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
    }

    #[test]
    fn returns_relative_paths() {
        let dir = TempDir::new().unwrap();
        touch(&dir.path().join("a.html"));
        touch(&dir.path().join("sub/b.md"));

        let idx = list_files_recursive(dir.path()).unwrap();
        let mut files = idx.files.clone();
        files.sort();
        assert_eq!(files, vec!["a.html", "sub/b.md"]);
        assert!(!idx.truncated);
    }

    #[test]
    fn ignored_dirs_are_excluded() {
        let dir = TempDir::new().unwrap();
        touch(&dir.path().join("keep.ts"));
        touch(&dir.path().join("node_modules/dep/index.js"));
        touch(&dir.path().join(".git/HEAD"));

        let idx = list_files_recursive(dir.path()).unwrap();
        assert_eq!(idx.files, vec!["keep.ts"]);
    }

    #[test]
    fn truncates_at_cap() {
        let dir = TempDir::new().unwrap();
        for i in 0..5 {
            touch(&dir.path().join(format!("f{i}.txt")));
        }

        let idx = walk_files(dir.path(), 3).unwrap();
        assert_eq!(idx.files.len(), 3);
        assert!(idx.truncated);
    }

    #[test]
    fn truncation_keeps_shallow_paths_bfs() {
        // The BFS order is the design goal: shallow paths must survive
        // truncation (better quick-open hits). A depth-first walk would pass
        // the flat truncates_at_cap test above but fail this one.
        let dir = TempDir::new().unwrap();
        touch(&dir.path().join("a.txt"));
        touch(&dir.path().join("b.txt"));
        touch(&dir.path().join("deep/d1.txt"));
        touch(&dir.path().join("deep/deeper/d2.txt"));

        let idx = walk_files(dir.path(), 3).unwrap();
        assert!(idx.truncated);
        assert!(idx.files.contains(&"a.txt".to_string()));
        assert!(idx.files.contains(&"b.txt".to_string()));
        assert!(
            !idx.files.iter().any(|f| f.starts_with("deep/deeper/")),
            "deepest path must be the one truncated away"
        );
    }

    #[test]
    fn hidden_dirs_skipped_hidden_files_kept() {
        let dir = TempDir::new().unwrap();
        touch(&dir.path().join(".claude/settings.json"));
        touch(&dir.path().join(".env"));
        touch(&dir.path().join("visible.md"));

        let idx = list_files_recursive(dir.path()).unwrap();
        let mut files = idx.files.clone();
        files.sort();
        assert_eq!(files, vec![".env", "visible.md"]);
    }

    #[test]
    fn symlinked_dirs_not_followed() {
        let dir = TempDir::new().unwrap();
        touch(&dir.path().join("real/file.txt"));
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("loop")).unwrap();

        let idx = list_files_recursive(dir.path()).unwrap();
        assert_eq!(idx.files, vec!["real/file.txt"]);
    }
}

/// `pie_census` tests — pure, over `tempfile::TempDir` only. Deliberately do
/// NOT touch `state_store` (unlike `pies.rs::tests`, which serialize on
/// their own lock + `ensure_shared_test_state_dir` because they mutate the
/// process-global state document) — `census_with_cap` takes its members as
/// a plain slice, so these run fully parallel-safe.
#[cfg(test)]
mod census_tests {
    use super::*;
    use crate::pies::{PieMember, PieMemberKind};
    use std::time::{Duration, UNIX_EPOCH};
    use tempfile::TempDir;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
    }

    fn member(kind: PieMemberKind, path: &Path) -> PieMember {
        PieMember {
            kind,
            path: path.to_path_buf(),
            added_at: 0,
            source: None,
            origin: None,
            rest: Default::default(),
        }
    }

    /// Deterministic mtimes — real filesystem timestamps have too coarse a
    /// resolution (and a real `sleep` between writes is flaky in CI) to
    /// assert against, so every test that reads an mtime back stamps its
    /// fixture files explicitly instead.
    fn set_mtime(path: &Path, ms: u64) {
        let time = UNIX_EPOCH + Duration::from_millis(ms);
        std::fs::File::open(path).unwrap().set_modified(time).unwrap();
    }

    #[test]
    fn cap_order_and_truncated_at_points_at_the_member_cut_mid_walk() {
        let dir = TempDir::new().unwrap();
        let folder_a = dir.path().join("a");
        let folder_b = dir.path().join("b");
        for i in 0..3 {
            touch(&folder_a.join(format!("f{i}.txt")));
        }
        for i in 0..3 {
            touch(&folder_b.join(format!("g{i}.txt")));
        }
        let members = vec![
            member(PieMemberKind::Folder, &folder_a),
            member(PieMemberKind::Folder, &folder_b),
        ];
        // Cap smaller than folder_a's own file count: the walk stops
        // PARTWAY through the first member, which is the one truncated_at
        // must point at — the second member is never reached.
        let census = census_with_cap(&members, None, 2);
        assert!(census.truncated);
        assert_eq!(census.truncated_at, Some(0));
        assert_eq!(census.files.len(), 2);
        assert!(
            census.files.iter().all(|f| f.folder.as_deref() == Some(folder_a.as_path())),
            "no file from the second, unwalked member should appear: {:?}",
            census.files,
        );
    }

    #[test]
    fn cap_exactly_filled_by_one_member_cuts_the_next_one_instead() {
        let dir = TempDir::new().unwrap();
        let folder_a = dir.path().join("a");
        let folder_b = dir.path().join("b");
        touch(&folder_a.join("f0.txt"));
        touch(&folder_a.join("f1.txt"));
        touch(&folder_b.join("g0.txt"));
        let members = vec![
            member(PieMemberKind::Folder, &folder_a),
            member(PieMemberKind::Folder, &folder_b),
        ];
        let census = census_with_cap(&members, None, 2);
        assert!(census.truncated);
        assert_eq!(
            census.truncated_at,
            Some(1),
            "member 0 exactly filled the budget; member 1 is the one cut, not member 0",
        );
        assert_eq!(census.files.len(), 2);
    }

    #[test]
    fn a_missing_folder_member_is_reported_missing_not_an_error() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("gone");
        let members = vec![member(PieMemberKind::Folder, &missing)];

        let census = census_with_cap(&members, None, MAX_INDEX_ENTRIES);

        assert_eq!(census.missing, vec![missing]);
        assert!(census.files.is_empty());
        assert!(!census.truncated);
    }

    #[test]
    fn a_file_under_a_folder_member_of_the_same_pie_is_reported_once() {
        // A file that is both a direct FILE member and inside a FOLDER
        // member of the same pie used to be reported twice — once from the
        // folder's `bfs_walk`, once from the File-member branch.
        let dir = TempDir::new().unwrap();
        let folder = dir.path().join("docs");
        let nested = folder.join("readme.md");
        touch(&nested);
        let members = vec![
            member(PieMemberKind::Folder, &folder),
            member(PieMemberKind::File, &nested),
        ];

        let census = census_with_cap(&members, None, MAX_INDEX_ENTRIES);

        assert_eq!(
            census.files.iter().filter(|f| f.path == nested).count(),
            1,
            "a file inside a folder member must not also be counted as a direct file member",
        );
        // Order of members must not matter — the file listed BEFORE its
        // folder is deduped the same way.
        let reordered = vec![
            member(PieMemberKind::File, &nested),
            member(PieMemberKind::Folder, &folder),
        ];
        let census2 = census_with_cap(&reordered, None, MAX_INDEX_ENTRIES);
        assert_eq!(census2.files.iter().filter(|f| f.path == nested).count(), 1);
    }

    #[test]
    fn a_file_member_carries_real_mtime_and_size() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "hello").unwrap();
        set_mtime(&file, 1_700_000_000_000);
        let members = vec![member(PieMemberKind::File, &file)];

        let census = census_with_cap(&members, None, MAX_INDEX_ENTRIES);

        assert_eq!(census.files.len(), 1);
        let f = &census.files[0];
        assert_eq!(f.path, file);
        assert_eq!(f.size, 5);
        assert_eq!(f.mtime, 1_700_000_000_000);
        assert_eq!(f.folder, None);
    }

    #[test]
    fn a_folder_walked_file_carries_real_mtime_size_and_its_member_tag() {
        // The folder branch reads its metadata from the `DirEntry` the walk
        // already holds, a different code path from the FILE branch's own
        // `std::fs::metadata` above — so it needs its own assertion that
        // the numbers arrive intact.
        let dir = TempDir::new().unwrap();
        let folder = dir.path().join("docs");
        let nested = folder.join("note.txt");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&nested, "hello").unwrap();
        set_mtime(&nested, 1_700_000_000_000);
        let members = vec![member(PieMemberKind::Folder, &folder)];

        let census = census_with_cap(&members, None, MAX_INDEX_ENTRIES);

        assert_eq!(census.files.len(), 1);
        let f = &census.files[0];
        assert_eq!(f.path, nested);
        assert_eq!(f.size, 5);
        assert_eq!(f.mtime, 1_700_000_000_000);
        assert_eq!(f.folder.as_deref(), Some(folder.as_path()));
    }

    #[test]
    fn two_overlapping_folder_members_report_each_shared_file_once() {
        // `pies::add_member` dedupes exact member paths only, so a pie can
        // hold both `/x` and its own subfolder `/x/y`. No member-vs-member
        // comparison catches that overlap — only the census's own `seen`
        // set does.
        let dir = TempDir::new().unwrap();
        let outer = dir.path().join("outer");
        let inner = outer.join("inner");
        let shared = inner.join("a.txt");
        touch(&shared);
        let members = vec![
            member(PieMemberKind::Folder, &outer),
            member(PieMemberKind::Folder, &inner),
        ];

        let census = census_with_cap(&members, None, MAX_INDEX_ENTRIES);

        assert_eq!(census.files.len(), 1, "got {:?}", census.files);
        assert_eq!(
            census.files[0].folder.as_deref(),
            Some(outer.as_path()),
            "the FIRST member to reach the file tags it",
        );
    }

    #[test]
    fn a_deduped_file_does_not_spend_the_entry_budget() {
        // `bfs_walk`'s budget must measure files REPORTED, not entries
        // looked at: a cap of 2 over a pie whose two folder members overlap
        // on one file still has room for the second member's own file.
        let dir = TempDir::new().unwrap();
        let outer = dir.path().join("outer");
        let inner = outer.join("inner");
        touch(&inner.join("shared.txt"));
        let other = dir.path().join("other");
        touch(&other.join("b.txt"));
        let members = vec![
            member(PieMemberKind::Folder, &outer),
            member(PieMemberKind::Folder, &inner),
            member(PieMemberKind::Folder, &other),
        ];

        let census = census_with_cap(&members, None, 2);

        assert_eq!(census.files.len(), 2, "got {:?}", census.files);
        assert!(!census.truncated);
    }

    #[test]
    fn a_missing_or_wrong_type_file_member_is_reported_missing() {
        // A `kind: File` member whose path is gone, or resolves to a
        // directory, must land in `missing` and never in `files` — only the
        // missing-FOLDER case had coverage before.
        let dir = TempDir::new().unwrap();
        let gone = dir.path().join("gone.txt");
        let a_directory = dir.path().join("actually-a-dir");
        std::fs::create_dir_all(&a_directory).unwrap();
        let members = vec![
            member(PieMemberKind::File, &gone),
            member(PieMemberKind::File, &a_directory),
        ];

        let census = census_with_cap(&members, None, MAX_INDEX_ENTRIES);

        assert_eq!(census.missing, vec![gone, a_directory]);
        assert!(census.files.is_empty());
    }

    #[test]
    fn outside_root_flags_a_member_not_under_the_canonical_workspace_root() {
        let workspace = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let inside = workspace.path().join("in.txt");
        let outside = elsewhere.path().join("out.txt");
        touch(&inside);
        touch(&outside);
        let canonical_inside = std::fs::canonicalize(&inside).unwrap();
        let canonical_outside = std::fs::canonicalize(&outside).unwrap();
        let root = std::fs::canonicalize(workspace.path()).unwrap();

        let members = vec![
            member(PieMemberKind::File, &canonical_inside),
            member(PieMemberKind::File, &canonical_outside),
        ];
        let census = census_with_cap(&members, Some(&root), MAX_INDEX_ENTRIES);

        assert_eq!(census.outside_root, vec![canonical_outside]);
    }

    #[test]
    fn no_workspace_root_marks_every_member_outside_root() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("a.txt");
        touch(&file);
        let canonical = std::fs::canonicalize(&file).unwrap();
        let members = vec![member(PieMemberKind::File, &canonical)];

        let census = census_with_cap(&members, None, MAX_INDEX_ENTRIES);

        assert_eq!(census.outside_root, vec![canonical]);
    }
}
