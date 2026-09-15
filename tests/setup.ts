import "dotenv/config";

// Integration tests run against a dedicated database and the dev auth fallback.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://rmos:rmos@localhost:5432/rmos_test";
process.env.DEV_USER_ID = process.env.DEV_USER_ID ?? "test-user";
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
