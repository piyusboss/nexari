// server.ts — Streaming Fix for Nexari G1
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const HF_API_KEY = Deno.env.get("HF_API_KEY") ?? "";
const SHARED_SECRET = "NEXARI_SECURE_HANDSHAKE_KEY_2025"; 

// === CONFIG ===
const MODELS: Record<string, string> = {
  "Nexari-G1": "https://Nexari-Research-nexari-server.hf.space/v1/chat/completions",
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
  
  // Identify if it's our Custom Space (Nexari)
  let isCustomSpace = targetEndpoint.includes("hf.space");
  
  // Decide Endpoint URL
  let finalUrl = isCustomSpace ? targetEndpoint : "https://router.huggingface.co/v1/chat/completions";

  // === CRITICAL FIX ===
  // Previously: let useStream = !isCustomSpace; (This caused the crash)
  // New Logic: Always use stream because app.py is now strictly streaming SSE.
  let useStream = true; 

  console.log(`🚀 Target: ${modelKey} | Custom: ${isCustomSpace} | Stream: ${useStream}`);

  try {
    const payload = {
        model: isCustomSpace ? "tgi" : MODELS[modelKey], 
        messages: body.messages,
        // Custom Space needs lower tokens to avoid CPU timeout during stream setup
        max_tokens: isCustomSpace ? 512 : 2048, 
        temperature: body.temperature || 0.7,
        stream: true // Force Stream ON
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
    
    if (!res.ok) {
        const text = await res.text();
        if (res.status === 503) return new Response(JSON.stringify({ error: { code: "LOADING", message: "Model is warming up..." } }), { status: 503, headers: corsHeaders });
        return new Response(JSON.stringify({ error: `Upstream Error: ${text}` }), { status: res.status, headers: corsHeaders });
    }

    // Since we forced stream=true, we ALWAYS pipe the body directly.
    // No more `await res.json()` which was causing the "Unexpected token d" error.
    return new Response(res.body, { 
        status: 200, 
        headers: { 
            ...corsHeaders, 
            "Content-Type": "text/event-stream", 
            "Cache-Control": "no-cache", 
            "Connection": "keep-alive" 
        } 
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

serve(handler);
