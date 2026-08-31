# openrouter-mcp

Remote MCP server that lets Claude invoke third-party models (Grok, GPT, Gemini, DeepSeek — anything OpenRouter carries) as tools mid-conversation. The OpenRouter API key never leaves this server.

## Tools exposed

- **ask_model** — `{ model, prompt, system?, temperature?, max_tokens? }` → model reply + token/cost footer
- **list_models** — `{ search?, limit? }` → matching OpenRouter model IDs with context length and pricing

## Deploy (Render)

1. Push this repo to GitHub, create a **Web Service** on Render pointing at it.
   - Build: `npm install` · Start: `npm start` (Render injects `PORT`)
2. Environment variables:
   - `OPENROUTER_API_KEY` — from https://openrouter.ai/keys (set a spend limit on the key)
   - `AUTH_TOKEN` — generate one: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
   - `APP_URL` — optional, your Render URL (OpenRouter attribution header)
3. Sanity check: `GET https://your-app.onrender.com/healthz` → `{"ok":true}`

Also runs fine on the SOCKS5-proxy VPS with pm2 + a reverse proxy for TLS — claude.ai requires HTTPS for connectors.

## Connect to claude.ai

Settings → Connectors → Add custom connector → URL:

```
https://your-app.onrender.com/mcp/<AUTH_TOKEN>
```

No OAuth config needed — the token in the path is the auth. Then in any chat, enable the connector and ask Claude to `ask_model` with e.g. `x-ai/grok-4`.

## Notes

- **Stateless transport**: every request builds a fresh server instance. No sessions to lose when Render cold-starts or Starlink blips.
- The secret lives in the URL path, so treat the connector URL itself as a credential. Rotate `AUTH_TOKEN` if it leaks.
- Free-tier Render sleeps after idle; first call after a nap takes ~30s. Fine for this use case.
