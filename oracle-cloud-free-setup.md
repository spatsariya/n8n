# Oracle Cloud Always Free n8n Setup

## What you get for FREE (forever):
- 4 ARM-based VMs (up to 24GB RAM total)
- 200GB storage
- 10TB monthly data transfer
- Load balancer

## Setup Steps:

### 1. Create Oracle Cloud Account
- Go to cloud.oracle.com
- Sign up for Always Free account
- No credit card required after trial

### 2. Create VM Instance
```bash
# Choose ARM-based VM for better specs
# OS: Ubuntu 22.04
# Shape: VM.Standard.A1.Flex (4 OCPU, 24GB RAM)
```

### 3. Install Docker
```bash
sudo apt update
sudo apt install docker.io docker-compose -y
sudo usermod -aG docker $USER
```

### 4. Deploy n8n
```bash
# Create docker-compose.yml
version: '3.8'
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n
    restart: always
    ports:
      - "5678:5678"
    environment:
      - N8N_HOST=0.0.0.0
      - N8N_PORT=5678
      - N8N_PROTOCOL=http
      - WEBHOOK_URL=http://YOUR_VM_IP:5678/
    volumes:
      - n8n_data:/home/node/.n8n

volumes:
  n8n_data:
```

### 5. Start n8n
```bash
docker-compose up -d
```

## Security Setup (Important!)
```bash
# Install nginx for reverse proxy
sudo apt install nginx certbot python3-certbot-nginx

# Configure domain (optional, use free services like freenom.com)
# Get SSL certificate
sudo certbot --nginx -d your-domain.com
```
