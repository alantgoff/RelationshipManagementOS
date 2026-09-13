import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

const links = [
  { href: "/", label: "This week" },
  { href: "/people", label: "People" },
  { href: "/import", label: "Import" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ clerkEnabled }: { clerkEnabled: boolean }) {
  return (
    <header className="border-b border-border bg-card">
      <nav className="mx-auto flex w-full max-w-5xl items-center gap-1 px-4 py-2 overflow-x-auto" aria-label="Main">
        <Link href="/" className="mr-3 shrink-0 font-semibold tracking-tight">
          Relationship OS
        </Link>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="shrink-0 rounded-md px-3 py-2 text-sm text-muted hover:text-foreground hover:bg-background"
          >
            {l.label}
          </Link>
        ))}
        <span className="ml-auto shrink-0 flex items-center">
          {clerkEnabled ? <UserButton /> : <span className="text-xs text-muted">dev user</span>}
        </span>
      </nav>
    </header>
  );
}
