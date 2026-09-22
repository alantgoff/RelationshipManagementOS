import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkEnabled } from "@/server/auth";
import { Nav } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Relationship OS",
  description: "Keep the right people warm.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Nav clerkEnabled={clerkEnabled} />
        <main className="mx-auto w-full max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
  return clerkEnabled ? <ClerkProvider>{body}</ClerkProvider> : body;
}
