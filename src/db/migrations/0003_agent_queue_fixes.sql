ALTER TABLE "channel_messages" ADD COLUMN "ref_id" uuid;--> statement-breakpoint
-- Inbound rows left unprocessed by earlier versions (binding codes, killed runs) are closed, so the tick never answers them late.
UPDATE "channel_messages" SET "processed_at" = "created_at" WHERE "direction" = 'in' AND "processed_at" IS NULL AND "created_at" < now() - interval '10 minutes';--> statement-breakpoint
-- Draft bodies belong only in encrypted storage; scrub copies earlier versions kept in the audit log.
UPDATE "agent_actions" SET "input" = jsonb_set("input", '{body}', '"[redacted]"') WHERE "tool" = 'draft_message' AND "input" ? 'body';
