// Kind Words, London — moderation + rate-limiting edge function
// Works with ANY OpenAI-compatible chat endpoint (OpenAI, GreenPT, Together,
// Groq, a local LLM, Anthropic's OpenAI-compat layer, etc.).
// Swap providers by changing the MODERATION_* secrets — no code change.
//
// Deploy:  supabase functions deploy submit --no-verify-jwt
//   (--no-verify-jwt makes the endpoint publicly callable, which is intended:
//    it's a public submit box. Abuse is handled by the rate limit + moderation
//    below, and it keeps the function working with the new publishable keys.)
// Secrets: supabase secrets set \
//            MODERATION_BASE_URL=... MODERATION_API_KEY=... MODERATION_MODEL=... \
//            RATE_LIMIT_SALT=<any long random string>
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- tune these -------------------------------------------------------------
const RATE_LIMIT_MAX = 5;          // submissions allowed...
const RATE_LIMIT_WINDOW_MIN = 15;  // ...per this many minutes, per IP
// ----------------------------------------------------------------------------

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT =
  "You are a content safety check for a public kindness wall where strangers " +
  "leave short anonymous messages for each other. Approve the message if it is " +
  "kind, neutral, supportive, or harmlessly playful. Reject it ONLY if it is " +
  "hateful, harassing, threatening, sexual, spam or advertising, contains personal " +
  "contact details, or is clearly designed to upset the reader. Be lenient with " +
  "imperfect or quirky kindness.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { text } = await req.json();
    const clean = (text ?? "").toString().trim();

    if (clean.length < 3 || clean.length > 280) {
      return json({ approved: false, reason: "Keep it between 3 and 280 characters." });
    }

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      // legacy projects expose SUPABASE_SERVICE_ROLE_KEY; new-key projects expose
      // SUPABASE_SECRET_KEYS (a JSON map). Use whichever is present.
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
        JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default,
    );

    // --- rate limit (before we spend a moderation call) ---------------------
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const ipHash = await hashIp(ip);
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60_000).toISOString();

    // best-effort prune of expired rows keeps the table tiny
    await supa.from("submission_log").delete().lt("created_at", windowStart);

    const { count } = await supa
      .from("submission_log")
      .select("*", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", windowStart);

    if ((count ?? 0) >= RATE_LIMIT_MAX) {
      return json({
        approved: false,
        rateLimited: true,
        reason: "You've shared a few already — give others a turn and come back in a little while.",
      });
    }

    // count this attempt (so repeated rejected tries still throttle)
    await supa.from("submission_log").insert({ ip_hash: ipHash });

    // --- moderation ---------------------------------------------------------
    const verdict = await moderate(clean);

    if (verdict.status === "approved") {
      await supa.from("messages").insert({ text: clean, approved: true });
      return json({ approved: true });
    }
    if (verdict.status === "rejected") {
      return json({
        approved: false,
        reason: verdict.reason || "Let's keep it kind — try rephrasing.",
      });
    }

    // Moderator unreachable / unparseable: fail safe — hold unpublished for a human.
    await supa.from("messages").insert({ text: clean, approved: false });
    return json({ approved: false, pending: true });
  } catch (_e) {
    return json({ approved: false, reason: "Something went wrong — try again." }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function hashIp(ip: string): Promise<string> {
  const salt = Deno.env.get("RATE_LIMIT_SALT") ?? "";
  const data = new TextEncoder().encode(salt + "|" + ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Verdict = { status: "approved" | "rejected" | "error"; reason?: string };

async function moderate(text: string): Promise<Verdict> {
  const base = Deno.env.get("MODERATION_BASE_URL");
  const key = Deno.env.get("MODERATION_API_KEY");
  const model = Deno.env.get("MODERATION_MODEL");
  if (!base || !key || !model) return { status: "error" };

  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Message: """${text}"""\n\n` +
              `Reply with ONLY a JSON object, no markdown: ` +
              `{"approved": boolean, "reason": "short friendly note if rejected, empty string if approved"}`,
          },
        ],
      }),
    });

    if (!res.ok) return { status: "error" };

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

    if (parsed.approved === true) return { status: "approved" };
    if (parsed.approved === false) return { status: "rejected", reason: parsed.reason };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}
