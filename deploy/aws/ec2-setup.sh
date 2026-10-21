#!/usr/bin/env bash
# Install or update the service on an Amazon Linux 2023 EC2 instance.
#
# First deploy (in EC2 Instance Connect or SSH):
#   sudo dnf install -y git
#   git clone https://github.com/akshay-th/walnut-folks.git app && cd app
#   sudo bash deploy/aws/ec2-setup.sh      # creates the config file and stops
#   sudo nano /etc/transaction-webhook-service/app.env
#   sudo bash deploy/aws/ec2-setup.sh      # builds and starts the service
#
# Redeploy later:  git pull && sudo bash deploy/aws/ec2-setup.sh
set -euo pipefail

APP=transaction-webhook-service
CONFIG_DIR=/etc/$APP
ENV_FILE=$CONFIG_DIR/app.env
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

# 1. Docker (first run only)
if ! command -v docker >/dev/null 2>&1; then
  dnf install -y docker
  systemctl enable --now docker
fi

# 2. Configuration lives outside the repo, readable by root only, never committed.
install -d -m 700 "$CONFIG_DIR"
if [[ ! -f $ENV_FILE ]]; then
  install -m 600 "$REPO_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE."
  echo "Set DATABASE_URL in it, then run this script again."
  exit 1
fi
if grep -q '<project-ref>:<password>@' "$ENV_FILE"; then
  echo "DATABASE_URL in $ENV_FILE is still the placeholder." >&2
  exit 1
fi

# 3. Build the new image before touching the running container, to keep downtime short.
docker build --pull -t "$APP:latest" "$REPO_DIR"

# 4. Replace the container. "docker stop" sends SIGTERM and waits: in-flight
#    requests finish and running jobs are handed back to the queue, so the new
#    container resumes them immediately. Senders retry anything refused meanwhile.
docker stop -t 25 "$APP" >/dev/null 2>&1 || true
docker rm "$APP" >/dev/null 2>&1 || true
docker run -d --name "$APP" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" -e PORT=3000 \
  -p 80:3000 \
  --stop-timeout 25 \
  --log-opt max-size=10m --log-opt max-file=5 \
  "$APP:latest" >/dev/null
docker image prune -f >/dev/null

# 5. Wait until the health check passes.
for _ in $(seq 1 30); do
  if body=$(curl -fsS http://127.0.0.1/ 2>/dev/null); then
    echo "Deployed: $body"
    exit 0
  fi
  sleep 2
done
echo "Service did not become healthy. Last logs:" >&2
docker logs --tail 50 "$APP" >&2
exit 1
