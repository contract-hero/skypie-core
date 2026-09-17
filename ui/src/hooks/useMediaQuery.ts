// useMediaQuery — one CSS media query as a boolean. The layout breakpoints
// this app reacts to in JS (PiePlate's short/narrow pane postures) were one
// hand-rolled copy of this each; they are now one-liners over this hook, so
// a fix to the subscription shape lands in exactly one place.
import * as React from "react";

export function useMediaQuery(query: string): boolean {
  // Lazy, so the first paint is already correct and no layout thrash
  // follows on mount. Guarded for the non-DOM environments this project's
  // vitest runs in (no jsdom).
  const [matches, setMatches] = React.useState(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches,
  );

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    // No eager `onChange()`: the initializer above already read this exact
    // query, so calling it on mount only sets the state it is already in.
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
