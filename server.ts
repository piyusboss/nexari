// server.ts — Hybrid Fix (Standard for Public, Raw for Custom)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

const MODELS: Record<string, string> = {
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-Full", // Custom Model
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B", // Official
  "Qwen-7B": "Qwen/Qwen2.5-7B-Instruct", // Official
};

const DEFAULT_MODEL = "Nexari-G1";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// --- AUTH ---
function verifyToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  try {
    const [payloadB64, signature] = authHeader.split(".");
    if (!payloadB64 || !signature) return false;
    const hmac = createHmac("sha256", SHARED_SECRET);
    hmac.update(payloadB64);
    if (signature !== hmac.digest("hex")) return false;
    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch (e) { return false; }
}

// --- ERROR HANDLING ---
function formatHfError(status: number, rawBody: string) {
  let message = `Server Error (${status})`;
  try {
      const json = JSON.parse(rawBody);
      message = json.error?.message || json.error || message;
      if (status === 503) message = "Model loading (Cold Start)... Wait 30s.";
      if (status === 400) message = "Invalid Request Format.";
  } catch {}
  return { error: { message } };
}

// --- METHOD 1: Standard OpenAI Style (For DeepSeek/Official Qwen) ---
async function callStandardAPI(modelId: string, messages: any[], params: any) {
  const url = `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`;
  const payload = {
    model: modelId,
    messages: messages,
    max_tokens: 512,
    temperature: 0.7,
    stream: true
  };

  const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
  });

  if (!res.ok) {
      const txt = await res.text();
      return { ok: false, status: res.status, data: formatHfError(res.status, txt) };
  }
  return { ok: true, body: res.body };
}

// --- METHOD 2: Raw Manual Prompting (For Custom Nexari) ---
async function callRawAPI(modelId: string, messages: any[], params: any) {
  // Direct Model URL (Bypasses strict validation)
  const url = `https://api-inference.huggingface.co/models/${modelId}`;
  
  // Manually build ChatML Prompt (Qwen Format)
  // <|im_start|>system...<|im_end|><|im_start|>user...
  let prompt = "";
  
  // Inject System Prompt if missing
  const hasSystem = messages.some((m: any) => m.role === "system");
  if (!hasSystem) {
      prompt += `<|im_start|>system\nYou are Nexari, an intelligent AI assistant developed by Piyush. Answer clearly.<|im_end|>\n`;
  }

  messages.forEach((msg: any) => {
      prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
  });
  prompt += `<|im_start|>assistant\n`;

  const payload = {
    inputs: prompt,
    parameters: {
      max_new_tokens: 512,
      temperature: 0.7,
      return_full_text: false, // Sirf naya jawab chahiye
      stream: true 
    }
  };

  const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
  });

  if (!res.ok) {
      const txt = await res.text();
      return { ok: false, status: res.status, data: formatHfError(res.status, txt) };
  }
  return { ok: true, body: res.body };
}

// --- MAIN HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders }); }

  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) targetModelId = MODELS[body.model];

  let messages = body.messages || [{ role: "user", content: body.input || "Hi" }];

  // === HYBRID SWITCHING ===
  let result;
  if (targetModelId.includes("Nexari")) {
      // Nexari ke liye Raw Method use karo (Fixes Invalid Request)
      result = await callRawAPI(targetModelId, messages, body);
  } else {
      // Baaki sab ke liye Standard Method
      result = await callStandardAPI(targetModelId, messages, body);
  }

  if (!result.ok) {
      return new Response(JSON.stringify(result.data), { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  
  return new Response(result.body, { status: 200, headers });
}

console.log("✅ Hybrid Server Running...");
serve(handler);
