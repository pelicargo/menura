# Menura

\*The superb lyrebird (**Menura** novaehollandiae) is an Australian passerine songbird. One of the world's largest songbirds, the superb lyrebird is renowned for its elaborate tail and courtship displays, and for its **excellent mimicry.\***

Group call server that uses the Twilio API, listens for incoming calls, rings a list of agents, passes the call to the first agent, and messages on Slack.

TODO: handle SMS to Slack bridge

# Requirements

Install pnpm: https://pnpm.io/installation

Copy `.env.example` and `agents.json.example` to `.env` and `agents.json`, respectively, and modify as necessary. `agents.json` should be a single dictionary, with agent phone numbers as the key, and the label of the agent as the value. Include the country code as well as the "+" in the phone number, and do not include spaces or dashes.

# Usage

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
