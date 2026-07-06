import { createEffect, createSignal, on } from "solid-js";

/**
 * The localStorage keys for persisted sidebar state. Defined here, the canonical
 * sidebar-persistence module, and imported wherever sidebar state is read/written
 * (e.g. the isolated document-area root seeds + persists the right-sidebar keys),
 * so the key strings live in exactly one place.
 */
export const SIDEBAR_KEYS = {
  leftCollapsed: "patchwork:leftSidebarCollapsed",
  rightCollapsed: "patchwork:rightSidebarCollapsed",
  leftWidth: "patchwork:leftSidebarWidth",
  rightWidth: "patchwork:rightSidebarWidth",
  contextToolId: "patchwork:contextSidebarToolId",
} as const;

/** Default sidebar width (px) when nothing is persisted. */
export const DEFAULT_SIDEBAR_WIDTH = 400;

/**
 * Reads a number from localStorage with a default fallback
 */
export function getStoredNumber(key: string, defaultValue: number): number {
  const stored = localStorage.getItem(key);
  return stored ? parseInt(stored, 10) : defaultValue;
}

/**
 * Reads a boolean from localStorage (returns true if value is "true")
 */
export function getStoredBoolean(key: string): boolean {
  return localStorage.getItem(key) === "true";
}

/**
 * Manages sidebar collapse and width state with localStorage persistence
 */
export function useSidebarState() {
  // Sidebar collapse state with localStorage persistence
  const [isSidebarCollapsed, setIsSidebarCollapsed] = createSignal(
    getStoredBoolean(SIDEBAR_KEYS.leftCollapsed)
  );
  const [isRightSidebarCollapsed, setIsRightSidebarCollapsed] = createSignal(
    getStoredBoolean(SIDEBAR_KEYS.rightCollapsed)
  );

  // Resizable sidebar width state with localStorage persistence
  const [leftSidebarWidth, setLeftSidebarWidth] = createSignal(
    getStoredNumber(SIDEBAR_KEYS.leftWidth, DEFAULT_SIDEBAR_WIDTH)
  );
  const [rightSidebarWidth, setRightSidebarWidth] = createSignal(
    getStoredNumber(SIDEBAR_KEYS.rightWidth, DEFAULT_SIDEBAR_WIDTH)
  );

  // Persist each sidebar state to localStorage independently
  createEffect(
    on(isSidebarCollapsed, (value) => {
      localStorage.setItem(SIDEBAR_KEYS.leftCollapsed, String(value));
    })
  );

  createEffect(
    on(isRightSidebarCollapsed, (value) => {
      localStorage.setItem(SIDEBAR_KEYS.rightCollapsed, String(value));
    })
  );

  createEffect(
    on(leftSidebarWidth, (value) => {
      localStorage.setItem(SIDEBAR_KEYS.leftWidth, String(value));
    })
  );

  createEffect(
    on(rightSidebarWidth, (value) => {
      localStorage.setItem(SIDEBAR_KEYS.rightWidth, String(value));
    })
  );

  return {
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    isRightSidebarCollapsed,
    setIsRightSidebarCollapsed,
    leftSidebarWidth,
    setLeftSidebarWidth,
    rightSidebarWidth,
    setRightSidebarWidth,
  };
}
