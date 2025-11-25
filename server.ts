// server.ts — The Final Connection (Nexari Space + VIP Router)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) { console.error("❌ HF_API_KEY missing."); Deno.exit(1); }

// === MODEL MAPPING ===
const MODELS: Record<string, string> = {
  // 🟢 YEH HAI TUMHARA NAYA SPACE URL
  // Note: Hum seedha '/v1/chat/completions' par hit karenge jo tumne app.py mein banaya hai
  "Nexari-G1": "https://piyush-boss-nexari-server.hf.space/v1/chat/completions",
  
  // VIP Models abhi bhi HF Router se chalenge
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

  // 1. Target URL choose karo
  let modelKey = body.model || DEFAULT_MODEL;
  let targetUrl = MODELS[modelKey] || MODELS[DEFAULT_MODEL];

  // Logic: Agar ye tumhara Space hai, toh URL wahi rahega.
  // Agar ye VIP model hai, toh HF Router URL banega.
  let isCustomSpace = targetUrl.includes("hf.space");
  
  if (!isCustomSpace) {
      targetUrl = "https://router.huggingface.co/v1/chat/completions";
  }

  console.log(`🚀 Route: ${isCustomSpace ? "Custom Space (Nexari)" : "HF Router (VIP)"} -> ${modelKey}`);

  try {
    // 2. Payload Finalize karo
    const payload = {
        // Space ko model name se fark nahi padta, par Router ko padta hai
        model: isCustomSpace ? "nexari" : MODELS[modelKey], 
        messages: body.messages,
        max_tokens: body.max_tokens || 512,
        temperature: body.temperature || 0.7,
        stream: false 
    };

    const res = await fetch(targetUrl, {
        method: "POST",
        headers: { 
            // Space Public hai toh token ki zaroorat nahi, par Router ko chahiye
            "Authorization": `Bearer ${HF_API_KEY}`, 
            "Content-Type": "application/json" 
        },
        body: JSON.stringify(payload)
    });

    const text = await res.text();

    if (!res.ok) {
        console.error(`❌ Error:`, text);
        return new Response(JSON.stringify({ error: `Upstream Error (${res.status}): ${text}` }), { status: res.status, headers: corsHeaders });
    }

    // 3. Success! JSON wapas bhejo
    return new Response(text, { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });

  } catch (err: any) {
    console.error("Critical:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

console.log("✅ SYSTEM ONLINE: Nexari Space Connected.");
serve(handler);
