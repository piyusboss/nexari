// server.ts — Smart Token Limits (VIP = Long, Custom = Fast)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) { console.error("❌ HF_API_KEY missing."); Deno.exit(1); }

// === MODEL MAPPING ===
const MODELS: Record<string, string> = {
  // 🟢 PERSONAL SPACE (Custom)
  "Nexari-G1": "https://piyush-boss-nexari-server.hf.space/v1/chat/completions",
  
  // 🟠 VIP ROUTER (Official High-Speed)
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  "Qwen2.5-72B": "Qwen/Qwen2.5-72B-Instruct", 
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
    return signature === hmac.digest("hex");
  } catch { return false; }
}

// --- HANDLER ---
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) return new Response(JSON.stringify({error: "Unauthorized"}), {status: 401, headers: corsHeaders});
  if (req.method !== "POST") return new Response("Only POST", { status: 405 });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  let modelKey = body.model || DEFAULT_MODEL;
  let targetUrl = MODELS[modelKey] || MODELS[DEFAULT_MODEL];

  // Logic: Kya ye humara Custom Space hai?
  let isCustomSpace = targetUrl.includes("hf.space");
  
  // URL Setup
  if (!isCustomSpace) {
      targetUrl = "https://router.huggingface.co/v1/chat/completions";
  }

  // === 🧠 SMART TOKEN LOGIC ===
  // Agar VIP model hai toh 4096 tokens (Bahut lamba answer allowed)
  // Agar Custom Space hai toh 512 tokens (Speed maintain karne ke liye)
  // User agar frontend se khud limit bheje, toh wo priority lega.
  const defaultMaxTokens = isCustomSpace ? 512 : 4096;
  const finalMaxTokens = body.max_tokens || defaultMaxTokens;

  console.log(`🚀 Route: ${modelKey} | Limit: ${finalMaxTokens} tokens`);

  try {
    const payload = {
        model: isCustomSpace ? "tgi" : MODELS[modelKey], 
        messages: body.messages,
        max_tokens: finalMaxTokens, // <--- Yahan Fix Hua Hai
        temperature: body.temperature || 0.7,
        stream: isCustomSpace ? false : (body.stream || false) 
    };

    const res = await fetch(targetUrl, {
        method: "POST",
        headers: { 
            "Authorization": `Bearer ${HF_API_KEY}`, 
            "Content-Type": "application/json" 
        },
        body: JSON.stringify(payload)
    });

    const text = await res.text();

    if (!res.ok) {
        if (res.status === 503) {
            return new Response(JSON.stringify({ error: { code: "LOADING", message: "Model is warming up. Please wait." } }), { status: 503, headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: `Upstream Error: ${text}` }), { status: res.status, headers: corsHeaders });
    }

    return new Response(text, { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

console.log("✅ Nexari Server (Smart Limits) Running...");
serve(handler);
