#!/bin/bash
# EC2 user-data for the Kita staging desk (mirrors prod's). Logs: /var/log/cloud-init-output.log
set -eux
apt-get update && apt-get install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com | sh
git clone --branch staging https://github.com/carmelvl/chatwoot.git /opt/chatwoot-staging
bash /opt/chatwoot-staging/deployment/kita-staging/bootstrap.sh
