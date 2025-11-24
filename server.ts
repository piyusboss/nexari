// server.ts — The Golden Fix (Correct Router Paths)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

// === ✅ FINAL MODEL LIST ===
const MODELS: Record<string, string> = {
  // Custom Model (Raw Path use karega)
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-Full", 
  
  // DeepSeek (Chat Path use karega)
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  
  // Qwen 7B (Chat Path use karega)
  "Qwen-7B": "Qwen/Qwen2.5-7B-Instruct", 
};

const DEFAULT_MODEL = "Nexari-G1";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// --- AUTHENTICATION ---
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

// --- PROMPT GENERATOR (Manual Formatting for Custom Models) ---
function generatePrompt(messages: any[], modelId: string) {
    let prompt = "";
    // System Prompt
    if (modelId.includes("Nexari")) {
        const sysPrompt = "You are Nexari, an intelligent AI assistant developed by Piyush. You are NOT Llama 3. Answer clearly.";
        if (!messages.some((m: any) => m.role === "system")) {
            prompt += `<|im_start|>system\n${sysPrompt}<|im_end|>\n`;
        }
    }
    // Messages
    messages.forEach((msg: any) => {
        prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
    });
    prompt += `<|im_start|>assistant\n`;
    return prompt;
}

// --- METHOD 1: Standard Chat API (For Official Models) ---
async function callStandardAPI(modelId: string, messages: any[], params: any) {
  // ✅ CORRECT URL: No /hf-inference/ junk
  const url = `https://router.huggingface.co/models/${modelId}/v1/chat/completions`;
  
  const payload = {
    model: modelId,
    messages: messages,
    max_tokens: 512,
    temperature: 0.7,
    stream: true
  };

  try {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!res.ok) return await handleHfError(res);
    return { ok: true, body: res.body };
  } catch (err: any) { return { ok: false, status: 500, data: { error: { message: err.message } } }; }
}

// --- METHOD 2: Raw API (For Nexari) ---
async function callRawAPI(modelId: string, messages: any[], params: any) {
  // ✅ CORRECT URL: Direct Model Path
  const url = `https://router.huggingface.co/models/${modelId}`;
  
  const rawPrompt = generatePrompt(messages, modelId);
  const payload = {
    inputs: rawPrompt,
    parameters: {
      max_new_tokens: 512,
      temperature: 0.7,
      return_full_text: false,
      stream: true 
    }
  };

  try {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${HF_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!res.ok) return await handleHfError(res);
    return { ok: true, body: res.body };
  } catch (err: any) { return { ok: false, status: 500, data: { error: { message: err.message } } }; }
}

// --- ERROR HANDLER HELPER ---
async function handleHfError(res: Response) {
    const txt = await res.text();
    let message = `Server Error (${res.status})`;
    try { 
        const json = JSON.parse(txt);
        message = json.error?.message || json.error || message;
    } catch {}

    if (res.status === 503) message = "Model is loading... (Cold Start). Wait 30s.";
    if (res.status === 404) message = "Model URL not found. Check Model ID.";
    
    return { ok: false, status: res.status, data: { error: { message: message } } };
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

  // === HYBRID ROUTING ===
  let result;
  if (targetModelId.includes("Nexari")) {
      // Custom Model -> Raw Path
      result = await callRawAPI(targetModelId, messages, body);
  } else {
      // Official Model -> Standard Chat Path
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

console.log("✅ Golden Router Server Running...");
serve(handler);
