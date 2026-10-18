CREATE TABLE "ai_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"requirement_id" integer NOT NULL,
	"revision" integer NOT NULL,
	"mode" varchar(10) NOT NULL,
	"profile" varchar(64) NOT NULL,
	"status" varchar(10) DEFAULT 'running' NOT NULL,
	"analysis_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ai_runs_state_consistent" CHECK (("ai_runs"."status" = 'running' AND "ai_runs"."analysis_id" IS NULL AND "ai_runs"."finished_at" IS NULL) OR ("ai_runs"."status" = 'failed' AND "ai_runs"."analysis_id" IS NULL AND "ai_runs"."finished_at" IS NOT NULL) OR ("ai_runs"."status" = 'succeeded' AND "ai_runs"."analysis_id" IS NOT NULL AND "ai_runs"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "mutation_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"request_id" varchar(36) NOT NULL,
	"action" varchar(30) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"result_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requirement_analyses" ADD COLUMN "policy_version" varchar(30) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_analysis_id_requirement_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."requirement_analyses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_receipts" ADD CONSTRAINT "mutation_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_receipts" ADD CONSTRAINT "mutation_receipts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_version_profile_unique" ON "ai_runs" USING btree ("user_id","requirement_id","revision","mode","profile");--> statement-breakpoint
CREATE INDEX "ai_runs_quota_idx" ON "ai_runs" USING btree ("mode","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mutation_receipts_actor_request_unique" ON "mutation_receipts" USING btree ("user_id","request_id");--> statement-breakpoint
-- Existing same-price duplicate catalog rows are archived, not deleted.
-- Ambiguous prices require operator review; the entire migration rolls back.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM service_catalog WHERE archived_at IS NULL
    GROUP BY team_id, service, currency, lower(btrim(name)) HAVING count(DISTINCT unit_cents) > 1)
  THEN RAISE EXCEPTION 'Conflicting catalog prices: review duplicate items before migration'; END IF;
END $$;
--> statement-breakpoint
UPDATE service_catalog SET archived_at = now() WHERE id IN (
  SELECT id FROM (SELECT id, row_number() OVER (
    PARTITION BY team_id, service, currency, lower(btrim(name)) ORDER BY id
  ) AS position FROM service_catalog WHERE archived_at IS NULL) ranked WHERE position > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_active_item_unique" ON "service_catalog" USING btree ("team_id","service","currency",lower(btrim("name"))) WHERE "service_catalog"."archived_at" IS NULL;