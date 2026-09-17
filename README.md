# openrouter-mcp

Remote MCP server that lets Claude invoke third-party models (Grok, GPT, Gemini, DeepSeek — anything OpenRouter carries) as tools mid-conversation, plus fetch live market quotes. The OpenRouter API key never leaves this server.

## Tools exposed

- **ask_model** — `{ model, prompt, system?, temperature?, max_tokens?, chat_id? }` → model reply + token/cost footer. Pass `chat_id` (any string you invent) to make the conversation sticky: the server keeps the transcript and replays it on every call, so the model remembers earlier turns. Different calls on one chat may use different models — they share the transcript.
- **list_models** — `{ search?, limit? }` → matching OpenRouter model IDs with context length and pricing
- **list_chats** — active sticky chats with turn count, last model, total cost, last activity
- **get_chat** — `{ chat_id }` → full transcript of one sticky chat
- **get_quotes** — `{ symbols: string[] }` → JSON array of `{ symbol, name, price, prevClose, marketState, asOfISO, dayHigh, dayLow, currency, source }` per ticker, no API key. Equities/ETFs (`AAPL`, `SHOP.TO`), indices (`^GSPC`) and crypto (`BTC-USD`) come from Yahoo Finance's unofficial chart endpoint, near-real-time; `marketState` is PRE/REGULAR/POST/CLOSED (derived from the session windows Yahoo returns) and in POST/CLOSED `price` is the last regular-session trade. FX pairs (`USDCAD=X` or `USD/CAD`) come from official daily reference rates instead — Bank of Canada for anything involving CAD, ECB (via Frankfurter) otherwise — with `marketState: "REFERENCE"` and `asOfISO` as the date; pairs neither covers fall back to Yahoo. Unknown tickers come back as `{ symbol, error }` without failing the rest of the batch. Up to 25 symbols per call.

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
- **Sticky chats are in-memory only**: they survive across requests but are lost on restart/redeploy (and Render free-tier sleep). Capped at 100 chats / 200 messages each, LRU-evicted. A failed model call never creates or grows a chat.
- The secret lives in the URL path, so treat the connector URL itself as a credential. Rotate `AUTH_TOKEN` if it leaks.
- **Yahoo quotes are unofficial**: no API key, no TOS, no SLA, and no documented limits — everything known is reverse-engineered by the yfinance community. Yahoo 429s non-browser user agents outright (the server sends a browser UA), TLS-fingerprints clients so Node's `fetch` gets a tighter budget than a real browser, and hard-blocks an IP for 13–40+ minutes after a burst of roughly 10–15 quick requests, escalating if you keep knocking. Defences, all server-wide (shared across every connected consumer):
  - **Rate limiter**: never more than one Yahoo request per second, server-wide, serialised through a shared queue (a token bucket behind it caps sustained load at 60/min). A cold 25-symbol call takes ~25 s; anything that would wait over 30 s fails fast instead of hanging.
  - **Cache**: Yahoo quotes 30 s, FX reference rates 1 h.
  - **Circuit breaker**: after any 429 the server stops calling Yahoo for 60 s, doubling on each consecutive 429 up to 30 min. During the block it returns cached quotes up to 10 min old flagged `stale: true`, or `{ symbol, error: "Yahoo rate-limited ... retry after <ISO>" }`.
  - **FX off Yahoo entirely**: Bank of Canada Valet and ECB/Frankfurter are official, keyless, and have real terms of service. They publish one rate per business day, which for book-keeping is the number you want anyway.
  - If Yahoo ever breaks for good, Finnhub's free tier (60 calls/min, real-time US equities, needs a signup for a key) is the drop-in for equities.
- Free-tier Render sleeps after idle; first call after a nap takes ~30s. Fine for this use case.
