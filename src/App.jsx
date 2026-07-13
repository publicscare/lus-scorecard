import { useState, useEffect, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";

/* =====================================================================
   LU'S SCORECARD (writer · game data) + LU'S SCOREBOARD (read-only)
   ---------------------------------------------------------------------
   One artifact, two roles, chosen on load:
     • SCORE  — LU'S SCORECARD (writer / game data). Generates a CODE and
                upserts the contract into a Supabase `games` row on every
                change. The single source of truth.
     • WATCH  — LU'S SCOREBOARD (read-only). Readers enter the same CODE,
                poll the Supabase row, and render. Never edits anything.

   Sync is via Supabase REST (publishable key), so it works across any
   devices — publish the artifact and open it on each device. For eval in
   one session you can SCORE a bit, go back to roles, then WATCH the code.

   CONTRACT (the only thing WATCH consumes):
   { awayName, homeName, inning, awayRuns, homeRuns, awayHr, homeHr,
     hrMax, status:"live"|"final", updatedAt }   // or null => waiting
   ===================================================================== */

const DEFAULT_HR_MAX = 6;
const FF = "'Atkinson Hyperlegible', system-ui, sans-serif";
const clamp = (n) => (n < 0 ? 0 : n);
const blankInning = () => ({ aR: 0, hR: 0, aHr: 0, hHr: 0 });
const sum = (list) => list.reduce((t, i) => ({ aR: t.aR + i.aR, hR: t.hR + i.hR, aHr: t.aHr + i.aHr, hHr: t.hHr + i.hHr }), { aR: 0, hR: 0, aHr: 0, hHr: 0 });
const abbr = (n) => (n || "").trim().slice(0, 3).toUpperCase() || "—";
const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
const isEmpty = (inn) => inn.aR === 0 && inn.hR === 0 && inn.aHr === 0 && inn.hHr === 0;

const THEMES = {
  dark: {
    base: "#06090e",
    bg: "radial-gradient(140% 95% at 50% -10%, #16273a 0%, #0a1018 52%, #03060a 100%)",
    panel: "linear-gradient(180deg,#142334,#0d1825)",
    card: "#13202e", border: "#33495f", text: "#f4f8fc", muted: "#a7b6c9",
    runs: "#ffd24d", away: "#5ccbff", home: "#bcf24f", danger: "#ff5a5a",
    onAccent: "#0a0e14", minusBg: "#1b2a3a", minusText: "#dbe6f2", minusBorder: "#44596f",
    chipBg: "#1b2a3a", inputBg: "#0e1a26", glow: "0 0 24px rgba(255,210,77,0.4)",
  },
  light: {
    base: "#eaf0f6",
    bg: "radial-gradient(140% 95% at 50% -10%, #ffffff 0%, #eef2f7 60%, #dbe3ec 100%)",
    panel: "linear-gradient(180deg,#ffffff,#eaf0f6)",
    card: "#ffffff", border: "#1f2d3d", text: "#0a121c", muted: "#3f5161",
    runs: "#a85a00", away: "#0b5e9c", home: "#3d6310", danger: "#b3261e",
    onAccent: "#ffffff", minusBg: "#e2e8f0", minusText: "#0a121c", minusBorder: "#94a3b8",
    chipBg: "#e2e8f0", inputBg: "#f1f5f9", glow: "none",
  },
};
let C = THEMES.dark;

/* ---------------- TRANSPORT: Supabase (REST) ----------------
   The ONLY place the apps touch a wire. Scorecard upserts the contract
   into the `games` table; Scoreboard fetches it by code. Plain fetch —
   no SDK. The publishable key is safe to ship in client code. */
const SUPABASE_URL = "https://ddrcflyuqeuzotmxxtnh.supabase.co";
const SUPABASE_KEY = "sb_publishable_QFfgTfwH5OQUaWP_LaB2qQ_a0WBts8O";
const SB_READY = !!(SUPABASE_URL && SUPABASE_KEY);
const SB_REST = `${SUPABASE_URL}/rest/v1/games`;
const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

async function publishGame(code, contract) {
  if (!SB_READY || !code) return false;
  try {
    const res = await fetch(SB_REST, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ code, state: contract }),
    });
    return res.ok;
  } catch (e) { return false; }
}
// Returns { ok, game, reason } so the UI can show WHY it's waiting.
async function fetchGame(code) {
  if (!SB_READY) return { ok: false, game: null, reason: "config-missing" };
  if (!code) return { ok: false, game: null, reason: "no-code" };
  try {
    const res = await fetch(`${SB_REST}?code=eq.${encodeURIComponent(code)}&select=state`, { headers: SB_HEADERS });
    if (!res.ok) return { ok: false, game: null, reason: `http-${res.status}` };
    const rows = await res.json();
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    return { ok: true, game: row ? row.state : null, reason: row ? "found" : "empty" };
  } catch (e) {
    return { ok: false, game: null, reason: "request-failed", detail: String((e && e.message) || e) };
  }
}
// Diagnostic: which game codes does the database currently hold?
async function listGameCodes() {
  if (!SB_READY) return null;
  try {
    const res = await fetch(`${SB_REST}?select=code`, { headers: SB_HEADERS });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows.map((r) => r.code) : [];
  } catch (e) { return []; }
}
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const makeCode = () => "LU-" + Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");

const abbrAgo = (s) => (s < 2 ? "just now" : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`);

const Style = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap');
    @keyframes fadeUp { from { opacity:0; transform:translateY(10px);} to { opacity:1; transform:none; } }
    @keyframes pulseBadge { 0%,100%{transform:scale(1);} 50%{transform:scale(1.08);} }
    @keyframes liveDot { 0%,100%{opacity:1; transform:scale(1);} 50%{opacity:.35; transform:scale(.7);} }
    @keyframes breathe { 0%,100%{opacity:.5;} 50%{opacity:1;} }
    .bs-press:active { transform: scale(0.93); }
    .bs-tap:active { transform: scale(0.97); }
    .bs-input::placeholder { color:#8a99ab; }
  `}</style>
);

/* ===================================================================== */

const initialWatch = (() => {
  try { return (new URLSearchParams(window.location.search).get("watch") || "").trim().toUpperCase(); }
  catch (e) { return ""; }
})();

export default function App() {
  const [role, setRole] = useState(initialWatch ? "watch" : null); // null | "score" | "watch"
  if (role === "score") return <Scorecard onExit={() => setRole(null)} />;
  if (role === "watch") return <Mirror onExit={() => setRole(null)} initialCode={initialWatch} />;
  return <RolePicker onPick={setRole} />;
}

function RolePicker({ onPick }) {
  C = THEMES.dark;
  useEffect(() => { try { document.body.style.background = C.base; document.body.style.margin = "0"; } catch (e) {} }, []);
  const big = { fontFamily: FF, width: "100%", border: "none", borderRadius: 18, padding: "22px 18px", cursor: "pointer", textAlign: "center", display: "block" };
  return (
    <Screen center>
      <div style={{ textAlign: "center", maxWidth: 460, margin: "0 auto", animation: "fadeUp .2s ease both" }}>
        <div style={{ fontFamily: FF, fontSize: 38, color: C.runs, fontWeight: 700 }}>⚾ CHOOSE YOUR APP</div>
        <div style={{ color: C.muted, fontSize: 18, fontWeight: 700, marginTop: 6, marginBottom: 28 }}>Two separate apps — pick what this device is</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <button className="bs-press" onClick={() => onPick("score")} style={{ ...big, background: C.runs, color: C.onAccent, boxShadow: "0 12px 26px -8px rgba(255,210,77,0.6)" }}>
            <div style={{ fontSize: 30, fontWeight: 700 }}>📝 LU'S SCORECARD</div>
            <div style={{ fontSize: 16, fontWeight: 700, opacity: 0.85, marginTop: 4 }}>Keep score — runs, home runs, innings · shares a code</div>
          </button>
          <button className="bs-press" onClick={() => onPick("watch")} style={{ ...big, background: C.panel, color: C.text, border: `2px solid ${C.border}` }}>
            <div style={{ fontSize: 30, fontWeight: 700, color: C.away }}>📺 LU'S SCOREBOARD</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.muted, marginTop: 4 }}>Read-only display · enter a game code</div>
          </button>
        </div>
        <p style={{ color: C.muted, fontSize: 15, fontWeight: 700, marginTop: 26, opacity: 0.85 }}>
          The Scorecard keeps score and shows a code; Scoreboards read it.{!SB_READY && " (Sharing needs the published artifact.)"}
        </p>
      </div>
    </Screen>
  );
}

/* =========================== SCORE (writer) =========================== */
/* =========================== WATCH (mirror) =========================== */
function Mirror({ onExit, initialCode }) {
  const [code, setCode] = useState(initialCode || "");
  const [entry, setEntry] = useState(initialCode || "");
  const [game, setGame] = useState(null);
  const [diag, setDiag] = useState(null); // { reason } from last fetch
  const [diagDetail, setDiagDetail] = useState("");
  const [visible, setVisible] = useState(null); // game codes this device can see
  const [now, setNow] = useState(Date.now());
  const [lastOkAt, setLastOkAt] = useState(Date.now()); // last successful fetch (connection health)
  const [theme, setTheme] = useState("dark");
  const [landscape, setLandscape] = useState(false);
  const wakeRef = useRef(null);

  C = THEMES[theme] || THEMES.dark;

  useEffect(() => { try { document.body.style.background = C.base; document.body.style.margin = "0"; } catch (e) {} }, [theme]);

  useEffect(() => {
    const u = () => setLandscape(window.innerWidth > window.innerHeight + 40);
    u();
    window.addEventListener("resize", u);
    window.addEventListener("orientationchange", u);
    return () => { window.removeEventListener("resize", u); window.removeEventListener("orientationchange", u); };
  }, []);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    let timer = null;
    let lastRaw = "";
    let lastChangeAt = Date.now();
    const schedule = (ms) => { if (alive) timer = setTimeout(tick, ms); };
    const tick = async () => {
      if (!alive) return;
      // Tab hidden: don't hit the network; visibilitychange re-ticks on return.
      if (typeof document !== "undefined" && document.hidden) { schedule(5000); return; }
      const res = await fetchGame(code);
      if (!alive) return;
      setGame(res.game || null);
      setDiag(res.reason);
      setDiagDetail(res.detail || "");
      if (res.ok) setLastOkAt(Date.now());
      const raw = res.game ? JSON.stringify(res.game) : "";
      if (raw !== lastRaw) { lastRaw = raw; lastChangeAt = Date.now(); }
      if (!res.game) { const codes = await listGameCodes(); if (alive) setVisible(codes); }
      // Back off when nothing is happening: final games poll every 10s,
      // games idle for over a minute every 5s, active games every 1.2s.
      const isFinalNow = !!(res.game && res.game.status === "final");
      const idle = Date.now() - lastChangeAt > 60000;
      schedule(isFinalNow ? 10000 : idle ? 5000 : 1200);
    };
    const onVis = () => { if (typeof document !== "undefined" && !document.hidden) { clearTimeout(timer); tick(); } };
    document.addEventListener("visibilitychange", onVis);
    tick();
    return () => { alive = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [code]);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  useEffect(() => {
    const acquire = async () => { try { if ("wakeLock" in navigator) wakeRef.current = await navigator.wakeLock.request("screen"); } catch (e) {} };
    const onVis = () => { if (document.visibilityState === "visible") acquire(); };
    acquire();
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); try { wakeRef.current && wakeRef.current.release(); } catch (e) {} };
  }, []);

  const themeBtn = (
    <button className="bs-press" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} aria-label="toggle display" style={{ width: 44, height: 44, borderRadius: 12, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontSize: 20, cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>{theme === "dark" ? "☾" : "☀"}</button>
  );
  const rolesBtn = (
    <button className="bs-press" onClick={onExit} aria-label="back to roles" style={{ height: 44, borderRadius: 12, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontFamily: FF, fontSize: 15, fontWeight: 700, padding: "0 14px", cursor: "pointer" }}>‹ ROLES</button>
  );

  // ---------- CODE ENTRY ----------
  if (!code) {
    const go = () => { const v = entry.trim().toUpperCase(); if (v) setCode(v); };
    return (
      <Screen center>
        <div style={{ position: "absolute", top: 18, left: 18 }}>{rolesBtn}</div>
        <div style={{ position: "absolute", top: 18, right: 18 }}>{themeBtn}</div>
        <div style={{ maxWidth: 420, margin: "0 auto", animation: "fadeUp .2s ease both" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: FF, fontSize: 20, letterSpacing: 4, color: C.muted, fontWeight: 700 }}>⚾ LU'S SCOREBOARD</div>
            <div style={{ fontFamily: FF, fontSize: 34, fontWeight: 700, color: C.runs, marginTop: 8 }}>WATCH A GAME</div>
            <div style={{ color: C.muted, fontSize: 17, fontWeight: 700, marginTop: 6, marginBottom: 24 }}>Read-only. Enter the code the scorekeeper is showing.</div>
          </div>
          <div style={{ fontFamily: FF, fontSize: 20, letterSpacing: 1, color: C.text, fontWeight: 700, marginBottom: 6 }}>GAME CODE</div>
          <input className="bs-input" value={entry} placeholder="LU-XXXX" onChange={(e) => setEntry(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") go(); }} style={{ width: "100%", boxSizing: "border-box", fontFamily: FF, fontSize: 30, letterSpacing: 3, fontWeight: 700, color: C.text, background: C.inputBg, border: `2px solid ${C.away}66`, borderRadius: 12, padding: "12px 16px", outline: "none", textAlign: "center" }} />
          <button className="bs-press" disabled={!entry.trim()} onClick={go} style={{ marginTop: 16, width: "100%", fontFamily: FF, fontSize: 30, fontWeight: 700, color: C.onAccent, background: C.runs, border: "none", borderRadius: 14, padding: "14px 0", cursor: entry.trim() ? "pointer" : "default", opacity: entry.trim() ? 1 : 0.4 }}>WATCH ▸</button>
          {!SB_READY && <p style={{ color: C.danger, fontSize: 14, fontWeight: 700, textAlign: "center", marginTop: 14 }}>Live sharing needs the published artifact — preview can only read games this same window wrote.</p>}
        </div>
      </Screen>
    );
  }

  const subBar = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
      <span style={{ fontFamily: FF, fontSize: 14, fontWeight: 700, color: C.muted }}>watching <b style={{ color: C.text, letterSpacing: 1 }}>{code}</b></span>
      <button className="bs-press" onClick={() => { setCode(""); setEntry(""); setGame(null); }} style={{ background: "transparent", border: "none", color: C.away, fontFamily: FF, fontSize: 14, fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}>change code</button>
    </div>
  );

  // ---------- WAITING ----------
  if (!game) {
    return (
      <Screen center>
        <div style={{ position: "absolute", top: 18, left: 18 }}>{rolesBtn}</div>
        <div style={{ position: "absolute", top: 18, right: 18 }}>{themeBtn}</div>
        <div style={{ textAlign: "center", animation: "fadeUp .2s ease both" }}>
          <div style={{ fontFamily: FF, fontSize: 20, letterSpacing: 4, color: C.muted, fontWeight: 700 }}>⚾ LU'S SCOREBOARD</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 22 }}>
            <span style={{ width: 14, height: 14, borderRadius: "50%", background: C.runs, animation: "breathe 1.6s ease-in-out infinite" }} />
            <span style={{ fontFamily: FF, fontSize: "clamp(30px,6vw,46px)", fontWeight: 700, color: C.text }}>Waiting for game…</span>
          </div>
          <div style={{ color: C.muted, fontSize: 18, fontWeight: 700, marginTop: 14 }}>Listening for code <b style={{ color: C.text, letterSpacing: 1 }}>{code}</b></div>
          <div style={{ marginTop: 12, fontFamily: FF, fontSize: 14, fontWeight: 700, color: (diag === "empty" || diag == null) ? C.muted : C.danger }}>
            {diag === "config-missing"
              ? "⚠ Supabase isn't configured in this build."
              : diag === "request-failed"
              ? "⚠ Can't reach the database — check your connection."
              : (diag && diag.indexOf("http-") === 0)
              ? `⚠ Database error (${diag.replace("http-", "HTTP ")}) — make sure the games table and its read/insert/update policies exist.`
              : diag === "empty"
              ? "✓ Connected — no game at this code yet. Make sure the code matches the Scorecard exactly."
              : "Connecting…"}
          </div>
          {diagDetail && (diag === "request-failed" || (diag && diag.indexOf("http-") === 0)) && (
            <div style={{ marginTop: 6, fontFamily: FF, fontSize: 12, fontWeight: 700, color: C.muted, opacity: 0.85, wordBreak: "break-word" }}>{diagDetail}</div>
          )}
          {diag === "empty" && (
            <div style={{ marginTop: 8, fontFamily: FF, fontSize: 13, fontWeight: 700, color: C.muted }}>
              {visible == null ? "" : visible.length
                ? `Games in the database: ${visible.join(", ")}`
                : "No games in the database yet — start one on the Scorecard."}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "center" }}>{subBar}</div>
        </div>
      </Screen>
    );
  }

  const isFinal = game.status === "final";
  const leader = game.awayRuns > game.homeRuns ? "away" : game.homeRuns > game.awayRuns ? "home" : null;
  const secsAgo = Math.max(0, Math.round((now - (game.updatedAt || now)) / 1000));
  // updatedAt is now honest (only bumps on real score changes), so quiet play
  // legitimately ages. "Stale" therefore tracks connection health instead.
  const stale = !isFinal && now - lastOkAt > 15000;
  const away = (game.awayName || "AWAY").trim() || "AWAY";
  const home = (game.homeName || "HOME").trim() || "HOME";

  const statusBar = (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {isFinal ? (
        <span style={{ fontFamily: FF, fontSize: 17, fontWeight: 700, color: C.onAccent, background: C.runs, borderRadius: 8, padding: "4px 12px", letterSpacing: 2 }}>FINAL</span>
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 12, height: 12, borderRadius: "50%", background: C.danger, animation: "liveDot 1.3s ease-in-out infinite" }} />
          <span style={{ fontFamily: FF, fontSize: 17, fontWeight: 700, color: C.text, letterSpacing: 2 }}>LIVE</span>
        </span>
      )}
      <span style={{ fontFamily: FF, fontSize: 15, fontWeight: 700, color: stale ? C.danger : C.muted }}>{stale ? "⚠ reconnecting… · " : ""}updated {abbrAgo(secsAgo)}</span>
    </div>
  );

  const header = (
    <div style={{ marginBottom: landscape ? 10 : 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {rolesBtn}
          <span style={{ fontFamily: FF, fontSize: 18, letterSpacing: 2, color: C.muted, fontWeight: 700, whiteSpace: "nowrap" }}>⚾ LU'S SCOREBOARD</span>
          <span style={{ fontFamily: FF, fontSize: 12, letterSpacing: 2, color: C.muted, fontWeight: 700, border: `1px solid ${C.border}`, borderRadius: 6, padding: "2px 7px" }}>MIRROR</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>{statusBar}{themeBtn}</div>
      </div>
      {subBar}
    </div>
  );

  const inningCluster = (vertical) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 130, padding: "0 6px" }}>
      <div style={{ fontFamily: FF, fontSize: 18, letterSpacing: 3, color: C.muted, fontWeight: 700 }}>INNING</div>
      <div style={{ fontFamily: FF, fontSize: vertical ? 112 : 100, lineHeight: 0.82, fontWeight: 700, color: C.runs, textShadow: C.glow }}>{game.inning}</div>
    </div>
  );

  const awayTeam = <GameTeam team="away" accent={C.away} name={away} hideControls landscape={landscape} runs={game.awayRuns} hr={game.awayHr} hrMax={game.hrMax} highlight={leader === "away"} tag={leader === "away" ? (isFinal ? "WINNER" : "LEADING") : null} />;
  const homeTeam = <GameTeam team="home" accent={C.home} name={home} hideControls mirror={!landscape} landscape={landscape} runs={game.homeRuns} hr={game.homeHr} hrMax={game.hrMax} highlight={leader === "home"} tag={leader === "home" ? (isFinal ? "WINNER" : "LEADING") : null} />;

  // ---------- FINAL ----------
  if (isFinal) {
    return (
      <Screen landscape={landscape} top>
        {header}
        <div style={{ textAlign: "center", animation: "fadeUp .25s ease both" }}>
          <div style={{ fontFamily: FF, fontSize: 58, lineHeight: 0.95, fontWeight: 700, color: C.runs }}>FINAL</div>
          <div style={{ color: C.text, fontSize: 22, fontWeight: 700, marginBottom: 14 }}>{leader ? `${(leader === "away" ? away : home).toUpperCase()} WIN` : "TIE GAME"}</div>
        </div>
        <div style={{ display: "flex", flexDirection: landscape ? "row" : "column", alignItems: "stretch", gap: landscape ? 16 : 12 }}>{awayTeam}{homeTeam}</div>
      </Screen>
    );
  }

  // ---------- LIVE ----------
  return (
    <Screen landscape={landscape} top>
      {header}
      {landscape ? (
        <div style={{ display: "flex", alignItems: "stretch", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>{awayTeam}</div>
          <div style={{ display: "flex", alignItems: "center" }}>{inningCluster(true)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>{homeTeam}</div>
        </div>
      ) : (
        <>
          {awayTeam}
          <div style={{ margin: "14px 0 4px", display: "flex", justifyContent: "center" }}>{inningCluster(false)}</div>
          <div style={{ marginTop: 4 }}>{homeTeam}</div>
        </>
      )}
    </Screen>
  );
}

/* =========================== shared UI =========================== */
function GameTeam({ team, accent, name, runs, hr, hrMax, inningRuns, inningHr, inningNo, editable, highlight, tag, hideControls, mirror, landscape, onRunPlus, onRunMinus, onHrPlus, onHrMinus }) {
  const over = hr > hrMax;
  const big = !landscape;
  const runsFont = landscape ? "clamp(54px, 9.5vw, 104px)" : "clamp(66px, 19vw, 124px)";

  const runsRow = (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {!hideControls && <RunBtn sign="−" big={big} disabled={!editable || inningRuns <= 0} onClick={onRunMinus} />}
      <div className={!hideControls && editable ? "bs-tap" : undefined} onClick={!hideControls && editable ? onRunPlus : undefined} role={!hideControls && editable ? "button" : undefined} style={{ flex: 1, textAlign: "center", minWidth: 0, cursor: !hideControls && editable ? "pointer" : "default", userSelect: "none" }}>
        <div style={{ fontSize: 15, letterSpacing: 2, color: C.muted, fontWeight: 700 }}>RUNS</div>
        <div style={{ fontFamily: FF, fontSize: runsFont, lineHeight: 0.82, fontWeight: 700, color: C.runs, textShadow: C.glow }}>{runs}</div>
        {!hideControls && editable && <div style={{ fontSize: 13, letterSpacing: 1, color: C.muted, fontWeight: 700, opacity: 0.85 }}>＋ TAP TO ADD</div>}
      </div>
      <div style={{ width: 96, display: "flex", flexDirection: "column", alignItems: "flex-end", justifyContent: "center", gap: 5 }}>
        {highlight && <div style={{ color: accent, fontSize: 26, lineHeight: 1, fontWeight: 700 }}>▲</div>}
        <div title={name} style={{ fontFamily: FF, fontSize: 21, fontWeight: 700, color: accent, textTransform: "uppercase", textAlign: "right", lineHeight: 1, wordBreak: "break-word" }}>{name}</div>
        {tag && <span style={{ fontFamily: FF, fontSize: 14, fontWeight: 700, color: C.onAccent, background: accent, borderRadius: 6, padding: "2px 8px" }}>{tag}</span>}
      </div>
    </div>
  );

  const hrRow = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, flexWrap: "wrap" }}>
      <span style={{ fontSize: 15, letterSpacing: 1, color: C.muted, fontWeight: 700 }}>HR</span>
      {!hideControls && <Softball sign="−" uid={`${team}-m`} disabled={!editable || inningHr <= 0} onClick={onHrMinus} />}
      <div className={!hideControls && editable ? "bs-tap" : undefined} onClick={!hideControls && editable ? onHrPlus : undefined} role={!hideControls && editable ? "button" : undefined} style={{ display: "flex", flexDirection: "column", alignItems: "center", cursor: !hideControls && editable ? "pointer" : "default", userSelect: "none" }}>
        <span style={{ fontFamily: FF, fontSize: 44, fontWeight: 700, lineHeight: 1, color: over ? C.danger : C.text }}>{hr}<span style={{ fontSize: 22, color: C.muted, fontWeight: 700 }}> / {hrMax}</span></span>
        {!hideControls && editable && <span style={{ fontSize: 11, letterSpacing: 1, color: C.muted, fontWeight: 700, opacity: 0.85, marginTop: 2 }}>＋ TAP</span>}
      </div>
      {over && <span style={{ fontFamily: FF, fontSize: 17, fontWeight: 700, color: "#fff", background: C.danger, borderRadius: 7, padding: "2px 9px", animation: "pulseBadge 1.6s ease-in-out infinite" }}>OVER</span>}
    </div>
  );

  const divider = <div style={{ height: 2, background: C.border, margin: "12px 2px", opacity: 0.6 }} />;

  return (
    <div style={{ background: C.panel, border: `2px solid ${highlight ? accent : C.border}`, borderRadius: 18, padding: landscape ? "16px 16px" : "16px 18px", boxShadow: highlight ? `0 0 0 1px ${accent}, 0 0 30px -8px ${accent}` : "none", transition: "box-shadow .25s ease, border-color .25s ease", flex: 1 }}>
      {mirror ? (<>{hrRow}{divider}{runsRow}</>) : (<>{runsRow}{divider}{hrRow}</>)}
      {!hideControls && <div style={{ textAlign: "center", fontSize: 14, color: C.muted, fontWeight: 700, marginTop: 10, opacity: 0.85 }}>INN {inningNo}: {inningRuns} R · {inningHr} HR</div>}
    </div>
  );
}

function RunBtn({ sign, accent, disabled, onClick, big }) {
  const minus = sign === "−";
  const w = big ? 76 : 64;
  const h = big ? 60 : 54;
  return (
    <button className="bs-press" onClick={onClick} disabled={disabled} aria-label={minus ? "subtract run" : "add run"} style={{ fontFamily: FF, fontSize: big ? 36 : 30, lineHeight: 1, width: w, height: h, borderRadius: 13, cursor: disabled ? "default" : "pointer", fontWeight: 700, opacity: disabled ? 0.3 : 1, color: minus ? C.minusText : C.onAccent, background: minus ? C.minusBg : accent, border: minus ? `2px solid ${C.minusBorder}` : "none" }}>{sign}</button>
  );
}

function Softball({ sign, uid, disabled, onClick }) {
  const size = 52;
  return (
    <button className="bs-press" onClick={onClick} disabled={disabled} aria-label={sign === "+" ? "add home run" : "subtract home run"} style={{ width: size, height: size, padding: 0, border: "none", background: "transparent", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.3 : 1, position: "relative" }}>
      <svg width={size} height={size} viewBox="0 0 40 40" style={{ display: "block", filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.4))" }}>
        <defs>
          <radialGradient id={`sb-${uid}`} cx="38%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#fdffe6" /><stop offset="60%" stopColor="#eef06a" /><stop offset="100%" stopColor="#d3d637" />
          </radialGradient>
        </defs>
        <circle cx="20" cy="20" r="18.5" fill={`url(#sb-${uid})`} stroke="#bcc02f" strokeWidth="1.2" />
        <path d="M8,7 C13.5,14 13.5,26 8,33" fill="none" stroke="#d8401f" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M32,7 C26.5,14 26.5,26 32,33" fill="none" stroke="#d8401f" strokeWidth="1.6" strokeLinecap="round" />
        <g stroke="#d8401f" strokeWidth="1.3" strokeLinecap="round">
          <line x1="9" y1="13" x2="13" y2="12" /><line x1="9.4" y1="20" x2="13.7" y2="20" /><line x1="9" y1="27" x2="13" y2="28" />
          <line x1="31" y1="13" x2="27" y2="12" /><line x1="30.6" y1="20" x2="26.3" y2="20" /><line x1="31" y1="27" x2="27" y2="28" />
        </g>
      </svg>
      <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FF, fontSize: 30, fontWeight: 700, color: "#2a3318", lineHeight: 1 }}>{sign}</span>
    </button>
  );
}

function LineScore({ innings, idx, awayAbbr, homeAbbr, fullTotals, onJump }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 14, letterSpacing: 1, color: C.muted, fontWeight: 700, marginBottom: 6, textAlign: "center" }}>{idx >= 0 ? "LINE SCORE · TAP AN INNING TO JUMP" : "LINE SCORE"}</div>
      <div style={{ display: "flex", alignItems: "stretch", background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", marginRight: 2 }}>
          <LScell head> </LScell>
          <LScell label accent={C.away}>{awayAbbr}</LScell>
          <LScell label accent={C.home}>{homeAbbr}</LScell>
        </div>
        <div style={{ display: "flex", overflowX: "auto", flex: 1 }}>
          {innings.map((inn, i) => (
            <div key={i} onClick={() => onJump(i)} style={{ cursor: idx >= 0 ? "pointer" : "default", display: "flex", flexDirection: "column" }}>
              <LScell head active={i === idx}>{i + 1}</LScell>
              <LScell active={i === idx}>{inn.aR}</LScell>
              <LScell active={i === idx}>{inn.hR}</LScell>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", marginLeft: 4, borderLeft: `1px solid ${C.border}`, paddingLeft: 2 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <LScell head total>R</LScell><LScell total>{fullTotals.aR}</LScell><LScell total>{fullTotals.hR}</LScell>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <LScell head total>HR</LScell><LScell total>{fullTotals.aHr}</LScell><LScell total>{fullTotals.hHr}</LScell>
          </div>
        </div>
      </div>
    </div>
  );
}

function LScell({ children, head, active, label, total, accent }) {
  return (
    <div style={{ width: label ? 48 : total ? 42 : 38, height: 32, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FF, fontSize: head ? 16 : 22, fontWeight: 700, color: label ? accent : head ? (active ? C.onAccent : C.muted) : active ? C.runs : C.text, background: active ? (head ? C.runs : (C.glow === "none" ? "rgba(168,90,0,0.14)" : "rgba(255,210,77,0.12)")) : total && !head ? C.chipBg : "transparent", borderRadius: head ? "6px 6px 0 0" : 0 }}>{children}</div>
  );
}

function Screen({ children, landscape, top, center }) {
  const align = center ? "center" : top ? "flex-start" : landscape ? "center" : "flex-start";
  return (
    <div style={{ position: "relative", background: C.bg, minHeight: "100vh", width: "100%", boxSizing: "border-box", display: "flex", alignItems: align, justifyContent: "center", color: C.text, fontFamily: FF }}>
      <Style />
      <div style={{ width: "100%", maxWidth: landscape ? 1000 : 560, padding: landscape ? "16px 20px" : "20px 18px", boxSizing: "border-box" }}>{children}</div>
    </div>
  );
}

function NavBtn({ glyph, onClick, disabled }) {
  return (
    <button className="bs-press" onClick={onClick} disabled={disabled} aria-label={glyph === "◂" ? "previous inning" : "next inning"} style={{ fontFamily: FF, fontSize: 26, lineHeight: 1, width: 56, height: 50, color: C.text, background: C.chipBg, border: `1px solid ${C.border}`, borderRadius: 12, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.3 : 1 }}>{glyph}</button>
  );
}

function Field({ label, accent, value, placeholder, onChange }) {
  return (
    <div>
      <div style={{ fontFamily: FF, fontSize: 20, letterSpacing: 1, color: accent, fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <input className="bs-input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} maxLength={16} style={{ width: "100%", boxSizing: "border-box", fontFamily: FF, fontSize: 28, fontWeight: 700, color: C.text, background: C.inputBg, border: `2px solid ${accent}66`, borderRadius: 12, padding: "12px 16px", outline: "none" }} />
    </div>
  );
}

function Toggle({ on, onChange }) {
  return (
    <button className="bs-press" onClick={onChange} aria-pressed={on} style={{ width: 72, height: 40, borderRadius: 20, border: "none", cursor: "pointer", background: on ? C.home : C.border, position: "relative", transition: "background .2s ease", padding: 0, flexShrink: 0 }}>
      <span style={{ position: "absolute", top: 4, left: on ? 36 : 4, width: 32, height: 32, borderRadius: "50%", background: C.card, transition: "left .2s ease" }} />
    </button>
  );
}

/* ===================== LU'S SCORECARD (writer · real app) =====================
   The genuine Senior Softball scorecard, namespaced (SC palette / SS styles /
   sumArr / clampN) so it can't collide with the reader. Untouched scoring logic;
   added only: a game CODE, a publish() of the contract, keep-awake, roles exit. */

/* Senior Softball Scorecard — web preview (mirrors the Expo app).
   Scoring per Senior Softball-USA / USSSA / ISSA rules.
   Game + preferences persist to localStorage and restore after a refresh. */

const SC_STORE_KEY = 'lus.scorecard.v1';
const SC_UNLOCK_KEY = 'lus.scorecard.unlocked';
const SC_PASSWORD = 'softball'; // client-side gate only — visible in source, keeps casual users out
const OUTS_PER_HALF = 3;
const DEFAULTS = { hrLimit: 6, innings: 7, runCap: 5, openLastInning: true };
const LIMITS = {
  hrLimit: { min: 0, max: 15 },
  innings: { min: 1, max: 9 },
  runCap: { min: 1, max: 20 },
};

const SC = {
  bg: '#0A0E12', surface: '#151B23', surface2: '#1E2630', border: '#2A333F',
  text: '#ECF1F5', muted: '#7E8B99', run: '#2ED47A', hr: '#F5B53D',
  danger: '#FF5C5C', away: '#FF924C', home: '#4CC9F0',
};

const emptyInnings = (n) => Array(n).fill(0);
const sumArr = (a) => a.reduce((x, y) => x + y, 0);
const clampN = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const ordinal = (n) => {
  const v = n % 100;
  const s = v >= 11 && v <= 13 ? 'TH' : n % 10 === 1 ? 'ST' : n % 10 === 2 ? 'ND' : n % 10 === 3 ? 'RD' : 'TH';
  return `${n}${s}`;
};

function Scorecard({ onExit }) {
  const [phase, setPhase] = useState('setup');
  const [scoreMode, setScoreMode] = useState('detailed'); // 'detailed' | 'quick'
  const [settings, setSettings] = useState(DEFAULTS);
  const [awayName, setAwayName] = useState('');
  const [homeName, setHomeName] = useState('');
  const [awayInn, setAwayInn] = useState(emptyInnings(DEFAULTS.innings));
  const [homeInn, setHomeInn] = useState(emptyInnings(DEFAULTS.innings));
  const [awayHR, setAwayHR] = useState(0);
  const [homeHR, setHomeHR] = useState(0);
  const [inning, setInning] = useState(1);
  const [half, setHalf] = useState('top');
  const [hrThisHalf, setHrThisHalf] = useState(0);
  const [outs, setOuts] = useState(0);
  const [timeExpired, setTimeExpired] = useState(false); // time limit reached → unlimited runs/inning (HR still limited)
  const [bases, setBases] = useState({ first: false, second: false, third: false });
  const [history, setHistory] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [runnerMenu, setRunnerMenu] = useState(null); // 'first' | 'second' | 'third' | null
  const [showQR, setShowQR] = useState(false);
  const [gameCode, setGameCode] = useState('');
  const [unlocked, setUnlocked] = useState(() => { try { return localStorage.getItem(SC_UNLOCK_KEY) === '1'; } catch (e) { return false; } });
  const [pw, setPw] = useState('');
  const [pwErr, setPwErr] = useState(false);
  const [syncFail, setSyncFail] = useState(false); // last publish to Supabase failed
  const [hydrated, setHydrated] = useState(false); // localStorage restore finished
  const lastPubRef = useRef('');                   // serialized last-published contract
  const contractRef = useRef(null);                // current contract (for retries)
  const noRunners = { first: false, second: false, third: false };

  const { hrLimit, innings, runCap: runCapPerInning, openLastInning } = settings;
  const isAway = half === 'top';
  const aName = awayName.trim() || 'Away';
  const hName = homeName.trim() || 'Home';
  const battingName = isAway ? aName : hName;
  const battingColor = isAway ? SC.away : SC.home;
  const battingInn = isAway ? awayInn : homeInn;
  const setBattingInn = isAway ? setAwayInn : setHomeInn;
  const battingHR = isAway ? awayHR : homeHR;
  const setBattingHR = isAway ? setAwayHR : setHomeHR;

  const cellRuns = battingInn[inning - 1] ?? 0;
  const isOpenInning = timeExpired || (openLastInning && inning === innings);
  const runCap = isOpenInning ? Infinity : runCapPerInning;
  const runCapReached = cellRuns >= runCap;
  const atHrLimit = battingHR >= hrLimit;
  const canDecRun = cellRuns > 0;
  const canDecHR = hrThisHalf > 0;
  const awayRuns = sumArr(awayInn);
  const homeRuns = sumArr(homeInn);

  // ---- READ-ONLY MIRROR FEED ----
  // Publish only when the contract *content* changes, so updatedAt is honest:
  // it means "the score last changed then", not "this tab last re-rendered then".
  const liveContract = (phase === 'game' || phase === 'over') ? {
    awayName: aName, homeName: hName,
    inning,
    awayRuns, homeRuns,
    awayHr: awayHR, homeHr: homeHR,
    hrMax: hrLimit,
    status: phase === 'over' ? 'final' : 'live',
  } : null;
  contractRef.current = liveContract;

  useEffect(() => {
    if (!gameCode || !contractRef.current) return;
    const key = JSON.stringify(contractRef.current);
    if (key === lastPubRef.current) return; // nothing actually changed
    let alive = true;
    publishGame(gameCode, { ...contractRef.current, updatedAt: Date.now() }).then((ok) => {
      if (!alive) return;
      if (ok) { lastPubRef.current = key; setSyncFail(false); }
      else if (SB_READY) setSyncFail(true);
    });
    return () => { alive = false; };
  }, [gameCode, phase, awayInn, homeInn, awayHR, homeHR, hrLimit, awayName, homeName, inning]);

  // While a publish is failing, retry every 5s so a dropped connection
  // recovers on its own instead of waiting for the next scored run.
  useEffect(() => {
    if (!syncFail || !gameCode) return;
    const id = setInterval(() => {
      const c = contractRef.current;
      if (!c) return;
      publishGame(gameCode, { ...c, updatedAt: Date.now() }).then((ok) => {
        if (ok) { lastPubRef.current = JSON.stringify(c); setSyncFail(false); }
      });
    }, 5000);
    return () => clearInterval(id);
  }, [syncFail, gameCode]);

  useEffect(() => {
    let lock = null;
    const acquire = async () => { try { if ((phase === 'game' || phase === 'over') && 'wakeLock' in navigator) lock = await navigator.wakeLock.request('screen'); } catch (e) {} };
    const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
    if (phase === 'game' || phase === 'over') { acquire(); document.addEventListener('visibilitychange', onVis); }
    return () => { document.removeEventListener('visibilitychange', onVis); try { lock && lock.release(); } catch (e) {} };
  }, [phase]);

  // ---- PERSISTENCE: survive a refresh / phone sleep mid-game ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SC_STORE_KEY);
      if (raw) {
        const g = JSON.parse(raw);
        if (g && typeof g === 'object') {
          if (g.settings && typeof g.settings === 'object') setSettings((s) => ({ ...s, ...g.settings }));
          if (typeof g.awayName === 'string') setAwayName(g.awayName);
          if (typeof g.homeName === 'string') setHomeName(g.homeName);
          if (Array.isArray(g.awayInn)) setAwayInn(g.awayInn);
          if (Array.isArray(g.homeInn)) setHomeInn(g.homeInn);
          if (Number.isFinite(g.awayHR)) setAwayHR(g.awayHR);
          if (Number.isFinite(g.homeHR)) setHomeHR(g.homeHR);
          if (Number.isFinite(g.inning)) setInning(g.inning);
          if (g.scoreMode === 'quick' || g.scoreMode === 'detailed') setScoreMode(g.scoreMode);
          if (g.half === 'top' || g.half === 'bottom') setHalf(g.half);
          if (Number.isFinite(g.hrThisHalf)) setHrThisHalf(g.hrThisHalf);
          if (Number.isFinite(g.outs)) setOuts(g.outs);
          if (typeof g.timeExpired === 'boolean') setTimeExpired(g.timeExpired);
          if (g.bases && typeof g.bases === 'object') setBases({ first: !!g.bases.first, second: !!g.bases.second, third: !!g.bases.third });
          if (Array.isArray(g.history)) setHistory(g.history);
          if (typeof g.gameCode === 'string') setGameCode(g.gameCode);
          if (g.phase === 'game' || g.phase === 'over') setPhase(g.phase);
        }
      }
    } catch (e) {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(SC_STORE_KEY, JSON.stringify({
        phase, scoreMode, settings, awayName, homeName, awayInn, homeInn,
        awayHR, homeHR, inning, half, hrThisHalf, outs, timeExpired, bases, history, gameCode,
      }));
    } catch (e) {}
  }, [hydrated, phase, scoreMode, settings, awayName, homeName, awayInn, homeInn, awayHR, homeHR, inning, half, hrThisHalf, outs, timeExpired, bases, history, gameCode]);

  const ask = (title, message, onConfirm, opts = {}) => setConfirm({ title, message, onConfirm, onCancel: opts.onCancel, confirmLabel: opts.confirmLabel, cancelLabel: opts.cancelLabel });
  const bumpCell = (n) =>
    setBattingInn((prev) => {
      const x = [...prev];
      x[inning - 1] = Math.max(0, (x[inning - 1] || 0) + n);
      return x;
    });

  // Quick-score mode has no innings/halves — runs live in cell 0 of each team's
  // array, so awayRuns/homeRuns (sumArr) and the published contract stay correct.
  const adjustQuick = (side, delta) => {
    const setInn = side === 'away' ? setAwayInn : setHomeInn;
    setInn((prev) => { const x = [...prev]; x[0] = Math.max(0, (x[0] || 0) + delta); return x; });
  };

  // Manual run correction for the detailed scorer. ＋ adds to the current inning;
  // − removes from the current inning if it has runs, else from the latest earlier
  // inning that does, so − always lowers the total when it's > 0. Snapshots first so
  // UNDO reverts it like any play. Raw correction: bypasses the run cap, leaves HR/outs.
  const adjustRun = (side, delta) => {
    const cur = side === 'away' ? awayInn : homeInn;
    const setInn = side === 'away' ? setAwayInn : setHomeInn;
    if (delta < 0 && sumArr(cur) <= 0) return; // nothing to remove
    snapshot();
    setInn((prev) => {
      const x = [...prev];
      if (delta > 0) { x[inning - 1] = (x[inning - 1] || 0) + 1; }
      else {
        const i = (x[inning - 1] || 0) > 0 ? inning - 1 : x.reduce((acc, v, j) => (v > 0 ? j : acc), -1);
        if (i >= 0) x[i] = Math.max(0, x[i] - 1);
      }
      return x;
    });
  };

  const startGame = () => {
    setAwayInn(emptyInnings(innings)); setHomeInn(emptyInnings(innings));
    setAwayHR(0); setHomeHR(0); setInning(1); setHalf('top');
    setHrThisHalf(0); setOuts(0); setBases(noRunners); setHistory([]); setTimeExpired(false); setGameCode(makeCode()); setPhase('game');
  };

  const canUndo = history.length > 0;
  const snapshot = () => setHistory((h) => [...h, { awayInn: [...awayInn], homeInn: [...homeInn], awayHR, homeHR, bases: { ...bases }, outs, hrThisHalf }]);
  const restore = (s) => { setAwayInn(s.awayInn); setHomeInn(s.homeInn); setAwayHR(s.awayHR); setHomeHR(s.homeHR); setBases(s.bases); setOuts(s.outs); setHrThisHalf(s.hrThisHalf); };
  const undo = () => {
    if (!canUndo) return;
    ask('Undo last play?', 'Revert the most recent play in this half-inning.', () => {
      const last = history[history.length - 1];
      if (last) restore(last);
      setHistory((h) => h.slice(0, -1));
    });
  };

  const addOut = () => setOuts((o) => Math.min(OUTS_PER_HALF, o + 1));
  // Tap an empty base to place a runner; tap an occupied base for the
  // runner menu (advance / scored / out / remove) — covers first-to-third,
  // scoring from 1st, pickoffs, and every other "the default guessed wrong" play.
  const tapBase = (k) => {
    if (bases[k]) { setRunnerMenu(k); return; }
    snapshot();
    setBases((b) => ({ ...b, [k]: true }));
  };
  const NEXT_BASE = { first: 'second', second: 'third' };
  const BASE_LABEL = { first: '1st', second: '2nd', third: '3rd' };
  const runnerAdvance = (k) => {
    snapshot();
    if (k === 'third') { addCappedRuns(1); setBases((b) => ({ ...b, third: false })); }
    else { const nk = NEXT_BASE[k]; setBases((b) => ({ ...b, [k]: false, [nk]: true })); }
    setRunnerMenu(null);
  };
  const runnerScored = (k) => { snapshot(); addCappedRuns(1); setBases((b) => ({ ...b, [k]: false })); setRunnerMenu(null); };
  const runnerOut = (k) => { snapshot(); addOut(); setBases((b) => ({ ...b, [k]: false })); setRunnerMenu(null); };
  const runnerRemove = (k) => { snapshot(); setBases((b) => ({ ...b, [k]: false })); setRunnerMenu(null); };
  const addCappedRuns = (runs) => {
    const add = isOpenInning ? runs : Math.min(runs, Math.max(0, runCapPerInning - cellRuns));
    if (add > 0) bumpCell(add);
  };

  // Single=1, Double=2, Triple=3: batter + each runner advance that many bases.
  const recordHit = (k) => {
    if (runCapReached) return;
    snapshot();
    let runs = 0;
    const nb = { first: false, second: false, third: false };
    const occupy = (b) => { if (b === 1) nb.first = true; else if (b === 2) nb.second = true; else if (b === 3) nb.third = true; };
    [[1, bases.first], [2, bases.second], [3, bases.third]].forEach(([p, on]) => {
      if (on) { const np = p + k; if (np >= 4) runs += 1; else occupy(np); }
    });
    occupy(k);
    // Standard advancement is applied automatically. If a runner took an
    // extra base (first-to-third, scored from 2nd, etc.), tap that runner
    // on the diamond and use the menu to adjust — no prompt on every play.
    addCappedRuns(runs);
    setBases(nb);
  };

  // Home run: batter + all runners score, bases clear. Over the limit = an out.
  const recordHR = () => {
    snapshot();
    if (atHrLimit) { addOut(); return; }
    const runners = (bases.first ? 1 : 0) + (bases.second ? 1 : 0) + (bases.third ? 1 : 0);
    setBattingHR((h) => h + 1); setHrThisHalf((h) => h + 1);
    addCappedRuns(runners + 1);
    setBases(noRunners);
  };

  const recordOut = () => { snapshot(); addOut(); };

  const recordWalk = () => {
    if (runCapReached) return;
    snapshot();
    const b = bases;
    let runs = 0;
    let nb;
    if (b.first && b.second && b.third) { runs = 1; nb = { first: true, second: true, third: true }; }
    else if (b.first && b.second) nb = { first: true, second: true, third: true };
    else if (b.first) nb = { first: true, second: true, third: b.third };
    else nb = { first: true, second: b.second, third: b.third };
    addCappedRuns(runs);
    setBases(nb);
  };

  const recordSacFly = () => {
    snapshot();
    addOut();
    if (bases.third) addCappedRuns(1);
    const hadFirst = bases.first;
    const hadSecond = bases.second;
    setBases((b) => ({ first: b.first, second: b.second, third: false }));
    const askFirst = (secondOpen) => {
      if (!hadFirst || !secondOpen) return;
      ask('Runner on 1st', 'Advance to 2nd, or hold at 1st?', () => setBases((b) => ({ ...b, first: false, second: true })), { confirmLabel: 'TO 2ND', cancelLabel: 'HOLD' });
    };
    if (hadSecond) {
      ask('Runner on 2nd', 'Advance to 3rd, or hold at 2nd?', () => { setBases((b) => ({ ...b, second: false, third: true })); askFirst(true); }, { onCancel: () => askFirst(false), confirmLabel: 'TO 3RD', cancelLabel: 'HOLD' });
    } else if (hadFirst) {
      askFirst(true);
    }
  };

  const isLastHalf = half === 'bottom' && inning === innings;
  const onNext = () => {
    if (isLastHalf) { ask('Finish game?', 'End the game and show the final score.', () => { setHrThisHalf(0); setOuts(0); setBases(noRunners); setHistory([]); setPhase('over'); }); return; }
    setHrThisHalf(0); setOuts(0); setBases(noRunners); setHistory([]);
    if (half === 'top') setHalf('bottom');
    else { setInning((i) => i + 1); setHalf('top'); }
  };
  const endGame = () => ask('End game now?', 'This ends the game and shows the final score.', () => setPhase('over'));
  const newGame = () => { phase === 'game' ? ask('Start a new game?', 'The current game will be cleared.', () => setPhase('setup')) : setPhase('setup'); };

  // Time limit reached: lift the per-inning run cap for the rest of the game
  // (HR limit is unaffected). Reversible in case of a mis-tap; both directions confirm.
  const toggleTimeExpired = () => {
    if (timeExpired)
      ask('Turn off open scoring?', `Runs per inning will be capped again at ${runCapPerInning}. Use this only if it was enabled by mistake.`,
          () => setTimeExpired(false), { confirmLabel: 'TURN OFF', cancelLabel: 'KEEP ON' });
    else
      ask('Time limit reached?', 'Every inning now allows unlimited runs for the rest of the game. The home-run limit still applies.',
          () => setTimeExpired(true), { confirmLabel: 'OPEN SCORING', cancelLabel: 'CANCEL' });
  };

  // A half-inning-ending note whose "Next" is a real button — used for both the
  // 3-outs and run-cap-reached cases so either can change sides with one tap.
  const nextNote = (msg) => (
    <div style={{ ...SS.note, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span>{msg}</span>
      <button className="tap" onClick={onNext}
        style={{ border: 'none', borderRadius: 999, padding: '7px 16px', background: isLastHalf ? SC.danger : SC.run, color: isLastHalf ? '#2A0606' : '#06231A', fontSize: 13, fontWeight: 900, letterSpacing: 0.5, cursor: 'pointer' }}>
        {isLastHalf ? 'FINISH ▸' : 'NEXT HALF-INNING ▸'}
      </button>
    </div>
  );

  // ---- shared UI ----
  const Score = ({ name, runs, hr, color, active, right, onPlus, onMinus, minusDisabled }) => (
    <div style={{ flex: 1, textAlign: right ? 'right' : 'left' }}>
      <div style={{ fontSize: 15, fontWeight: 700, color, letterSpacing: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {name}{active ? '  •' : ''}
      </div>
      <div style={{ fontSize: 82, fontWeight: 900, color: SC.text, lineHeight: '84px' }}>{runs}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: SC.muted }}>HR {hr}/{hrLimit}</div>
      {onPlus && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: right ? 'flex-end' : 'flex-start' }}>
          <button className="tap" onClick={onMinus} disabled={minusDisabled} aria-label={`subtract run for ${name}`}
            style={{ width: 40, height: 40, borderRadius: 10, border: `1.5px solid ${SC.border}`, background: SC.surface2, color: SC.text, fontSize: 22, fontWeight: 900, lineHeight: 1, cursor: minusDisabled ? 'default' : 'pointer', opacity: minusDisabled ? 0.35 : 1 }}>−</button>
          <button className="tap" onClick={onPlus} aria-label={`add run for ${name}`}
            style={{ width: 40, height: 40, borderRadius: 10, border: 'none', background: color, color: '#06231A', fontSize: 22, fontWeight: 900, lineHeight: 1, cursor: 'pointer' }}>＋</button>
        </div>
      )}
    </div>
  );

  const Diamond = ({ color }) => {
    const B = ({ bk, cx, cy, label }) => {
      const on = bases[bk];
      return (
        <g onClick={() => tapBase(bk)} className="tap" style={{ cursor: 'pointer' }}>
          <rect x={cx - 18} y={cy - 18} width={36} height={36} rx={6}
            transform={`rotate(45 ${cx} ${cy})`}
            fill={on ? color : SC.surface2} stroke={on ? color : SC.border} strokeWidth={2} />
          <text x={cx} y={cy + 4} textAnchor="middle" fontSize="13" fontWeight="800" fill={on ? '#06231A' : SC.text}>{label}</text>
        </g>
      );
    };
    return (
      <svg viewBox="0 0 180 180" width="180" height="180" style={{ display: 'block', margin: '4px auto 2px' }}>
        <polygon points="90,30 150,90 90,150 30,90" fill="none" stroke={SC.border} strokeWidth="2" />
        <B bk="second" cx={90} cy={30} label="2B" />
        <B bk="first" cx={150} cy={90} label="1B" />
        <B bk="third" cx={30} cy={90} label="3B" />
        <rect x={90 - 15} y={150 - 15} width={30} height={30} rx={5} transform="rotate(45 90 150)" fill={SC.surface} stroke={SC.muted} strokeWidth="2" />
        <text x={90} y={154} textAnchor="middle" fontSize="12" fontWeight="800" fill={SC.muted}>H</text>
      </svg>
    );
  };

  const LineScore = () => (
    <div style={SS.card}>
      <div style={{ display: 'flex' }}>
        <div style={{ ...SS.cell, ...SS.nameCell }}><span style={SS.cellHead}>TEAM</span></div>
        {Array.from({ length: innings }).map((_, i) => (
          <div key={i} style={SS.cell}><span style={SS.cellHead}>{openLastInning && i + 1 === innings ? `${i + 1}*` : i + 1}</span></div>
        ))}
        <div style={{ ...SS.cell, ...SS.cellWide }}><span style={SS.cellHead}>R</span></div>
        <div style={{ ...SS.cell, ...SS.cellWide }}><span style={SS.cellHead}>HR</span></div>
      </div>
      {[{ n: aName, inn: awayInn, hr: awayHR, color: SC.away, on: isAway }, { n: hName, inn: homeInn, hr: homeHR, color: SC.home, on: !isAway }].map((t, ri) => (
        <div key={ri} style={{ display: 'flex', background: t.on ? t.color + '14' : 'transparent', borderRadius: 6 }}>
          <div style={{ ...SS.cell, ...SS.nameCell, justifyContent: 'flex-start' }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: t.color, marginRight: 7, display: 'inline-block' }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: SC.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.n}</span>
          </div>
          {t.inn.map((r, i) => {
            const act = phase === 'game' && t.on && i === inning - 1;
            return (
              <div key={i} style={{ ...SS.cell, ...(act ? { background: t.color + '22', borderColor: t.color } : {}) }}>
                <span style={{ ...SS.cellTxt, color: act ? t.color : SC.text }}>{r}</span>
              </div>
            );
          })}
          <div style={{ ...SS.cell, ...SS.cellWide }}><span style={{ ...SS.cellTxt, fontWeight: 900 }}>{sumArr(t.inn)}</span></div>
          <div style={{ ...SS.cell, ...SS.cellWide }}><span style={{ ...SS.cellTxt, fontWeight: 900, color: SC.hr }}>{t.hr}</span></div>
        </div>
      ))}
      {openLastInning && <div style={{ color: SC.muted, fontSize: 11, marginTop: 8, paddingLeft: 4 }}>* open inning — unlimited runs</div>}
    </div>
  );

  const Topbar = ({ left, center, right }) => (
    <div style={SS.topbar}>{left}<div>{center}</div>{right}</div>
  );

  let body;

  if (phase === 'setup') {
    const ruleLine = `${innings} innings · ${hrLimit} HR · ${runCapPerInning} runs/inn` + (openLastInning ? ` · open ${ordinal(innings).toLowerCase()}` : '');
    body = (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'relative', width: 28, height: 28, borderRadius: 14, background: '#FFFFFF', border: '1px solid #D8DEE6', overflow: 'hidden', marginRight: 10 }}>
            <div style={{ position: 'absolute', top: 0, left: -19, width: 28, height: 28, borderRadius: 14, border: '2px solid #E0654F' }} />
            <div style={{ position: 'absolute', top: 0, left: 19, width: 28, height: 28, borderRadius: 14, border: '2px solid #E0654F' }} />
          </div>
          <span style={{ color: SC.text, fontSize: 30, fontWeight: 800, letterSpacing: 1 }}>Lu's Scorecard</span>
        </div>
        <div style={{ textAlign: 'center', color: SC.muted, fontSize: 14, marginTop: 6 }}>Senior softball</div>
        <button className="tap" onClick={() => setPhase('settings')} style={SS.chip}>
          <span style={{ color: SC.muted, fontSize: 13, fontWeight: 600 }}>{ruleLine}</span>
          <span style={{ color: SC.run, fontSize: 13, fontWeight: 800, marginLeft: 10 }}>⚙ Edit</span>
        </button>
        <div style={{ ...SS.card, marginTop: 18 }}>
          <div style={SS.label}>AWAY TEAM</div>
          <input style={SS.input} placeholder="Away" value={awayName} onChange={(e) => setAwayName(e.target.value)} maxLength={20} />
          <div style={{ ...SS.label, marginTop: 18 }}>HOME TEAM</div>
          <input style={SS.input} placeholder="Home" value={homeName} onChange={(e) => setHomeName(e.target.value)} maxLength={20} />
        </div>
        <div style={SS.label}>SCORING</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {[
            { m: 'detailed', title: 'Detailed', sub: 'play-by-play' },
            { m: 'quick', title: 'Quick score', sub: '＋ / − runs' },
          ].map((opt) => {
            const on = scoreMode === opt.m;
            return (
              <button key={opt.m} className="tap" onClick={() => setScoreMode(opt.m)}
                style={{ flex: 1, borderRadius: 12, padding: '12px 0', cursor: 'pointer', background: on ? SC.run + '22' : SC.surface2, border: `1.5px solid ${on ? SC.run : SC.border}` }}>
                <div style={{ color: on ? SC.run : SC.text, fontSize: 16, fontWeight: 900, letterSpacing: 0.5 }}>{opt.title}</div>
                <div style={{ color: on ? SC.run : SC.muted, fontSize: 11, fontWeight: 700, opacity: 0.85, marginTop: 2 }}>{opt.sub}</div>
              </button>
            );
          })}
        </div>
        <button className="tap" onClick={startGame} style={{ ...SS.bigBtn, background: SC.run }}>
          <span style={{ color: '#06231A', fontSize: 20, fontWeight: 900, letterSpacing: 1 }}>NEW GAME</span>
        </button>
      </div>
    );
  } else if (phase === 'settings') {
    const Stepper = ({ label, sub, k }) => (
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 0' }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: SC.text, fontSize: 17, fontWeight: 700 }}>{label}</div>
          <div style={{ color: SC.muted, fontSize: 12, marginTop: 2 }}>{sub}</div>
        </div>
        <button className="tap" onClick={() => setSettings((s) => ({ ...s, [k]: clampN(s[k] - 1, LIMITS[k].min, LIMITS[k].max) }))}
          disabled={settings[k] <= LIMITS[k].min} style={{ ...SS.stepBtn, opacity: settings[k] <= LIMITS[k].min ? 0.35 : 1 }}>−</button>
        <div style={{ color: SC.text, fontSize: 26, fontWeight: 900, width: 52, textAlign: 'center' }}>{settings[k]}</div>
        <button className="tap" onClick={() => setSettings((s) => ({ ...s, [k]: clampN(s[k] + 1, LIMITS[k].min, LIMITS[k].max) }))}
          disabled={settings[k] >= LIMITS[k].max} style={{ ...SS.stepBtn, opacity: settings[k] >= LIMITS[k].max ? 0.35 : 1 }}>＋</button>
      </div>
    );
    const div = <div style={{ height: 1, background: SC.border, margin: '6px 0' }} />;
    body = (
      <>
        <Topbar
          left={<button className="tap" onClick={() => setPhase('setup')} style={SS.topBtn}>Cancel</button>}
          center={<span style={{ color: SC.text, fontSize: 15, fontWeight: 800, letterSpacing: 2 }}>SETTINGS</span>}
          right={<button className="tap" onClick={() => setPhase('setup')} style={{ ...SS.topBtn, color: SC.run }}>Done</button>}
        />
        <div style={{ padding: 18 }}>
          <div style={{ color: SC.muted, fontSize: 13, lineHeight: '19px', marginBottom: 16 }}>
            Defaults follow the senior softball rulebook. (In this preview, settings reset on reload.)
          </div>
          <div style={SS.card}>
            <Stepper label="Home runs" sub="per team, per game" k="hrLimit" />
            {div}
            <Stepper label="Innings" sub="per game" k="innings" />
            {div}
            <Stepper label="Runs per inning" sub="max per half-inning" k="runCap" />
            {div}
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 0' }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: SC.text, fontSize: 17, fontWeight: 700 }}>Open last inning</div>
                <div style={{ color: SC.muted, fontSize: 12, marginTop: 2 }}>unlimited runs in the final inning</div>
              </div>
              <button className="tap" onClick={() => setSettings((s) => ({ ...s, openLastInning: !s.openLastInning }))}
                style={{ width: 52, height: 30, borderRadius: 15, border: 'none', cursor: 'pointer', background: openLastInning ? SC.run : SC.border, position: 'relative' }}>
                <span style={{ position: 'absolute', top: 3, left: openLastInning ? 25 : 3, width: 24, height: 24, borderRadius: 12, background: '#fff', transition: 'left .15s' }} />
              </button>
            </div>
          </div>
          <button className="tap" onClick={() => setSettings(DEFAULTS)} style={{ background: 'none', border: 'none', color: SC.danger, fontSize: 15, fontWeight: 700, width: '100%', padding: 12, cursor: 'pointer' }}>
            Reset to rulebook defaults
          </button>
        </div>
      </>
    );
  } else if (phase === 'over') {
    const winner = awayRuns === homeRuns ? null : awayRuns > homeRuns ? aName : hName;
    body = (
      <div style={{ padding: 18 }}>
        <div style={{ color: SC.muted, fontSize: 14, fontWeight: 800, letterSpacing: 3, textAlign: 'center', marginBottom: 10 }}>FINAL</div>
        <div style={SS.scoreboard}>
          <Score name={aName} runs={awayRuns} hr={awayHR} color={SC.away} />
          <div style={SS.dash}>–</div>
          <Score name={hName} runs={homeRuns} hr={homeHR} color={SC.home} right />
        </div>
        <div style={{ border: `1.5px solid ${winner ? SC.run : SC.muted}`, borderRadius: 12, padding: '12px 0', textAlign: 'center', marginBottom: 18 }}>
          <span style={{ color: winner ? SC.run : SC.muted, fontSize: 20, fontWeight: 900, letterSpacing: 1 }}>{winner ? `${winner} win` : 'Tie game'}</span>
        </div>
        <LineScore />
        <button className="tap" onClick={newGame} style={{ ...SS.bigBtn, background: SC.run }}>
          <span style={{ color: '#06231A', fontSize: 20, fontWeight: 900, letterSpacing: 1 }}>NEW GAME</span>
        </button>
      </div>
    );
  } else if (scoreMode === 'quick') {
    const QuickTeam = ({ side, name, runs, color }) => (
      <div style={{ ...SS.card, borderColor: color, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ width: 12, height: 12, borderRadius: 6, background: color, marginRight: 8 }} />
          <span style={{ color: SC.text, fontSize: 20, fontWeight: 800, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="tap" onClick={() => adjustQuick(side, -1)} disabled={runs <= 0}
            style={{ width: 72, height: 72, borderRadius: 18, border: `1.5px solid ${SC.danger}`, background: 'none', color: SC.danger, fontSize: 40, fontWeight: 900, lineHeight: 1, cursor: runs <= 0 ? 'default' : 'pointer', opacity: runs <= 0 ? 0.35 : 1 }}>−</button>
          <div style={{ flex: 1, textAlign: 'center', fontSize: 76, fontWeight: 900, color: SC.text, lineHeight: '80px' }}>{runs}</div>
          <button className="tap" onClick={() => adjustQuick(side, 1)}
            style={{ width: 72, height: 72, borderRadius: 18, border: 'none', background: color, color: '#06231A', fontSize: 40, fontWeight: 900, lineHeight: 1, cursor: 'pointer' }}>＋</button>
        </div>
      </div>
    );
    body = (
      <>
        <Topbar
          left={<button className="tap" onClick={newGame} style={SS.topBtn}>New Game</button>}
          center={<span style={{ color: SC.text, fontSize: 13, fontWeight: 800, letterSpacing: 2 }}>QUICK SCORE</span>}
          right={<button className="tap" onClick={endGame} style={{ ...SS.topBtn, color: SC.danger }}>End Game</button>}
        />
        <div style={{ padding: 18 }}>
          <QuickTeam side="away" name={aName} runs={awayRuns} color={SC.away} />
          <QuickTeam side="home" name={hName} runs={homeRuns} color={SC.home} />
          <div style={{ color: SC.muted, fontSize: 12, textAlign: 'center', marginTop: 4 }}>Tap ＋ or − to adjust each team's score.</div>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Topbar
          left={<button className="tap" onClick={newGame} style={SS.topBtn}>New Game</button>}
          center={<span style={{ color: SC.text, fontSize: 13, fontWeight: 800, letterSpacing: 2 }}>LU'S SCORECARD</span>}
          right={<button className="tap" onClick={endGame} style={{ ...SS.topBtn, color: SC.danger }}>End Game</button>}
        />
        <div style={{ padding: 18 }}>
          <div style={SS.scoreboard}>
            <Score name={aName} runs={awayRuns} hr={awayHR} color={SC.away} active={isAway}
              onPlus={() => adjustRun('away', 1)} onMinus={() => adjustRun('away', -1)} minusDisabled={awayRuns <= 0} />
            <div style={{ textAlign: 'center', padding: '0 6px', minWidth: 92 }}>
              <div style={{ color: battingColor, fontSize: 12, fontWeight: 800, letterSpacing: 1 }}>{isAway ? '▲ TOP' : '▼ BOT'}</div>
              <div style={{ color: SC.text, fontSize: 28, fontWeight: 900, lineHeight: '30px' }}>{ordinal(inning)}</div>
              <button className="tap" onClick={onNext}
                style={{ marginTop: 6, border: `1.5px solid ${isLastHalf ? SC.danger : SC.border}`, borderRadius: 999, padding: '7px 12px', background: 'none', cursor: 'pointer', color: isLastHalf ? SC.danger : SC.text, fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>
                {isLastHalf ? 'FINISH ▸' : half === 'top' ? `BOT ${ordinal(inning)} ▸` : `TOP ${ordinal(inning + 1)} ▸`}
              </button>
            </div>
            <Score name={hName} runs={homeRuns} hr={homeHR} color={SC.home} active={!isAway} right
              onPlus={() => adjustRun('home', 1)} onMinus={() => adjustRun('home', -1)} minusDisabled={homeRuns <= 0} />
          </div>

          <div style={{ ...SS.card, borderColor: battingColor }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ width: 12, height: 12, borderRadius: 6, background: battingColor, marginRight: 8 }} />
              <span style={{ color: SC.text, fontSize: 20, fontWeight: 800, flex: 1 }}>{battingName}</span>
              <span style={{ borderRadius: 999, padding: '4px 10px', background: (isOpenInning ? SC.run : battingColor) + '22', color: isOpenInning ? SC.run : battingColor, fontSize: 12, fontWeight: 800, letterSpacing: 1 }}>
                {isOpenInning ? 'OPEN INNING' : 'AT BAT'}
              </span>
            </div>

            <Diamond color={battingColor} />
            <div style={{ color: SC.muted, fontSize: 13, fontWeight: 700, textAlign: 'center', marginTop: 2, marginBottom: 12 }}>
              This half: {cellRuns} run{cellRuns === 1 ? '' : 's'}{isOpenInning ? '' : ` / ${runCapPerInning}`}
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {[{ k: 1, l: '1B', s: 'single' }, { k: 2, l: '2B', s: 'double' }, { k: 3, l: '3B', s: 'triple' }].map((h) => (
                <button key={h.k} className="tap" onClick={() => recordHit(h.k)} disabled={runCapReached}
                  style={{ flex: 1, background: SC.run, border: 'none', borderRadius: 12, padding: '12px 0', cursor: 'pointer', opacity: runCapReached ? 0.35 : 1 }}>
                  <div style={{ color: '#06231A', fontSize: 20, fontWeight: 900, letterSpacing: 1 }}>{h.l}</div>
                  <div style={{ color: '#06231A', fontSize: 10, fontWeight: 800, opacity: 0.7 }}>{h.s}</div>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              {atHrLimit ? (
                <button className="tap" onClick={recordHR}
                  style={{ flex: 1.7, borderRadius: 12, padding: '12px 0', cursor: 'pointer', border: `1.5px solid ${SC.danger}`, background: SC.danger + '1A' }}>
                  <div style={{ color: SC.danger, fontSize: 18, fontWeight: 900, letterSpacing: 1 }}>HR → OUT</div>
                  <div style={{ color: SC.danger, fontSize: 11, fontWeight: 700, opacity: 0.85 }}>over {hrLimit}-HR limit</div>
                </button>
              ) : (
                <button className="tap" onClick={recordHR} disabled={runCapReached}
                  style={{ flex: 1.7, background: SC.hr, border: 'none', borderRadius: 12, padding: '12px 0', cursor: 'pointer', opacity: runCapReached ? 0.35 : 1 }}>
                  <div style={{ color: '#2A1E03', fontSize: 18, fontWeight: 900, letterSpacing: 1 }}>HOME RUN</div>
                  <div style={{ color: '#2A1E03', fontSize: 11, fontWeight: 800, opacity: 0.75 }}>{battingHR} / {hrLimit} · clears bases</div>
                </button>
              )}
              <button className="tap" onClick={recordOut} style={{ flex: 1, border: `1.5px solid ${SC.danger}`, borderRadius: 12, padding: '12px 0', background: 'none', color: SC.danger, fontSize: 18, fontWeight: 900, letterSpacing: 1, cursor: 'pointer' }}>OUT</button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="tap" onClick={recordWalk} disabled={runCapReached} style={{ flex: 1, border: `1.5px solid ${SC.run}`, borderRadius: 12, padding: '12px 0', background: 'none', cursor: 'pointer', opacity: runCapReached ? 0.35 : 1 }}>
                <div style={{ color: SC.run, fontSize: 18, fontWeight: 900, letterSpacing: 1 }}>WALK</div>
                <div style={{ color: SC.run, fontSize: 10, fontWeight: 800, opacity: 0.8 }}>BB · forces runners</div>
              </button>
              <button className="tap" onClick={recordSacFly} style={{ flex: 1, border: `1.5px solid ${SC.hr}`, borderRadius: 12, padding: '12px 0', background: 'none', cursor: 'pointer' }}>
                <div style={{ color: SC.hr, fontSize: 18, fontWeight: 900, letterSpacing: 1 }}>SAC FLY</div>
                <div style={{ color: SC.hr, fontSize: 10, fontWeight: 800, opacity: 0.8 }}>out · scores 3rd</div>
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', marginTop: 12 }}>
              <span style={{ color: SC.muted, fontSize: 12, fontWeight: 800, letterSpacing: 1, marginRight: 10 }}>OUTS</span>
              <div style={{ display: 'flex', flex: 1 }}>
                {Array.from({ length: OUTS_PER_HALF }).map((_, i) => (
                  <span key={i} style={{ width: 16, height: 16, borderRadius: 8, marginRight: 8, border: `1.5px solid ${i < outs ? SC.danger : SC.border}`, background: i < outs ? SC.danger : 'transparent' }} />
                ))}
              </div>
            </div>

            <button className="tap" onClick={toggleTimeExpired}
              style={{ width: '100%', marginTop: 12, borderRadius: 12, padding: '11px 0', cursor: 'pointer', border: `1.5px solid ${timeExpired ? SC.run : SC.border}`, background: timeExpired ? SC.run + '22' : 'none' }}>
              <div style={{ color: timeExpired ? SC.run : SC.text, fontSize: 14, fontWeight: 900, letterSpacing: 0.5 }}>
                {timeExpired ? '⏱ OPEN SCORING ON' : '⏱ TIME LIMIT — OPEN SCORING'}
              </div>
              <div style={{ color: timeExpired ? SC.run : SC.muted, fontSize: 11, fontWeight: 700, opacity: 0.85, marginTop: 2 }}>
                {timeExpired ? 'unlimited runs · HR limit still applies · tap to undo' : 'unlimited runs per inning · HR limit unaffected'}
              </div>
            </button>

            {!isOpenInning && runCapReached && nextNote(`${runCapPerInning}-run limit reached this inning —`)}
            {outs >= OUTS_PER_HALF && nextNote('3 outs —')}

            <button className="tap" onClick={undo} disabled={!canUndo}
              style={{ width: '100%', border: `1.5px solid ${SC.muted}`, borderRadius: 12, padding: '12px 0', marginTop: 14, background: 'none', color: SC.text, fontSize: 15, fontWeight: 800, letterSpacing: 1, cursor: 'pointer', opacity: canUndo ? 1 : 0.35 }}>
              ↶ UNDO LAST PLAY
            </button>
            <div style={{ color: SC.muted, fontSize: 12, textAlign: 'center', marginTop: 10 }}>Hits auto-advance runners. Tap a base to fix it by hand. Undo reverts the last play this half-inning.</div>
          </div>

          <LineScore />
        </div>
      </>
    );
  }

  const watchUrl = gameCode ? `${window.location.origin}${window.location.pathname}?watch=${encodeURIComponent(gameCode)}` : "";

  // ---- SCOREKEEPER GATE ----
  if (!unlocked) {
    const tryUnlock = () => {
      if (pw.trim().toLowerCase() === SC_PASSWORD) {
        try { localStorage.setItem(SC_UNLOCK_KEY, '1'); } catch (e) {}
        setUnlocked(true); setPwErr(false);
      } else { setPwErr(true); }
    };
    return (
      <div style={{ minHeight: '100vh', background: '#05080B', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 16, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <style>{`.tap{transition:opacity .12s} .tap:active{opacity:.7} input:focus{outline:none;border-color:${SC.run}!important}`}</style>
        <div style={{ width: '100%', maxWidth: 430, background: SC.bg, borderRadius: 28, border: `1px solid ${SC.border}`, padding: '40px 28px', position: 'relative' }}>
          <button className="tap" onClick={onExit} style={{ position: 'absolute', top: 14, left: 16, background: 'none', border: 'none', color: SC.muted, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>‹ Roles</button>
          <div style={{ textAlign: 'center' }}>
            <div style={{ color: SC.text, fontSize: 28, fontWeight: 800, letterSpacing: 1 }}>Lu's Scorecard</div>
            <div style={{ color: SC.muted, fontSize: 15, marginTop: 6, marginBottom: 26 }}>Scorekeeper access — enter the password</div>
          </div>
          <div style={{ color: SC.muted, fontSize: 13, fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>PASSWORD</div>
          <input
            type="password"
            autoComplete="off"
            value={pw}
            onChange={(e) => { setPw(e.target.value); setPwErr(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') tryUnlock(); }}
            style={{ width: '100%', boxSizing: 'border-box', background: SC.surface, border: `2px solid ${pwErr ? SC.danger : SC.border}`, borderRadius: 12, padding: '14px 16px', color: SC.text, fontSize: 22, fontWeight: 700, letterSpacing: 2, textAlign: 'center' }}
          />
          {pwErr && <div style={{ color: SC.danger, fontSize: 14, fontWeight: 700, marginTop: 8, textAlign: 'center' }}>That's not it — try again.</div>}
          <button className="tap" onClick={tryUnlock} disabled={!pw.trim()} style={{ marginTop: 18, width: '100%', background: SC.run, color: SC.bg, border: 'none', borderRadius: 12, padding: '15px 0', fontSize: 20, fontWeight: 900, letterSpacing: 1, cursor: pw.trim() ? 'pointer' : 'default', opacity: pw.trim() ? 1 : 0.4 }}>UNLOCK ▸</button>
          <div style={{ color: SC.muted, fontSize: 12, marginTop: 16, textAlign: 'center', opacity: 0.8 }}>Spectators don't need this — they use Watch with a game code.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#05080B', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 16, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <style>{`.tap{transition:opacity .12s} .tap:active{opacity:.7} input:focus{outline:none;border-color:${SC.run}!important}`}</style>
      <div style={{ width: '100%', maxWidth: 430, minHeight: 760, background: SC.bg, borderRadius: 28, border: `1px solid ${SC.border}`, overflow: 'hidden', position: 'relative' }}>
        {phase === 'setup' && (
          <button className="tap" onClick={onExit} style={{ position: 'absolute', top: 10, left: 12, zIndex: 6, background: 'none', border: 'none', color: SC.muted, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>‹ Roles</button>
        )}
        {(phase === 'game' || phase === 'over') && gameCode && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '6px 10px', background: SC.surface2, borderBottom: `1px solid ${SC.border}` }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: SC.run }} />
            <span style={{ color: SC.muted, fontSize: 11, fontWeight: 800, letterSpacing: 1 }}>SCOREBOARD CODE</span>
            <span style={{ color: SC.text, fontSize: 14, fontWeight: 900, letterSpacing: 2 }}>{gameCode}</span>
            {!SB_READY && <span style={{ color: SC.danger, fontSize: 10, fontWeight: 800 }}>· offline</span>}
            {SB_READY && syncFail && <span style={{ color: SC.danger, fontSize: 10, fontWeight: 800 }}>⚠ NOT SYNCING</span>}
            <button className="tap" onClick={() => setShowQR(true)} style={{ marginLeft: 6, background: SC.run, color: SC.bg, border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 900, letterSpacing: 1, cursor: 'pointer' }}>SHOW QR</button>
          </div>
        )}
        {body}
        {showQR && gameCode && (
          <div onClick={() => setShowQR(false)} style={{ position: 'fixed', inset: 0, background: '#000000DD', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 30 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 20, padding: '24px 24px 18px', width: '100%', maxWidth: 360, textAlign: 'center', boxShadow: '0 24px 60px rgba(0,0,0,0.55)' }}>
              <div style={{ color: '#0A0E12', fontSize: 21, fontWeight: 900, letterSpacing: 1 }}>SCAN TO WATCH</div>
              <div style={{ color: '#5b6675', fontSize: 14, fontWeight: 700, marginTop: 4, marginBottom: 16 }}>Opens Lu's Scoreboard for this game</div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <div style={{ background: '#fff', padding: 12, borderRadius: 12, border: '1px solid #e3e8ee' }}>
                  <QRCodeSVG value={watchUrl} size={232} level="M" />
                </div>
              </div>
              <div style={{ color: '#0A0E12', fontSize: 30, fontWeight: 900, letterSpacing: 3, marginTop: 16 }}>{gameCode}</div>
              <div style={{ color: '#5b6675', fontSize: 12, fontWeight: 600, marginTop: 6, wordBreak: 'break-all' }}>{watchUrl}</div>
              <button className="tap" onClick={() => setShowQR(false)} style={{ marginTop: 18, width: '100%', border: 'none', borderRadius: 12, padding: '14px 0', background: '#0A0E12', color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>DONE</button>
            </div>
          </div>
        )}
        {runnerMenu && (() => {
          const k = runnerMenu;
          const nk = NEXT_BASE[k];
          const nextBlocked = nk ? bases[nk] : false;
          const btn = (bg, fg, weight = 800) => ({ width: '100%', borderRadius: 12, padding: '15px 0', border: 'none', background: bg, color: fg, fontSize: 16, fontWeight: weight, cursor: 'pointer', marginTop: 10 });
          return (
            <div onClick={() => setRunnerMenu(null)} style={{ position: 'absolute', inset: 0, background: '#000000AA', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28, zIndex: 20 }}>
              <div onClick={(e) => e.stopPropagation()} style={{ background: SC.surface, borderRadius: 18, border: `1px solid ${SC.border}`, padding: 20, width: '100%' }}>
                <div style={{ color: SC.text, fontSize: 20, fontWeight: 800 }}>Runner on {BASE_LABEL[k]}</div>
                <div style={{ color: SC.muted, fontSize: 14, marginTop: 6 }}>What happened to this runner?</div>
                {k !== 'third' && (
                  <button className="tap" disabled={nextBlocked} onClick={() => runnerAdvance(k)} style={{ ...btn(SC.surface2, SC.text), opacity: nextBlocked ? 0.35 : 1, cursor: nextBlocked ? 'default' : 'pointer' }}>
                    ADVANCE TO {BASE_LABEL[nk].toUpperCase()}{nextBlocked ? ' — OCCUPIED' : ''}
                  </button>
                )}
                <button className="tap" onClick={() => runnerScored(k)} style={btn(SC.run, '#06231A', 900)}>SCORED{runCapReached ? ' (RUN CAP REACHED)' : ''}</button>
                <button className="tap" onClick={() => runnerOut(k)} style={btn(SC.danger, '#2A0606', 900)}>OUT</button>
                <button className="tap" onClick={() => runnerRemove(k)} style={{ ...btn('transparent', SC.muted, 700), border: `1px solid ${SC.border}` }}>REMOVE (MIS-TAP)</button>
                <button className="tap" onClick={() => setRunnerMenu(null)} style={btn(SC.surface2, SC.text)}>CANCEL</button>
              </div>
            </div>
          );
        })()}
        {confirm && (
          <div style={{ position: 'absolute', inset: 0, background: '#000000AA', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 }}>
            <div style={{ background: SC.surface, borderRadius: 18, border: `1px solid ${SC.border}`, padding: 20, width: '100%' }}>
              <div style={{ color: SC.text, fontSize: 20, fontWeight: 800 }}>{confirm.title}</div>
              <div style={{ color: SC.muted, fontSize: 15, marginTop: 8, lineHeight: '21px' }}>{confirm.message}</div>
              <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
                <button className="tap" onClick={() => { const c = confirm; setConfirm(null); c.onCancel && c.onCancel(); }} style={{ flex: 1, borderRadius: 12, padding: '14px 0', border: 'none', background: SC.surface2, color: SC.text, fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>{confirm.cancelLabel || 'CANCEL'}</button>
                <button className="tap" onClick={() => { const c = confirm; setConfirm(null); c.onConfirm && c.onConfirm(); }} style={{ flex: 1, borderRadius: 12, padding: '14px 0', border: 'none', background: SC.danger, color: '#2A0606', fontSize: 16, fontWeight: 900, cursor: 'pointer' }}>{confirm.confirmLabel || 'CONFIRM'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const SS = {
  card: { background: SC.surface, borderRadius: 16, border: `1px solid ${SC.border}`, padding: 14, marginBottom: 16 },
  label: { color: SC.muted, fontSize: 12, fontWeight: 700, letterSpacing: 1 },
  input: { marginTop: 8, width: '100%', boxSizing: 'border-box', background: SC.surface2, borderRadius: 12, border: `1px solid ${SC.border}`, color: SC.text, fontSize: 18, padding: '12px 14px' },
  bigBtn: { width: '100%', border: 'none', borderRadius: 16, padding: '20px 0', cursor: 'pointer', marginTop: 8 },
  topbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: `1px solid ${SC.border}` },
  topBtn: { background: 'none', border: 'none', color: SC.muted, fontSize: 15, fontWeight: 600, cursor: 'pointer', minWidth: 76 },
  stepBtn: { width: 52, height: 52, borderRadius: 26, background: SC.surface2, border: `1px solid ${SC.border}`, color: SC.text, fontSize: 24, fontWeight: 800, cursor: 'pointer' },
  scoreboard: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  dash: { color: SC.muted, fontSize: 36, fontWeight: 300, padding: '0 8px' },
  decBtn: { flex: 1, border: `1.5px solid ${SC.danger}`, borderRadius: 12, padding: '12px 0', background: 'none', color: SC.danger, fontSize: 16, fontWeight: 800, cursor: 'pointer' },
  note: { color: SC.hr, fontSize: 13, textAlign: 'center', marginTop: 12, fontWeight: 700 },
  cell: { flex: 1, minWidth: 22, padding: '8px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid transparent', borderRadius: 6, margin: 1 },
  cellWide: { flex: 1.3, background: SC.surface2 },
  nameCell: { flex: 2.2, paddingLeft: 6 },
  cellTxt: { fontSize: 14, fontWeight: 700, color: SC.text },
  cellHead: { color: SC.muted, fontSize: 11, fontWeight: 800, letterSpacing: 0.5 },
};
