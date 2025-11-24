import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) {
  console.error("❌ HF_API_KEY missing.");
  Deno.exit(1);
}

// === MODEL CONFIGURATION ===
const MODELS: Record<string, string> = {
  // Custom Model (Full Merged)
  "Nexari-G1": "Piyush-boss/Nexari-Qwen-3B-Full", 
  
  // Standard Models (Free Tier Friendly)
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
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

// --- PROMPT GENERATOR (ChatML Format) ---
function generatePrompt(messages: any[], modelId: string) {
    let prompt = "";
    // System Prompt for Nexari
    if (modelId.includes("Nexari")) {
        const sysPrompt = "You are Nexari, an intelligent AI assistant developed by Piyush. You are NOT Llama 3. Answer clearly.";
        if (!messages.some((m: any) => m.role === "system")) {
            prompt += `<|im_start|>system\n${sysPrompt}<|im_end|>\n`;
        }
    }
    // Build Conversation
    messages.forEach((msg: any) => {
        prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
    });
    prompt += `<|im_start|>assistant\n`;
    return prompt;
}

// --- API CALLER (The Fix) ---
async function callHuggingFaceRouter(modelId: string, messages: any[], params: any, isCustom: boolean) {
  let url = "";
  let payload = {};

  if (isCustom) {
      // ✅ FIX: Custom Models ke liye specific Router URL
      url = `https://router.huggingface.co/hf-inference/models/${modelId}`;
      // Custom models ko RAW PROMPT chahiye
      const rawPrompt = generatePrompt(messages, modelId);
      payload = {
          inputs: rawPrompt,
          parameters: {
              max_new_tokens: 512,
              temperature: 0.7,
              return_full_text: false,
              stream: true
          }
      };
  } else {
      // ✅ FIX: Official Models ke liye Standard Router URL
      url = `https://router.huggingface.co/hf-inference/v1/chat/completions`;
      payload = {
          model: modelId,
          messages: messages,
          max_tokens: 512,
          temperature: 0.7,
          stream: true
      };
  }

  console.log(`Calling URL: ${url}`); // Debug log

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
        let errorMsg = `HF Error ${res.status}`;
        if (res.status === 404) errorMsg = "Model endpoint not found (Check Model ID).";
        if (res.status === 503) errorMsg = "Model is loading (Cold Start)... Wait 20s.";
        return { ok: false, status: res.status, error: errorMsg + " | " + txt };
    }
    
    return { ok: true, body: res.body };

  } catch (err: any) {
    return { ok: false, status: 500, error: err.message };
  }
}

// --- HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders }); }

  let targetModelId = MODELS[DEFAULT_MODEL];
  if (body.model && MODELS[body.model]) targetModelId = MODELS[body.model];

  let messages = body.messages || [{ role: "user", content: body.input || "Hi" }];

  // === ROUTING LOGIC ===
  // Agar Nexari hai toh "Custom Path" use karega, nahi toh "Standard Path"
  const isCustom = targetModelId.includes("Nexari");
  const result = await callHuggingFaceRouter(targetModelId, messages, body, isCustom);

  if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  
  return new Response(result.body, { status: 200, headers });
}

console.log("✅ Router v2 Running...");
serve(handler);
