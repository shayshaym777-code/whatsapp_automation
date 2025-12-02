-- Migration script for v9.1 - Add retry_count to message_queue
-- Run this script to add retry mechanism for failed messages

-- Add retry_count column to message_queue table
ALTER TABLE message_queue 
ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Add index for retry_count to help with queries
CREATE INDEX IF NOT EXISTS idx_queue_retry ON message_queue(status, retry_count) 
WHERE status = 'pending' AND retry_count > 0;

