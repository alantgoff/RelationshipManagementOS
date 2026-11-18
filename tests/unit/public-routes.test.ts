import { createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { PUBLIC_ROUTE_PATTERNS } from "@/server/public-routes";

const isPublic = createRouteMatcher(PUBLIC_ROUTE_PATTERNS);
const req = (path: string) => new NextRequest(`https://app.example.com${path}`, { method: "POST" });

describe("public routes", () => {
  it("lets machine-authenticated routes past the Clerk session check", () => {
    expect(isPublic(req("/api/channels/sendblue"))).toBe(true);
    expect(isPublic(req("/api/cron/tick"))).toBe(true);
    expect(isPublic(req("/sign-in"))).toBe(true);
  });

  it("keeps the app and data APIs behind sign-in", () => {
    for (const path of ["/", "/people", "/settings", "/api/export", "/api/channelsx", "/api/cronjob"]) {
      expect(isPublic(req(path)), path).toBe(false);
    }
  });
});
