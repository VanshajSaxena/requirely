CREATE TABLE "answers" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"selected_option_ids" jsonb NOT NULL,
	"custom_text" text,
	"additional_context" text,
	"answered_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"dimension" text NOT NULL,
	"about" text,
	"text" text NOT NULL,
	"mode" text NOT NULL,
	"options" jsonb NOT NULL,
	"rationale" text,
	"asked_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"status" text NOT NULL,
	"output_target" text,
	"question_budget" integer NOT NULL,
	"questions_asked" integer NOT NULL,
	"current_revision_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"derived_by" text NOT NULL,
	"origin" jsonb NOT NULL,
	"normalized_text" text,
	"segments" jsonb,
	"failure_reason" text,
	"ingested_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "sources_session_id_id_pk" PRIMARY KEY("session_id","id")
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"trigger" text NOT NULL,
	"input_source_ids" jsonb NOT NULL,
	"input_answer_ids" jsonb NOT NULL,
	"understanding_before" text,
	"understanding_after" text NOT NULL,
	"verdict" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"completed_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "understanding_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"revision" integer NOT NULL,
	"produced_by_turn_id" text,
	"content" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "understanding_revisions" ADD CONSTRAINT "understanding_revisions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_session_index_key" ON "turns" USING btree ("session_id","turn_index");--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_session_revision_key" ON "understanding_revisions" USING btree ("session_id","revision");