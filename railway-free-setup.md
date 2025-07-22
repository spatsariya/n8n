# Railway Free Deployment

## 1. Sign up at railway.app with GitHub
## 2. Click "New Project" → "Deploy from GitHub repo"
## 3. Select your n8n repository
## 4. Railway will auto-detect and deploy

## Environment Variables to set in Railway:
N8N_HOST=0.0.0.0
N8N_PORT=5678
N8N_PROTOCOL=https
WEBHOOK_URL=https://your-app.railway.app/
NODE_ENV=production

## Add PostgreSQL database:
# In Railway dashboard: Add → Database → PostgreSQL
# Railway will automatically set database environment variables

## Your n8n will be available at:
# https://your-app-name.railway.app

## Free tier includes:
# - $5 monthly credits
# - Usually enough for personal n8n usage
# - Automatic SSL certificates
# - Custom domains
