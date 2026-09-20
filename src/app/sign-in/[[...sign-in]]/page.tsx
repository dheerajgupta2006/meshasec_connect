import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    // `p-4` on phones: Clerk's card is 25rem/400px wide by default, and the old
    // `p-6` left only 327px for it on a 375px screen. The gradient replaces a
    // hardcoded `bg-gray-50`, which stayed light even in dark mode.
    <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-gradient-to-b from-primary/[0.06] via-background to-background p-4 sm:p-6">
      <SignIn
        appearance={{
          elements: { rootBox: "w-full max-w-md", card: "w-full" },
        }}
      />
    </main>
  );
}
