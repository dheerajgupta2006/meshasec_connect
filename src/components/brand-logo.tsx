import { Video } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

interface BrandLogoProps {
  className?: string;
  compact?: boolean;
}

export function BrandLogo({ className, compact = false }: BrandLogoProps) {
  return (
    <Link
      href="/"
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
      aria-label="Meshasec Connect home"
    >
      <span className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/20 transition-transform group-hover:scale-[1.03]">
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.38),transparent_42%)]" />
        <Video className="relative h-[18px] w-[18px]" strokeWidth={2.4} />
      </span>
      {!compact && (
        <span className="text-[15px] font-bold tracking-[-0.02em] text-foreground sm:text-base">
          Meshasec <span className="text-primary">Connect</span>
        </span>
      )}
    </Link>
  );
}
