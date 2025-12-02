#!/bin/bash
# View important logs in real-time
docker compose logs -f master | grep -E "(📥 Received|✅ Added|📊 Contacts|⏳.*waiting|📤 Processing|🟢 Sent to:|✅ Sent|❌ Failed|🚨 BLOCKED|📊 Batch|✅ Campaign.*COMPLETED|⚠️ No available|Error|error|POST.*send|GET.*accounts)" --line-buffered


