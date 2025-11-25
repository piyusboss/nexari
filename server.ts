// server.ts — Nexari Hybrid Bridge (Space + Router)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

if (!HF_API_KEY) { console.error("❌ HF_API_KEY missing."); Deno.exit(1); }

// === 1. MODEL CONFIGURATION ===
const MODELS: Record<string, string> = {
  // 🟢 PERSONAL SPACE URL (Nexari)
  "Nexari-G1": "https://piyush-boss-nexari-server.hf.space/v1/chat/completions",
  
  // 🟠 OFFICIAL ROUTER MODELS (DeepSeek, Qwen)
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  "Qwen2.5-72B": "Qwen/Qwen2.5-72B-Instruct", 
};
const DEFAULT_MODEL = "Nexari-G1"; 

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

// --- AUTH HELPER ---
function verifyToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  try {
    const [payloadB64, signature] = authHeader.split(".");
    if (!payloadB64 || !signature) return false;
    const hmac = createHmac("sha256", SHARED_SECRET);
    hmac.update(payloadB64);
    const expectedSignature = hmac.digest("hex");
    if (signature !== expectedSignature) return false;
    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp < Math.floor(Date.now() / 1000)) return false; // Token Expired
    return true;
  } catch (e) { return false; }
}

// --- MAIN REQUEST HANDLER ---
async function handler(req: Request): Promise<Response> {
  // 1. CORS Preflight
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  // 2. Auth Check
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) {
    return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid Token" } }), { 
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }

  if (req.method !== "POST") return new Response("Only POST allowed", { status: 405, headers: corsHeaders });

  // 3. Parse Body
  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  // 4. Determine Target (Space vs Router)
  let requestedModel = body.model || DEFAULT_MODEL;
  
  // Model Mapping Check
  let targetEndpoint = MODELS[requestedModel];
  if (!targetEndpoint) {
      // Agar model list mein nahi hai, toh default (Nexari) use karo
      console.warn(`Unknown model ${requestedModel}, switching to Nexari.`);
      targetEndpoint = MODELS["Nexari-G1"];
  }

  const isPersonalSpace = targetEndpoint.includes("hf.space");
  
  // Final URL Construction
  // Agar Space hai, toh wahi URL use karo. Agar Router hai, toh official router URL.
  const finalUrl = isPersonalSpace 
      ? targetEndpoint 
      : "https://router.huggingface.co/v1/chat/completions";

  console.log(`🚀 Routing: ${requestedModel} -> ${isPersonalSpace ? "PERSONAL SPACE" : "HF ROUTER"}`);

  try {
    // 5. Prepare Payload
    const payload = {
        // Router ko model ID chahiye, Space ko fark nahi padta (wo 'tgi' ya kuch bhi le lega)
        model: isPersonalSpace ? "tgi" : MODELS[requestedModel], 
        messages: body.messages,
        max_tokens: body.max_tokens || 512,
        temperature: body.temperature || 0.7,
        stream: isPersonalSpace ? false : (body.stream || false) // Space stream support nahi karta
    };

    // 6. Fetch from Upstream
    const res = await fetch(finalUrl, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${HF_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    // 7. Handle Response
    const text = await res.text();

    if (!res.ok) {
        console.error(`❌ Upstream Error:`, text);
        // "Model Loading" wala error catch karo
        if (res.status === 503 || text.includes("loading")) {
            return new Response(JSON.stringify({ 
                error: { code: "LOADING", message: "Nexari is waking up. Please wait 30 seconds." } 
            }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: `Upstream Error: ${text}` }), { status: res.status, headers: corsHeaders });
    }

    // 8. Return Success
    // Space JSON return karega, Frontend usse display kar dega
    return new Response(text, { 
        status: 200, 
        headers: { 
            ...corsHeaders, 
            "Content-Type": "application/json" 
        } 
    });

  } catch (err: any) {
    console.error("Critical Error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

console.log("✅ Nexari Hybrid Server (Fixed) Running...");
serve(handler);
