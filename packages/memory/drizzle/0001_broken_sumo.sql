CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE "episodic_memories" (
	"campaign_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"summary_english" text NOT NULL,
	"day" integer NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "episodic_memories_campaign_id_sequence_pk" PRIMARY KEY("campaign_id","sequence")
);
