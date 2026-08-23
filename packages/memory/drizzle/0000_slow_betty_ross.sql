CREATE TABLE "game_events" (
	"session_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_id" text NOT NULL,
	"timestamp" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_events_session_id_sequence_pk" PRIMARY KEY("session_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "session_snapshots" (
	"session_id" text PRIMARY KEY NOT NULL,
	"sequence" integer NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
