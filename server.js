// openrouter-mcp — remote MCP server that exposes third-party models
// (Grok, GPT, Gemini, whatever OpenRouter carries) as tools for Claude,
// plus a market-quote tool (Finnhub for US equities/ETFs, Bank of Canada +
// ECB daily reference rates for FX).
//
// Auth model: the OpenRouter key lives ONLY here (env var). Claude connects
// via a secret path segment: https://your-host/mcp/<AUTH_TOKEN>
// Nobody without the token can burn your credits.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.PORT || 3100;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const OR_BASE = "https://openrouter.ai/api/v1";

if (!AUTH_TOKEN || !OPENROUTER_API_KEY || !FINNHUB_API_KEY) {
  console.error("Missing AUTH_TOKEN, OPENROUTER_API_KEY or FINNHUB_API_KEY env vars. Refusing to start.");
  process.exit(1);
}

// ---------------------------------------------------------------- OpenRouter

async function orFetch(path, options = {}) {
  const res = await fetch(`${OR_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      // Optional attribution headers OpenRouter likes:
      "HTTP-Referer": process.env.APP_URL || "https://localhost",
      "X-Title": "openrouter-mcp",
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText;
    throw new Error(`OpenRouter ${res.status}: ${msg}`);
  }
  return body;
}


// ---------------------------------------------------------------- rate limiter
//
// App-wide token bucket, shared by every MCP request (module scope survives
// across the stateless per-request server instances). Callers await acquire()
// before each upstream hit; it serialises them, enforces a minimum gap, and
// refills tokens over time. Waiting longer than maxWaitMs fails fast so an MCP
// call never hangs.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RateLimiter {
  constructor({ name, capacity, refillPerSec, minGapMs, maxWaitMs }) {
    Object.assign(this, { name, capacity, refillPerSec, minGapMs, maxWaitMs });
    this.tokens = capacity;
    this.lastRefill = Date.now();
    this.nextAllowedAt = 0;
    this.queue = Promise.resolve();
  }

  #refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) / 1000) * this.refillPerSec);
    this.lastRefill = now;
  }

  acquire() {
    const enqueuedAt = Date.now();
    const run = async () => {
      this.#refill();
      let waitMs = Math.max(0, this.nextAllowedAt - Date.now());
      if (this.tokens < 1) {
        waitMs = Math.max(waitMs, ((1 - this.tokens) / this.refillPerSec) * 1000);
      }
      if (Date.now() + waitMs - enqueuedAt > this.maxWaitMs) {
        throw new Error(`${this.name} request budget exhausted; try again in a minute`);
      }
      if (waitMs > 0) await sleep(waitMs);
      this.#refill();
      this.tokens -= 1;
      this.nextAllowedAt = Date.now() + this.minGapMs;
    };
    const turn = this.queue.then(run, run);
    this.queue = turn.catch(() => {});
    return turn;
  }
}

// Finnhub free tier: 60 calls/min, 30/s burst. Stay comfortably under.
const finnhubLimiter = new RateLimiter({
  name: "Finnhub",
  capacity: 10,
  refillPerSec: 1,
  minGapMs: 50,
  maxWaitMs: 30_000,
});

// Bank of Canada / ECB: official public APIs, no published limit; be polite.
const fxLimiter = new RateLimiter({
  name: "FX",
  capacity: 5,
  refillPerSec: 2,
  minGapMs: 100,
  maxWaitMs: 30_000,
});

// ---------------------------------------------------------------- quote cache

const quoteCache = new Map(); // SYMBOL → { quote, fetchedAt }

function cachedQuote(symbol, maxAgeMs) {
  const c = quoteCache.get(symbol);
  return c && Date.now() - c.fetchedAt <= maxAgeMs ? c.quote : null;
}

function rememberQuote(symbol, quote) {
  quoteCache.set(symbol, { quote, fetchedAt: Date.now() });
  return quote;
}

// ---------------------------------------------------------------- Finnhub quotes
//
// US equities and ETFs, real-time on the free tier. /quote returns
// { c, pc, h, l, o, t } and all zeros for anything it doesn't know (or that the
// plan doesn't cover, e.g. TSX listings), so zeros are treated as an error.
// Finnhub doesn't report market state or currency; state is derived from
// US-market wall-clock hours and currency is USD (free tier is US-only).

const FH_BASE = "https://finnhub.io/api/v1";
const FH_TIMEOUT_MS = 10_000;
const FH_FRESH_MS = 30_000;

function usMarketState(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  if (["Sat", "Sun"].includes(get("weekday"))) return "CLOSED";
  const mins = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "REGULAR";
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "PRE";
  if (mins >= 16 * 60 && mins < 20 * 60) return "POST";
  return "CLOSED";
}

async function fetchFinnhubQuote(symbol) {
  const fresh = cachedQuote(symbol, FH_FRESH_MS);
  if (fresh) return fresh;

  await finnhubLimiter.acquire();
  const res = await fetch(`${FH_BASE}/quote?symbol=${encodeURIComponent(symbol)}`, {
    headers: { "X-Finnhub-Token": FINNHUB_API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(FH_TIMEOUT_MS),
  });
  if (res.status === 429) throw new Error("Finnhub rate limit hit (60/min); retry shortly");
  if (res.status === 403) {
    throw new Error("Not available on the Finnhub free tier (non-US listings such as TSX need a paid plan)");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Finnhub ${res.status}: ${body?.error ?? res.statusText}`);
  if (typeof body.c !== "number" || (body.c === 0 && !body.t)) {
    throw new Error("Unknown symbol, or not covered by the Finnhub free tier (US equities/ETFs only)");
  }
  return rememberQuote(symbol, {
    symbol,
    name: null,
    price: body.c,
    prevClose: body.pc ?? null,
    marketState: usMarketState(),
    asOfISO: body.t ? new Date(body.t * 1000).toISOString() : null,
    dayHigh: body.h ?? null,
    dayLow: body.l ?? null,
    currency: "USD",
    source: "finnhub",
  });
}

// ---------------------------------------------------------------- FX quotes
//
// FX pairs go to official, keyless daily-reference sources: Bank of Canada
// Valet for anything involving CAD (27 currencies, daily average), ECB via
// Frankfurter for the rest (29 currencies). Both publish one rate per business
// day, so marketState is "REFERENCE" and asOfISO is a date.

const FX_FRESH_MS = 60 * 60_000; // daily rates: an hour of cache is plenty
const FX_TIMEOUT_MS = 10_000;
const BOC_BASE = "https://www.bankofcanada.ca/valet/observations";
const ECB_BASE = "https://api.frankfurter.dev/v1";

// "USDCAD=X" (Yahoo-style) or "USD/CAD" → { base, quote }; anything else → null.
function parseFxPair(symbol) {
  const m = /^([A-Z]{3})\/?([A-Z]{3})=?X?$/.exec(symbol);
  if (!m) return null;
  // Guard against 6-letter equity tickers matching: require the =X or slash.
  if (!/=X$|\//.test(symbol)) return null;
  return { base: m[1], quote: m[2] };
}

async function fxJson(url) {
  await fxLimiter.acquire();
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FX_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

function fxQuote(symbol, { base, quote }, price, prevClose, date, source) {
  const round = (v) => (v == null ? null : Number(v.toPrecision(6)));
  return {
    symbol,
    name: `${base}/${quote}`,
    price: round(price),
    prevClose: round(prevClose),
    marketState: "REFERENCE",
    asOfISO: date,
    dayHigh: null,
    dayLow: null,
    currency: quote,
    source,
  };
}

// BoC series are all FX<CCY>CAD (1 unit of CCY in CAD); invert for CAD<CCY>.
async function fetchBocFx(symbol, pair) {
  const foreign = pair.base === "CAD" ? pair.quote : pair.base;
  const data = await fxJson(`${BOC_BASE}/FX${foreign}CAD/json?recent=2`);
  const obs = (data.observations ?? []).map((o) => ({
    date: o.d,
    v: Number(o[`FX${foreign}CAD`]?.v),
  }));
  if (!obs.length || !Number.isFinite(obs[0].v)) throw new Error("No BoC observation");
  const conv = (v) => (pair.base === "CAD" ? 1 / v : v);
  return fxQuote(symbol, pair, conv(obs[0].v), obs[1] ? conv(obs[1].v) : null, obs[0].date, "bank-of-canada");
}

async function fetchEcbFx(symbol, pair) {
  const from = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const data = await fxJson(`${ECB_BASE}/${from}..?base=${pair.base}&symbols=${pair.quote}`);
  const dates = Object.keys(data.rates ?? {}).sort();
  if (!dates.length) throw new Error("No ECB observation");
  const at = (i) => data.rates[dates[i]]?.[pair.quote];
  const last = dates.length - 1;
  return fxQuote(symbol, pair, at(last), last > 0 ? at(last - 1) : null, dates[last], "ecb");
}

async function fetchFxQuote(symbol, pair) {
  const fresh = cachedQuote(symbol, FX_FRESH_MS);
  if (fresh) return fresh;
  try {
    const q = pair.base === "CAD" || pair.quote === "CAD"
      ? await fetchBocFx(symbol, pair)
      : await fetchEcbFx(symbol, pair);
    return rememberQuote(symbol, q);
  } catch (err) {
    throw new Error(`FX pair not available from Bank of Canada or ECB (${err.message})`);
  }
}

// ---------------------------------------------------------------- dispatcher

function normalizeSymbol(raw) {
  const s = raw.trim().toUpperCase();
  const m = /^([A-Z]{3})\/([A-Z]{3})$/.exec(s);
  return m ? `${m[1]}${m[2]}=X` : s;
}

function getQuote(symbol) {
  const pair = parseFxPair(symbol);
  return pair ? fetchFxQuote(symbol, pair) : fetchFinnhubQuote(symbol);
}

// ---------------------------------------------------------------- chat store
//
// Sticky conversations, in memory. The MCP transport stays stateless (fresh
// server per request); this Map lives at module scope, so history survives
// across requests — but not restarts/redeploys. Fine for second opinions.

const MAX_CHATS = 100; // LRU-evicted beyond this
const MAX_MESSAGES = 200; // per chat; oldest turns trimmed

const chats = new Map(); // chat_id → { system, messages, createdAt, updatedAt, lastModel, cost }

function getOrCreateChat(id) {
  let c = chats.get(id);
  if (!c) {
    if (chats.size >= MAX_CHATS) {
      const lru = [...chats.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (lru) chats.delete(lru[0]);
    }
    c = {
      system: null,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastModel: null,
      cost: 0,
    };
    chats.set(id, c);
  }
  return c;
}

// ---------------------------------------------------------------- MCP server

function buildServer() {
  const server = new McpServer({ name: "openrouter-mcp", version: "1.1.0" });

  server.registerTool(
    "ask_model",
    {
      title: "Ask another model",
      description:
        "Send a prompt to a third-party model via OpenRouter and return its reply. " +
        "Use full OpenRouter model IDs, e.g. 'x-ai/grok-4', 'openai/gpt-5.1', " +
        "'google/gemini-2.5-pro'. If unsure of an ID, call list_models first. " +
        "Pass chat_id to make the conversation sticky: the server keeps the message " +
        "history and replays it each call, so the model remembers earlier turns.",
      inputSchema: {
        model: z.string().describe("OpenRouter model ID, e.g. x-ai/grok-4"),
        prompt: z.string().describe("The user-role message to send"),
        system: z.string().optional().describe("Optional system prompt"),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().positive().max(16000).default(2048),
        chat_id: z
          .string()
          .max(120)
          .optional()
          .describe(
            "Sticky conversation id, e.g. 'grok-db-templates'. Auto-created on first " +
            "use; lives in server memory until restart. Different calls on the same " +
            "chat may use different models (they share the transcript)."
          ),
      },
    },
    async ({ model, prompt, system, temperature, max_tokens, chat_id }) => {
      // Read history if the chat exists; only persist after a successful reply,
      // so failed calls never mint empty chats.
      const prior = chat_id ? chats.get(chat_id) : undefined;
      const effectiveSystem = system ?? prior?.system;
      const messages = [];
      if (effectiveSystem) messages.push({ role: "system", content: effectiveSystem });
      if (prior) messages.push(...prior.messages);
      messages.push({ role: "user", content: prompt });

      const data = await orFetch("/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model,
          messages,
          max_tokens,
          ...(temperature !== undefined ? { temperature } : {}),
          usage: { include: true },
        }),
      });

      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? "(empty response)";
      const u = data.usage || {};
      const chat = chat_id ? getOrCreateChat(chat_id) : null;
      if (chat) {
        if (system) chat.system = system; // latest system wins for the whole chat
        chat.messages.push(
          { role: "user", content: prompt },
          { role: "assistant", content: text }
        );
        while (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, 2);
        chat.updatedAt = Date.now();
        chat.lastModel = data.model;
        if (typeof u.cost === "number") chat.cost += u.cost;
      }
      const meta =
        `\n\n---\nmodel: ${data.model} | finish: ${choice?.finish_reason}` +
        ` | tokens: ${u.prompt_tokens ?? "?"} in / ${u.completion_tokens ?? "?"} out` +
        (u.cost !== undefined ? ` | cost: $${u.cost}` : "") +
        (chat
          ? ` | chat: ${chat_id} (${chat.messages.length / 2} turns, $${chat.cost.toFixed(4)} total)`
          : "");

      return { content: [{ type: "text", text: text + meta }] };
    }
  );

  server.registerTool(
    "list_models",
    {
      title: "List available models",
      description:
        "Search OpenRouter's model catalog. Returns matching model IDs with " +
        "context length and pricing. Use to find the right ID for ask_model.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Substring filter, e.g. 'grok', 'gpt', 'gemini'"),
        limit: z.number().int().positive().max(50).default(20),
      },
    },
    async ({ search, limit }) => {
      const data = await orFetch("/models");
      let models = data.data || [];
      if (search) {
        const q = search.toLowerCase();
        models = models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            (m.name || "").toLowerCase().includes(q)
        );
      }
      const lines = models.slice(0, limit).map((m) => {
        const p = m.pricing || {};
        const inPrice = p.prompt ? `$${(p.prompt * 1e6).toFixed(2)}/M in` : "n/a";
        const outPrice = p.completion
          ? `$${(p.completion * 1e6).toFixed(2)}/M out`
          : "n/a";
        return `${m.id} — ctx ${m.context_length} — ${inPrice}, ${outPrice}`;
      });
      return {
        content: [
          {
            type: "text",
            text: lines.length
              ? lines.join("\n")
              : `No models matching "${search}".`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_chats",
    {
      title: "List sticky chats",
      description:
        "List active sticky chat ids with turn count, last model, total cost, and " +
        "last activity. Chats live in server memory only — a restart clears them.",
      inputSchema: {},
    },
    async () => {
      const lines = [...chats.entries()]
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .map(
          ([id, c]) =>
            `${id} — ${c.messages.length / 2} turn(s) — last model ${c.lastModel ?? "?"}` +
            ` — $${c.cost.toFixed(4)} — updated ${new Date(c.updatedAt).toISOString()}`
        );
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : "No active chats." }],
      };
    }
  );

  server.registerTool(
    "get_chat",
    {
      title: "Read a chat transcript",
      description: "Return the full message history of one sticky chat (see list_chats).",
      inputSchema: {
        chat_id: z.string().describe("Chat id passed to ask_model"),
      },
    },
    async ({ chat_id }) => {
      const c = chats.get(chat_id);
      if (!c) {
        return { content: [{ type: "text", text: `No chat "${chat_id}".` }] };
      }
      const lines = [];
      if (c.system) lines.push(`[system] ${c.system}`);
      for (const m of c.messages) lines.push(`[${m.role}] ${m.content}`);
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.registerTool(
    "get_quotes",
    {
      title: "Get market quotes",
      description:
        "Fetch quotes for one or more tickers. US equities and ETFs ('AAPL', " +
        "'VOO') come from Finnhub, real-time. FX pairs ('USDCAD=X' or 'USD/CAD') " +
        "come from official daily reference rates (Bank of Canada for CAD pairs, " +
        "ECB otherwise; marketState 'REFERENCE', asOfISO is the date). Returns a " +
        "JSON array with, per symbol: price, prevClose, marketState (PRE/REGULAR/" +
        "POST/CLOSED/REFERENCE), asOfISO, dayHigh, dayLow, currency, source. " +
        "Outside REGULAR hours the equity price is the last trade. Non-US " +
        "listings (e.g. TSX 'SHOP.TO'), indices and crypto are not covered; " +
        "unknown or uncovered symbols come back as { symbol, error } without " +
        "failing the batch. Quotes are cached ~30s.",
      inputSchema: {
        symbols: z
          .array(z.string().trim().min(1).max(20))
          .min(1)
          .max(25)
          .describe("Ticker symbols, e.g. ['AAPL', 'VOO', 'USD/CAD']"),
      },
    },
    async ({ symbols }) => {
      const unique = [...new Set(symbols.map(normalizeSymbol))];
      const settled = await Promise.allSettled(unique.map(getQuote));
      const quotes = settled.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : { symbol: unique[i], error: r.reason?.message ?? String(r.reason) }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(quotes, null, 2) }],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------- transport

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Stateless mode: fresh server + transport per request. No session bookkeeping,
// survives Render restarts and your Starlink dropping mid-conversation.
app.post("/mcp/:token", async (req, res) => {
  if (req.params.token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless server: GET (SSE resume) and DELETE (session teardown) are N/A.
const notAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode" },
    id: null,
  });
app.get("/mcp/:token", notAllowed);
app.delete("/mcp/:token", notAllowed);

app.listen(PORT, () => {
  console.log(`openrouter-mcp listening on :${PORT}`);
});
