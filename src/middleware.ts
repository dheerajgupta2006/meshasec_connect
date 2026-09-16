import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Authentication stays in these handlers so API clients receive JSON 401 errors
  // rather than a redirect to a sign-in page.
  "/api/meetings/token",
  // Guest access. An invited guest has no account, so they must be able to reach
  // the passcode exchange, the lobby and the room without signing in. None of
  // these are unguarded: the lobby and room render a passcode prompt until a
  // signed guest session exists, and the token route re-verifies that session
  // before minting anything. Admission is enforced there, not here.
  "/api/meetings/guest",
  "/meeting/(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
