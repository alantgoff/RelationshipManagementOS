import { AsyncLocalStorage } from "node:async_hooks";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export const clerkEnabled =
  Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && Boolean(process.env.CLERK_SECRET_KEY);

/** Who a headless run (iMessage webhook, cron job, eval) acts for, and why. */
export interface AgentRunContext {
  userId: string;
  source: "channel" | "cron" | "eval" | "script";
}

const agentContext = new AsyncLocalStorage<AgentRunContext>();

/**
 * Run `fn` as the given owner. Used by webhook and cron routes after they have
 * resolved and verified the owner (e.g. a bound phone number). Every existing
 * query and action then scopes to this user through `requireUserId()`, so the
 * agent reuses the web app's owner-scoped data layer unchanged.
 */
export function runAsOwner<T>(userId: string, source: AgentRunContext["source"], fn: () => Promise<T>): Promise<T> {
  if (!userId) throw new Error("runAsOwner requires a user id");
  return agentContext.run({ userId, source }, fn);
}

/** The active headless run, if any. */
export function currentAgentRun(): AgentRunContext | undefined {
  return agentContext.getStore();
}

/**
 * Returns the current owner's user id. Every query and action must call this
 * and scope by the result; callers never pass a user id in.
 *
 * Resolution order:
 * 1. A headless agent run started with `runAsOwner()`.
 * 2. The Clerk session.
 * 3. Without Clerk keys in non-production, DEV_USER_ID so local development
 *    and tests run without an account. Production builds require Clerk
 *    unless ALLOW_DEV_AUTH=1 is set explicitly (used by the e2e suite).
 */
export async function requireUserId(): Promise<string> {
  const run = agentContext.getStore();
  if (run) return run.userId;
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
