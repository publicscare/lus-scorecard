// Supabase keep-alive heartbeat.
// The free tier pauses a project after 7 days without API activity; this
// endpoint performs one tiny read against the games table so the activity
// clock resets. Invoked once a day by the Vercel cron in vercel.json.
// Uses the same public URL + publishable key the client app already ships.
const SUPABASE_URL = "https://ddrcflyuqeuzotmxxtnh.supabase.co";
const SUPABASE_KEY = "sb_publishable_QFfgTfwH5OQUaWP_LaB2qQ_a0WBts8O";

export default async function handler(req, res) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/games?select=code&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    // Body content doesn't matter — the request itself is the heartbeat.
    const body = await r.text();
    res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      supabaseStatus: r.status,
      rows: r.ok ? Math.min(1, (body || "").length > 2 ? 1 : 0) : 0,
      at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e && e.message || e), at: new Date().toISOString() });
  }
}
