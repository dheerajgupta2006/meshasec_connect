import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    // Matches the sign-in page: `p-4` so Clerk's 400px card fits a 375px screen,
    // and a themed gradient instead of a hardcoded light `bg-gray-50`.
    <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-gradient-to-b from-primary/[0.06] via-background to-background p-4 sm:p-6">
      <SignUp
        appearance={{
          elements: { rootBox: "w-full max-w-md", card: "w-full" },
        }}
      />
    </main>
  );
}
