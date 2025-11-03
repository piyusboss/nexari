import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// ✅ 1. Hugging Face API Key
const HF_API_KEY = Deno.env.get("HF_API_KEY");

if (!HF_API_KEY) {
  console.error("❌ WARNING: HF_API_KEY environment variable not set!");
}

// ✅✅✅ FIX 1: API Base URL ko sahi kiya gaya ✅✅✅
// Puraana (wrong): "https://router.huggingface.co/hf-inference/models/"
// Sahi (correct): "https://router.huggingface.co/hf-inference/"
// (Aapke "Not Found" error ka yahi kaaran tha)
const HF_API_BASE_URL = "https://router.huggingface.co/hf-inference/";

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
    
    // Naya, sahi URL banayein
    const apiUrl = HF_API_BASE_URL + modelId;
    
    let prompt = message;

    // Mistral ke liye prompt format karein
    if (modelId.includes("mistralai/Mistral")) {
      prompt = `[INST] ${message} [/INST]`;
    }

    console.log(`ℹ️ Calling Hugging Face Model: ${modelId}`);
    console.log(`ℹ️ Using Endpoint: ${apiUrl}`); // Debugging ke liye

    // Payload taiyaar karein
    const payload = {
      inputs: prompt,
      parameters: {
        return_full_text: false,
        max_new_tokens: 512,
      },
      options: {
        wait_for_model: true,
      },
    };

    // Hugging Face API ko call karein
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // ✅✅✅ FIX 2: Error handling ko behtar kiya gaya ✅✅✅
    // Ab hum .json() call karne se *pehle* check karte hain ki request successful tha ya nahi.
    // Isse "Not Found" error par server crash nahi hoga.
    if (!response.ok) {
      const errorText = await response.text(); // Error ko text ke roop mein padhein
      console.error(`❌ Hugging Face API Error (Status: ${response.status}):`, errorText);
      return new Response(
        JSON.stringify({ 
          error: "Hugging Face API failed", 
          details: errorText || `HTTP status ${response.status}` 
        }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Ab hum safe hain .json() call karne ke liye
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
    // Yeh "SyntaxError" ab nahi aana chahiye, lekin baki errors ke liye zaroori hai
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
