// server.ts — Deno proxy to Hugging Face Inference API (improved normalization)
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
  // Common HF shapes -> try to extract a string reply
  // 1) array of outputs: [{generated_text: "..."}]
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "string") return first;
    if (first.generated_text) return first.generated_text;
    if (first.text) return first.text;
    if (first.output && Array.isArray(first.output) && first.output[0]?.generated_text) return first.output[0].generated_text;
  }
  // 2) object with generated_text
  if (data && typeof data === "object") {
    if (typeof data.generated_text === "string") return data.generated_text;
    if (typeof data.text === "string") return data.text;
    // Some models return {choices: [{text: "..."}]}
    if (Array.isArray(data.choices) && data.choices[0]?.text) return data.choices[0].text;
  }
  // 3) plain string
  if (typeof data === "string") return data;
  return null;
}

async function callHf(modelRepo: string, payload: unknown) {
  
  // ================== GEMINI MODIFY START ==================
  // YAHI FIX HAI:
  // Purana 'api-inference.huggingface.co/models/' URL
  // Naye 'router.huggingface.co/hf-inference/' URL se badal diya gaya hai.
  
  // === FIX ===
  const url = `https://router.huggingface.co/hf-inference/${encodeURIComponent(modelRepo)}`;
  
  // ==================  GEMINI MODIFY END  ==================

  const controller = new AbortController();
  const timeoutMs = 60_000;
  // Pichla 'timer' wala fix bhi isme shamil hai
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
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    clearTimeout(timer);
    return { ok: false, status: 500, data: { error: err?.message ?? String(err) } };
  }
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let body: any = {};
  try { body = await req.json(); } catch (e) { /* ignore */ }

  // Accept multiple keys from client: message / input / prompt
  const input = body.input ?? body.inputs ?? body.prompt ?? body.message ?? "";
  if (!input || (typeof input === 'string' && input.trim() === "")) {
    return new Response(JSON.stringify({ error: "Missing 'input'/'message'/'prompt' in request body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // script.js se ab 'distilgpt2' aayega
  const model = (body.model ?? "distilgpt2").toString();

  const payload: any = { inputs: input };
  if (body.parameters && typeof body.parameters === "object") payload.parameters = body.parameters;

  // Ab callHf() 'distilgpt2' model ko naye sahi URL par call karega
  const hf = await callHf(model, payload);

  if (!hf.ok) {
    let message = hf.data?.error ?? hf.data?.message ?? JSON.stringify(hf.data);
    if (hf.status === 404) {
      message = `Hugging Face returned 404 Not Found — model not found or inference disabled. Check model id. (Model used: ${model})`;
    }
    
    // Error ko Deno logs mein print karein taaki aap isey dashboard par dekh sakein
    console.error(`❌ Error calling HF with model '${model}': ${message}`);

    return new Response(JSON.stringify({ error: message, status: hf.status, details: hf.data }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Try to extract a clean text response for frontend convenience
  const normalized = extractTextFromHf(hf.data);
  if (normalized !== null) {
    return new Response(JSON.stringify({ response: normalized, raw: hf.data }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // If not extractable, forward raw hf.data as 'response' (frontend can handle object)
  return new Response(JSON.stringify({ response: hf.data }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

console.log("✅ Deno server starting — proxy to Hugging Face API");
serve(handler);

