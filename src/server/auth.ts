import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export const clerkEnabled =
  Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && Boolean(process.env.CLERK_SECRET_KEY);

/**
 * Returns the current owner's user id. Every query and action must call this
 * and scope by the result; callers never pass a user id in.
 *
 * Without Clerk keys in non-production, falls back to DEV_USER_ID so local
 * development and tests run without an account. Production builds require
 * Clerk unless ALLOW_DEV_AUTH=1 is set explicitly (used by the e2e suite).
 */
export async function requireUserId(): Promise<string> {
  if (clerkEnabled) {
    const { userId } = await auth();
    if (!userId) redirect("/sign-in");
    return userId;
  }
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_AUTH !== "1") {
    throw new Error("Clerk keys are required in production");
  }
  return process.env.DEV_USER_ID ?? "dev-user";
}
