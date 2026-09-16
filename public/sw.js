/**
 * Service worker for Meshasec Connext push notifications.
 *
 * Deliberately minimal: it does not cache anything and does not intercept fetches.
 * Its only job is to receive pushes and open the right page when one is clicked.
 * Adding offline caching here would risk serving stale application code, which is
 * a much bigger problem than the benefit.
 */

/* eslint-env serviceworker */

// Activate immediately rather than waiting for existing tabs to close, so a
// deploy does not leave an old worker handling notifications.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function parsePayload(event) {
  if (!event.data) {
    return null;
  }

  try {
    return event.data.json();
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) => {
  const payload = parsePayload(event);

  if (payload === null) {
    return;
  }

  if (payload.kind === "call") {
    const title = payload.isGroupInvite
      ? `${payload.callerName} invited you to a group call`
      : `${payload.callerName} is calling`;

    event.waitUntil(
      self.registration.showNotification(title, {
        body: "Tap to join the call.",
        // `renotify` with a stable tag replaces an earlier notification for the
        // same room instead of stacking duplicates, while still alerting again.
        tag: `call-${payload.meetingCode}`,
        renotify: true,
        requireInteraction: true,
        // The OS plays the notification sound, which is not subject to the
        // browser autoplay rules that can silence an in-page ringtone.
        silent: false,
        vibrate: [200, 100, 200, 100, 200],
        data: { url: `/meeting/${encodeURIComponent(payload.meetingCode)}/lobby` },
        actions: [{ action: "join", title: "Join" }],
      }),
    );

    return;
  }

  if (payload.kind === "message") {
    event.waitUntil(
      self.registration.showNotification(`${payload.fromName}`, {
        body: payload.preview,
        tag: `message-${payload.fromUsername}`,
        renotify: true,
        data: { url: `/messages/${encodeURIComponent(payload.fromUsername)}` },
      }),
    );
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target =
    event.notification.data && typeof event.notification.data.url === "string"
      ? event.notification.data.url
      : "/dashboard";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Reuse an existing tab where possible: opening a second one would join the
      // call twice and leave a stray window behind.
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();

          if ("navigate" in client) {
            await client.navigate(target).catch(() => undefined);
          }

          return;
        }
      }

      await self.clients.openWindow(target);
    })(),
  );
});
