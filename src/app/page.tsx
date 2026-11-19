"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ── PSYOP//TERMINAL ──
// This is not a trading dashboard. This is a behavioral confrontation system.
// The market is the stage. YOU are the subject.
//
// Design principles (brutalist anti-design):
//   - No green for profit. Only losses have visual presence.
//   - The tilt score pulsates. When it's high, the UI glitches.
//   - The confession gate blocks execution. You must articulate before you act.
//   - The shadow self tells you what your pattern says you'll do.
//   - The pain engine makes losses visceral (meals, hours, labor).

interface TiltData {
  total: number;
  factors: {
    tradeFrequency: number;
    lossStreak: number;
    planDeviation: number;
    sessionFatigue: number;
    confessionDecay: number;
    revengeWindow: number;
  };
  state: "calm" | "elevated" | "tilted" | "friction" | "lockdown";
  recommendation: string;
}

interface ShadowData {
  predictedAction: string;
  confidence: number;
  sampleSize: number;
  pattern: string;
  historicalMatches: number;
  shadowVerdict: string;
  currentTilt: number;
}

interface ConfessionResult {
  classification: string;
  wordCount: number;
  signals: any;
  tiltContribution: number;
  verdict: string;
  executeDenied: boolean;
  denialReason: string | null;
}

interface ProfileData {
  profile: {
    totalIntentions: number;
    totalExecutions: number;
    totalDeviations: number;
    currentTilt: number;
    maxTilt: number;
    planAdherenceRate: number;
    tiltState: string;
  };
  badges: { id: string; label: string; severity: string; description: string; earned: boolean }[];
  recentConfessions: { id: string; text: string; classified: string; wordCount: number }[];
}

export default function PsyopTerminal() {
  const [tilt, setTilt] = useState<TiltData | null>(null);
  const [shadow, setShadow] = useState<ShadowData | null>(null);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [pair, setPair] = useState("btc_idr");
  const [capital] = useState(10000000);

  // Confession state
  const [confessionText, setConfessionText] = useState("");
  const [confessionResult, setConfessionResult] = useState<ConfessionResult | null>(null);
  const [confessing, setConfessing] = useState(false);

  // Glitch state — intensifies with tilt
  const [glitchKey, setGlitchKey] = useState(0);

  const fetchAll = useCallback(async () => {
    try {
      const [tiltRes, shadowRes, profileRes, marketRes] = await Promise.all([
        fetch("/api/psyop/tilt").then((r) => r.json()),
        fetch("/api/psyop/shadow").then((r) => r.json()),
        fetch("/api/psyop/profile").then((r) => r.json()),
        fetch(`/api/psyop/market?pair=${pair}&capital=${capital}`).then((r) => r.json()),
      ]);
      if (tiltRes.total !== undefined) setTilt(tiltRes);
      if (shadowRes.predictedAction) setShadow(shadowRes);
      if (profileRes.profile) setProfile(profileRes);
      if (marketRes.currentPrice) setPrice(marketRes.currentPrice);
    } catch { /* ignore */ }
  }, [pair, capital]);

  useEffect(() => {
    let active = true;
    const doFetch = async () => {
      try {
        const [tiltRes, shadowRes, profileRes, marketRes] = await Promise.all([
          fetch("/api/psyop/tilt").then((r) => r.json()),
          fetch("/api/psyop/shadow").then((r) => r.json()),
          fetch("/api/psyop/profile").then((r) => r.json()),
          fetch(`/api/psyop/market?pair=${pair}&capital=${capital}`).then((r) => r.json()),
        ]);
        if (!active) return;
        if (tiltRes.total !== undefined) setTilt(tiltRes);
        if (shadowRes.predictedAction) setShadow(shadowRes);
        if (profileRes.profile) setProfile(profileRes);
        if (marketRes.currentPrice) setPrice(marketRes.currentPrice);
      } catch { /* ignore */ }
    };
    doFetch();
    const interval = setInterval(doFetch, 15000);
    return () => { active = false; clearInterval(interval); };
  }, [pair, capital]);

  // Glitch effect intensifies with tilt
  useEffect(() => {
    if (!tilt) return;
    const intensity = tilt.total;
    if (intensity > 60) {
      const glitchInterval = setInterval(() => setGlitchKey((k) => k + 1), 800 - intensity * 5);
      return () => clearInterval(glitchInterval);
    }
  }, [tilt?.total]);

  const submitConfession = async () => {
    if (confessionText.trim().split(/\s+/).filter(Boolean).length < 20) {
      setConfessionResult({
        classification: "rejected",
        wordCount: confessionText.trim().split(/\s+/).filter(Boolean).length,
        signals: {},
        tiltContribution: 10,
        verdict: `MINIMUM 20 WORDS. You wrote ${confessionText.trim().split(/\s+/).filter(Boolean).length}. If you can't articulate 20 words of reasoning, you haven't thought it through. This is impulse wearing a costume.`,
        executeDenied: true,
        denialReason: "Confession too short — minimum 20 words required.",
      });
      return;
    }
    setConfessing(true);
    try {
      const res = await fetch("/api/psyop/confess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: confessionText, pair }),
      });
      const data = await res.json();
      setConfessionResult(data);
      fetchAll();
    } catch { /* ignore */ }
    setConfessing(false);
  };

  const tiltColor = (t: number) => {
    if (t >= 85) return "#ff0000";
    if (t >= 70) return "#ff3300";
    if (t >= 45) return "#ff6600";
    if (t >= 25) return "#ffaa00";
    return "#666";
  };

  const tiltState = tilt?.state ?? "calm";
  const locked = tiltState === "lockdown";
  const friction = tiltState === "friction";

  return (
    <div
      key={glitchKey}
      style={{
        background: "#000",
        color: "#ccc",
        fontFamily: "monospace",
        minHeight: "100vh",
        padding: "20px",
        maxWidth: "900px",
        margin: "0 auto",
      }}
    >
      {/* Glitch overlay when tilted */}
      {tilt && tilt.total > 60 && (
        <style>{`
          @keyframes glitch {
            0% { transform: translate(0); filter: hue-rotate(0deg); }
            20% { transform: translate(-${tilt.total > 80 ? 3 : 1}px, ${tilt.total > 80 ? 2 : 1}px); }
            40% { transform: translate(${tilt.total > 80 ? 2 : 1}px, -${tilt.total > 80 ? 2 : 1}px); filter: hue-rotate(${tilt.total}deg); }
            60% { transform: translate(-1px, 1px); }
            80% { transform: translate(1px, -1px); filter: hue-rotate(-${tilt.total}deg); }
            100% { transform: translate(0); filter: hue-rotate(0deg); }
          }
          * { animation: glitch ${(100 - tilt.total) / 20}s infinite; }
        `}</style>
      )}

      {/* HEADER */}
      <header style={{ borderBottom: "1px solid #333", paddingBottom: "10px", marginBottom: "20px" }}>
        <h1 style={{ fontSize: "28px", fontWeight: "bold", letterSpacing: "-1px", margin: 0 }}>
          PSYOP<span style={{ color: "#ff0000" }}>{"//"}</span>TERMINAL
        </h1>
        <p style={{ fontSize: "11px", color: "#666", margin: "4px 0 0" }}>
          the market is the stage. <span style={{ color: "#999" }}>you are the subject.</span>
        </p>
      </header>

      {/* TILT SCORE — full-width, pulsating */}
      <section style={{ marginBottom: "24px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "12px",
            padding: "16px 0",
            borderBottom: `2px solid ${tiltColor(tilt?.total ?? 0)}`,
          }}
        >
          <span style={{ fontSize: "11px", color: "#666", textTransform: "uppercase" }}>Tilt Index</span>
          <span
            style={{
              fontSize: "72px",
              fontWeight: "bold",
              color: tiltColor(tilt?.total ?? 0),
              lineHeight: 1,
              textShadow: tilt && tilt.total > 60 ? `0 0 ${tilt.total / 3}px ${tiltColor(tilt.total)}` : "none",
            }}
          >
            {tilt?.total.toFixed(0) ?? "--"}
          </span>
          <span style={{ fontSize: "14px", color: "#666" }}>/100</span>
          <span
            style={{
              marginLeft: "auto",
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "2px",
              padding: "4px 8px",
              border: `1px solid ${tiltColor(tilt?.total ?? 0)}`,
              color: tiltColor(tilt?.total ?? 0),
            }}
          >
            {tiltState}
          </span>
        </div>

        {/* Tilt breakdown */}
        {tilt && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "4px", marginTop: "8px", fontSize: "10px" }}>
            {[
              ["trade freq", tilt.factors.tradeFrequency, 25],
              ["loss streak", tilt.factors.lossStreak, 25],
              ["plan dev", tilt.factors.planDeviation, 20],
              ["fatigue", tilt.factors.sessionFatigue, 15],
              ["confession", tilt.factors.confessionDecay, 10],
              ["revenge", tilt.factors.revengeWindow, 5],
            ].map(([label, val, max]) => (
              <div key={label as string} style={{ color: "#666" }}>
                {label}: <span style={{ color: tiltColor(val as number) }}>{val}</span>/{max}
              </div>
            ))}
          </div>
        )}

        {tilt && (
          <p style={{ fontSize: "12px", color: tiltColor(tilt.total), marginTop: "8px", lineHeight: 1.4 }}>
            {tilt.recommendation}
          </p>
        )}
      </section>

      {/* MARKET — stated flatly, no celebration */}
      <section style={{ marginBottom: "24px", padding: "12px", border: "1px solid #222", background: "#0a0a0a" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: "11px", color: "#666", textTransform: "uppercase" }}>{pair}</span>
          <span style={{ fontSize: "20px", color: "#ccc" }}>
            Rp {price ? price.toLocaleString("id-ID", { maximumFractionDigits: 0 }) : "---"}
          </span>
        </div>
        <p style={{ fontSize: "10px", color: "#444", margin: "6px 0 0" }}>
          the price is the price. it has no opinion about you.
        </p>
      </section>

      {/* SHADOW SELF */}
      {shadow && (
        <section style={{ marginBottom: "24px", padding: "16px", border: `1px solid ${shadow.confidence > 0.6 ? "#ff3300" : "#333"}`, background: "#0a0a0a" }}>
          <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", marginBottom: "8px" }}>
            Shadow Self <span style={{ color: "#444" }}>(your behavioral pattern)</span>
          </div>
          <div style={{ fontSize: "16px", color: "#ccc", marginBottom: "8px" }}>
            <span style={{ color: "#ff3300", fontWeight: "bold" }}>{shadow.predictedAction.replace(/_/g, " ")}</span>
            <span style={{ color: "#666", fontSize: "11px", marginLeft: "8px" }}>
              {shadow.confidence > 0 ? `${Math.round(shadow.confidence * 100)}% confidence · ${shadow.historicalMatches} matches` : ""}
            </span>
          </div>
          <p style={{ fontSize: "12px", color: "#999", lineHeight: 1.5 }}>{shadow.shadowVerdict}</p>
          {shadow.pattern !== "insufficient data" && (
            <p style={{ fontSize: "10px", color: "#444", marginTop: "6px", fontFamily: "monospace" }}>
              pattern: {shadow.pattern} · sample: {shadow.sampleSize}
            </p>
          )}
        </section>
      )}

      {/* CONFESSION GATE */}
      <section style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", marginBottom: "8px", borderBottom: "1px solid #222", paddingBottom: "4px" }}>
          Confession Gate <span style={{ color: "#444" }}>(required before execution)</span>
        </div>

        <textarea
          value={confessionText}
          onChange={(e) => setConfessionText(e.target.value)}
          placeholder="Type at least 20 words explaining WHY this trade fits your plan. What setup? What level? What risk? If you can't articulate it, don't execute it."
          disabled={locked}
          style={{
            width: "100%",
            minHeight: "100px",
            background: "#0a0a0a",
            border: `1px solid ${locked ? "#ff0000" : "#333"}`,
            color: "#ccc",
            fontFamily: "monospace",
            fontSize: "12px",
            padding: "12px",
            resize: "vertical",
            outline: "none",
          }}
        />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "8px" }}>
          <span style={{ fontSize: "10px", color: confessionText.trim().split(/\s+/).filter(Boolean).length >= 20 ? "#666" : "#ff3300" }}>
            {confessionText.trim().split(/\s+/).filter(Boolean).length} words {confessionText.trim().split(/\s+/).filter(Boolean).length >= 20 ? "✓" : "(need 20)"}
          </span>

          <button
            onClick={submitConfession}
            disabled={locked || confessing || confessionText.trim().split(/\s+/).filter(Boolean).length < 20}
            style={{
              padding: "8px 24px",
              background: locked ? "#1a0000" : friction ? "#1a0a00" : "#111",
              border: `1px solid ${locked ? "#ff0000" : friction ? "#ff6600" : "#333"}`,
              color: locked ? "#ff0000" : friction ? "#ff6600" : "#ccc",
              fontFamily: "monospace",
              fontSize: "12px",
              cursor: locked ? "not-allowed" : "pointer",
              textTransform: "uppercase",
              letterSpacing: "2px",
            }}
          >
            {locked ? "LOCKED" : friction ? "EXECUTE (FRICTION)" : "EXECUTE"}
          </button>
        </div>

        {/* Confession verdict */}
        {confessionResult && (
          <div
            style={{
              marginTop: "12px",
              padding: "12px",
              border: `1px solid ${
                confessionResult.classification === "tilt_driven" ? "#ff0000"
                : confessionResult.classification === "plan_driven" ? "#333"
                : "#ff6600"
              }`,
              background: "#0a0a0a",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
              <span style={{ fontSize: "11px", textTransform: "uppercase", color: "#666" }}>
                classified: <span style={{
                  color:
                    confessionResult.classification === "tilt_driven" ? "#ff0000"
                    : confessionResult.classification === "plan_driven" ? "#ccc"
                    : "#ff6600",
                  fontWeight: "bold",
                }}>{confessionResult.classification.replace(/_/g, " ")}</span>
              </span>
              {confessionResult.executeDenied && (
                <span style={{ fontSize: "11px", color: "#ff0000", fontWeight: "bold" }}>EXECUTE DENIED</span>
              )}
            </div>
            <p style={{ fontSize: "12px", color: "#ccc", lineHeight: 1.5 }}>{confessionResult.verdict}</p>
            {confessionResult.denialReason && (
              <p style={{ fontSize: "11px", color: "#ff3300", marginTop: "6px" }}>{confessionResult.denialReason}</p>
            )}
          </div>
        )}
      </section>

      {/* BADGES — inverted gamification */}
      {profile && profile.badges.length > 0 && (
        <section style={{ marginBottom: "24px" }}>
          <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", marginBottom: "8px", borderBottom: "1px solid #222", paddingBottom: "4px" }}>
            Behavioral Badges <span style={{ color: "#444" }}>(earned for bad patterns)</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {profile.badges.filter((b) => b.earned).map((b) => (
              <span
                key={b.id}
                title={b.description}
                style={{
                  fontSize: "10px",
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  padding: "4px 8px",
                  border: `1px solid ${b.severity === "critical" ? "#ff0000" : b.severity === "error" ? "#ff3300" : b.severity === "warn" ? "#ff6600" : "#333"}`,
                  color: b.severity === "critical" ? "#ff0000" : b.severity === "error" ? "#ff3300" : b.severity === "warn" ? "#ff6600" : "#ccc",
                }}
              >
                {b.label}
              </span>
            ))}
            {profile.badges.filter((b) => b.earned).length === 0 && (
              <span style={{ fontSize: "11px", color: "#444" }}>no badges earned. keep it that way.</span>
            )}
          </div>
        </section>
      )}

      {/* PROFILE STATS */}
      {profile && (
        <section style={{ marginBottom: "24px", padding: "12px", border: "1px solid #222", background: "#0a0a0a" }}>
          <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", marginBottom: "8px" }}>Your Numbers</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", fontSize: "12px" }}>
            <div>
              <div style={{ color: "#666", fontSize: "10px" }}>Intentions</div>
              <div style={{ color: "#ccc", fontSize: "18px" }}>{profile.profile.totalIntentions}</div>
            </div>
            <div>
              <div style={{ color: "#666", fontSize: "10px" }}>Executions</div>
              <div style={{ color: "#ccc", fontSize: "18px" }}>{profile.profile.totalExecutions}</div>
            </div>
            <div>
              <div style={{ color: "#666", fontSize: "10px" }}>Deviations</div>
              <div style={{ color: profile.profile.totalDeviations > 0 ? "#ff3300" : "#ccc", fontSize: "18px" }}>{profile.profile.totalDeviations}</div>
            </div>
            <div>
              <div style={{ color: "#666", fontSize: "10px" }}>Max Tilt</div>
              <div style={{ color: tiltColor(profile.profile.maxTilt), fontSize: "18px" }}>{profile.profile.maxTilt.toFixed(0)}</div>
            </div>
          </div>
        </section>
      )}

      {/* RECENT CONFESSIONS */}
      {profile && profile.recentConfessions.length > 0 && (
        <section style={{ marginBottom: "24px" }}>
          <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", marginBottom: "8px", borderBottom: "1px solid #222", paddingBottom: "4px" }}>
            Your Own Words <span style={{ color: "#444" }}>(recent confessions)</span>
          </div>
          <div style={{ maxHeight: "200px", overflowY: "auto" }}>
            {profile.recentConfessions.map((c) => (
              <div key={c.id} style={{ padding: "6px 0", borderBottom: "1px solid #111", fontSize: "11px" }}>
                <span style={{
                  color:
                    c.classified === "tilt_driven" ? "#ff0000"
                    : c.classified === "plan_driven" ? "#666"
                    : "#ff6600",
                  fontWeight: "bold",
                  textTransform: "uppercase",
                  marginRight: "8px",
                }}>
                  [{c.classified.replace(/_/g, " ")}]
                </span>
                <span style={{ color: "#888" }}>{c.text}</span>
                <span style={{ color: "#333", marginLeft: "6px" }}>· {c.wordCount}w</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* FOOTER */}
      <footer style={{ marginTop: "40px", paddingTop: "12px", borderTop: "1px solid #222", fontSize: "10px", color: "#333" }}>
        <p>PSYOP{"//"}TERMINAL v1.0 — this system does not predict the market. it predicts you.</p>
        <p style={{ marginTop: "4px" }}>the market is efficient. your psychology is not. that's the only edge.</p>
      </footer>
    </div>
  );
}
