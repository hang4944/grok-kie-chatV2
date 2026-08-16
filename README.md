# Grok Desk via KIE

Private, self-hosted chat UI for KIE's OpenAI-compatible chat models. It does not bypass KIE credit, concurrency, or rate-limit rules.

## Included

- Password login with a first-run administrator account
- Streaming KIE chat proxy, keeping the API key off the browser
- Desktop and mobile UI with a model selector
- Initial model catalog: Grok, Google Gemini, and OpenAI GPT models offered through compatible KIE endpoints
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

All catalog entries use this KIE OpenAI-compatible endpoint shape:

```text
${KIE_API_BASE}/{model_id}/v1/chat/completions
```

The included catalog is a starting point. Confirm new slugs in KIE's model documentation before adding them. Native Gemini, Responses API, image, and video models use different protocols and need separate adapters instead of being forced through this chat endpoint.
