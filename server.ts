// server.ts — Deno proxy to Hugging Face Inference API (fixed)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing. Set HF_API_KEY env variable before starting the server.");
  Deno.exit(1);
}

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization",
};

function extractTextFromHf(data: any): string | null {
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "string") return first;
    if (typeof first.generated_text === "string") return first.generated_text;
    if (typeof first.text === "string") return first.text;
    if (first.output && Array.isArray(first.output) && first.output[0]?.generated_text) return first.output[0].generated_text;
  }
  if (data && typeof data === "object") {
    if (typeof data.generated_text === "string") return data.generated_text;
    if (typeof data.text === "string") return data.text;
    if (Array.isArray(data.choices) && data.choices[0]?.text) return data.choices[0].text;
  }
  if (typeof data === "string") return data;
  return null;
}

async function callHf(modelRepo: string, payload: unknown, timeoutMs = 60_000) {
  // Use encode per path-segment so slashes remain separators
  const encodedModel = modelRepo.split("/").map(encodeURIComponent).join("/");
  const url = `https://api-inference.huggingface.co/models/${encodedModel}`;

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
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }

    return { ok: res.ok, status: res.status, data, statusText: res.statusText };
  } catch (err: any) {
    clearTimeout(timer);
    // If aborted, err.name is "AbortError"
    return { ok: false, status: 500, data: { error: err?.message ?? String(err) } };
  }
}

async function tryWithFallback(models: string[], payload: unknown) {
  // Try models sequentially when 404 happens
  for (const m of models) {
    const res = await callHf(m, payload);
    if (res.ok) return { model: m, res };
    // if 404 -> try next model
    if (res.status === 404) {
      console.warn(`Model ${m} returned 404, trying next fallback if any.`);
      continue;
    }
    // for rate limits or server errors, return immediately to the client
    return { model: m, res };
  }
  return null;
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let body: any = {};
  try { body = await req.json(); } catch (e) { /* ignore, will validate below */ }

  const input = body.input ?? body.inputs ?? body.prompt ?? body.message ?? "";
  if (!input || (typeof input === 'string' && input.trim() === "")) {
    return new Response(JSON.stringify({ error: "Missing 'input'/'message'/'prompt' in request body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Don't silently default to "gpt2" (may be unavailable). Prefer explicit model or a safe fallback list.
  const clientModel = body.model ?? null;

  // Fallback list — adjust to models you verify are available for your account.
  const fallbackModels = [
    // put verified models here (example)
    "facebook/bart-large-mnli",
    "distilbert-base-uncased"
    // don't include models you know are removed from free inference
  ];

  const payload: any = { inputs: input };
  if (body.parameters && typeof body.parameters === "object") payload.parameters = body.parameters;

  let result: any;
  if (clientModel) {
    // try requested model first
    result = await callHf(clientModel.toString(), payload);
    if (!result.ok && result.status === 404) {
      // try fallback list if requested model not found
      const tried = await tryWithFallback(fallbackModels, payload);
      if (tried) {
        result = tried.res;
        console.log(`Fell back to model ${tried.model}`);
      }
    }
  } else {
    // no client model provided — try fallback list
    const tried = await tryWithFallback(fallbackModels, payload);
    if (!tried) {
      return new Response(JSON.stringify({ error: "No models available from fallback list" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    result = tried.res;
  }

  if (!result.ok) {
    let message = result.data?.error ?? result.data?.message ?? JSON.stringify(result.data);
    if (result.status === 404) {
      message = `Hugging Face returned 404 Not Found — model not found or inference disabled. Check model id.`;
    }
    console.error(`❌ Error calling HF: ${message} (status ${result.status})`);
    return new Response(JSON.stringify({ error: message, status: result.status, details: result.data }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const normalized = extractTextFromHf(result.data);
  if (normalized !== null) {
    return new Response(JSON.stringify({ response: normalized, raw: result.data }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ response: result.data }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

console.log("✅ Deno server starting — proxy to Hugging Face API");
serve(handler);
