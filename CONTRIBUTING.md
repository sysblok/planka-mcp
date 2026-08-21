# Contributing

Thanks for improving Planka 2.x support.

## Local checks

Node.js 18 or newer is required.

```bash
npm ci
npm run build
npm test
```

Keep unit tests offline. A real Planka test is opt-in because it writes a temporary
card:

```bash
export PLANKA_BASE_URL="https://planka.example.com"
export PLANKA_AGENT_EMAIL="agent@example.com"
export PLANKA_AGENT_PASSWORD="<YOUR_PASSWORD>"
export PLANKA_SMOKE_BOARD_ID="<BOARD_ID>"
npm run test:smoke
```

The smoke test must clean up after itself and must compare MCP claims with the raw
API. A `success: true` response alone is not proof.

## Pull requests

- Add a regression test for every Planka compatibility fix.
- Keep Node 18 compatibility.
- Never commit credentials, private hosts, real customer data, or screenshots with
  personal information.
- Preserve upstream attribution and the MIT license.
- Update both `README.md` and `README.es.md` when setup behavior changes.
- Do not broaden the optional workflow into a requirement for MCP-only users.
