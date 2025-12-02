#!/bin/bash
# Test database connection from Master container

echo "📊 Testing database connection from Master container..."

docker compose exec master node -e "
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.query('SELECT COUNT(*) FROM message_queue')
  .then(result => {
    console.log('✅ message_queue table exists! Count:', result.rows[0].count);
    return pool.query('SELECT COUNT(*) FROM chat_history');
  })
  .then(result => {
    console.log('✅ chat_history table exists! Count:', result.rows[0].count);
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
"

