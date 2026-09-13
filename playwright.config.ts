import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/** Use a system Chromium when one is provided (e.g. PW_CHROMIUM_PATH or the container default). */
const chromiumPath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const launchOptions = existsSync(chromiumPath) ? { executablePath: chromiumPath } : {};

const PORT = 3100;
const E2E_DB = process.env.TEST_DATABASE_URL ?? "postgres://rmos:rmos@localhost:5432/rmos_test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      DATABASE_URL: E2E_DB,
      DEV_USER_ID: "e2e-user",
      ALLOW_DEV_AUTH: "1",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      CLERK_SECRET_KEY: "",
    },
  },
});
