CREATE TYPE "public"."project_status" AS ENUM('active', 'awaiting_edits', 'closed');--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'reviewed' BEFORE 'done';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'rework' BEFORE 'done';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'awaiting_approval' BEFORE 'done';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'head' BEFORE 'manager';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "status" "project_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");