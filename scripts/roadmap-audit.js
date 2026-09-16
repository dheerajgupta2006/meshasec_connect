/**
 * Roadmap audit: greps the source tree for a marker of each Tier 1/2/3 feature.
 *
 * Deliberately a script rather than a shell one-liner — PowerShell's `-Include`
 * globbing does not recurse the way it appears to, which produced false
 * "absent" results and would have made this report wrong.
 *
 * A marker being present means the code exists, not that the feature is
 * finished; the report separates backend from UI where that distinction matters.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOTS = ["src", "prisma"];
const EXTENSIONS = new Set([".ts", ".tsx", ".prisma", ".sql"]);

const CHECKS = [
  ["TIER 1", null],
  ["Message edit + soft delete", /editDirectMessage|deleteDirectMessage/],
  ["Message reply / quote", /replyToId/],
  ["Message search (backend)", /searchMessages/],
  ["Message search (UI)", /searchDirectMessages/],
  ["Rich link previews (lib)", /getLinkPreview/],
  ["Rich link previews (UI)", /LinkPreviewCard/],
  // Anchored to a schema model / upload endpoint, not the word "attachment",
  // which also appears in the calendar route's Content-Disposition header.
  ["Media / file attachments", /model MessageAttachment|uploadthing|cloudinary/i],
  ["Realtime SSE", /EventSource|event-stream/],
  // `isTypingTarget` in the keyboard-shortcut hook is unrelated, so this must
  // match a typing *broadcast*, not any identifier containing "isTyping".
  ["Typing indicators", /typingUsers|broadcastTyping|TYPING_EVENT/],
  ["Presence dots", /onlineAt|lastSeenAt/],
  ["Incoming call ringing", /IncomingCallBanner/],
  ["TIER 2", null],
  // Split backend primitives from being actually reachable by a host. The first
  // can exist while the feature is unusable, which is misleading on its own.
  ["Host moderation (server lib)", /RoomServiceClient/],
  ["Host moderation (wired to UI)", /muteEveryoneElse|removeFromMeeting/, "tsx"],
  ["Lock / waiting room (schema)", /model WaitingRoomEntry/],
  ["Lock / waiting room (wired)", /admitFromWaitingRoom|setMeetingLock/, "tsx"],
  ["Cloud recording (Egress)", /EgressClient|startRoomComposite/],
  ["AI transcription", /transcri/i],
  ["Background blur", /BackgroundBlur|backgroundBlur/],
  ["Custom virtual backgrounds", /VirtualBackground/],
  // Matches the in-house canvas board as well as a third-party library, since the
  // feature is "there is a whiteboard", not "we installed tldraw".
  ["Whiteboard", /tldraw|excalidraw|reduceWhiteboard/i],
  ["Polls / Q&A", /reducePolls|openPoll/],
  ["TIER 3", null],
  ["Calendar .ics + links", /buildIcsCalendar/],
  ["Emailed calendar invites", /calendarInviteEmail|attachIcs/],
  ["Group chats / channels", /ConversationMember|ChannelMember/],
  ["Web push notifications", /PushSubscription|VAPID/],
  ["Theme switcher", /ThemeToggle/],
  ["BEYOND ROADMAP", null],
  ["Dynamic call expansion", /inviteFriendToCall/],
  ["Room passcode", /generateRoomPasscode/],
  ["Meeting lifecycle / ended", /resolveMeetingStatus/],
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }

    if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }

  return out;
}

const files = [];
for (const root of ROOTS) {
  if (fs.existsSync(root)) {
    walk(root, files);
  }
}

const contents = files.map((file) => ({
  file,
  text: fs.readFileSync(file, "utf8"),
}));

for (const [label, pattern, requiredExt] of CHECKS) {
  if (pattern === null) {
    console.log(`\n=== ${label} ===`);
    continue;
  }

  // Some checks only count as done when the marker reaches a component, which is
  // what distinguishes "the function exists" from "a user can press it".
  const scope =
    requiredExt === undefined
      ? contents
      : contents.filter((entry) => entry.file.endsWith(`.${requiredExt}`));

  const hits = scope.filter((entry) => pattern.test(entry.text));
  const mark = hits.length > 0 ? "DONE" : " -- ";
  console.log(
    `${mark}  ${label.padEnd(30)}${
      hits.length > 0 ? `${hits.length} file(s)` : ""
    }`,
  );
}

console.log(`\nscanned ${files.length} files`);
