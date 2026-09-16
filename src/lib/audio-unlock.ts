/**
 * Keeps a single unlocked AudioContext ready for the ringtone.
 *
 * A browser will not start audio until the user has interacted with the page, and
 * the permission is granted to the *gesture*, not to the page — so a context
 * created later, when a call arrives, is refused. That is why the ring could be
 * silent even though the user had clicked around.
 *
 * The fix is to create and resume the context during the first real interaction,
 * then reuse it. By the time a call comes in it is already running.
 *
 * A single shared context is also the right shape regardless: browsers cap how
 * many may exist, and creating one per ring leaks them.
 */

type AudioContextConstructor = new () => AudioContext;

let shared: AudioContext | null = null;
let listening = false;

function resolveConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  const candidate =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext;

  return candidate ?? null;
}

/**
 * Creates the context if needed and tries to resume it.
 *
 * Safe to call repeatedly and outside a gesture; it simply will not reach
 * `running` until a gesture has happened.
 */
export function primeAudio(): void {
  const Ctor = resolveConstructor();

  if (Ctor === null) {
    return;
  }

  if (shared === null) {
    try {
      shared = new Ctor();
    } catch {
      return;
    }
  }

  if (shared.state === "suspended") {
    void shared.resume().catch(() => undefined);
  }
}

/**
 * Returns the shared context when it is actually running, else null.
 *
 * Null means "audio is not available right now", which callers should treat as a
 * silent notification rather than an error.
 */
export function runningAudioContext(): AudioContext | null {
  if (shared === null || shared.state !== "running") {
    return null;
  }

  return shared;
}

/**
 * Starts listening for the first user interaction.
 *
 * Listeners are passive and removed once the context is running, so this costs
 * nothing after the first click. `pointerdown` rather than `click` because it
 * fires earlier, and `keydown` so keyboard users are covered too.
 */
export function installAudioUnlock(): () => void {
  if (typeof window === "undefined" || listening) {
    return () => undefined;
  }

  listening = true;

  const events: (keyof WindowEventMap)[] = [
    "pointerdown",
    "keydown",
    "touchstart",
  ];

  function handle(): void {
    primeAudio();

    if (runningAudioContext() !== null) {
      remove();
    }
  }

  function remove(): void {
    events.forEach((event) => {
      window.removeEventListener(event, handle);
    });
    listening = false;
  }

  events.forEach((event) => {
    window.addEventListener(event, handle, { passive: true });
  });

  return remove;
}
