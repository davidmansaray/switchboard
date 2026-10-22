CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TYPE "app"."desk_run_state" AS ENUM('idle', 'running', 'queued', 'awaiting_approval', 'recovering');--> statement-breakpoint
CREATE TYPE "app"."draft_kind" AS ENUM('bundle', 'email', 'update');--> statement-breakpoint
CREATE TYPE "app"."draft_status" AS ENUM('pending', 'stale', 'superseded', 'approved', 'applied', 'rejected');--> statement-breakpoint
CREATE TYPE "app"."hire_status" AS ENUM('enquiry', 'confirmed', 'on_hire', 'off_hire', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."line_status" AS ENUM('booked', 'on_hire', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."signal_kind" AS ENUM('message', 'queued-message', 'signal', 'queued-signal', 'schedule');--> statement-breakpoint
CREATE TYPE "app"."signal_outcome" AS ENUM('delivered', 'queued', 'persisted', 'discarded', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "app"."staff_role" AS ENUM('staff', 'approver');--> statement-breakpoint
CREATE TYPE "app"."approval_tier" AS ENUM('auto', 'approval');--> statement-breakpoint
CREATE SEQUENCE "app"."credit_note_ref_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 301 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "app"."draft_ref_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 7 CACHE 1;--> statement-breakpoint
CREATE TABLE "app"."action_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"tool" text NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"tool" text NOT NULL,
	"result" jsonb NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."approval_tiers" (
	"field" text PRIMARY KEY NOT NULL,
	"tier" "app"."approval_tier" NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"decided_by" text NOT NULL,
	"decision" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"hire_version_at_decision" integer NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "app"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"phone" text,
	CONSTRAINT "contacts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "app"."credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text DEFAULT 'CN-' || nextval('app.credit_note_ref_seq') NOT NULL,
	"hire_id" uuid NOT NULL,
	"line_id" uuid,
	"amount_pence" integer NOT NULL,
	"reason" text NOT NULL,
	"action_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_ref_unique" UNIQUE("ref"),
	CONSTRAINT "credit_notes_action_key_unique" UNIQUE("action_key")
);
--> statement-breakpoint
CREATE TABLE "app"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"account_ref" text NOT NULL,
	CONSTRAINT "customers_account_ref_unique" UNIQUE("account_ref")
);
--> statement-breakpoint
CREATE TABLE "app"."desks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"mastra_thread_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"run_state" "app"."desk_run_state" DEFAULT 'idle' NOT NULL,
	"active_run_id" text,
	"current_step" text,
	"sweep_schedule_id" text,
	"last_signal_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desks_hire_id_unique" UNIQUE("hire_id"),
	CONSTRAINT "desks_mastra_thread_id_unique" UNIQUE("mastra_thread_id")
);
--> statement-breakpoint
CREATE TABLE "app"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"signed" boolean DEFAULT false NOT NULL,
	"signed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text DEFAULT 'D-' || nextval('app.draft_ref_seq') NOT NULL,
	"hire_id" uuid NOT NULL,
	"kind" "app"."draft_kind" NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"based_on_version" integer NOT NULL,
	"evidence_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "app"."draft_status" DEFAULT 'pending' NOT NULL,
	"supersedes_id" uuid,
	"action_key" text NOT NULL,
	"stale_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	CONSTRAINT "drafts_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "app"."email_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"label" text NOT NULL,
	"subject" text NOT NULL,
	"contact_id" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"hire_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"direction" text NOT NULL,
	"from_addr" text NOT NULL,
	"to_addrs" text[] NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"contact_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emails_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "app"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"actor" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"run_id" text,
	CONSTRAINT "events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "app"."evidence_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."hire_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"description" text NOT NULL,
	"spec" text,
	"fleet_no" text,
	"status" "app"."line_status" DEFAULT 'booked' NOT NULL,
	"weekly_rate_pence" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."hire_versions" (
	"hire_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"diff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hire_versions_hire_id_version_pk" PRIMARY KEY("hire_id","version")
);
--> statement-breakpoint
CREATE TABLE "app"."hires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"site" text NOT NULL,
	"site_area" text,
	"delivery_date" date NOT NULL,
	"delivery_slot" text DEFAULT 'AM' NOT NULL,
	"duration_days" integer NOT NULL,
	"status" "app"."hire_status" DEFAULT 'confirmed' NOT NULL,
	"po_number" text,
	"invoice_address" text,
	"site_contact_id" uuid,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"damage_waiver" boolean DEFAULT true NOT NULL,
	"waiver_rate_pct" numeric(5, 2) DEFAULT '12' NOT NULL,
	"transport_pence" integer DEFAULT 0 NOT NULL,
	"total_pence" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"version_txid" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hires_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "app"."notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"mentions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"thread_id" uuid,
	"draft_id" uuid,
	"to_addrs" text[] NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "app"."signals_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"event_id" uuid,
	"kind" "app"."signal_kind" NOT NULL,
	"outcome" "app"."signal_outcome" NOT NULL,
	"backend" text NOT NULL,
	"tag" text NOT NULL,
	"contents" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" text,
	"waits_for_run_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."staff" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" "app"."staff_role" NOT NULL,
	"title" text NOT NULL,
	"avatar" text
);
--> statement-breakpoint
CREATE TABLE "app"."transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"title" text NOT NULL,
	"participants" text[] NOT NULL,
	"body" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."action_attempts" ADD CONSTRAINT "action_attempts_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_actions" ADD CONSTRAINT "agent_actions_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD CONSTRAINT "approvals_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "app"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD CONSTRAINT "approvals_decided_by_staff_id_fk" FOREIGN KEY ("decided_by") REFERENCES "app"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contacts" ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_notes" ADD CONSTRAINT "credit_notes_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_notes" ADD CONSTRAINT "credit_notes_line_id_hire_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "app"."hire_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."desks" ADD CONSTRAINT "desks_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."drafts" ADD CONSTRAINT "drafts_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_threads" ADD CONSTRAINT "email_threads_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_threads" ADD CONSTRAINT "email_threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "app"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."emails" ADD CONSTRAINT "emails_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "app"."email_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."emails" ADD CONSTRAINT "emails_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."emails" ADD CONSTRAINT "emails_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "app"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."events" ADD CONSTRAINT "events_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."evidence_chunks" ADD CONSTRAINT "evidence_chunks_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hire_lines" ADD CONSTRAINT "hire_lines_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hire_versions" ADD CONSTRAINT "hire_versions_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hires" ADD CONSTRAINT "hires_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hires" ADD CONSTRAINT "hires_site_contact_id_contacts_id_fk" FOREIGN KEY ("site_contact_id") REFERENCES "app"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notes" ADD CONSTRAINT "notes_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notes" ADD CONSTRAINT "notes_author_id_staff_id_fk" FOREIGN KEY ("author_id") REFERENCES "app"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD CONSTRAINT "outbox_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD CONSTRAINT "outbox_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "app"."email_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD CONSTRAINT "outbox_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "app"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signals_log" ADD CONSTRAINT "signals_log_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signals_log" ADD CONSTRAINT "signals_log_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcripts" ADD CONSTRAINT "transcripts_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_attempts_hire_idx" ON "app"."action_attempts" USING btree ("hire_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_actions_uq" ON "app"."agent_actions" USING btree ("hire_id","action_key");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_action_uq" ON "app"."drafts" USING btree ("hire_id","action_key");--> statement-breakpoint
CREATE INDEX "drafts_hire_idx" ON "app"."drafts" USING btree ("hire_id");--> statement-breakpoint
CREATE INDEX "emails_hire_idx" ON "app"."emails" USING btree ("hire_id");--> statement-breakpoint
CREATE INDEX "events_hire_idx" ON "app"."events" USING btree ("hire_id","created_at");--> statement-breakpoint
CREATE INDEX "events_unprocessed_idx" ON "app"."events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "evidence_hire_idx" ON "app"."evidence_chunks" USING btree ("hire_id");--> statement-breakpoint
CREATE INDEX "evidence_tsv_idx" ON "app"."evidence_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_source_uq" ON "app"."evidence_chunks" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hire_lines_no_uq" ON "app"."hire_lines" USING btree ("hire_id","line_no");--> statement-breakpoint
CREATE INDEX "hires_customer_idx" ON "app"."hires" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "signals_hire_idx" ON "app"."signals_log" USING btree ("hire_id","created_at");