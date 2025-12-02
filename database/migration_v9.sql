-- Migration script for v9.0 - Add new tables and columns
-- Run this script on existing database to add message_queue and chat_history tables

-- Add new columns to accounts table
ALTER TABLE accounts 
ADD COLUMN IF NOT EXISTS messages_last_minute INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS messages_in_session INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_messages_sent INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS successful_messages INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_message_minute_reset TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Create chat_history table
CREATE TABLE IF NOT EXISTS chat_history (
    sender_phone VARCHAR(20) NOT NULL,
    recipient_phone VARCHAR(20) NOT NULL,
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (sender_phone, recipient_phone),
    FOREIGN KEY (sender_phone) REFERENCES accounts(phone) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_history_recipient ON chat_history(recipient_phone);
CREATE INDEX IF NOT EXISTS idx_chat_history_last_message ON chat_history(last_message_at);

-- Create message_queue table
CREATE TABLE IF NOT EXISTS message_queue (
    id SERIAL PRIMARY KEY,
    campaign_id VARCHAR(50),
    recipient_phone VARCHAR(20) NOT NULL,
    recipient_name VARCHAR(100),
    message_template TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    assigned_sender VARCHAR(20),
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT queue_status_check CHECK (status IN ('pending', 'processing', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON message_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_priority ON message_queue(priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_campaign ON message_queue(campaign_id);

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE chat_history TO whatsapp;
GRANT ALL PRIVILEGES ON TABLE message_queue TO whatsapp;
GRANT USAGE, SELECT ON SEQUENCE message_queue_id_seq TO whatsapp;

