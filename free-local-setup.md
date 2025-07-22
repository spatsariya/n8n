# Free local n8n setup with ngrok tunneling

## Option 1: Direct npm installation
npm install -g n8n
n8n start

## Option 2: Docker with external access
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n

## Option 3: With ngrok for webhooks (in separate terminal)
# Download ngrok from https://ngrok.com/ (free account)
ngrok http 5678

## This gives you a public URL like: https://abc123.ngrok.io
## Use this URL in n8n webhook settings
