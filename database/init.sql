-- ============================================
-- WhatsApp Multi-Docker Automation System
-- Database Schema Initialization
-- ============================================
-- 
-- Tables:
--   - workers: Worker instances and their status
--   - accounts: WhatsApp accounts managed by workers
--   - messages: Message queue and history
--   - campaigns: Bulk messaging campaigns
--   - proxies: Proxy server pool
--   - daily_stats: Daily statistics per account
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
-- ACCOUNTS TABLE
-- WhatsApp accounts connected to the system
-- ============================================
CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    country VARCHAR(5) NOT NULL,
    country_code VARCHAR(5) NOT NULL,
    worker_id INTEGER REFERENCES workers(id) ON DELETE
    SET NULL,
        -- Proxy configuration
        proxy_host VARCHAR(255),
        proxy_port INTEGER,
        proxy_username VARCHAR(100),
        proxy_password VARCHAR(255),
        proxy_type VARCHAR(20) DEFAULT 'http',
        -- Status and health
        status VARCHAR(20) NOT NULL DEFAULT 'disconnected',
        connection_state VARCHAR(30) DEFAULT 'idle',
        trust_score INTEGER NOT NULL DEFAULT 100,
        is_banned BOOLEAN NOT NULL DEFAULT FALSE,
        ban_reason TEXT,
        -- Message tracking
        messages_sent_today INTEGER NOT NULL DEFAULT 0,
        messages_sent_total INTEGER NOT NULL DEFAULT 0,
        last_message_at TIMESTAMP WITH TIME ZONE,
        -- Session data (encrypted in production)
        session_data TEXT,
        device_id VARCHAR(100),
        -- Timestamps
        connected_at TIMESTAMP WITH TIME ZONE,
        last_active_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT accounts_status_check CHECK (
            status IN (
                'connected',
                'disconnected',
                'connecting',
                'qr_pending',
                'banned',
                'error'
            )
        ),
        CONSTRAINT accounts_trust_score_check CHECK (
            trust_score >= 0
            AND trust_score <= 100
        )
);
-- Indexes for accounts
CREATE INDEX IF NOT EXISTS idx_accounts_country ON accounts(country);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_worker_id ON accounts(worker_id);
CREATE INDEX IF NOT EXISTS idx_accounts_trust_score ON accounts(trust_score);
CREATE INDEX IF NOT EXISTS idx_accounts_phone_country ON accounts(phone_number, country);
CREATE INDEX IF NOT EXISTS idx_accounts_messages_today ON accounts(messages_sent_today);
-- ============================================
-- MESSAGES TABLE
-- Message queue and delivery history
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Message routing
    from_phone VARCHAR(20) NOT NULL,
    from_account_id INTEGER REFERENCES accounts(id) ON DELETE
    SET NULL,
        to_phone VARCHAR(20) NOT NULL,
        worker_id INTEGER REFERENCES workers(id) ON DELETE
    SET NULL,
        -- Message content
        message_text TEXT NOT NULL,
        message_type VARCHAR(20) NOT NULL DEFAULT 'text',
        media_url TEXT,
        media_type VARCHAR(50),
        -- Campaign association
        campaign_id INTEGER,
        -- Status tracking
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        priority VARCHAR(10) NOT NULL DEFAULT 'normal',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        -- Timestamps
        scheduled_at TIMESTAMP WITH TIME ZONE,
        queued_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMP WITH TIME ZONE,
        delivered_at TIMESTAMP WITH TIME ZONE,
        read_at TIMESTAMP WITH TIME ZONE,
        failed_at TIMESTAMP WITH TIME ZONE,
        -- Error handling
        error_message TEXT,
        error_code VARCHAR(50),
        -- WhatsApp message ID
        wa_message_id VARCHAR(100),
        -- Timestamps
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
        CONSTRAINT messages_priority_check CHECK (priority IN ('high', 'normal', 'low')),
        CONSTRAINT messages_type_check CHECK (
            message_type IN (
                'text',
                'image',
                'video',
                'audio',
                'document',
                'location',
                'contact'
            )
        )
);
-- Indexes for messages
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_from_phone ON messages(from_phone);
CREATE INDEX IF NOT EXISTS idx_messages_to_phone ON messages(to_phone);
CREATE INDEX IF NOT EXISTS idx_messages_worker_id ON messages(worker_id);
CREATE INDEX IF NOT EXISTS idx_messages_campaign_id ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority);
CREATE INDEX IF NOT EXISTS idx_messages_scheduled_at ON messages(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_queued ON messages(status, priority, created_at)
WHERE status = 'queued';
-- ============================================
-- CAMPAIGNS TABLE
-- Bulk messaging campaigns
-- ============================================
CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    -- Message template
    message_template TEXT NOT NULL,
    message_type VARCHAR(20) NOT NULL DEFAULT 'text',
    media_url TEXT,
    -- Target configuration
    target_phones TEXT [] NOT NULL DEFAULT '{}',
    target_countries VARCHAR(5) [] DEFAULT '{}',
    total_recipients INTEGER NOT NULL DEFAULT 0,
    -- Execution settings
    from_accounts TEXT [] DEFAULT '{}',
    messages_per_account INTEGER DEFAULT 50,
    delay_between_messages INTEGER DEFAULT 3000,
    -- Status tracking
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    messages_queued INTEGER NOT NULL DEFAULT 0,
    messages_sent INTEGER NOT NULL DEFAULT 0,
    messages_delivered INTEGER NOT NULL DEFAULT 0,
    messages_failed INTEGER NOT NULL DEFAULT 0,
    -- Schedule
    scheduled_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    paused_at TIMESTAMP WITH TIME ZONE,
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(100),
    CONSTRAINT campaigns_status_check CHECK (
        status IN (
            'draft',
            'scheduled',
            'running',
            'paused',
            'completed',
            'cancelled',
            'failed'
        )
    )
);
-- Indexes for campaigns
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at ON campaigns(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at);
-- ============================================
-- PROXIES TABLE
-- Proxy server pool for account connections
-- ============================================
CREATE TABLE IF NOT EXISTS proxies (
    id SERIAL PRIMARY KEY,
    -- Proxy connection details
    host VARCHAR(255) NOT NULL,
    port INTEGER NOT NULL,
    username VARCHAR(100),
    password VARCHAR(255),
    proxy_type VARCHAR(20) NOT NULL DEFAULT 'http',
    -- Location
    country VARCHAR(5) NOT NULL,
    city VARCHAR(100),
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'available',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    -- Assignment
    assigned_account_id INTEGER REFERENCES accounts(id) ON DELETE
    SET NULL,
        assigned_at TIMESTAMP WITH TIME ZONE,
        -- Health tracking
        last_check_at TIMESTAMP WITH TIME ZONE,
        last_success_at TIMESTAMP WITH TIME ZONE,
        failure_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        avg_latency_ms INTEGER,
        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT proxies_status_check CHECK (
            status IN (
                'available',
                'assigned',
                'testing',
                'failed',
                'disabled'
            )
        ),
        CONSTRAINT proxies_type_check CHECK (
            proxy_type IN ('http', 'https', 'socks4', 'socks5')
        ),
        CONSTRAINT proxies_unique_host_port UNIQUE (host, port)
);
-- Indexes for proxies
CREATE INDEX IF NOT EXISTS idx_proxies_country ON proxies(country);
CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status);
CREATE INDEX IF NOT EXISTS idx_proxies_assigned_account ON proxies(assigned_account_id);
CREATE INDEX IF NOT EXISTS idx_proxies_available ON proxies(country, status)
WHERE status = 'available'
    AND is_active = TRUE;
-- ============================================
-- DAILY_STATS TABLE
-- Daily statistics per account for analytics
-- ============================================
CREATE TABLE IF NOT EXISTS daily_stats (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    account_phone VARCHAR(20) NOT NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE
    SET NULL,
        -- Message stats
        messages_sent INTEGER NOT NULL DEFAULT 0,
        messages_delivered INTEGER NOT NULL DEFAULT 0,
        messages_read INTEGER NOT NULL DEFAULT 0,
        messages_failed INTEGER NOT NULL DEFAULT 0,
        -- Rate stats
        delivery_rate DECIMAL(5, 2) DEFAULT 0,
        read_rate DECIMAL(5, 2) DEFAULT 0,
        -- Health stats
        trust_score_start INTEGER,
        trust_score_end INTEGER,
        connection_errors INTEGER NOT NULL DEFAULT 0,
        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT daily_stats_unique_date_phone UNIQUE (date, account_phone)
);
-- Indexes for daily_stats
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_account_phone ON daily_stats(account_phone);
CREATE INDEX IF NOT EXISTS idx_daily_stats_account_id ON daily_stats(account_id);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date_range ON daily_stats(date, account_phone);
-- ============================================
-- WARMUP_ACCOUNTS TABLE
-- Tracks account warmup progress
-- ============================================
CREATE TABLE IF NOT EXISTS warmup_accounts (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    worker_id VARCHAR(50) NOT NULL,
    country VARCHAR(5) NOT NULL,
    -- Warmup stages: new_born, baby, toddler, teen, adult
    stage VARCHAR(20) NOT NULL DEFAULT 'new_born',
    -- Message limits per stage
    -- new_born (day 1-3): max 5 messages/day
    -- baby (day 4-7): max 15 messages/day
    -- toddler (day 8-14): max 30 messages/day
    -- teen (day 15-30): max 50 messages/day
    -- adult (day 31+): max 100 messages/day
    max_messages_per_day INTEGER NOT NULL DEFAULT 5,
    messages_sent_today INTEGER NOT NULL DEFAULT 0,
    total_warmup_messages INTEGER NOT NULL DEFAULT 0,
    -- Warmup progress
    warmup_started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    warmup_completed_at TIMESTAMP WITH TIME ZONE,
    is_warmup_complete BOOLEAN NOT NULL DEFAULT FALSE,
    -- Last activity
    last_warmup_message_at TIMESTAMP WITH TIME ZONE,
    last_warmup_target VARCHAR(20),
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT warmup_stage_check CHECK (
        stage IN ('new_born', 'baby', 'toddler', 'teen', 'adult')
    )
);
-- Indexes for warmup_accounts
CREATE INDEX IF NOT EXISTS idx_warmup_accounts_phone ON warmup_accounts(phone_number);
CREATE INDEX IF NOT EXISTS idx_warmup_accounts_worker ON warmup_accounts(worker_id);
CREATE INDEX IF NOT EXISTS idx_warmup_accounts_stage ON warmup_accounts(stage);
CREATE INDEX IF NOT EXISTS idx_warmup_accounts_active ON warmup_accounts(is_warmup_complete)
WHERE is_warmup_complete = FALSE;
-- Trigger for warmup_accounts updated_at
CREATE TRIGGER update_warmup_accounts_updated_at BEFORE
UPDATE ON warmup_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- ============================================
-- WARMUP_STAGES TABLE
-- Defines warmup stage configuration
-- ============================================
CREATE TABLE IF NOT EXISTS warmup_stages (
    id SERIAL PRIMARY KEY,
    name VARCHAR(20) UNIQUE NOT NULL,
    min_days INTEGER NOT NULL,
    max_days INTEGER NOT NULL,
    daily_limit INTEGER NOT NULL,
    delay_seconds INTEGER NOT NULL,
    description TEXT
);
-- Insert default warmup stages
INSERT INTO warmup_stages (
        name,
        min_days,
        max_days,
        daily_limit,
        delay_seconds,
        description
    )
VALUES (
        'new_born',
        0,
        3,
        5,
        120,
        'Day 1-3: Very limited activity, 2 min delay'
    ),
    (
        'baby',
        4,
        7,
        15,
        90,
        'Day 4-7: Light activity, 1.5 min delay'
    ),
    (
        'toddler',
        8,
        14,
        30,
        60,
        'Day 8-14: Moderate activity, 1 min delay'
    ),
    (
        'teen',
        15,
        30,
        50,
        45,
        'Day 15-30: Normal activity, 45 sec delay'
    ),
    (
        'adult',
        31,
        9999,
        100,
        30,
        'Day 31+: Full activity, 30 sec delay'
    ) ON CONFLICT (name) DO NOTHING;
-- ============================================
-- WARMUP_MESSAGES TABLE
-- Logs all warmup messages sent
-- ============================================
CREATE TABLE IF NOT EXISTS warmup_messages (
    id SERIAL PRIMARY KEY,
    from_phone VARCHAR(20) NOT NULL,
    to_phone VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    message_id VARCHAR(100),
    worker_id VARCHAR(50),
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'sent',
    CONSTRAINT warmup_messages_status_check CHECK (status IN ('sent', 'delivered', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_warmup_messages_from ON warmup_messages(from_phone);
CREATE INDEX IF NOT EXISTS idx_warmup_messages_to ON warmup_messages(to_phone);
CREATE INDEX IF NOT EXISTS idx_warmup_messages_sent_at ON warmup_messages(sent_at);
-- ============================================
-- ACCOUNT_HEALTH TABLE
-- Tracks account safety scores and health
-- ============================================
CREATE TABLE IF NOT EXISTS account_health (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    -- Safety score (0-100)
    safety_score INTEGER NOT NULL DEFAULT 60,
    activity_score DECIMAL(5, 2) DEFAULT 50,
    age_score DECIMAL(5, 2) DEFAULT 20,
    trust_score DECIMAL(5, 2) DEFAULT 60,
    pattern_score DECIMAL(5, 2) DEFAULT 80,
    -- Delivery stats
    messages_sent INTEGER NOT NULL DEFAULT 0,
    messages_delivered INTEGER NOT NULL DEFAULT 0,
    messages_failed INTEGER NOT NULL DEFAULT 0,
    delivery_rate DECIMAL(5, 2) DEFAULT 100,
    -- Error tracking
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_at TIMESTAMP WITH TIME ZONE,
    -- Suspicious activity
    is_suspicious BOOLEAN NOT NULL DEFAULT FALSE,
    suspicious_reason TEXT,
    suspended_until TIMESTAMP WITH TIME ZONE,
    -- Recommended action: normal, slow, very_slow, pause, stop
    recommended_action VARCHAR(20) DEFAULT 'normal',
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_account_health_phone ON account_health(phone_number);
CREATE INDEX IF NOT EXISTS idx_account_health_score ON account_health(safety_score);
CREATE INDEX IF NOT EXISTS idx_account_health_suspicious ON account_health(is_suspicious)
WHERE is_suspicious = TRUE;
CREATE TRIGGER update_account_health_updated_at BEFORE
UPDATE ON account_health FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
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
    worker_id INTEGER REFERENCES workers(id) ON DELETE
    SET NULL,
        account_id INTEGER REFERENCES accounts(id) ON DELETE
    SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT system_logs_level_check CHECK (
            level IN ('debug', 'info', 'warn', 'error', 'fatal')
        )
);
-- Indexes for system_logs
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_system_logs_source ON system_logs(source);
CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_system_logs_worker_id ON system_logs(worker_id);
-- ============================================
-- FUNCTIONS
-- ============================================
-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = CURRENT_TIMESTAMP;
RETURN NEW;
END;
$$ language 'plpgsql';
-- ============================================
-- TRIGGERS
-- ============================================
-- Auto-update updated_at for all tables
CREATE TRIGGER update_workers_updated_at BEFORE
UPDATE ON workers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_accounts_updated_at BEFORE
UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_messages_updated_at BEFORE
UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_campaigns_updated_at BEFORE
UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_proxies_updated_at BEFORE
UPDATE ON proxies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_daily_stats_updated_at BEFORE
UPDATE ON daily_stats FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
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
COMMENT ON TABLE workers IS 'Worker instances that handle WhatsApp connections';
COMMENT ON TABLE accounts IS 'WhatsApp accounts connected to the system';
COMMENT ON TABLE messages IS 'Message queue and delivery history';
COMMENT ON TABLE campaigns IS 'Bulk messaging campaigns';
COMMENT ON TABLE proxies IS 'Proxy server pool for account connections';
COMMENT ON TABLE daily_stats IS 'Daily statistics per account for analytics';
COMMENT ON TABLE system_logs IS 'System-wide logging for debugging';
COMMENT ON COLUMN accounts.trust_score IS 'Account health score (0-100). Decreases on failures, increases on successful sends';
COMMENT ON COLUMN accounts.messages_sent_today IS 'Reset daily. Max 100 per day for anti-ban';
COMMENT ON COLUMN workers.proxy_country IS 'Country code (US, IL, GB) for routing messages by phone prefix';
COMMENT ON COLUMN messages.priority IS 'high: immediate, normal: standard queue, low: batch processing';