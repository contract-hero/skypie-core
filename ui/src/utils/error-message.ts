// One reading of "what went wrong", for everything that calls the backend.
//
// Tauri rejects with the command's `Err` VALUE, not with an Error: a command
// declared `Result<T, String>` rejects with a plain string. A `catch` that
// assumed `e.message` would show "undefined" to the user, which is how a
// backend error becomes a mystery.

export function messageOf(e: unknown, fallback: string): string {
  if (typeof e === "string" && e.length > 0) return e;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
