-- ============================================
-- WhatsApp Multi-Docker Automation System
-- Database Schema Initialization v7.0
-- ============================================
-- 
-- Tables:
--   - workers: Worker instances and their status
--   - accounts: WhatsApp accounts (phone numbers)
--   - sessions: Multiple sessions per account (4 backups)
--   - messages: Message queue and history
--   - campaigns: Bulk messaging campaigns
--   - proxies: Proxy server pool
--   - daily_stats: Daily statistics per account
--   - send_log: Message send history
--
-- v7.0 Changes:
--   - Added sessions table (4 sessions per phone)
--   - Updated accounts with is_new, power, stage fields
--   - Updated warmup stages (Baby, Toddler, Teen, Adult, Veteran)
--
-- ============================================
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- ============================================
-- WORKERS TABLE
-- Tracks all worker instances in the system
-- ============================================
CREATE TABLE IF NOT EXISTS workers (
    id SERIAL PRIMARY KEY,
    worker_id VARCHAR(50) UNIQUE NOT NULL,
    host VARCHAR(255) NOT NULL,
    port INTEGER NOT NULL DEFAULT 3001,
    proxy_country VARCHAR(5) NOT NULL,
    max_accounts INTEGER NOT NULL DEFAULT 10,
    current_accounts INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'offline',
    device_seed VARCHAR(100),
    fingerprint_data JSONB,
    last_heartbeat TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT workers_status_check CHECK (
        status IN (
            'online',
            'offline',
            'busy',
            'error',
            'maintenance'
        )
    )
);
-- Indexes for workers
CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
CREATE INDEX IF NOT EXISTS idx_workers_proxy_country ON workers(proxy_country);
CREATE INDEX IF NOT EXISTS idx_workers_last_heartbeat ON workers(last_heartbeat);
-- ============================================
-- ACCOUNTS TABLE (v7.0)
-- WhatsApp accounts (phone numbers) - each can have 4 sessions
-- ============================================
CREATE TABLE IF NOT EXISTS accounts (
    phone VARCHAR(20) PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'HEALTHY',
    is_new BOOLEAN DEFAULT FALSE,
    -- v7.0: Manual flag for new device warmup
    stage VARCHAR(20) DEFAULT 'Adult',
    -- v7.0: Baby, Toddler, Teen, Adult, Veteran
    power INTEGER DEFAULT 100,
    -- v7.0: Power score for load distribution
    max_per_day INTEGER DEFAULT 100,
    -- Daily message limit based on stage
    messages_today INTEGER DEFAULT 0,
    country VARCHAR(2),
    -- US, IL, GB
    proxy_id VARCHAR(50),
    -- Assigned sticky proxy
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    blocked_at TIMESTAMP WITH TIME ZONE,
    last_message_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT accounts_status_check CHECK (
        status IN (
            'HEALTHY',
            'WARMING',
            'DISCONNECTED',
            'BLOCKED'
        )
    ),
    CONSTRAINT accounts_stage_check CHECK (
        stage IN (
            'WARMING',
            'Baby',
            'Toddler',
            'Teen',
            'Adult',
            'Veteran'
        )
    )
);
-- Indexes for accounts
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_country ON accounts(country);
CREATE INDEX IF NOT EXISTS idx_accounts_stage ON accounts(stage);
CREATE INDEX IF NOT EXISTS idx_accounts_is_new ON accounts(is_new)
WHERE is_new = TRUE;
-- ============================================
-- SESSIONS TABLE (v7.0 - with unique fingerprints)
-- Multiple sessions per phone number (4 backups)
-- Each session has unique fingerprint + proxy
-- ============================================
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL REFERENCES accounts(phone) ON DELETE CASCADE,
    session_number INTEGER NOT NULL,        -- 1, 2, 3, or 4
    worker_id VARCHAR(50),                  -- Which worker manages this session
    
    -- Fingerprint (unique per session!)
    user_agent TEXT,                        -- Browser user agent
    screen_width INTEGER,                   -- Screen resolution width
    screen_height INTEGER,                  -- Screen resolution height
    timezone VARCHAR(50),                   -- Must match phone country!
    language VARCHAR(10) DEFAULT 'en-US',   -- Browser language
    
    -- Proxy (different for each session!)
    proxy_id VARCHAR(50),                   -- Reference to proxies table
    proxy_ip VARCHAR(45),                   -- Cached proxy IP
    
    -- Status
    status VARCHAR(20) DEFAULT 'DISCONNECTED',
    session_data TEXT,                      -- Encrypted session data
    last_active TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT sessions_unique_phone_number UNIQUE (phone, session_number),
    CONSTRAINT sessions_number_check CHECK (session_number BETWEEN 1 AND 4),
    CONSTRAINT sessions_status_check CHECK (
        status IN (
            'CONNECTED',
            'DISCONNECTED',
            'CONNECTING'
        )
    )
);

-- Indexes for sessions
CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_worker ON sessions(worker_id);
CREATE INDEX IF NOT EXISTS idx_sessions_proxy ON sessions(proxy_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(phone, status)
WHERE status = 'CONNECTED';
-- ============================================
-- SEND_LOG TABLE (v7.0)
-- Message send history
-- ============================================
CREATE TABLE IF NOT EXISTS send_log (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    -- Sender phone
    recipient VARCHAR(20) NOT NULL,
    -- Recipient phone
    content TEXT,
    status VARCHAR(20) DEFAULT 'SENT',
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    error TEXT,
    campaign_id INTEGER,
    CONSTRAINT send_log_status_check CHECK (
        status IN ('SENT', 'DELIVERED', 'FAILED', 'READ')
    )
);
-- Indexes for send_log
CREATE INDEX IF NOT EXISTS idx_send_log_phone ON send_log(phone);
CREATE INDEX IF NOT EXISTS idx_send_log_recipient ON send_log(recipient);
CREATE INDEX IF NOT EXISTS idx_send_log_sent_at ON send_log(sent_at);
CREATE INDEX IF NOT EXISTS idx_send_log_campaign ON send_log(campaign_id);
-- ============================================
-- PROXIES TABLE (v7.0)
-- Sticky proxy pool for account connections
-- ============================================
CREATE TABLE IF NOT EXISTS proxies (
    proxy_id VARCHAR(50) PRIMARY KEY,
    country VARCHAR(2) NOT NULL,
    -- US, IL, GB
    host VARCHAR(100) NOT NULL,
    port INTEGER NOT NULL,
    username VARCHAR(50),
    password VARCHAR(100),
    proxy_type VARCHAR(20) DEFAULT 'socks5',
    is_active BOOLEAN DEFAULT TRUE,
    assigned_phone VARCHAR(20),
    -- Which phone is using this proxy
    assigned_at TIMESTAMP WITH TIME ZONE,
    last_check_at TIMESTAMP WITH TIME ZONE,
    failure_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT proxies_type_check CHECK (
        proxy_type IN ('http', 'https', 'socks4', 'socks5')
    )
);
-- Indexes for proxies
CREATE INDEX IF NOT EXISTS idx_proxies_country ON proxies(country);
CREATE INDEX IF NOT EXISTS idx_proxies_active ON proxies(is_active)
WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_proxies_available ON proxies(country, is_active)
WHERE is_active = TRUE
    AND assigned_phone IS NULL;
-- ============================================
-- CAMPAIGNS TABLE (v7.0)
-- Bulk messaging campaigns
-- ============================================
CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    campaign_id VARCHAR(50) UNIQUE DEFAULT ('camp_' || substr(md5(random()::text), 1, 8)),
    name VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending',
    message_template TEXT NOT NULL,
    total_contacts INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT campaigns_status_check CHECK (
        status IN (
            'pending',
            'in_progress',
            'completed',
            'paused',
            'cancelled',
            'failed'
        )
    )
);
-- Indexes for campaigns
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_campaign_id ON campaigns(campaign_id);
-- ============================================
-- MESSAGES TABLE
-- Message queue and delivery history
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_phone VARCHAR(20) NOT NULL,
    to_phone VARCHAR(20) NOT NULL,
    message_text TEXT NOT NULL,
    message_type VARCHAR(20) NOT NULL DEFAULT 'text',
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE
    SET NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        priority VARCHAR(10) NOT NULL DEFAULT 'normal',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        scheduled_at TIMESTAMP WITH TIME ZONE,
        queued_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMP WITH TIME ZONE,
        delivered_at TIMESTAMP WITH TIME ZONE,
        failed_at TIMESTAMP WITH TIME ZONE,
        error_message TEXT,
        wa_message_id VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT messages_status_check CHECK (
            status IN (
                'queued',
                'processing',
                'sent',
                'delivered',
                'read',
                'failed',
                'cancelled'
            )
        ),
        CONSTRAINT messages_priority_check CHECK (priority IN ('high', 'normal', 'low'))
);
-- Indexes for messages
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_from_phone ON messages(from_phone);
CREATE INDEX IF NOT EXISTS idx_messages_to_phone ON messages(to_phone);
CREATE INDEX IF NOT EXISTS idx_messages_campaign_id ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_queued ON messages(status, priority, created_at)
WHERE status = 'queued';
-- ============================================
-- DAILY_STATS TABLE
-- Daily statistics per account for analytics
-- ============================================
CREATE TABLE IF NOT EXISTS daily_stats (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    phone VARCHAR(20) NOT NULL,
    messages_sent INTEGER NOT NULL DEFAULT 0,
    messages_delivered INTEGER NOT NULL DEFAULT 0,
    messages_failed INTEGER NOT NULL DEFAULT 0,
    delivery_rate DECIMAL(5, 2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT daily_stats_unique_date_phone UNIQUE (date, phone)
);
-- Indexes for daily_stats
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_phone ON daily_stats(phone);
-- ============================================
-- WARMUP_STAGES TABLE (v7.0 Updated)
-- Defines warmup stage configuration
-- ============================================
CREATE TABLE IF NOT EXISTS warmup_stages (
    id SERIAL PRIMARY KEY,
    name VARCHAR(20) UNIQUE NOT NULL,
    min_days INTEGER NOT NULL,
    max_days INTEGER NOT NULL,
    daily_limit INTEGER NOT NULL,
    power INTEGER NOT NULL,
    -- v7.0: Power score
    description TEXT
);
-- Insert v7.0 warmup stages
INSERT INTO warmup_stages (
        name,
        min_days,
        max_days,
        daily_limit,
        power,
        description
    )
VALUES (
        'WARMING',
        1,
        3,
        5,
        0,
        'Day 1-3: Only internal warmup, no campaigns'
    ),
    ('Baby', 4, 7, 15, 15, 'Day 4-7: Light activity'),
    (
        'Toddler',
        8,
        14,
        30,
        30,
        'Day 8-14: Moderate activity'
    ),
    (
        'Teen',
        15,
        30,
        50,
        50,
        'Day 15-30: Normal activity'
    ),
    (
        'Adult',
        31,
        60,
        100,
        100,
        'Day 31-60: Full activity'
    ),
    (
        'Veteran',
        61,
        9999,
        200,
        200,
        'Day 60+: Maximum capacity'
    ) ON CONFLICT (name) DO
UPDATE
SET min_days = EXCLUDED.min_days,
    max_days = EXCLUDED.max_days,
    daily_limit = EXCLUDED.daily_limit,
    power = EXCLUDED.power,
    description = EXCLUDED.description;
-- ============================================
-- ACCOUNT_HEALTH TABLE
-- Tracks account safety scores and health
-- ============================================
CREATE TABLE IF NOT EXISTS account_health (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) UNIQUE NOT NULL,
    safety_score INTEGER NOT NULL DEFAULT 60,
    messages_sent INTEGER NOT NULL DEFAULT 0,
    messages_delivered INTEGER NOT NULL DEFAULT 0,
    messages_failed INTEGER NOT NULL DEFAULT 0,
    delivery_rate DECIMAL(5, 2) DEFAULT 100,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_at TIMESTAMP WITH TIME ZONE,
    is_suspicious BOOLEAN NOT NULL DEFAULT FALSE,
    suspicious_reason TEXT,
    suspended_until TIMESTAMP WITH TIME ZONE,
    recommended_action VARCHAR(20) DEFAULT 'normal',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_account_health_phone ON account_health(phone);
CREATE INDEX IF NOT EXISTS idx_account_health_score ON account_health(safety_score);
-- ============================================
-- SYSTEM_LOGS TABLE
-- System-wide logging for debugging
-- ============================================
CREATE TABLE IF NOT EXISTS system_logs (
    id SERIAL PRIMARY KEY,
    level VARCHAR(10) NOT NULL DEFAULT 'info',
    source VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT system_logs_level_check CHECK (
        level IN ('debug', 'info', 'warn', 'error', 'fatal')
    )
);
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);
-- ============================================
-- FUNCTIONS
-- ============================================
-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = CURRENT_TIMESTAMP;
RETURN NEW;
END;
$$ language 'plpgsql';
-- Function to get active session for a phone
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
-- Function to count connected sessions for a phone
CREATE OR REPLACE FUNCTION count_connected_sessions(p_phone VARCHAR(20)) RETURNS INTEGER AS $$
DECLARE session_count INTEGER;
BEGIN
SELECT COUNT(*) INTO session_count
FROM sessions
WHERE phone = p_phone
    AND status = 'CONNECTED';
RETURN session_count;
END;
$$ LANGUAGE plpgsql;
-- ============================================
-- TRIGGERS
-- ============================================
-- Auto-update updated_at for all tables
DROP TRIGGER IF EXISTS update_accounts_updated_at ON accounts;
CREATE TRIGGER update_accounts_updated_at BEFORE
UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
CREATE TRIGGER update_sessions_updated_at BEFORE
UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_campaigns_updated_at ON campaigns;
CREATE TRIGGER update_campaigns_updated_at BEFORE
UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_proxies_updated_at ON proxies;
CREATE TRIGGER update_proxies_updated_at BEFORE
UPDATE ON proxies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_daily_stats_updated_at ON daily_stats;
CREATE TRIGGER update_daily_stats_updated_at BEFORE
UPDATE ON daily_stats FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_account_health_updated_at ON account_health;
CREATE TRIGGER update_account_health_updated_at BEFORE
UPDATE ON account_health FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- ============================================
-- INITIAL DATA
-- ============================================
-- Insert default workers (will be updated when workers connect)
INSERT INTO workers (
        worker_id,
        host,
        port,
        proxy_country,
        max_accounts,
        status,
        device_seed
    )
VALUES (
        'worker-1',
        'worker-1',
        3001,
        'US',
        10,
        'offline',
        'unique-seed-worker-1-usa-abc123'
    ),
    (
        'worker-2',
        'worker-2',
        3001,
        'IL',
        10,
        'offline',
        'unique-seed-worker-2-israel-xyz789'
    ),
    (
        'worker-3',
        'worker-3',
        3001,
        'GB',
        10,
        'offline',
        'unique-seed-worker-3-uk-qwe456'
    ),
    (
        'worker-4',
        'worker-4',
        3001,
        'US',
        10,
        'offline',
        'unique-seed-worker-4-usa-def456'
    ) ON CONFLICT (worker_id) DO NOTHING;
-- ============================================
-- GRANTS (for security)
-- ============================================
-- Grant permissions to whatsapp user
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO whatsapp;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO whatsapp;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO whatsapp;
-- ============================================
-- COMMENTS
-- ============================================
COMMENT ON TABLE accounts IS 'WhatsApp phone numbers with status and warmup stage';
COMMENT ON TABLE sessions IS 'Multiple sessions per phone (4 backups) for automatic failover';
COMMENT ON TABLE send_log IS 'Message send history';
COMMENT ON TABLE proxies IS 'Sticky proxy pool - each phone gets a fixed proxy';
COMMENT ON TABLE campaigns IS 'Bulk messaging campaigns';
COMMENT ON COLUMN accounts.is_new IS 'v7.0: Manual flag - if TRUE, account enters 3-day warmup';
COMMENT ON COLUMN accounts.power IS 'v7.0: Power score for load distribution (0-200)';
COMMENT ON COLUMN accounts.stage IS 'v7.0: Warmup stage determines daily limits';
COMMENT ON COLUMN sessions.session_number IS 'v7.0: 1-4, each phone can have 4 backup sessions';