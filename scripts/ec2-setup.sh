#!/bin/bash
# ec2-setup.sh — Run once on a fresh EC2 t2.micro (Amazon Linux 2023)
# Usage: bash ec2-setup.sh
set -e

echo "=== ClawWorld EC2 Setup ==="

# 1. Node.js 22
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs git postgresql15

# 2. PM2
sudo npm install -g pm2
pm2 startup | tail -1 | sudo bash  # 开机自启

# 3. 创建项目目录
sudo mkdir -p /opt/clawworld
sudo chown ec2-user:ec2-user /opt/clawworld

echo ""
echo "=== Setup Complete ==="
echo "Next steps:"
echo "  1. Add GitHub Secrets (see docs/DEPLOY.md)"
echo "  2. Push to main → auto-deploy triggers"
echo "  3. Check: pm2 list"
