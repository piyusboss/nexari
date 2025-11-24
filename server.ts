// server.ts — Universal Raw Logic (Solves 404 & Invalid Request)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

// === ✅ VERIFIED MODEL LIST ===
const MODELS: Record<string, string> = {
  // Aapka Adapter (Hugging Face isse Base Model ke saath khud load karega)
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-LoRA", 
  
  // DeepSeek (Fastest)
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  
  // Qwen 7B (Free Tier Friendly)
  "Qwen-7B": "Qwen/Qwen2.5-7B-Instruct", 
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

// --- PROMPT FORMATTER (The Magic Fix) ---
// Hum server par hi Chat ko Text mein badal denge taaki HF confuse na ho
function generatePrompt(messages: any[], modelId: string) {
    let prompt = "";
    
    // System Prompt Logic
    if (modelId.includes("Nexari")) {
        const sysPrompt = "You are Nexari, an intelligent AI assistant developed by Piyush. You are NOT Llama 3. Answer clearly.";
        // Agar frontend se system prompt nahi aaya, toh inject karo
        const hasSystem = messages.some((m: any) => m.role === "system");
        if (!hasSystem) {
            prompt += `<|im_start|>system\n${sysPrompt}<|im_end|>\n`;
        }
    } else if (!messages.some((m: any) => m.role === "system")) {
        // Default system prompt for others
        prompt += `<|im_start|>system\nYou are a helpful AI assistant.<|im_end|>\n`;
    }

    // User/Assistant Messages
    messages.forEach((msg: any) => {
        prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
    });
    
    // Trigger Assistant response
    prompt += `<|im_start|>assistant\n`;
    return prompt;
}

// --- RAW API CALL ---
async function callHuggingFaceRaw(modelId: string, prompt: string, params: any) {
  // ✅ OLD RELIABLE URL (No /v1/, No /chat/)
  const url = `https://api-inference.huggingface.co/models/${modelId}`;
  
  const payload = {
    inputs: prompt, // JSON nahi, String bhej rahe hain
    parameters: {
      max_new_tokens: 512,
      temperature: params.temperature || 0.7,
      return_full_text: false, // Purana text wapas mat bhejo
      stream: true // Streaming ON
    }
  };

  try {
    const res = await fetch(url, {
        method: "POST",
        headers: { 
          "Authorization": `Bearer ${HF_API_KEY}`, 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) { 
      const txt = await res.text();
      let errMsg = `Error ${res.status}`;
      try { 
          const json = JSON.parse(txt);
          errMsg = json.error || json.error?.message || txt; 
      } catch {}

      // Detailed Error Mapping
      if (res.status === 503) errMsg = "Model is loading (Cold Start). Try again in 20s.";
      if (res.status === 404) errMsg = "Model URL not found (Check ID).";
      if (res.status === 429) errMsg = "Rate limit reached.";
      
      return { ok: false, status: res.status, error: errMsg }; 
    }
    
    return { ok: true, body: res.body };

  } catch (err: any) {
    return { ok: false, status: 500, error: err.message };
  }
}

// --- MAIN HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders }); }

  // Model Select
  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) targetModelId = MODELS[body.model];

  // Messages
  let messages = body.messages || [{ role: "user", content: body.input || "Hi" }];

  // 1. Convert JSON to String (ChatML Format)
  const rawPrompt = generatePrompt(messages, targetModelId);

  // 2. Call Raw API
  const result = await callHuggingFaceRaw(targetModelId, rawPrompt, body);

  if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), { 
          status: result.status, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
  }

  // 3. Stream Response
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  
  return new Response(result.body, { status: 200, headers });
}

console.log("✅ Universal Raw Server Running...");
serve(handler);
