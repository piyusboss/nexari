// server.ts — Deno HF proxy with improved error handling, streaming fallback, retries.
// Usage: set env HF_API_KEY and optionally MODEL_ID
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing. Set HF_API_KEY env variable before starting the server.");
  Deno.exit(1);
}

// Default locked model (can override with env MODEL_ID)
const MODEL_ID = Deno.env.get("MODEL_ID") ?? "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B";

// Hugging Face router base
const ROUTER_BASE = "https://router.huggingface.co/v1";
const ROUTER_CHAT = "/chat/completions";
const ROUTER_COMPLETIONS = "/completions";

const ALLOWED_ORIGINS = Deno.env.get("ALLOWED_ORIGINS") ?? "*";

// Tunables
const REQUEST_TIMEOUT_MS = Number(Deno.env.get("REQUEST_TIMEOUT_MS") ?? 25_000);
const MAX_RETRIES = Number(Deno.env.get("MAX_RETRIES") ?? 2); // for retryable upstream errors
const RETRY_BASE_MS = 800;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function now() {
  return new Date().toISOString();
}

async function readBodyAsText(r: Request) {
  try {
    return await r.text();
  } catch {
    return null;
  }
}

async function parseUpstreamErrorText(text: string | null) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    // HF often returns { error: "..." } or structured object
    if (j.error) return String(j.error);
    // some endpoints return message
    if (j.message) return String(j.message);
    // last resort: stringify
    return JSON.stringify(j);
  } catch {
    return text.slice(0, 200);
  }
}

function makeErrorResponseObject(opts: {
  message: string;
  code?: string;
  source?: string;
  upstream_status?: number | null;
  upstream_message?: string | null;
  retryable?: boolean;
}) {
  return {
    ok: false,
    error: {
      message: opts.message,
      code: opts.code ?? "server_error",
      source: opts.source ?? "proxy",
      upstream_status: opts.upstream_status ?? null,
      upstream_message: opts.upstream_message ?? null,
      retryable: !!opts.retryable,
      timestamp: now(),
    },
  };
}

// small backoff
function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function callUpstream(path: string, body: any, stream: boolean, abortSignal?: AbortSignal) {
  const url = `${ROUTER_BASE}${path.replace(/^\/+/,'')}`;
  const headers: Record<string,string> = {
    "Authorization": `Bearer ${HF_API_KEY}`,
    "Accept": stream ? "text/event-stream, application/json" : "application/json",
    "Content-Type": "application/json",
    "User-Agent": "deno-hf-proxy/1.0",
  };

  const payload = { model: MODEL_ID, ...body };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // If caller provided an AbortSignal, forward aborts
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => controller.abort());
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Handler: expects POST with JSON body. Example:
 * { "messages": [...], "stream": true } OR { "inputs": "hello", "stream": false }
 */
async function handler(req: Request): Promise<Response> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify(makeErrorResponseObject({ message: "Method not allowed", code: "method_not_allowed" })), {
      status: 405,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  const rawBody = await readBodyAsText(req);
  let clientJson: any = null;
  try {
    clientJson = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {
    console.error("[handler] invalid JSON body:", rawBody?.slice(0, 500));
    return new Response(JSON.stringify(makeErrorResponseObject({ message: "Invalid JSON body", code: "invalid_json" })), {
      status: 400,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  const wantsStream = !!clientJson.stream;
  // Decide which HF path to call:
  const useChat = Array.isArray(clientJson.messages);
  const path = useChat ? ROUTER_CHAT : ROUTER_COMPLETIONS;

  // We attach a small provenance field so upstream logs can be matched
  const upstreamBody = { ...(clientJson || {}) };

  // Try with retries for transient upstream statuses
  let attempt = 0;
  while (true) {
    attempt++;
    let res: Response | null = null;
    try {
      res = await callUpstream(path, upstreamBody, wantsStream);
    } catch (err: any) {
      // Network / fetch error
      const msg = String(err?.message ?? err);
      console.warn(`[proxy] network error on attempt ${attempt}:`, msg);
      // If it's aborted due to timeout, provide specific message
      if (attempt <= MAX_RETRIES && (msg.includes("timed out") || msg.includes("aborted") || msg.includes("network"))) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.log(`[proxy] retrying after ${backoff}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(backoff);
        continue;
      }
      const body = makeErrorResponseObject({
        message: "Upstream network error or timeout when contacting Hugging Face.",
        code: "upstream_network_error",
        source: "network",
        upstream_message: msg,
        retryable: attempt <= MAX_RETRIES,
      });
      return new Response(JSON.stringify(body), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }

    // If we have a response object:
    const upstreamStatus = res.status;
    const upstreamContentType = res.headers.get("Content-Type") ?? "";

    // Success streaming: 200 and a body stream; forward as-is (but check for empty).
    if (upstreamStatus === 200 && wantsStream) {
      if (!res.body) {
        const body = makeErrorResponseObject({
          message: "Upstream returned no stream body. Possible hosting or upstream blocking.",
          code: "empty_stream",
          source: "upstream",
          upstream_status: upstreamStatus,
          upstream_message: await parseUpstreamErrorText(await res.text()),
        });
        return new Response(JSON.stringify(body), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }

      // Forward response headers, prefer upstream Content-Type (likely text/event-stream)
      const headers = new Headers(corsHeaders());
      if (upstreamContentType) headers.set("Content-Type", upstreamContentType);
      headers.set("Cache-Control", "no-cache");
      // Pass-through response body (stream piping)
      console.log(`[proxy] streaming proxied (200) to client. model=${MODEL_ID}`);
      return new Response(res.body, { status: 200, headers });
    }

    // Success non-stream (or client requested non-stream): return full JSON body
    if (upstreamStatus === 200) {
      // clone/res.text() available
      let text = "";
      try {
        text = await res.text();
      } catch (err) {
        console.error("[proxy] failed reading upstream body:", String(err));
        return new Response(JSON.stringify(makeErrorResponseObject({ message: "Failed to read upstream response", code: "read_error" })), {
          status: 502,
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }
      // If upstream returned empty body
      if (!text) {
        return new Response(JSON.stringify(makeErrorResponseObject({
          message: "Upstream returned an empty response body.",
          code: "empty_response",
          source: "upstream",
          upstream_status: upstreamStatus,
        })), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
      // Return what upstream returned (json or text)
      const headers = { ...corsHeaders(), "Content-Type": "application/json" };
      return new Response(text, { status: 200, headers });
    }

    // Handle common upstream failure statuses with clear messaging and retry logic
    const rawUpstreamText = await (async () => {
      try {
        return await res.text();
      } catch {
        return null;
      }
    })();
    const upstreamMessage = await parseUpstreamErrorText(rawUpstreamText);

    // 401/403/402 -> auth/payment error
    if ([401, 403, 402].includes(upstreamStatus)) {
      const body = makeErrorResponseObject({
        message: upstreamStatus === 401 ? "Authentication to Hugging Face failed (invalid or expired HF_API_KEY)." :
                 upstreamStatus === 402 ? "Payment required on Hugging Face account (usage or billing problem)." :
                 "Permission denied by Hugging Face (model access restricted).",
        code: upstreamStatus === 401 ? "auth_failed" : upstreamStatus === 402 ? "payment_required" : "forbidden",
        source: "huggingface",
        upstream_status: upstreamStatus,
        upstream_message: upstreamMessage,
        retryable: false,
      });
      console.error(`[proxy] upstream auth/permission error: ${upstreamStatus} ${upstreamMessage}`);
      return new Response(JSON.stringify(body), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }

    // 404 -> model not found or invalid path
    if (upstreamStatus === 404) {
      const body = makeErrorResponseObject({
        message: "Upstream model or endpoint not found. Confirm MODEL_ID and that the model is available on Hugging Face.",
        code: "model_not_found",
        source: "huggingface",
        upstream_status: upstreamStatus,
        upstream_message: upstreamMessage,
        retryable: false,
      });
      console.warn(`[proxy] model not found: ${upstreamMessage}`);
      return new Response(JSON.stringify(body), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }

    // 429 -> rate limit; retry with backoff if attempts left
    if (upstreamStatus === 429) {
      console.warn(`[proxy] upstream rate-limited (429). attempt=${attempt}`);
      if (attempt <= MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue; // retry
      }
      const body = makeErrorResponseObject({
        message: "Upstream rate-limited by Hugging Face. Try again later or reduce request rate.",
        code: "rate_limited",
        source: "huggingface",
        upstream_status: upstreamStatus,
        upstream_message: upstreamMessage,
        retryable: true,
      });
      return new Response(JSON.stringify(body), { status: 429, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }

    // 502/503/504 -> upstream overloaded / gateway errors -> retry a few times then return error
    if ([502, 503, 504].includes(upstreamStatus)) {
      console.warn(`[proxy] upstream temporary error ${upstreamStatus}. attempt=${attempt}`);
      if (attempt <= MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue;
      }
      const body = makeErrorResponseObject({
        message: "Upstream service appears overloaded or temporarily unavailable.",
        code: "upstream_unavailable",
        source: "huggingface",
        upstream_status: upstreamStatus,
        upstream_message: upstreamMessage,
        retryable: true,
      });
      return new Response(JSON.stringify(body), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }

    // Other 4xx/5xx -> bubble up HF message
    {
      const body = makeErrorResponseObject({
        message: `Hugging Face returned an error (${upstreamStatus}). See upstream_message for details.`,
        code: "upstream_error",
        source: "huggingface",
        upstream_status: upstreamStatus,
        upstream_message: upstreamMessage,
        retryable: [500, 501].includes(upstreamStatus),
      });
      console.error(`[proxy] upstream returned status ${upstreamStatus}: ${upstreamMessage}`);
      return new Response(JSON.stringify(body), { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }
  } // end retry loop
}

console.log("✅ Deno HF-proxy starting. Model locked to:", MODEL_ID);
serve(handler);
