#!/bin/bash
# View only phone numbers that received messages (green emoji) - Live
docker compose logs -f master | grep --line-buffered "🟢 Sent to:" | sed 's/.*🟢 Sent to: /🟢 /'

