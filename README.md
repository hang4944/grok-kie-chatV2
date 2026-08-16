# Grok Desk via KIE

Private, self-hosted chat UI for KIE's OpenAI-compatible chat models. It does not bypass KIE credit, concurrency, or rate-limit rules.

## Included

- Password login with a first-run administrator account
- Streaming KIE chat proxy, keeping the API key off the browser
- Desktop and mobile UI with a model selector
- Grok 4.5 and 4.6 through KIE's Responses API, with live text-stream conversion for the web UI
- Docker Compose deployment with persistent local data

## Deploy

```bash
cp .env.example .env
# Set KIE_API_KEY, SESSION_SECRET, ADMIN_USERNAME, and ADMIN_PASSWORD.
docker compose up -d --build
docker compose logs -f
```

The container binds to `127.0.0.1:3000`. Use a TLS reverse proxy such as Caddy before exposing it publicly.

## Model catalog

On first start the app creates `data/models.json`. Users select from that catalog in the chat header; changing models does not require an `.env` edit or container restart.

The current Grok catalog uses KIE's Responses API:

```text
${KIE_API_BASE}/grok/v1/responses
```

The included catalog contains only the two model IDs verified from the supplied KIE request examples. New providers and models need their own confirmed endpoint and request/response adapter; do not force them through this protocol.
