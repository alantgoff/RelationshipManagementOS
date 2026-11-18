CREATE TABLE "binding_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "ready_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
UPDATE "channel_messages" SET "ready_at" = "created_at";--> statement-breakpoint
CREATE INDEX "binding_failures_created_idx" ON "binding_failures" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "binding_failures_phone_idx" ON "binding_failures" USING btree ("phone_hash","created_at");--> statement-breakpoint
CREATE INDEX "channel_messages_pending_idx" ON "channel_messages" USING btree ("user_id","direction","processed_at");