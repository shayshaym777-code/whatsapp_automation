#!/bin/bash
# Update workers - stash local changes first
cd ~/whatsapp_automation/docker
cd .. && git stash && cd docker
git pull origin main
docker compose up -d --build worker-1 worker-2 worker-3

