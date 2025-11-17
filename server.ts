// server.ts — Deno proxy with Enhanced Error Handling
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing. Set HF_API_KEY env variable before starting the server.");
  Deno.exit(1);
}

// === SINGLE MODEL (locked) ===
const MODEL_ID = "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B";

const ROUTER_BASE = "https://router.huggingface.co/v1";
const CHAT_PATH = "/chat/completions";
const COMPLETIONS_PATH = "/completions";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization",
};

function isString(x: any) { return typeof x === "string"; }
function safeJsonParse(text: string) { try { return JSON.parse(text); } catch { return null; } }

// --- NEW: Error Formatting Logic ---
function formatHfError(status: number, rawBody: string) {
  let code = "UNKNOWN_ERROR";
  let message = "An unexpected error occurred while contacting the AI model.";
  let details = rawBody;

  // Attempt to parse raw body for specific HF messages
  const jsonBody = safeJsonParse(rawBody);
  const hfErrorMsg = jsonBody?.error?.message || jsonBody?.error || rawBody;

  if (status === 503) {
    code = "MODEL_LOADING";
    message = "The AI model is currently loading on the server. Please try again in about 20-30 seconds.";
  } else if (status === 429) {
    code = "HEAVY_TRAFFIC";
    message = "Too many requests. The AI server is currently busy. Please wait a moment before trying again.";
  } else if (status === 401 || status === 403) {
    code = "AUTH_ERROR";
    message = "Authentication failed with the AI provider. Please check the server configuration.";
  } else if (status === 400) {
    code = "INVALID_REQUEST";
    message = "The request was invalid. Your prompt might be too long.";
  } else if (status === 500 || status === 502 || status === 504) {
    code = "UPSTREAM_ERROR";
    message = "The AI provider is experiencing connection issues.";
  }

  // Specific check for "Model is too large" or "context length" in body
  if (typeof hfErrorMsg === 'string' && hfErrorMsg.toLowerCase().includes("context length")) {
      code = "CONTEXT_LIMIT";
      message = "The conversation is too long for this model. Please start a new chat.";
  }

  return {
    error: {
      code,
      message,
      details: hfErrorMsg // Developer details
    }
  };
}

function normalizeIncoming(body: any) {
  const out: any = {};
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    out.messages = body.messages.map((m: any) => ({ role: m.role ?? "user", content: isString(m.content) ? m.content : String(m.content ?? "") }));
  } else if (body.input || body.inputs || body.prompt || body.message) {
    const text = body.input ?? body.inputs ?? body.prompt ?? body.message;
    out.messages = [{ role: "user", content: isString(text) ? text : String(text ?? "") }];
  }
  const allowed = ["max_tokens", "temperature", "top_p", "n", "stop", "stream"];
  for (const k of allowed) if (k in body) out[k] = body[k];
  return out;
}

// --- NON-STREAMING: Call Router JSON ---
async function callRouterJson(path: string, payload: unknown, timeoutMs = 60_000) {
  const url = `${ROUTER_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    
    const text = await res.text();
    
    // Handle API Errors specifically
    if (!res.ok) {
        const formatted = formatHfError(res.status, text);
        return { ok: false, status: res.status, statusText: res.statusText, data: formatted };
    }

    const data = safeJsonParse(text) ?? text;
    return { ok: res.ok, status: res.status, statusText: res.statusText, data };
  } catch (err: any) {
    clearTimeout(timer);
    const formatted = formatHfError(500, err?.message ?? String(err));
    return { ok: false, status: 500, statusText: "Internal Error", data: formatted };
  }
}

// --- STREAMING: Call Router Stream ---
async function callRouterStream(path: string, payload: unknown): Promise<Response> {
  const url = `${ROUTER_BASE}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify(payload),
    });

    // === ERROR HANDLING INTERCEPTION ===
    // If HF returns an error (e.g., 429, 503), it usually sends JSON, not a stream.
    // We must catch this, format it, and return it as JSON so the frontend knows why it failed.
    if (!res.ok) {
      const rawText = await res.text();
      const formattedError = formatHfError(res.status, rawText);
      
      return new Response(JSON.stringify(formattedError), { 
        status: res.status, // Pass the 429/503 status code specifically
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // If OK, pipe the stream
    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Content-Type", res.headers.get("Content-Type") || "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    
    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders
    });

  } catch (err: any) {
    const formattedError = formatHfError(500, err?.message ?? String(err));
    return new Response(JSON.stringify(formattedError), { 
      status: 500, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
}

function messagesToPrompt(messages: Array<{role:string,content:string}>) {
  return messages.map(m => {
    const role = (m.role || "user").toLowerCase();
    if (role === "system") return `System: ${m.content}`;
    if (role === "assistant") return `Assistant: ${m.content}`;
    return `User: ${m.content}`;
  }).join("\n\n");
}

function extractText(data: any): string | null {
  try {
    if (data && Array.isArray(data.choices) && data.choices.length > 0) {
      const c = data.choices[0];
      if (c?.message?.content && isString(c.message.content)) return c.message.content;
      if (c?.text && isString(c.text)) return c.text;
    }
    if (data?.generated_text && isString(data.generated_text)) return data.generated_text;
    if (data?.output_text && isString(data.output_text)) return data.output_text;
    if (isString(data)) return data;
  } catch (e) {}
  return null;
}

async function handler(req: Request): Promise<Response> {
  const responseHeaders = new Headers(corsHeaders);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") {
    const err = formatHfError(405, "Method Not Allowed");
    return new Response(JSON.stringify(err), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const normalized = normalizeIncoming(body);
  if (!Array.isArray(normalized.messages) || normalized.messages.length === 0) {
    const err = formatHfError(400, "Missing 'messages' or 'input' in request body.");
    return new Response(JSON.stringify(err), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const chatPayload: any = {
    model: MODEL_ID,
    messages: normalized.messages,
  };
  for (const k of ["max_tokens","temperature","top_p","n","stop","stream"]) if (k in normalized) chatPayload[k] = normalized[k];

  // --- STREAMING LOGIC ---
  if (chatPayload.stream === true) {
    console.log(`➡️ Calling HF Router (STREAM) with model: ${MODEL_ID}`);
    return await callRouterStream(CHAT_PATH, chatPayload);
  }

  // --- NON-STREAMING LOGIC ---
  console.log(`➡️ Calling HF Router (JSON) with model: ${MODEL_ID}`);
  responseHeaders.set("Content-Type", "application/json");

  const chatRes = await callRouterJson(CHAT_PATH, chatPayload);

  if (chatRes.ok) {
    const txt = extractText(chatRes.data);
    return new Response(JSON.stringify({ response: txt ?? chatRes.data, modelUsed: MODEL_ID, endpoint: "chat", raw: chatRes.data }), { status: 200, headers: responseHeaders });
  }

  // Fallback Logic for "Not a chat model"
  const errMsg = JSON.stringify(chatRes.data).toLowerCase();
  const isNotChat = chatRes.status === 400 && (errMsg.includes("not a chat model") || errMsg.includes("model_not_supported"));

  if (isNotChat) {
    const prompt = messagesToPrompt(normalized.messages);
    const compPayload: any = { model: MODEL_ID, prompt };
    if (normalized.max_tokens) compPayload.max_tokens = normalized.max_tokens;
    if (normalized.temperature) compPayload.temperature = normalized.temperature;
    
    console.log(`➡️ Falling back to completions endpoint: ${MODEL_ID}`);
    const compRes = await callRouterJson(COMPLETIONS_PATH, compPayload);
    
    if (compRes.ok) {
      const txt = extractText(compRes.data);
      return new Response(JSON.stringify({ response: txt ?? compRes.data, modelUsed: MODEL_ID, endpoint: "completions", raw: compRes.data }), { status: 200, headers: responseHeaders });
    }
    
    // If fallback fails, return the formatted error from the fallback attempt
    return new Response(JSON.stringify(compRes.data), { status: compRes.status, headers: responseHeaders });
  }

  // Return the formatted error from the first attempt
  return new Response(JSON.stringify(chatRes.data), { status: chatRes.status, headers: responseHeaders });
}

console.log("✅ Deno server starting — locked to model:", MODEL_ID);
serve(handler);
