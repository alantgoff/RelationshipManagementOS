# ADR-0001: Application stack

Date: 2026-09-12
Status: Accepted

## Context
RelationshipManagementOS is a greenfield, single-developer app: a personal
relationship manager that must also serve a VC microfund's need to keep
prospective LPs, deal-flow sources, and founders engaged. Priorities are
speed of iteration, a hosted deploy with minimal ops, and a schema that can
grow from personal contacts to fund-specific roles.

## Decision
- Next.js (App Router, 16 at build time) with TypeScript and Tailwind CSS.
- Postgres with Drizzle ORM; SQL migrations checked into the repo.
- Clerk for authentication.
- Vercel for hosting.
- Vitest for unit tests, Playwright for end-to-end tests.

## Consequences
- One codebase for UI, server actions, and data access.
- Drizzle keeps the schema explicit and reviewable as the fund model grows.
- Clerk and Vercel are hosted dependencies; swapping them later is possible
  but not free.
- Ruflo agents should read this ADR and the `project` memory namespace before
  proposing alternatives.
