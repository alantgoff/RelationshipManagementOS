/**
 * Routes that skip the Clerk session check. Each one authenticates itself:
 * - /sign-in, /sign-up: Clerk's own pages
 * - /api/channels/*: provider webhooks, verified by the provider's signing secret
 * - /api/cron/*: scheduled ticks, verified by CRON_SECRET
 * Keep this list short; anything added here must do its own auth.
 */
export const PUBLIC_ROUTE_PATTERNS = ["/sign-in(.*)", "/sign-up(.*)", "/api/channels/(.*)", "/api/cron/(.*)"];
