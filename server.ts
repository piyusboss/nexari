import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// ✅ 1. Hugging Face API Key
const HF_API_KEY = Deno.env.get("HF_API_KEY");

if (!HF_API_KEY) {
  console.error("❌ WARNING: HF_API_KEY environment variable not set!");
}

// ❌ HF_API_URL yahan se hata diya gaya hai, kyunki yeh dynamic hoga.

// ✅ 3. Model Mapping
const MODEL_MAP: { [key: string]: string } = {
  "Nexari G1": "mistralai/Mistral-7B-Instruct-v0.3",
  "Nexari G2": "gpt-oss-20b",
};
const DEFAULT_MODEL_ID = MODEL_MAP["Nexari G1"];

// ✅ CORS config
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handler(req: Request) {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Sirf POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST requests allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // API Key Check
  if (!HF_API_KEY) {
    console.error("❌ API Key is missing. Request failed.");
    return new Response(
      JSON.stringify({ error: "Server configuration error: API Key missing." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Client se data lein
    const { message, model } = await req.json();

    if (!message || typeof message !== "string" || message.trim() === "") {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sahi Model ID chunein
    const modelId = MODEL_MAP[model] || DEFAULT_MODEL_ID;
    
    let prompt = message;

    // Mistral ke liye prompt format karein
    if (modelId.includes("mistralai/Mistral")) {
      prompt = `[INST] ${message} [/INST]`;
    }

    // ✅✅✅ FIX 1: API URL ko dynamically modelId ke saath banayein ✅✅✅
    // Standard Inference API ka URL format yeh hota hai:
    const HF_API_URL = `https://api-inference.huggingface.co/models/${modelId}`;

    console.log(`ℹ️ Calling Hugging Face API for model: ${modelId}`);
    console.log(`ℹ️ Using Dynamic Endpoint: ${HF_API_URL}`); // Log message update kar diya

    // ✅✅✅ FIX 2: Payload (JSON) se 'model' key ko hata dein ✅✅✅
    const payload = {
      // model: modelId, <-- YEH LINE HATA DI GAYI HAI
      inputs: prompt,
      parameters: {
        return_full_text: false,
        max_new_tokens: 512,
      },
      options: {
        wait_for_model: true,
      },
    };

    // Hugging Face API ko call karein (ab naye dynamic 'HF_API_URL' ke saath)
    const response = await fetch(HF_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // Error handling (ismein koi badlaav nahi)
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Hugging Face API Error (Status: ${response.status}):`, errorText);
      return new Response(
        JSON.stringify({ 
          error: "Hugging Face API failed", 
          details: errorText || `HTTP status ${response.status}` 
        }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();

    // Response ko extract karein
    const output = data[0]?.generated_text;

    if (!output) {
      console.error("❌ Invalid HF Response Structure:", data);
      return new Response(
        JSON.stringify({ response: "Maaf kijiye, model se empty response mila." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Client ko response bhej dein
    return new Response(JSON.stringify({ response: output.trim() }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("💥 Server error:", error);
    return new Response(JSON.stringify({ error: "Internal server error", details: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

console.log("✅ Deno server starting...");
console.log("Registered Hugging Face models:");
Object.keys(MODEL_MAP).forEach(key => {
    console.log(`- ${key} -> ${MODEL_MAP[key]}`);
});

// Server ko start karein
serve(handler);
