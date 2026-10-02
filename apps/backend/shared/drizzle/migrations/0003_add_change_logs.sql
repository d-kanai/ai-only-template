CREATE TABLE "change_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"changes" jsonb NOT NULL,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "change_logs_table_name_row_id_index" ON "change_logs" USING btree ("table_name","row_id");