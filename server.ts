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

// 'modelRepo' argument ab sirf logging ke liye istemaal hoga, URL ke liye nahi.
async function callHf(modelRepo: string, payload: unknown) {
  
  // ================== GEMINI MODIFY START (FIX 1) ==================
  // Naya 'hf-inference' router ek static URL istemaal karta hai.
  // Model ka naam ab URL ka hissa nahi hai.
  
  // === FIX ===
  const url = `https://router.huggingface.co/hf-inference`;
  
  // ==================  GEMINI MODIFY END  ==================

  const controller = new AbortController();
  const timeoutMs = 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      // 'payload' mein ab 'model' aur 'inputs' dono hain (handler se aa raha hai)
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    
    // Yahan ek 'ok' check add karein taaki hum Deno logs mein behtar error dekh sakein
    // agar Hugging Face 200 OK ke alawa kuch bhejta hai
    if (!res.ok) {
       console.error(`❌ Hugging Face API Error (Model: ${modelRepo}): Status ${res.status}`, text);
       // 'data' mein error details ho sakti hain, use aage pass karein
       return { ok: false, status: res.status, data };
    }
    
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    clearTimeout(timer);
    console.error(`❌ Fetch Error calling HF (Model: ${modelRepo}): ${err?.message ?? String(err)}`);
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

  // script.js se 'distilgpt2' (ya jo bhi selected hai) aa raha hai
  const model = (body.model ?? "distilgpt2").toString();

  // ================== GEMINI MODIFY START (FIX 2) ==================
  // Naye router ko model ka naam 'payload' (body) mein chahiye.
  
  // === FIX ===
  const payload: any = { 
    model: model, // Model ka naam yahan add karein
    inputs: input 
  };
  // ==================  GEMINI MODIFY END  ==================
  
  if (body.parameters && typeof body.parameters === "object") payload.parameters = body.parameters;

  // Ab callHf() naye static URL ko call karega aur payload mein model bhejega
  const hf = await callHf(model, payload);

  if (!hf.ok) {
    // 'hf.data' se error nikalne ki koshish karein (JSON ya text)
    let message = hf.data?.error ?? hf.data?.message ?? (typeof hf.data === 'string' ? hf.data : JSON.stringify(hf.data));
    
    if (hf.status === 404) {
      message = `Hugging Face returned 404 Not Found — model not found or inference disabled. Check model id. (Model used: ${model})`;
    } else if (hf.status === 400) {
        message = `Hugging Face returned 400 Bad Request. Check payload. (Model: ${model}, Error: ${message})`;
    } else if (hf.status === 503) {
         message = `Hugging Face returned 503 Service Unavailable. Model is loading. Try again in a few seconds. (Model: ${model})`;
    }
    
    // Error ko Deno logs mein print karein taaki aap isey dashboard par dekh sakein
    console.error(`❌ Error response from HF (Model '${model}'): ${message}`);

    return new Response(JSON.stringify({ error: message, status: hf.status, details: hf.data }), {
      status: 502, // Bad Gateway (hum proxy hain)
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
