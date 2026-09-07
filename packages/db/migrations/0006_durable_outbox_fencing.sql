CREATE TABLE IF NOT EXISTS "outbox" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"decision_id" varchar(128) NOT NULL,
	"action" varchar(64) NOT NULL,
	"payload" text,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"claim_owner" varchar(128),
	"claim_expiry" timestamp with time zone,
	"fencing_token" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "execution_attempts" ADD COLUMN IF NOT EXISTS "fencing_token" integer DEFAULT 0 NOT NULL;

DO $$ BEGIN
 ALTER TABLE "outbox" ADD CONSTRAINT "outbox_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "outbox" ADD CONSTRAINT "outbox_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_outbox_status_expiry" ON "outbox" USING btree ("status","claim_expiry");
CREATE INDEX IF NOT EXISTS "idx_outbox_decision_id" ON "outbox" USING btree ("decision_id");
CREATE INDEX IF NOT EXISTS "idx_outbox_session_id" ON "outbox" USING btree ("session_id");
