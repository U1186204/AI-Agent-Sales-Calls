/** Browser preference helpers (safe to call during SSR: they return the conservative default). */

function matches(query: string): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** True when the user asked the OS for less motion. */
export function prefersReducedMotion(): boolean {
  return matches("(prefers-reduced-motion: reduce)");
}

/**
 * `behavior` for scrollIntoView / scrollTo. An explicit "smooth" overrides the CSS
 * `scroll-behavior: auto` set under reduced motion, so JS scrolling must ask too.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

/** Touch-first device (soft keyboard): don't keep a text field focused after sending. */
export function isCoarsePointer(): boolean {
  return matches("(pointer: coarse)") || matches("(hover: none)");
}
