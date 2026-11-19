"use client";

import { useState, useEffect } from "react";

// ── ALPHA SIGNAL DASHBOARD ──
// Real edges: funding contrarian + volatility scaling + regime routing + Kelly.
// NOT the old indicator-based advisor (proven noise).
// Each signal has: entry, stop (2 ATR), targets (1.5R/3R), position size,
// regime-matched backtest, invalidation criteria.

interface AlphaSignal {
  pair: string;
  action: "LONG" | "SHORT" | "REDUCE" | "FLAT" | "CLOSE";
  strength: string;
  conviction: number;
  confirmed: boolean;
  dataStale: boolean;
  dataSource: string;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  positionSizePct: number;
  positionSizeIdr: number;
  notionalIdr: number;
  notionalCapPct: number;
  leverage: number;
  rewardRiskRatio: number;
  edges: { funding: string; fundingZScore: number; regime: string; volatility: string; trend: string };
  microstructure: {
    oiTrend: string; oiChange4hPct: number; cvd1h: number;
    cvdDivergence: boolean; absorptionDetected: boolean;
    takerBuyRatio: number; confirmation: string;
  } | null;
  backtest: {
    oosWinRate: number; oosAvgReturn: number; oosSampleSize: number;
    oosSharpe: number; oosMaxDrawdown: number; kellyFraction: number;
    kellyCI5: number; kellyCI95: number; kellyUncertainty: number;
    inSampleWinRate: number; overfitGap: number; honest: boolean;
    anchoredWindows: number; description: string;
  };
  liquidity: {
    maxNotionalWithoutSlippage: number; topBidDepth: number; topAskDepth: number;
    spreadPct: number; liquidityCapActive: boolean;
  } | null;
  rationale: string[];
  invalidation: string;
  warning: string | null;
  raw: {
    price: number; atr: number; atrPercent: number; rsi: number; adx: number;
    fundingRate: number; fundingZScore: number; fundingPercentile: number; regime: string;
  };
}

interface AlphaResult {
  signals: AlphaSignal[];
  portfolioAllocation: { pair: string; action: string; allocationPct: number }[];
  capitalAtRisk: number;
  regimeSummary: string;
  generatedAt: string;
  disclaimer: string;
}

export default function AlphaDashboard() {
  const [data, setData] = useState<AlphaResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [capital, setCapital] = useState(10000000);

  const fetchSignals = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/signal/alpha?capital=${capital}`);
      const d = await r.json();
      setData(d);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    let active = true;
    const doFetch = async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/signal/alpha?capital=${capital}`);
        const d = await r.json();
        if (active) setData(d);
      } catch { /* ignore */ }
      if (active) setLoading(false);
    };
    doFetch();
    const interval = setInterval(doFetch, 60000);
    return () => { active = false; clearInterval(interval); };
  }, [capital]);

  const fmtIdr = (n: number) => "Rp " + n.toLocaleString("id-ID", { maximumFractionDigits: 0 });
  const fmtPct = (n: number, dp = 2) => `${(n * 100).toFixed(dp)}%`;

  const actionColor = (a: string) =>
    a === "LONG" ? "#16a34a"
    : a === "SHORT" ? "#dc2626"
    : a === "REDUCE" ? "#f59e0b"
    : a === "CLOSE" ? "#f59e0b"
    : "#6b7280";

  const activeSignals = data?.signals.filter((s) => s.action === "LONG" || s.action === "SHORT") ?? [];
  const flatSignals = data?.signals.filter((s) => s.action === "FLAT") ?? [];

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#e5e5e5", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "24px 16px" }}>
        {/* HEADER */}
        <header style={{ marginBottom: "32px", borderBottom: "1px solid #262626", paddingBottom: "16px" }}>
          <h1 style={{ fontSize: "28px", fontWeight: 700, margin: 0, letterSpacing: "-0.5px" }}>
            Alpha Signal Terminal
          </h1>
          <p style={{ fontSize: "13px", color: "#737373", margin: "6px 0 0" }}>
            Funding contrarian + volatility scaling + regime routing + fractional Kelly.
            Real edges, honest backtests, risk-managed signals.
          </p>
        </header>

        {/* PORTFOLIO SUMMARY */}
        {data && (
          <section style={{ marginBottom: "32px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
              <div style={{ background: "#141414", border: "1px solid #262626", borderRadius: "8px", padding: "16px" }}>
                <div style={{ fontSize: "11px", color: "#737373", textTransform: "uppercase", letterSpacing: "1px" }}>Capital at Risk</div>
                <div style={{ fontSize: "28px", fontWeight: 700, color: data.capitalAtRisk > 0.04 ? "#f59e0b" : "#e5e5e5", marginTop: "4px" }}>
                  {fmtPct(data.capitalAtRisk)}
                </div>
                <div style={{ fontSize: "11px", color: "#525252", marginTop: "2px" }}>Max 6% (risk-managed)</div>
              </div>
              <div style={{ background: "#141414", border: "1px solid #262626", borderRadius: "8px", padding: "16px" }}>
                <div style={{ fontSize: "11px", color: "#737373", textTransform: "uppercase", letterSpacing: "1px" }}>Active Signals</div>
                <div style={{ fontSize: "28px", fontWeight: 700, marginTop: "4px" }}>{activeSignals.length}</div>
                <div style={{ fontSize: "11px", color: "#525252", marginTop: "2px" }}>{activeSignals.filter((s) => s.action === "LONG").length} long · {activeSignals.filter((s) => s.action === "SHORT").length} short</div>
              </div>
              <div style={{ background: "#141414", border: "1px solid #262626", borderRadius: "8px", padding: "16px" }}>
                <div style={{ fontSize: "11px", color: "#737373", textTransform: "uppercase", letterSpacing: "1px" }}>Flat (No Edge)</div>
                <div style={{ fontSize: "28px", fontWeight: 700, color: "#525252", marginTop: "4px" }}>{flatSignals.length}</div>
                <div style={{ fontSize: "11px", color: "#525252", marginTop: "2px" }}>Not trading = valid position</div>
              </div>
              <div style={{ background: "#141414", border: "1px solid #262626", borderRadius: "8px", padding: "16px" }}>
                <div style={{ fontSize: "11px", color: "#737373", textTransform: "uppercase", letterSpacing: "1px" }}>Capital</div>
                <input
                  type="number"
                  value={capital}
                  onChange={(e) => setCapital(Math.max(100000, parseInt(e.target.value) || 10000000))}
                  onBlur={fetchSignals}
                  style={{ background: "transparent", border: "none", color: "#e5e5e5", fontSize: "20px", fontWeight: 700, width: "100%", outline: "none" }}
                />
                <div style={{ fontSize: "11px", color: "#525252", marginTop: "2px" }}>Click to edit</div>
              </div>
            </div>

            {/* Regime summary */}
            <div style={{ background: "#141414", border: "1px solid #262626", borderRadius: "8px", padding: "12px 16px", marginTop: "12px" }}>
              <div style={{ fontSize: "11px", color: "#737373", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "4px" }}>Market Regime</div>
              <div style={{ fontSize: "13px", color: "#a3a3a3" }}>{data.regimeSummary}</div>
            </div>
          </section>
        )}

        {/* ACTIVE SIGNALS */}
        {data && activeSignals.length > 0 && (
          <section style={{ marginBottom: "32px" }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "16px", color: "#e5e5e5" }}>
              Active Signals <span style={{ color: "#525252", fontSize: "12px", fontWeight: 400 }}>({activeSignals.length})</span>
            </h2>
            <div style={{ display: "grid", gap: "16px" }}>
              {activeSignals.map((s) => (
                <SignalCard key={s.pair} signal={s} fmtIdr={fmtIdr} fmtPct={fmtPct} actionColor={actionColor} />
              ))}
            </div>
          </section>
        )}

        {/* FLAT SIGNALS (no edge — valid) */}
        {data && flatSignals.length > 0 && (
          <section style={{ marginBottom: "32px" }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "16px", color: "#737373" }}>
              No Edge — Flat <span style={{ color: "#525252", fontSize: "12px", fontWeight: 400 }}>({flatSignals.length})</span>
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "12px" }}>
              {flatSignals.map((s) => (
                <div key={s.pair} style={{ background: "#111", border: "1px solid #262626", borderRadius: "8px", padding: "16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <span style={{ fontSize: "14px", fontWeight: 600 }}>{s.pair.toUpperCase()}</span>
                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#525252" }}>FLAT</span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#737373" }}>
                    <div>Price: {fmtIdr(s.raw.price)}</div>
                    <div>Funding: {(s.raw.fundingRate * 100).toFixed(4)}% (z={s.raw.fundingZScore.toFixed(2)}) · ADX: {s.raw.adx.toFixed(0)} · RSI: {s.raw.rsi.toFixed(0)}</div>
                    <div style={{ marginTop: "6px", color: "#525252" }}>{s.rationale[0]}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* DISCLAIMER */}
        {data && (
          <footer style={{ marginTop: "40px", paddingTop: "16px", borderTop: "1px solid #262626" }}>
            <div style={{ fontSize: "11px", color: "#525252", lineHeight: 1.6, background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "8px", padding: "12px" }}>
              <strong style={{ color: "#737373" }}>Disclaimer:</strong> {data.disclaimer}
            </div>
            <div style={{ fontSize: "11px", color: "#404040", marginTop: "8px", textAlign: "center" }}>
              Generated: {data.generatedAt} · Next refresh: 60s
              {loading && <span style={{ marginLeft: "8px", color: "#525252" }}>· refreshing…</span>}
            </div>
          </footer>
        )}

        {/* LOADING STATE */}
        {!data && !loading && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#525252" }}>
            <button onClick={fetchSignals} style={{ padding: "12px 24px", background: "#171717", border: "1px solid #262626", borderRadius: "8px", color: "#e5e5e5", cursor: "pointer", fontSize: "14px" }}>
              Generate Signals
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SignalCard({ signal: s, fmtIdr, fmtPct, actionColor }: {
  signal: AlphaSignal;
  fmtIdr: (n: number) => string;
  fmtPct: (n: number, dp?: number) => string;
  actionColor: (a: string) => string;
}) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div style={{ background: "#141414", border: `1px solid ${actionColor(s.action)}40`, borderRadius: "8px", overflow: "hidden" }}>
      {/* HEADER */}
      <div style={{ padding: "16px", borderBottom: "1px solid #262626", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontSize: "18px", fontWeight: 700 }}>{s.pair.toUpperCase()}</span>
          <span style={{ fontSize: "14px", fontWeight: 700, color: actionColor(s.action), padding: "2px 10px", border: `1px solid ${actionColor(s.action)}`, borderRadius: "4px" }}>
            {s.action}
          </span>
          <span style={{ fontSize: "11px", color: "#737373", textTransform: "uppercase" }}>{s.strength}</span>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "18px", fontWeight: 600 }}>{fmtIdr(s.entry)}</div>
          <div style={{ fontSize: "11px", color: "#525252" }}>entry price</div>
        </div>
      </div>

      {/* RISK PARAMETERS */}
      <div style={{ padding: "16px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "12px", marginBottom: "16px" }}>
          <div>
            <div style={{ fontSize: "10px", color: "#525252", textTransform: "uppercase" }}>Stop Loss</div>
            <div style={{ fontSize: "15px", fontWeight: 600, color: "#dc2626" }}>{fmtIdr(s.stopLoss)}</div>
            <div style={{ fontSize: "10px", color: "#404040" }}>{fmtPct(Math.abs(s.entry - s.stopLoss) / s.entry)} (2 ATR)</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#525252", textTransform: "uppercase" }}>Target 1 (1.5R)</div>
            <div style={{ fontSize: "15px", fontWeight: 600, color: "#16a34a" }}>{fmtIdr(s.takeProfit1)}</div>
            <div style={{ fontSize: "10px", color: "#404040" }}>{fmtPct(Math.abs(s.takeProfit1 - s.entry) / s.entry)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#525252", textTransform: "uppercase" }}>Target 2 (3R)</div>
            <div style={{ fontSize: "15px", fontWeight: 600, color: "#16a34a" }}>{fmtIdr(s.takeProfit2)}</div>
            <div style={{ fontSize: "10px", color: "#404040" }}>{fmtPct(Math.abs(s.takeProfit2 - s.entry) / s.entry)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#525252", textTransform: "uppercase" }}>Position Size</div>
            <div style={{ fontSize: "15px", fontWeight: 600 }}>{fmtIdr(s.positionSizeIdr)}</div>
            <div style={{ fontSize: "10px", color: "#404040" }}>{fmtPct(s.positionSizePct)} of capital</div>
          </div>
        </div>

        {/* MICROSTRUCTURE CONFIRMATION */}
        {s.microstructure && (
          <div style={{ background: s.confirmed ? "#0a1a0a" : "#0f0f0f", border: `1px solid ${s.confirmed ? "#16a34a40" : "#1a1a1a"}`, borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
            <div style={{ fontSize: "10px", color: "#525252", textTransform: "uppercase", marginBottom: "8px" }}>
              Microstructure {s.confirmed && <span style={{ color: "#16a34a", fontWeight: 700 }}>✓ CONFIRMED</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: "8px" }}>
              <div>
                <div style={{ fontSize: "10px", color: "#525252" }}>OI Trend</div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: s.microstructure.oiTrend === "declining" ? "#16a34a" : s.microstructure.oiTrend === "rising" ? "#dc2626" : "#737373" }}>
                  {s.microstructure.oiTrend} ({s.microstructure.oiChange4hPct.toFixed(1)}%)
                </div>
              </div>
              <div>
                <div style={{ fontSize: "10px", color: "#525252" }}>CVD 1h</div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: s.microstructure.cvd1h > 0 ? "#16a34a" : "#dc2626" }}>
                  {s.microstructure.cvd1h > 0 ? "net buy" : "net sell"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "10px", color: "#525252" }}>Absorption</div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: s.microstructure.absorptionDetected ? "#f59e0b" : "#525252" }}>
                  {s.microstructure.absorptionDetected ? "DETECTED" : "none"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "10px", color: "#525252" }}>Taker Buy %</div>
                <div style={{ fontSize: "13px", fontWeight: 600 }}>{(s.microstructure.takerBuyRatio * 100).toFixed(0)}%</div>
              </div>
            </div>
            <div style={{ fontSize: "11px", color: "#737373", marginTop: "6px" }}>
              Verdict: {s.microstructure.confirmation}
            </div>
          </div>
        )}

        {/* OOS BACKTEST with bootstrap CI */}
        <div style={{ background: "#0f0f0f", border: `1px solid ${s.backtest.honest ? "#16a34a40" : "#1a1a1a"}`, borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
          <div style={{ fontSize: "10px", color: "#525252", textTransform: "uppercase", marginBottom: "8px" }}>
            Anchored Walk-Forward OOS <span style={{ color: "#404040" }}>(n={s.backtest.oosSampleSize}, {s.backtest.anchoredWindows} windows)</span>
            {s.backtest.honest && s.backtest.oosSampleSize > 0 && <span style={{ color: "#16a34a", marginLeft: "8px", fontWeight: 700 }}>✓ EDGE CONFIRMED (95% bootstrap)</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: "8px" }}>
            <div>
              <div style={{ fontSize: "10px", color: "#525252" }}>OOS Win Rate</div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: s.backtest.oosWinRate > 0.5 ? "#16a34a" : "#dc2626" }}>
                {s.backtest.oosSampleSize > 0 ? fmtPct(s.backtest.oosWinRate, 0) : "—"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "10px", color: "#525252" }}>OOS Sharpe</div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: s.backtest.oosSharpe > 1 ? "#16a34a" : "#737373" }}>
                {s.backtest.oosSampleSize > 0 ? s.backtest.oosSharpe.toFixed(1) : "—"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "10px", color: "#525252" }}>Kelly (point)</div>
              <div style={{ fontSize: "14px", fontWeight: 600 }}>{fmtPct(s.backtest.kellyFraction, 1)}</div>
            </div>
            <div>
              <div style={{ fontSize: "10px", color: "#525252" }}>Kelly CI5 (conservative)</div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: s.backtest.kellyCI5 > 0 ? "#16a34a" : "#dc2626" }}>
                {fmtPct(s.backtest.kellyCI5, 1)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "10px", color: "#525252" }}>Kelly CI [5-95%]</div>
              <div style={{ fontSize: "12px", fontWeight: 500, color: s.backtest.kellyUncertainty > 0.3 ? "#f59e0b" : "#737373" }}>
                {(s.backtest.kellyCI5 * 100).toFixed(1)}–{(s.backtest.kellyCI95 * 100).toFixed(1)}%
              </div>
            </div>
            <div>
              <div style={{ fontSize: "10px", color: "#525252" }}>Overfit Gap</div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: s.backtest.overfitGap > 0.15 ? "#dc2626" : "#737373" }}>
                {fmtPct(s.backtest.overfitGap, 0)}
              </div>
            </div>
          </div>
        </div>

        {/* RATIONALE */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontSize: "10px", color: "#525252", textTransform: "uppercase", marginBottom: "6px" }}>Rationale</div>
          {s.rationale.map((r, i) => (
            <div key={i} style={{ fontSize: "12px", color: "#a3a3a3", marginBottom: "3px", paddingLeft: "8px", borderLeft: "2px solid #262626" }}>
              {r}
            </div>
          ))}
        </div>

        {/* WARNING */}
        {s.warning && (
          <div style={{ background: "#1a1000", border: "1px solid #f59e0b40", borderRadius: "6px", padding: "8px 12px", marginBottom: "12px" }}>
            <span style={{ fontSize: "11px", color: "#f59e0b" }}>{s.warning}</span>
          </div>
        )}

        {/* INVALIDATION */}
        <div style={{ background: "#0f0a0a", border: "1px solid #dc262640", borderRadius: "6px", padding: "8px 12px", marginBottom: "12px" }}>
          <span style={{ fontSize: "10px", color: "#dc2626", textTransform: "uppercase" }}>Invalidation: </span>
          <span style={{ fontSize: "11px", color: "#a3a3a3" }}>{s.invalidation}</span>
        </div>

        {/* DETAILS TOGGLE */}
        <button
          onClick={() => setShowDetails(!showDetails)}
          style={{ background: "transparent", border: "1px solid #262626", color: "#737373", padding: "4px 12px", borderRadius: "4px", fontSize: "11px", cursor: "pointer" }}
        >
          {showDetails ? "Hide" : "Show"} raw data + edges
        </button>

        {showDetails && (
          <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #262626" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "8px", marginBottom: "12px" }}>
              <div><span style={{ fontSize: "10px", color: "#525252" }}>ATR: </span><span style={{ fontSize: "12px" }}>{s.raw.atr.toFixed(0)} ({s.raw.atrPercent.toFixed(2)}%)</span></div>
              <div><span style={{ fontSize: "10px", color: "#525252" }}>RSI: </span><span style={{ fontSize: "12px" }}>{s.raw.rsi.toFixed(0)}</span></div>
              <div><span style={{ fontSize: "10px", color: "#525252" }}>ADX: </span><span style={{ fontSize: "12px" }}>{s.raw.adx.toFixed(0)}</span></div>
              <div><span style={{ fontSize: "10px", color: "#525252" }}>Funding z: </span><span style={{ fontSize: "12px", color: Math.abs(s.raw.fundingZScore) > 2 ? "#dc2626" : Math.abs(s.raw.fundingZScore) > 1 ? "#f59e0b" : "#737373" }}>{s.raw.fundingZScore.toFixed(2)} ({s.raw.fundingPercentile.toFixed(0)}th)</span></div>
              <div><span style={{ fontSize: "10px", color: "#525252" }}>R:R: </span><span style={{ fontSize: "12px" }}>{s.rewardRiskRatio.toFixed(2)}:1</span></div>
              <div><span style={{ fontSize: "10px", color: "#525252" }}>Conviction: </span><span style={{ fontSize: "12px" }}>{s.conviction}/100</span></div>
              <div><span style={{ fontSize: "10px", color: "#525252" }}>Notional: </span><span style={{ fontSize: "12px" }}>Rp {s.notionalIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })} ({(s.notionalCapPct * 100).toFixed(0)}%, {s.leverage.toFixed(1)}x)</span></div>
              <div><span style={{ fontSize: "10px", color: "#525252" }}>Data: </span><span style={{ fontSize: "12px", color: s.dataStale ? "#dc2626" : "#16a34a" }}>{s.dataStale ? "STALE" : "fresh"} ({s.dataSource})</span></div>
            </div>
            <div style={{ fontSize: "11px", color: "#525252" }}>
              <strong>Edges:</strong> funding={s.edges.funding} (z={s.edges.fundingZScore.toFixed(2)}) · regime={s.edges.regime} · vol={s.edges.volatility} · trend={s.edges.trend}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
