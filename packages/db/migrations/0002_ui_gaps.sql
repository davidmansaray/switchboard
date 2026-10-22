CREATE TABLE "app"."desk_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"backend" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"pid" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."desk_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"run_id" text,
	"kind" text DEFAULT 'tool' NOT NULL,
	"tool" text NOT NULL,
	"text" text NOT NULL,
	"status" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."fleet" (
	"fleet_no" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ipaf_category" text,
	"loler_due" date,
	"loler_interval_months" integer
);
--> statement-breakpoint
CREATE TABLE "app"."ops_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."scenario_beats" (
	"n" integer PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."drafts" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "app"."signals_log" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "app"."desk_runs" ADD CONSTRAINT "desk_runs_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."desk_steps" ADD CONSTRAINT "desk_steps_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "app"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desk_runs_run_gen_uq" ON "app"."desk_runs" USING btree ("run_id","generation");--> statement-breakpoint
CREATE INDEX "desk_runs_hire_idx" ON "app"."desk_runs" USING btree ("hire_id","started_at");--> statement-breakpoint
CREATE INDEX "desk_steps_hire_idx" ON "app"."desk_steps" USING btree ("hire_id","created_at");