import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// 🔐 API key ko environment variable se securely load karein
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

if (!GEMINI_API_KEY) {
  console.error("❌ Error: GEMINI_API_KEY environment variable not set!");
  Deno.exit(1);
}

// ✅✅✅ YAHAN BADLAAV KIYA GAYA HAI ✅✅✅
// Model ko 'gemini-1.5-flash-latest' se badal kar 'gemini-pro' kar diya gaya hai
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

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
    const { message } = await req.json();
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

    // Call Gemini API
    const response = await fetch(API_URL, {
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
serve(handler, { port: 8000 });
