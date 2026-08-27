CREATE TABLE "campaign_snapshots" (
	"campaign_id" text PRIMARY KEY NOT NULL,
	"sequence" integer NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_events" (
	"campaign_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_id" text NOT NULL,
	"timestamp" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_events_campaign_id_sequence_pk" PRIMARY KEY("campaign_id","sequence")
);
