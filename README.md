# Menura

\*The superb lyrebird (**Menura** novaehollandiae) is an Australian passerine songbird. One of the world's largest songbirds, the superb lyrebird is renowned for its elaborate tail and courtship displays, and for its **excellent mimicry.\***

Group call server that uses the Twilio API, listens for incoming calls, rings a list of agents, passes the call to the first agent, and messages on Slack.

TODO: handle SMS to Slack bridge

# Requirements

Install pnpm: https://pnpm.io/installation

Copy `.env.example` and `agents.json.example` to `.env` and `agents.json`, respectively, and modify as necessary. `agents.json` should be a single dictionary, with agent phone numbers as the key, and the label of the agent as the value. Include the country code as well as the "+" in the phone number, and do not include spaces or dashes.

# Usage

## Local Development

```shell
# Install deps
pnpm i
# Compile
pnpm build
# Run
pnpm start

# To test
ssh -o PubkeyAuthentication=no -p 443 -R0:localhost:3000 username@free.pinggy.io

# Reformat
pnpm exec prettier --write .
```

## Docker

### Build and Run

```shell
# Build the Docker image
docker build -t menura .

# Run with mounted config files, host port 8080
docker run -p 8080:3000 \
  --name menura-instance \
  -v $(pwd)/.env:/app/.env \
  -v $(pwd)/agents.json:/app/agents.json \
  menura
```

### Required Bind Mounts

The following files must be bind mounted for the container to work properly:

- **`.env`** - Environment configuration file containing Twilio API credentials and other settings
- **`agents.json`** - Agent configuration file containing the list of phone numbers and labels

Make sure these files exist in your current directory before running the container. You can create them by copying the example files:

```shell
cp .env.example .env
cp agents.json.example agents.json
# Edit both files with your configuration
vim .env
vim agents.json
```
