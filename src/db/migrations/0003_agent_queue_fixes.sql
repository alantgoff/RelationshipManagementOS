ALTER TABLE "channel_messages" ADD COLUMN "ref_id" uuid;--> statement-breakpoint
-- Inbound rows left unprocessed by earlier versions (binding codes, killed runs) are closed, so the tick never answers them late.
UPDATE "channel_messages" SET "processed_at" = "created_at" WHERE "direction" = 'in' AND "processed_at" IS NULL AND "created_at" < now() - interval '10 minutes';--> statement-breakpoint
-- Message text belongs only in encrypted storage. Earlier versions kept draft_message arguments, and the raw
-- arguments of calls that failed validation or named an unknown tool (where text may sit under any key), in
-- the plaintext audit log: keep only ids, enums and a short intent.
UPDATE "agent_actions" SET "input" = (
  SELECT coalesce(jsonb_object_agg("key", CASE
    WHEN "key" = 'intent' AND "tool" = 'draft_message' AND jsonb_typeof("value") = 'string' AND length("value" #>> '{}') <= 80 THEN "value"
    WHEN "key" <> 'body' AND jsonb_typeof("value") IN ('number', 'boolean', 'null') THEN "value"
    WHEN "key" <> 'body' AND jsonb_typeof("value") = 'string' AND length("value" #>> '{}') <= 40 AND ("value" #>> '{}') !~ '\s' THEN "value"
    ELSE '"[redacted]"'::jsonb
  END), '{}'::jsonb)
  FROM jsonb_each("input")
)
WHERE jsonb_typeof("input") = 'object'
  AND ("tool" = 'draft_message' OR "summary" LIKE '%: invalid arguments' OR "summary" LIKE '%: invalid JSON' OR "summary" LIKE 'Unknown tool %');
