// openrouter-mcp — remote MCP server that exposes third-party models
// (Grok, GPT, Gemini, whatever OpenRouter carries) as tools for Claude.
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
const OR_BASE = "https://openrouter.ai/api/v1";

if (!AUTH_TOKEN || !OPENROUTER_API_KEY) {
  console.error("Missing AUTH_TOKEN or OPENROUTER_API_KEY env vars. Refusing to start.");
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
