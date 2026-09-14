import { auth } from "@clerk/nextjs/server";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { MeetingCreationForm } from "@/components/meeting/meeting-creation-form";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Create a meeting",
};

export default async function NewMeetingPage() {
  // Defense in depth behind the middleware, matching the dashboard and lobby.
  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-gradient-to-b from-primary/[0.06] via-background to-background">
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="mb-6 -ml-2 text-muted-foreground"
        >
          <Link href="/dashboard">
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
        </Button>

        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Create a meeting
          </h1>
          <p className="mt-2 text-muted-foreground">
            Start an instant meeting or schedule one for later.
          </p>
        </header>

        <MeetingCreationForm />
      </div>
    </main>
  );
}
