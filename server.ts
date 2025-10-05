import { serve } from "https://deno.land/std@0.182.0/http/server.ts";

const GEMINI_API_KEY = "AIzaSyAn_AV2_WQiOdUAEzUGoKrJH-adMsVlWC4";
const API_URL = `https://generativelanguage.googleapis.com/v1beta1/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { message } = await req.json();
    if (!message) {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = {
      contents: [{ parts: [{ text: message }] }],
    };

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Gemini error:", data);
      return new Response(JSON.stringify({ error: "Gemini API failed", details: data }), {
        status: res.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Maaf kijiye, koi jawab nahi mil paaya.";

    return new Response(JSON.stringify({ response: text }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Server error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

console.log("Server running on http://localhost:8000");
await serve(handler, { port: 8000 });
