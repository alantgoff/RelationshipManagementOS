CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"summary" text NOT NULL,
	"undo" jsonb,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"inbound_message_id" uuid,
	"model" text,
	"provider" text,
	"context_tokens" integer,
	"steps" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_bindings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"phone" text,
	"pending_code_hash" text,
	"code_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"direction" text NOT NULL,
	"kind" text DEFAULT 'chat' NOT NULL,
	"body_enc" text NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"person_id" uuid,
	"fact" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"local_date" text NOT NULL,
	"message_id" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'message_draft' NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"body_enc" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "thread_summaries" (
	"user_id" text PRIMARY KEY NOT NULL,
	"summary_enc" text NOT NULL,
	"covers_through" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "lp_commitment_usd" bigint;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "proactive_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "brief_time" text DEFAULT '07:30' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "quiet_start" text DEFAULT '21:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "quiet_end" text DEFAULT '07:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "daily_unprompted_limit" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_inbound_message_id_channel_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."channel_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_message_id_channel_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."channel_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_actions_turn_idx" ON "agent_actions" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "agent_actions_user_created_idx" ON "agent_actions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_turns_user_created_idx" ON "agent_turns" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_phone_idx" ON "channel_bindings" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "channel_bindings_code_idx" ON "channel_bindings" USING btree ("pending_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_provider_msg_idx" ON "channel_messages" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "channel_messages_user_created_idx" ON "channel_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_facts_user_person_idx" ON "memory_facts" USING btree ("user_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_log_brief_once_idx" ON "notification_log" USING btree ("user_id","kind","local_date") WHERE kind = 'brief';--> statement-breakpoint
CREATE INDEX "notification_log_user_date_idx" ON "notification_log" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "pending_actions_user_status_idx" ON "pending_actions" USING btree ("user_id","status");