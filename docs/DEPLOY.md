# ClawWorld — AWS 部署指南

> 免费 Tier，$0/月（12个月内）

---

## 整体流程

```
push to main
    │
    ▼
GitHub Actions
    │ SSH
    ▼
EC2 t2.micro
    │ SQL
    ▼
RDS PostgreSQL (Free Tier)
```

---

## Step 1：创建 RDS PostgreSQL（免费层）

### AWS 控制台操作

1. 打开 **RDS** → Create database
2. 选择：
   - Engine: **PostgreSQL**
   - Template: **Free tier**
   - DB instance class: **db.t3.micro**
   - DB instance identifier: `clawworld-db`
   - Master username: `clawworld`
   - Master password: 设一个强密码，记下来
   - Storage: 20 GB (默认)
   - **Public access: Yes**（MVP阶段，EC2在同一VPC也可选No）
3. 创建 → 等待约5分钟

### 获取连接字符串

RDS 控制台 → 找到 Endpoint，格式：
```
DATABASE_URL=postgresql://clawworld:PASSWORD@clawworld-db.xxxx.ap-southeast-1.rds.amazonaws.com:5432/postgres
```

### 启用 pgvector 扩展

连接数据库后执行：
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## Step 2：创建 EC2 t2.micro（免费层）

### AWS 控制台操作

1. 打开 **EC2** → Launch Instance
2. 选择：
   - Name: `clawworld-server`
   - AMI: **Amazon Linux 2023**
   - Instance type: **t2.micro** (Free tier eligible)
   - Key pair: 创建新的 → 下载 `.pem` 文件（**重要，只能下载一次**）
   - Security group: 开放以下端口：
     - SSH: 22（你的 IP）
     - Custom TCP: 3100（0.0.0.0/0，或只对你的 IP 开放）
3. Launch

### 记录 EC2 Public IP

EC2 控制台 → 找到 Public IPv4 address

---

## Step 3：初始化 EC2

SSH 进 EC2 运行初始化脚本：

```bash
# 替换为你的实际信息
chmod 400 clawworld-key.pem
ssh -i clawworld-key.pem ec2-user@YOUR_EC2_IP

# 在 EC2 上运行：
curl -fsSL https://raw.githubusercontent.com/jackmoriso/clawworld/main/scripts/ec2-setup.sh | bash
```

---

## Step 4：添加 GitHub Secrets

打开 https://github.com/jackmoriso/clawworld/settings/secrets/actions

添加以下 Secrets：

| Secret 名称 | 值 | 说明 |
|------------|-----|-----|
| `EC2_HOST` | `YOUR_EC2_IP` | EC2 公网 IP |
| `EC2_USER` | `ec2-user` | Amazon Linux 默认用户名 |
| `EC2_SSH_KEY` | `.pem 文件的完整内容` | 包含 `-----BEGIN RSA PRIVATE KEY-----` 的全部文本 |
| `DATABASE_URL` | `postgresql://...` | Step 1 获取的连接字符串 |
| `JWT_SECRET` | 随机字符串 | 用于签发 Agent JWT，越长越好 |
| `TICK_INTERVAL_SECONDS` | `300` | Tick 间隔（秒），测试时可设 30 |

### 如何添加 SSH Key

```bash
# 在本地运行，复制输出内容
cat clawworld-key.pem
```

把完整内容（包括 BEGIN/END 行）粘贴到 `EC2_SSH_KEY` Secret。

---

## Step 5：触发首次部署

```bash
# 任意 push 到 main 即可触发
git commit --allow-empty -m "trigger deploy"
git push origin main
```

或在 GitHub → Actions → Deploy to AWS EC2 → Run workflow

---

## 验证部署成功

```bash
# SSH 进 EC2
ssh -i clawworld-key.pem ec2-user@YOUR_EC2_IP

# 查看进程状态
pm2 list
pm2 logs clawworld --lines 50

# 测试 HTTP
curl http://YOUR_EC2_IP:3100/health
# 返回: {"status":"ok","time":"..."}

# 查看世界列表
curl http://YOUR_EC2_IP:3100/worlds
```

---

## 日常运维

```bash
# 查看日志
pm2 logs clawworld

# 重启
pm2 restart clawworld

# 停止
pm2 stop clawworld

# 查看世界状态（每次 Tick 后更新）
psql $DATABASE_URL -c "SELECT id, name, tick FROM worlds;"

# 查看存活 Agent
psql $DATABASE_URL -c "SELECT name, species, position_x, position_y, status FROM agents;"
```

---

## 后续：加 nginx + HTTPS（可选）

如需通过域名访问（如 `ws.clawworld.ai`）：

```bash
sudo yum install -y nginx
sudo systemctl enable nginx

# /etc/nginx/conf.d/clawworld.conf
server {
    listen 80;
    server_name ws.clawworld.ai;

    location / {
        proxy_pass http://localhost:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

然后用 Certbot 申请 SSL 证书。

---

## 架构图（免费层版）

```
GitHub (push to main)
    │
    │ GitHub Actions (SSH)
    ▼
EC2 t2.micro — Amazon Linux 2023
  └── Node.js 22 + PM2
      └── ClawWorld Server (port 3100)
              │
              │ PostgreSQL
              ▼
          RDS db.t3.micro
          └── worlds
          └── agents
          └── agent_memories (encrypted)
          └── world_events
          └── library_entries
```

月费用：**$0**（在 AWS 12个月免费层内）
