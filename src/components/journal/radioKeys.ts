import type { KeyboardEvent } from "react";

/** Arrow keys inside a radiogroup: move focus to the neighbouring radio and select it. */
export function radioKeys(e: KeyboardEvent<HTMLElement>): void {
  const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!d || !e.currentTarget.parentElement) return;
  const radios = [...e.currentTarget.parentElement.querySelectorAll<HTMLElement>('[role="radio"]')];
  const next = radios[(radios.indexOf(e.currentTarget) + d + radios.length) % radios.length];
  e.preventDefault();
  next.focus();
  next.click();
}
