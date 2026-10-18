CREATE INDEX "analyses_requirement_revision_idx" ON "requirement_analyses" USING btree ("requirement_id","revision");--> statement-breakpoint
CREATE INDEX "catalog_scope_idx" ON "service_catalog" USING btree ("team_id","service","currency");--> statement-breakpoint
CREATE INDEX "quotes_requirement_idx" ON "quotations" USING btree ("requirement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_history_revision_unique" ON "quotation_history" USING btree ("quotation_id","revision");--> statement-breakpoint
CREATE INDEX "requirements_scope_idx" ON "requirements" USING btree ("user_id","team_id");--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "catalog_price_bounds" CHECK ("service_catalog"."unit_cents" >= 0 AND "service_catalog"."unit_cents" <= 100000000);--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quote_confirmation_consistent" CHECK (("quotations"."status" = 'draft' AND "quotations"."confirmed_at" IS NULL AND "quotations"."confirmed_by" IS NULL) OR ("quotations"."status" = 'confirmed' AND "quotations"."confirmed_at" IS NOT NULL AND "quotations"."confirmed_by" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_revision_positive" CHECK ("requirements"."revision" > 0);