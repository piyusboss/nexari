// server.ts — Hybrid Mode (Stream for VIP, Wait for Custom)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

// === CONFIG ===
const MODELS: Record<string, string> = {
  "Nexari-G1": "https://piyush-boss-nexari-server.hf.space/v1/chat/completions",
  "DeepSeek-R1": "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  "Qwen2.5-72B": "Qwen/Qwen2.5-72B-Instruct", 
};
const DEFAULT_MODEL = "Nexari-G1"; 

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS, GET",
  "access-control-allow-headers": "Content-Type, Authorization, X-Nexari-Token",
};

function verifyToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  try {
    const [p, s] = authHeader.split(".");
    if (!p || !s) return false;
    const hmac = createHmac("sha256", SHARED_SECRET);
    hmac.update(p);
    return s === hmac.digest("hex") && JSON.parse(atob(p)).exp > Math.floor(Date.now()/1000);
  } catch { return false; }
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  
  const token = req.headers.get("X-Nexari-Token");
  if (!verifyToken(token)) return new Response(JSON.stringify({error: "Unauthorized"}), {status: 401, headers: corsHeaders});
  if (req.method !== "POST") return new Response("Only POST", { status: 405 });

  let body: any = {};
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  let modelKey = body.model || DEFAULT_MODEL;
  let targetEndpoint = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
  let isCustomSpace = targetEndpoint.includes("hf.space");
  
  let finalUrl = isCustomSpace ? targetEndpoint : "https://router.huggingface.co/v1/chat/completions";

  // === HYBRID LOGIC ===
  // Custom Space = No Stream (Stable)
  // VIP Models = Stream (Fast)
  let useStream = !isCustomSpace; 

  console.log(`🚀 Target: ${modelKey} | Stream: ${useStream}`);

  try {
    const payload = {
        model: isCustomSpace ? "tgi" : MODELS[modelKey], 
        messages: body.messages,
        max_tokens: isCustomSpace ? 256 : 2048, // Custom ke liye limit taaki timeout na ho
        temperature: body.temperature || 0.7,
        stream: useStream // <--- Critical Switch
    };

    const res = await fetch(finalUrl, {
        method: "POST",
        headers: { 
            "Authorization": `Bearer ${HF_API_KEY}`, 
            "Content-Type": "application/json" 
        },
        body: JSON.stringify(payload)
    });

    // === Handling Responses ===
    
    // 1. Agar Error hai
    if (!res.ok) {
        const text = await res.text();
        if (res.status === 503) return new Response(JSON.stringify({ error: { code: "LOADING", message: "Model is warming up..." } }), { status: 503, headers: corsHeaders });
        return new Response(JSON.stringify({ error: `Upstream Error: ${text}` }), { status: res.status, headers: corsHeaders });
    }

    // 2. Agar Stream Hai (VIP) -> Direct Pipe
    if (useStream) {
        return new Response(res.body, { 
            status: 200, 
            headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } 
        });
    } 
    
    // 3. Agar JSON Hai (Nexari) -> Wait & Send
    else {
        const jsonResponse = await res.json();
        return new Response(JSON.stringify(jsonResponse), { 
            status: 200, 
            headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
    }

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

serve(handler);
