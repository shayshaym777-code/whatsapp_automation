-- ============================================
-- WhatsApp Multi-Docker Automation System
-- Database Schema v8.0 - Simple & Clean
-- ============================================
-- 
-- Tables:
--   - accounts: WhatsApp phone numbers (HEALTHY/BLOCKED)
--   - sessions: 4 backup sessions per phone
--   - campaigns: Campaign tracking
--   - proxies: Sticky proxy pool
--
-- v8.0: Removed warmup, stages, power scores, fingerprints
-- Simple: HEALTHY = working, BLOCKED = don't touch 48h
--
-- ============================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- ============================================
-- ACCOUNTS TABLE (v8.0 - Status from sessions)
-- Status: CONNECTED (🟢) or DISCONNECTED (🔴)
-- At least 1 session connected = CONNECTED
-- ============================================
CREATE TABLE IF NOT EXISTS accounts (
    phone VARCHAR(20) PRIMARY KEY,
    country VARCHAR(2),                     -- US, IL, GB
    proxy_id VARCHAR(50),                   -- Assigned sticky proxy
    messages_today INTEGER DEFAULT 0,
    last_message_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounts_country ON accounts(country);
-- ============================================
-- SESSIONS TABLE (v8.0 - 4 backups per phone)
-- ============================================
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL REFERENCES accounts(phone) ON DELETE CASCADE,
    session_number INTEGER NOT NULL,
    -- 1, 2, 3, or 4
    worker_id VARCHAR(50),
    status VARCHAR(20) DEFAULT 'DISCONNECTED',
    session_data TEXT,
    last_active TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT sessions_unique_phone_number UNIQUE (phone, session_number),
    CONSTRAINT sessions_number_check CHECK (
        session_number BETWEEN 1 AND 4
    ),
    CONSTRAINT sessions_status_check CHECK (
        status IN ('CONNECTED', 'DISCONNECTED')
    )
);
CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(phone, status)
WHERE status = 'CONNECTED';
-- ============================================
-- CAMPAIGNS TABLE (v8.0)
-- ============================================
CREATE TABLE IF NOT EXISTS campaigns (
    id VARCHAR(50) PRIMARY KEY DEFAULT ('camp_' || substr(md5(random()::text), 1, 8)),
    total INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    message_template TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT campaigns_status_check CHECK (
        status IN ('pending', 'in_progress', 'completed', 'failed')
    )
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
-- ============================================
-- PROXIES TABLE (v8.0 - Sticky proxies)
-- ============================================
CREATE TABLE IF NOT EXISTS proxies (
    proxy_id VARCHAR(50) PRIMARY KEY,
    country VARCHAR(2) NOT NULL,
    host VARCHAR(100) NOT NULL,
    port INTEGER NOT NULL,
    username VARCHAR(50),
    password VARCHAR(100),
    proxy_type VARCHAR(20) DEFAULT 'socks5',
    is_active BOOLEAN DEFAULT TRUE,
    assigned_phone VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_proxies_country ON proxies(country);
CREATE INDEX IF NOT EXISTS idx_proxies_available ON proxies(country, is_active)
WHERE is_active = TRUE
    AND assigned_phone IS NULL;
-- ============================================
-- SEND_LOG TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS send_log (
    id SERIAL PRIMARY KEY,
    campaign_id VARCHAR(50),
    phone VARCHAR(20) NOT NULL,
    recipient VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'SENT',
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_log_campaign ON send_log(campaign_id);
-- ============================================
-- FUNCTIONS
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = CURRENT_TIMESTAMP;
RETURN NEW;
END;
$$ language 'plpgsql';
-- Get active session for a phone (first connected one)
CREATE OR REPLACE FUNCTION get_active_session(p_phone VARCHAR(20)) RETURNS TABLE(
        session_id INTEGER,
        session_number INTEGER,
        worker_id VARCHAR(50)
    ) AS $$ BEGIN RETURN QUERY
SELECT s.id,
    s.session_number,
    s.worker_id
FROM sessions s
WHERE s.phone = p_phone
    AND s.status = 'CONNECTED'
ORDER BY s.session_number
LIMIT 1;
END;
$$ LANGUAGE plpgsql;
-- ============================================
-- TRIGGERS
-- ============================================
DROP TRIGGER IF EXISTS update_accounts_updated_at ON accounts;
CREATE TRIGGER update_accounts_updated_at BEFORE
UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
CREATE TRIGGER update_sessions_updated_at BEFORE
UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- ============================================
-- GRANTS
-- ============================================
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO whatsapp;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO whatsapp;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO whatsapp;
-- ============================================
-- COMMENTS
-- ============================================
COMMENT ON TABLE accounts IS 'v8.0: Simple - HEALTHY or BLOCKED, no warmup';
COMMENT ON TABLE sessions IS 'v8.0: 4 backup sessions per phone, auto-failover';
COMMENT ON TABLE campaigns IS 'v8.0: Campaign tracking';
COMMENT ON TABLE proxies IS 'v8.0: Sticky proxies - same IP for each phone';