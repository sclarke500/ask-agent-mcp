# openrouter-mcp

Remote MCP server that lets Claude invoke third-party models (Grok, GPT, Gemini, DeepSeek — anything OpenRouter carries) as tools mid-conversation, plus fetch live market quotes. The API keys never leave this server.

## Tools exposed

- **ask_model** — `{ model, prompt, system?, temperature?, max_tokens?, chat_id? }` → model reply + token/cost footer. Pass `chat_id` (any string you invent) to make the conversation sticky: the server keeps the transcript and replays it on every call, so the model remembers earlier turns. Different calls on one chat may use different models — they share the transcript.
- **list_models** — `{ search?, limit? }` → matching OpenRouter model IDs with context length and pricing
- **list_chats** — active sticky chats with turn count, last model, total cost, last activity
- **get_chat** — `{ chat_id }` → full transcript of one sticky chat
- **get_quotes** — `{ symbols: string[] }` → JSON array of `{ symbol, price, prevClose, marketState, asOfISO, dayHigh, dayLow, currency, source }` per ticker. US equities and ETFs (`AAPL`, `VOO`) come from Finnhub, real-time on the free tier; `marketState` (PRE/REGULAR/POST/CLOSED) is derived from US market hours and `currency` is USD. FX pairs (`USDCAD=X` or `USD/CAD`) come from official, keyless daily reference rates — Bank of Canada for anything involving CAD, ECB (via Frankfurter) otherwise — with `marketState: "REFERENCE"` and `asOfISO` as the date. Not covered: non-US listings such as TSX (Finnhub free tier is US-only), indices, crypto. Unknown or uncovered tickers come back as `{ symbol, error }` without failing the rest of the batch. Up to 25 symbols per call, cached 30 s (FX 1 h).

## Deploy (Render)

1. Push this repo to GitHub, create a **Web Service** on Render pointing at it.
   - Build: `npm install` · Start: `npm start` (Render injects `PORT`)
2. Environment variables:
   - `OPENROUTER_API_KEY` — from https://openrouter.ai/keys (set a spend limit on the key)
   - `FINNHUB_API_KEY` — free at https://finnhub.io/register (60 calls/min, no card)
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
- **Sticky chats are in-memory only**: they survive across requests but are lost on restart/redeploy (and Render free-tier sleep). Capped at 100 chats / 200 messages each, LRU-evicted. A failed model call never creates or grows a chat.
- The secret lives in the URL path, so treat the connector URL itself as a credential. Rotate `AUTH_TOKEN` if it leaks.
- **Quote sources**: Finnhub is a real API with a TOS and documented limits (60/min free); the server keeps a shared token bucket under that and caches quotes 30 s, so a burst of tool calls from several chats can't trip it. Bank of Canada Valet and ECB/Frankfurter are official and keyless, one rate per business day. Yahoo Finance was tried first and dropped: its endpoint is undocumented, TLS-fingerprints clients, and hard-blocks cloud egress IPs (Render's included) for 13–40+ min at a time.
- Free-tier Render sleeps after idle; first call after a nap takes ~30s. Fine for this use case.
