CREATE TABLE "todo_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"todo_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"completed" boolean NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "todo_status_changes_todo_id_position_index" ON "todo_status_changes" USING btree ("todo_id","position");