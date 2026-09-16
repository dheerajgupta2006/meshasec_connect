"use client";

import { Bell, BellOff, BellRing } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * Turns browser notifications on for this device.
 *
 * Must be triggered by a click. Browsers refuse `Notification.requestPermission`
 * outside a user gesture, and asking on page load is both blocked and hostile.
 *
 * Per-device rather than per-account: a subscription belongs to one browser, so
 * signing in on a phone needs its own.
 */

type PushState =
  | "unsupported"
  | "checking"
  | "denied"
  | "off"
  | "on"
  | "working";

/**
 * Converts the URL-safe base64 VAPID key into the byte array the
 * subscription API requires.
 */
function decodeVapidKey(base64: string): ArrayBuffer {
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);

  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }

  // The buffer, not the view: `applicationServerKey` is typed as `BufferSource`,
  // and a `Uint8Array` over a generic `ArrayBufferLike` does not satisfy it.
  return buffer;
}

const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export function PushToggle() {
  const [state, setState] = React.useState<PushState>("checking");

  React.useEffect(() => {
    if (
      publicKey.length === 0 ||
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setState("unsupported");
      return;
    }

    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }

    // Already subscribed on this device? Check the registration rather than
    // assuming, so the button reflects reality after a reload.
    void navigator.serviceWorker
      .getRegistration()
      .then(async (registration) => {
        if (registration === undefined) {
          setState("off");
          return;
        }

        const existing = await registration.pushManager.getSubscription();
        setState(existing === null ? "off" : "on");
      })
      .catch(() => setState("off"));
  }, []);

  async function enable(): Promise<void> {
    setState("working");

    try {
      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      // The worker must be active before it can hold a subscription.
      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        // Required to be true by every browser: silent pushes are not allowed.
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(publicKey),
      });

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });

      if (!response.ok) {
        // Roll the browser subscription back, otherwise the browser believes it is
        // subscribed while the server has no record and will never send anything.
        await subscription.unsubscribe().catch(() => undefined);
        setState("off");
        toast.error("We could not turn on notifications. Try again.");
        return;
      }

      setState("on");
      toast.success("Notifications on for this device.");
    } catch {
      setState("off");
      toast.error("This browser refused to enable notifications.");
    }
  }

  async function disable(): Promise<void> {
    setState("working");

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();

      if (subscription !== null && subscription !== undefined) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => undefined);

        await subscription.unsubscribe().catch(() => undefined);
      }

      setState("off");
      toast.success("Notifications off for this device.");
    } catch {
      setState("on");
    }
  }

  if (state === "unsupported" || state === "checking") {
    return null;
  }

  if (state === "denied") {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled
        className="h-9 w-9 text-muted-foreground"
        title="Notifications are blocked for this site. Re-enable them in your browser's site settings."
        aria-label="Notifications are blocked in your browser settings"
      >
        <BellOff className="h-[18px] w-[18px]" />
      </Button>
    );
  }

  const on = state === "on";

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      disabled={state === "working"}
      onClick={() => void (on ? disable() : enable())}
      className={`h-9 w-9 ${
        on ? "text-emerald-500" : "text-muted-foreground hover:text-foreground"
      }`}
      aria-pressed={on}
      aria-label={
        on
          ? "Turn off call notifications for this device"
          : "Turn on call notifications for this device"
      }
      title={
        on
          ? "Call notifications are on for this device"
          : "Get notified about calls even when this tab is closed"
      }
    >
      {on ? (
        <BellRing className="h-[18px] w-[18px]" />
      ) : (
        <Bell className="h-[18px] w-[18px]" />
      )}
    </Button>
  );
}
