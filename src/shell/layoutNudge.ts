/**
 * Sections that load after the Settings popover opened make it taller; the popover only measures
 * itself on open and on resize, so tell it to measure again once the new content is in.
 */
export function nudgeLayout(): void {
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}
