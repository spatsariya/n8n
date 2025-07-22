# Cloudflare Tunnel Setup (100% Free)

## 1. Install cloudflared
# Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
# For Windows: Download cloudflared.exe

## 2. Login to Cloudflare
cloudflared tunnel login

## 3. Create a tunnel
cloudflared tunnel create n8n-tunnel

## 4. Route traffic
cloudflared tunnel route dns n8n-tunnel your-subdomain.your-domain.com

## 5. Start the tunnel
cloudflared tunnel --config-file config.yml run n8n-tunnel

# config.yml content:
# tunnel: YOUR_TUNNEL_ID
# credentials-file: ~/.cloudflared/YOUR_TUNNEL_ID.json
# ingress:
#   - hostname: your-subdomain.your-domain.com
#     service: http://localhost:5678
#   - service: http_status:404

## Benefits:
# - Completely free
# - No time limits
# - Custom domain support
# - HTTPS automatically
# - Better than ngrok free tier
