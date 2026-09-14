"use client";

import { useEffect, useRef } from "react";

export interface ShortcutHandlers {
  /** `M` */
  onToggleMute?: () => void;
  /** `V` */
  onToggleVideo?: () => void;
  /** Ctrl/Cmd + D */
  onToggleScreenShare?: () => void;
  /** Spacebar held down. */
  onPushToTalkStart?: () => void;
  /** Spacebar released. */
  onPushToTalkEnd?: () => void;
}

/** True when focus is in a field where typing should win over shortcuts. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName;

  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Global in-call shortcuts.
 *
 * Push-to-talk is edge-triggered: browsers fire `keydown` repeatedly while a key
 * is held, so a ref tracks whether the gesture already started.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  const spaceHeldRef = useRef(false);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      const current = handlersRef.current;

      if (event.code === "Space") {
        // Stop the page scrolling while push-to-talk is held.
        event.preventDefault();
        if (!spaceHeldRef.current) {
          spaceHeldRef.current = true;
          current.onPushToTalkStart?.();
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        current.onToggleScreenShare?.();
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        current.onToggleMute?.();
        return;
      }

      if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        current.onToggleVideo?.();
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.code !== "Space" || !spaceHeldRef.current) {
        return;
      }
      spaceHeldRef.current = false;
      handlersRef.current.onPushToTalkEnd?.();
    }

    function handleBlur() {
      // A lost window must not leave the mic stuck open.
      if (spaceHeldRef.current) {
        spaceHeldRef.current = false;
        handlersRef.current.onPushToTalkEnd?.();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);
}
