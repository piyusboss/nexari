import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// 🔐 API key ko environment variable se securely load karein
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

if (!GEMINI_API_KEY) {
  console.error("❌ Error: GEMINI_API_KEY environment variable not set!");
  Deno.exit(1);
}

// ✅✅✅ YAHAN BADLAAV KIYA GAYA HAI ✅✅✅
// Hum client se (model.js se) 'Nexari G1' ya 'Nexari G2' jaise naam expect kar rahe hain.
// Hum un naamon ko asli API URLs se map karenge.

const MODEL_MAP: { [key: string]: string } = {
  // "Nexari G1" (Display Name) -> "Full API URL"
  // Yeh aapka original model hai
  "Nexari G1": `https://generativelanguage.googleapis.com/gemini-2.5-flash-lite-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`,
  
  // "Nexari G2" (Aapka doosra model) -> "Full API URL"
  // Yeh 'gemini-pro' hai (jaisa aapne comment mein likha tha)
  // Note: 'gemini-pro' v1beta endpoint use karta hai
  "Nexari G2": `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
  
  // Aap yahan aur models add kar sakte hain, jaise:
  // "Nexari Pro": `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${GEMINI_API_KEY}`
};

// Agar koi anjaan model aaye, toh default "Nexari G1" use karein
const DEFAULT_API_URL = MODEL_MAP["Nexari G1"];
// ✅✅✅ END OF CHANGE ✅✅✅


// ✅ CORS config
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handler(req: Request) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST requests allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // ✅✅✅ YAHAN BADLAAV KIYA GAYA HAI ✅✅✅
    // Ab 'message' ke saath 'model' ko bhi request se nikaal rahe hain
    const { message, model } = await req.json(); 
    // ✅✅✅ END OF CHANGE ✅✅✅

    if (!message || typeof message !== "string" || message.trim() === "") {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Proper Gemini API request body
    const payload = {
      contents: [
        {
          role: "user",
          parts: [{ text: message }],
        },
      ],
    };

    // ✅✅✅ YAHAN BADLAAV KIYA GAYA HAI ✅✅✅
    // Client dwara bheje gaye 'model' naam ke aadhaar par sahi API URL chunein
    // Agar 'model' ka naam map mein nahi milta, toh default URL use karein
    const API_URL = MODEL_MAP[model] || DEFAULT_API_URL;
    
    console.log(`ℹ️ Model requested: "${model}", Using API endpoint for: "${Object.keys(MODEL_MAP).find(key => MODEL_MAP[key] === API_URL) || 'Default'}"`);
    // ✅✅✅ END OF CHANGE ✅✅✅

    // Call Gemini API
    const response = await fetch(API_URL, { // <-- API_URL ab dynamic hai
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    console.log("🔍 Raw Gemini response:", rawText); // Debug logging

    if (!rawText || rawText.trim() === "") {
      return new Response(
        JSON.stringify({ error: "Gemini returned empty response" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = JSON.parse(rawText);

    if (!response.ok) {
      console.error("❌ Gemini API Error:", data);
      return new Response(
        JSON.stringify({ error: "Gemini API failed", details: data }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract AI message
    const output =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Maaf kijiye, Gemini ne koi jawab nahi diya.";

    return new Response(JSON.stringify({ response: output }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("💥 Server error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

console.log("✅ Deno server running at http://localhost:8000");
console.log("Registered models:");
Object.keys(MODEL_MAP).forEach(key => {
    console.log(`- ${key} -> ${MODEL_MAP[key].split('/')[3].split(':')[0]}`);
});
serve(handler, { port: 8000 });
