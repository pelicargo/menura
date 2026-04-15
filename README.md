# Twilio Group call server

Group call server that uses the Twilio API, listens for incoming calls, rings a list of agents, passes the call to the first agent, and messages on Slack.

TODO: implement voicemail to slack
TODO: handle SMS to Slack bridge

# Requirements

Install pnpm: https://pnpm.io/installation

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
