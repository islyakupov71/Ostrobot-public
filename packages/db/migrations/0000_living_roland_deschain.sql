CREATE TYPE "public"."kp_status" AS ENUM('new', 'contacted', 'awaiting_quote', 'received', 'shortlisted', 'rejected', 'declined', 'selected');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('task_assigned', 'task_no_reaction', 'deadline_approaching', 'deadline_today', 'task_overdue', 'task_status_stale', 'kp_awaiting_receipt', 'kp_overdue', 'report_due', 'report_missing', 'status_table_unfilled', 'manager_digest', 'escalation');--> statement-breakpoint
CREATE TYPE "public"."notification_target" AS ENUM('assignee', 'manager', 'both');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('lead', 'member', 'observer');--> statement-breakpoint
CREATE TYPE "public"."record_source" AS ENUM('bot', 'web', 'sheets', 'system');--> statement-breakpoint
CREATE TYPE "public"."report_cadence" AS ENUM('daily', 'weekly', 'biweekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('pending', 'submitted', 'late', 'missed');--> statement-breakpoint
CREATE TYPE "public"."task_event_type" AS ENUM('created', 'assigned', 'acknowledged', 'status_changed', 'deadline_changed', 'commented', 'reminder_sent', 'escalated', 'synced_from_sheets', 'synced_to_sheets');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('new', 'acknowledged', 'in_progress', 'blocked', 'submitted', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('task', 'kp', 'report', 'routine');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'manager', 'employee');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'disabled');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"payload" jsonb,
	"source" "record_source" DEFAULT 'bot' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"dedupe_key" text NOT NULL,
	"telegram_message_id" integer,
	"deferred_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_log_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"offset_minutes" integer DEFAULT 0 NOT NULL,
	"repeat_every_minutes" integer DEFAULT 0 NOT NULL,
	"max_repeats" integer DEFAULT 0 NOT NULL,
	"target" "notification_target" DEFAULT 'assignee' NOT NULL,
	"respect_quiet_hours" boolean DEFAULT true NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"message_template" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"drive_folder_id" text,
	"target_quotes" integer DEFAULT 3,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "project_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"spreadsheet_id" text,
	"status_sheet_name" text DEFAULT 'Статус-таблица',
	"tasks_sheet_name" text DEFAULT 'Задачи',
	"drive_folder_id" text,
	"drive_folder_url" text,
	"event_date" timestamp with time zone,
	"task_counter" integer DEFAULT 0 NOT NULL,
	"kp_counter" integer DEFAULT 0 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "quote_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_request_id" uuid NOT NULL,
	"actor_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb,
	"comment" text,
	"source" "record_source" DEFAULT 'bot' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"category_id" uuid,
	"vendor_id" uuid NOT NULL,
	"status" "kp_status" DEFAULT 'new' NOT NULL,
	"responsible_id" uuid,
	"amount" numeric(14, 2),
	"currency" text DEFAULT 'RUB' NOT NULL,
	"terms" text,
	"note" text,
	"requested_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"drive_file_id" text,
	"drive_file_url" text,
	"drive_file_name" text,
	"sheet_row" integer,
	"sheet_hash" text,
	"sheet_synced_at" timestamp with time zone,
	"updated_source" "record_source" DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "report_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"cadence" "report_cadence" NOT NULL,
	"due_time" text DEFAULT '18:00' NOT NULL,
	"weekdays" smallint[],
	"month_day" smallint,
	"fields" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"entity" text NOT NULL,
	"last_pulled_at" timestamp with time zone,
	"last_pushed_at" timestamp with time zone,
	"last_row" integer,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_id" uuid,
	"type" "task_event_type" NOT NULL,
	"payload" jsonb,
	"comment" text,
	"source" "record_source" DEFAULT 'bot' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" "task_type" DEFAULT 'task' NOT NULL,
	"status" "task_status" DEFAULT 'new' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"assignee_id" uuid,
	"author_id" uuid,
	"deadline_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"blocked_reason" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sheet_row" integer,
	"sheet_hash" text,
	"sheet_synced_at" timestamp with time zone,
	"updated_source" "record_source" DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" text,
	"telegram_username" text,
	"invite_code" text,
	"invite_expires_at" timestamp with time zone,
	"first_name" text NOT NULL,
	"last_name" text,
	"position" text,
	"role" "user_role" DEFAULT 'employee' NOT NULL,
	"status" "user_status" DEFAULT 'pending' NOT NULL,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"confirmed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id"),
	CONSTRAINT "users_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"contacts" text,
	"address" text,
	"kind" text,
	"notes" text,
	"is_blacklisted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_categories" ADD CONSTRAINT "procurement_categories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_quote_request_id_quote_requests_id_fk" FOREIGN KEY ("quote_request_id") REFERENCES "public"."quote_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_category_id_procurement_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."procurement_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_responsible_id_users_id_fk" FOREIGN KEY ("responsible_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_submissions" ADD CONSTRAINT "report_submissions_template_id_report_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."report_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_submissions" ADD CONSTRAINT "report_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reminders" ADD CONSTRAINT "scheduled_reminders_rule_id_notification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reminders" ADD CONSTRAINT "scheduled_reminders_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_log_recipient_idx" ON "notification_log" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_rules_scope_idx" ON "notification_rules" USING btree ("project_id","kind","offset_minutes");--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_categories_project_name_idx" ON "procurement_categories" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_archived_idx" ON "projects" USING btree ("is_archived");--> statement-breakpoint
CREATE INDEX "quote_events_request_idx" ON "quote_events" USING btree ("quote_request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_requests_project_vendor_idx" ON "quote_requests" USING btree ("project_id","vendor_id");--> statement-breakpoint
CREATE INDEX "quote_requests_responsible_idx" ON "quote_requests" USING btree ("responsible_id","status");--> statement-breakpoint
CREATE INDEX "quote_requests_category_idx" ON "quote_requests" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "quote_requests_pending_idx" ON "quote_requests" USING btree ("requested_at") WHERE "quote_requests"."status" in ('contacted', 'awaiting_quote');--> statement-breakpoint
CREATE INDEX "quote_requests_sheet_row_idx" ON "quote_requests" USING btree ("project_id","sheet_row");--> statement-breakpoint
CREATE UNIQUE INDEX "report_submission_unique_idx" ON "report_submissions" USING btree ("template_id","user_id","period_start");--> statement-breakpoint
CREATE INDEX "report_submissions_due_idx" ON "report_submissions" USING btree ("due_at","status");--> statement-breakpoint
CREATE INDEX "report_templates_active_idx" ON "report_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "scheduled_reminders" USING btree ("fire_at") WHERE "scheduled_reminders"."sent_at" is null and "scheduled_reminders"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "reminders_target_idx" ON "scheduled_reminders" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_state_scope_idx" ON "sync_state" USING btree ("project_id","entity");--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_project_number_idx" ON "tasks" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "tasks_assignee_status_idx" ON "tasks" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "tasks_project_status_idx" ON "tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "tasks_open_deadline_idx" ON "tasks" USING btree ("deadline_at") WHERE "tasks"."status" not in ('done', 'cancelled');--> statement-breakpoint
CREATE INDEX "tasks_unacknowledged_idx" ON "tasks" USING btree ("created_at") WHERE "tasks"."acknowledged_at" is null and "tasks"."status" = 'new';--> statement-breakpoint
CREATE INDEX "tasks_sheet_row_idx" ON "tasks" USING btree ("project_id","sheet_row");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_idx" ON "users" USING btree (lower("telegram_username")) WHERE "users"."telegram_username" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_name_lower_idx" ON "vendors" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "vendors_kind_idx" ON "vendors" USING btree ("kind");