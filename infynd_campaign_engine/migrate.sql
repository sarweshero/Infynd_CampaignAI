-- Infynd Campaign Engine - Full Database Schema
-- Run: psql -U postgres -d <your_db> -f migrate.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$ BEGIN
    CREATE TYPE pipeline_state_enum AS ENUM (
        'CREATED', 'CLASSIFIED', 'CONTACTS_RETRIEVED', 'CHANNEL_DECIDED',
        'CONTENT_GENERATED', 'AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED',
        'COMPLETED', 'FAILED'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS campaigns (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR(255) NOT NULL,
    company           VARCHAR(255),
    campaign_purpose  TEXT,
    target_audience   TEXT,
    product_link      TEXT,
    prompt            TEXT,
    platform          VARCHAR(50),
    approval_required BOOLEAN      NOT NULL DEFAULT TRUE,
    pipeline_locked   BOOLEAN      NOT NULL DEFAULT FALSE,
    pipeline_state    pipeline_state_enum NOT NULL DEFAULT 'CREATED',
    generated_content JSON,
    approval_status   VARCHAR(50)  DEFAULT 'PENDING',
    approved_at       TIMESTAMP,
    approved_by       VARCHAR(255),
    created_by        VARCHAR(255),
    created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email             VARCHAR(255) NOT NULL UNIQUE,
    name              VARCHAR(255),
    role              VARCHAR(255),
    company           VARCHAR(255),
    location          VARCHAR(255),
    category          VARCHAR(255),
    emailclickrate    FLOAT,
    linkedinclickrate FLOAT,
    callanswerrate    FLOAT,
    preferredtime     VARCHAR(100),
    phone_number      VARCHAR(50),
    created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_contacts_email ON contacts (email);

CREATE TABLE IF NOT EXISTS icp_results (
    id                       UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id               UUID  NOT NULL REFERENCES contacts (id),
    buying_probability_score FLOAT,
    icp_match                VARCHAR(50),
    notes                    TEXT,
    created_at               TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_icp_results_contact_id ON icp_results (contact_id);

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id            UUID        NOT NULL REFERENCES campaigns (id),
    state                  VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    classification_summary JSON,
    downstream_results     JSON,
    started_at             TIMESTAMP   NOT NULL DEFAULT NOW(),
    completed_at           TIMESTAMP,
    error_message          TEXT
);
CREATE INDEX IF NOT EXISTS ix_pipeline_runs_campaign_id ON pipeline_runs (campaign_id);

CREATE TABLE IF NOT EXISTS campaign_logs (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id   UUID         NOT NULL REFERENCES campaigns (id),
    agent_name    VARCHAR(100) NOT NULL,
    started_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMP,
    duration_ms   INTEGER,
    status        VARCHAR(50)  NOT NULL DEFAULT 'RUNNING',
    error_message TEXT,
    metadata      JSON
);
CREATE INDEX IF NOT EXISTS ix_campaign_logs_campaign_id ON campaign_logs (campaign_id);

CREATE TABLE IF NOT EXISTS outbound_messages (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID         NOT NULL REFERENCES campaigns (id),
    contact_email       VARCHAR(255) NOT NULL,
    channel             VARCHAR(50)  NOT NULL,
    message_payload     TEXT,
    send_status         VARCHAR(50)  DEFAULT 'PENDING',
    provider_message_id VARCHAR(255),
    sent_at             TIMESTAMP,
    created_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_outbound_messages_campaign_id     ON outbound_messages (campaign_id);
CREATE INDEX IF NOT EXISTS ix_outbound_messages_contact_email   ON outbound_messages (contact_email);
CREATE INDEX IF NOT EXISTS ix_outbound_messages_provider_msg_id ON outbound_messages (provider_message_id);

CREATE TABLE IF NOT EXISTS email_tracking_events (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id   UUID,
    contact_email VARCHAR(255) NOT NULL,
    event_type    VARCHAR(50)  NOT NULL,
    message_id    VARCHAR(255),
    event_at      BIGINT,
    raw_payload   JSON,
    created_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_email_tracking_events_campaign_id   ON email_tracking_events (campaign_id);
CREATE INDEX IF NOT EXISTS ix_email_tracking_events_contact_email ON email_tracking_events (contact_email);

CREATE TABLE IF NOT EXISTS engagement_history (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id   UUID         NOT NULL REFERENCES campaigns (id),
    contact_email VARCHAR(255) NOT NULL,
    channel       VARCHAR(50)  NOT NULL,
    event_type    VARCHAR(50)  NOT NULL,
    payload       JSON,
    occurred_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_engagement_history_campaign_id   ON engagement_history (campaign_id);
CREATE INDEX IF NOT EXISTS ix_engagement_history_contact_email ON engagement_history (contact_email);

CREATE TABLE IF NOT EXISTS conversion_events (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id   UUID         NOT NULL REFERENCES campaigns (id),
    contact_email VARCHAR(255) NOT NULL,
    event_type    VARCHAR(100) NOT NULL,
    value         FLOAT,
    metadata      JSON,
    occurred_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_conversion_events_campaign_id   ON conversion_events (campaign_id);
CREATE INDEX IF NOT EXISTS ix_conversion_events_contact_email ON conversion_events (contact_email);

-- ── Voice Calls ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS voice_calls (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id       UUID         NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
    contact_name      VARCHAR(255),
    contact_email     VARCHAR(255),
    contact_phone     VARCHAR(50),
    call_sid          VARCHAR(100) UNIQUE,
    status            VARCHAR(50)  NOT NULL DEFAULT 'initiated',
    conversation_log  JSONB,
    created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_voice_calls_campaign_id    ON voice_calls (campaign_id);
CREATE INDEX IF NOT EXISTS ix_voice_calls_contact_email  ON voice_calls (contact_email);
CREATE INDEX IF NOT EXISTS ix_voice_calls_call_sid       ON voice_calls (call_sid);