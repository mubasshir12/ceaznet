import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// We read the HTML template dynamically during runtime.
// In Supabase Edge Functions, bundled files alongside the function folder can be read this way.
const templateHtml = await Deno.readTextFile(new URL("./template.html", import.meta.url));

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email: providedEmail, siteUrl = "https://your-domain.com" } = await req.json();

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseServiceKey || !supabaseAnonKey) {
      throw new Error("Supabase internal variables missing.");
    }

    // Verify the user token from the client invocation for security
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("Missing Authorization header. Cannot verify user.");
    }

    const supabaseUserClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: authError } = await supabaseUserClient.auth.getUser();
    
    if (authError || !user) {
      throw new Error("Unauthorized to send this alert. Invalid session.");
    }

    const targetEmail = user.email || providedEmail;

    if (!targetEmail) {
      throw new Error("Email is required");
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const { data: keysData, error: keyError } = await supabaseAdmin
      .from("news_api_keys")
      .select("api_key")
      .eq("provider", "brevo")
      .eq("status", "active")
      .order("calls_count", { ascending: true })
      .limit(1);

    if (keyError || !keysData || keysData.length === 0) {
      throw new Error("Could not find an active Brevo API key in the database.");
    }

    const BREVO_API_KEY = keysData[0].api_key;

    const userAgent = req.headers.get("user-agent") || "Unknown Device";
    
    // Supabase Edge Functions often include headers like x-real-ip or x-forwarded-for
    const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "Unknown IP";
    
    // Sometimes cloud providers add country headers (like cf-ipcountry via Cloudflare)
    const country = req.headers.get("cf-ipcountry") || "Unknown Location";
    const locationStr = country !== "Unknown Location" ? `Country Code: ${country} (IP: ${ip})` : `IP: ${ip}`;

    // Replace the variables dynamically
    const compiledHtml = templateHtml
      .replace(/{{ \.Email }}/g, targetEmail)
      .replace(/{{ \.SiteURL }}/g, siteUrl)
      .replace(/{{ \.Device }}/g, userAgent)
      .replace(/{{ \.Location }}/g, locationStr)
      .replace(/{{ \.Time }}/g, new Date().toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" }));

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "Ceaznet Security", email: "security@ceaznet.com" },
        to: [{ email: targetEmail }],
        subject: "Your password has been changed",
        htmlContent: compiledHtml,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Failed to send email");
    }

    return new Response(JSON.stringify({ success: true, data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
