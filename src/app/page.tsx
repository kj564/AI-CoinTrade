"use client";

import { useState, useEffect, useCallback } from "react";

// ── TRADING ASSISTANT + PAPER TRADING DASHBOARD ──
// Simple BELI / JUAL / TUNGGU per pair + portfolio capital protection.
//
// Sections:
//   1. Input (Dana, Risk per Trade, Mode)
//   2. Pair Aktif (KANDIDAT EDGE / MARGINAL cards)
//   3. Pair Nonaktif (NONAKTIF SEMENTARA)
//   4. Paper Trading Dashboard:
//      - Drawdown meter (0% → -15%) with tier labels
//      - Dynamic risk multiplier (anti-martingale)
//      - Portfolio P&L stats
//      - Per-pair circuit breaker table (with Wilson CI)
//      - Recent signals table (last 10)
//      - Alert feed (signal_fired / closed / circuit_tripped / drawdown_breach)
//      - Weekly review (with recommendations)

const PAIR_CONFIG: Record<string, {
  enabled: boolean;
  name: string;
  label: string;
  note: string;
  evidence: string;
  tier: "MAJOR" | "MICROCAP";
}> = {
  eth_idr: {
    enabled: true, name: "Ethereum",
    label: "KANDIDAT EDGE",
    note: "+25.1% net setelah biaya (21 hari replay)",
    evidence: "21 hari replay, 75% win, Sharpe 13.1 — belum cukup untuk live",
    tier: "MAJOR",
  },
  btc_idr: {
    enabled: true, name: "Bitcoin",
    label: "MARGINAL",
    note: "+4.5% net setelah biaya (21 hari replay)",
    evidence: "EV tipis setelah biaya, 64% win — butuh validasi lebih lanjut",
    tier: "MAJOR",
  },
  sol_idr: {
    enabled: false, name: "Solana",
    label: "NONAKTIF SEMENTARA",
    note: "-20.8% net setelah biaya (21 hari replay)",
    evidence: "EV negatif setelah biaya. Ditinjau ulang mingguan.",
    tier: "MAJOR",
  },
  bnb_idr: {
    enabled: false, name: "BNB",
    label: "NONAKTIF SEMENTARA",
    note: "-6.2% net setelah biaya (21 hari replay)",
    evidence: "EV negatif setelah biaya. Ditinjau ulang mingguan.",
    tier: "MAJOR",
  },
  xrp_idr: {
    enabled: false, name: "XRP",
    label: "NONAKTIF SEMENTARA",
    note: "-18.9% net setelah biaya (21 hari replay)",
    evidence: "EV negatif setelah biaya. Ditinjau ulang mingguan.",
    tier: "MAJOR",
  },
  unmd_idr: {
    enabled: false, name: "UNMD (Utility NexusMind)",
    label: "WATCHLIST",
    note: "Microcap — likuiditas sangat rendah, spread lebar, manipulasi riskan",
    evidence: "Volume 24h ~Rp 97-280jt. Syarat: volume ≥500jt, spread ≤1%, 100 candle, 20 OOS trade.",
    tier: "MICROCAP",
  },
};

interface Signal {
  pair: string;
  action: string;
  strength: string;
  conviction: number;
  confirmed: boolean;
  dataStale: boolean;
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
  microstructure: { oiTrend: string; absorptionDetected: boolean; confirmation: string } | null;
  backtest: { oosWinRate: number; oosSampleSize: number; honest: boolean; kellyCI5: number; regimeStable: boolean };
  impact: { evSeverity: string; expectedValueIdr: number; impactLevel: string } | null;
  limitOrder: { recommendation: string; fillProbability: number } | null;
  circuitBreaker: {
    open: boolean;
    consecutiveLosses: number;
    winRate: number;
    cooldownSec: number;
    trips: number;
    winRateCI5: number;
    winRateCI95: number;
    ciWidth: number;
    ciSampleAdequate: boolean;
  };
  rationale: string[];
  invalidation: string;
  warning: string | null;
  microcap: {
    isMicrocap: boolean;
    gatePassed: boolean;
    status: "WATCHLIST" | "KANDIDAT_EDGE" | "KANDIDAT_LIVE_MICRO" | "not_microcap";
    checks: { name: string; passed: boolean; actual: number; required: number; unit: string }[];
    failedChecks: string[];
    reason: string;
    maxRiskPct: number;
    maxNotionalIdr: number;
  } | null;
  raw: { price: number; fundingRate: number; fundingZScore: number; adx: number; rsi: number; atrPercent: number };
}

interface AlphaResult {
  signals: Signal[];
  capitalAtRisk: number;
  regimeSummary: string;
  signalCheck?: { checked: number; closed: number; wins: number; losses: number };
  generatedAt: string;
  disclaimer: string;
}

interface DrawdownState {
  cumulativePnlIdr: number;
  cumulativePnlPct: number;
  peakPnlIdr: number;
  troughPnlIdr: number;
  currentDrawdownPct: number;
  isHalted: boolean;
  haltReason: string | null;
  riskMultiplier: number;
  drawdownMultiplier: number;
  rampMultiplierCap: number;
  rampStage: number;
  rampStageLabel: string;
  rampAgeHours: number;
  riskTierLabel: string;
  closedSignals: number;
  alertThresholdPct: number;
  recoveryThresholdPct: number;
  weeklyLossPct: number;
  weeklyLossPauseActive: boolean;
  weeklyPauseExpiresAt: number | null;
  weeklyLossStartedAt: number | null;
  dailyLossPct: number;
  dailyLossPauseActive: boolean;
  dailyPauseExpiresAt: number | null;
  dailyLossStartedAt: number | null;
  haltedAt: number | null;
  recoveryStartedAt: number | null;
  computedAt: string;
}

interface RegimeTailRiskRow {
  regime: string;
  sampleSize: number;
  var95Pct: number;
  es95Pct: number;
  var99Pct: number;
  es99Pct: number;
  worstTradePct: number;
  ciAdequate: boolean;
  var95BootstrapCI5: number;
  var95BootstrapCI95: number;
  es95BootstrapCI5: number;
  es95BootstrapCI95: number;
  var99BootstrapCI5: number;
  var99BootstrapCI95: number;
  es99BootstrapCI5: number;
  es99BootstrapCI95: number;
}

interface EdgeBreakerRow {
  pair: string;
  edgeSource: string;
  open: boolean;
  consecutiveLosses: number;
  totalSignals: number;
  winRate: number;
  winRateCI5: number;
  winRateCI95: number;
  winRateBootstrapCI5: number;
  winRateBootstrapCI95: number;
  trips: number;
  cooldownSec: number;
  lastSignalOutcome: string | null;
}

interface TailRiskMetrics {
  var95Pct: number;
  es95Pct: number;
  var99Pct: number;
  es99Pct: number;
  avgPositionSizeIdr: number;
  var95Idr: number;
  es95Idr: number;
  portfolioVar95Idr: number;
  portfolioEs95Idr: number;
  sampleSize: number;
  tailSampleSize: number;
  ciAdequate: boolean;
  var95BootstrapCI5: number;
  var95BootstrapCI95: number;
  es95BootstrapCI5: number;
  es95BootstrapCI95: number;
  var99BootstrapCI5: number;
  var99BootstrapCI95: number;
  es99BootstrapCI5: number;
  es99BootstrapCI95: number;
  worstTradePct: number;
  worstTradeIdr: number;
  computedAt: string;
}

interface RecentAlert {
  id: string;
  type: string;
  severity: string;
  pair: string | null;
  message: string;
  delivered: boolean;
  createdAt: string;
}

interface PortfolioData {
  totalSignals: number;
  openSignals: number;
  closedSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlIdr: number;
  avgPnlPct: number;
  avgHoldHours: number;
  bestTrade: number;
  worstTrade: number;
  sharpeRatio: number;
  byPair: { pair: string; signals: number; winRate: number; pnlIdr: number }[];
  signalCheck?: { checked: number; closed: number; wins: number; losses: number };
  drawdown?: DrawdownState;
  recentAlerts?: RecentAlert[];
  currentPrices?: Record<string, number>;
  timestamp?: string;
}

interface CircuitBreakerRow {
  pair: string;
  open: boolean;
  consecutiveLosses: number;
  totalSignals: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  winRateCI5: number;
  winRateCI95: number;
  ciWidth: number;
  winRateBootstrapCI5: number;
  winRateBootstrapCI95: number;
  bootstrapCIWidth: number;
  ciSampleAdequate: boolean;
  trips: number;
  cooldownSec: number;
  lastSignalAction: string | null;
  lastSignalOutcome: string | null;
}

interface RecentSignalRow {
  id: string;
  pair: string;
  action: string;
  status: string;
  entryPrice: number;
  exitPrice: number | null;
  positionSizeIdr: number;
  pnlIdr: number | null;
  pnlPct: number | null;
  holdHours: number | null;
  riskMultiplier: number;
  drawdownAtSignal: number;
  createdAt: string;
}

interface WeeklyReview {
  weekStart: string;
  portfolioStats: any;
  replayStats: any[];
  circuitBreakers: any[];
  drawdownState: any;
  deviations: any[];
  recommendations: string[];
  timestamp: string;
}

export default function TradingAssistant() {
  const [data, setData] = useState<AlphaResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [capital, setCapital] = useState(10000000);
  const [riskPct, setRiskPct] = useState(0.5);
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [breakers, setBreakers] = useState<CircuitBreakerRow[] | null>(null);
  const [recentSignals, setRecentSignals] = useState<RecentSignalRow[] | null>(null);
  const [weeklyReview, setWeeklyReview] = useState<WeeklyReview | null>(null);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [tailRisk, setTailRisk] = useState<TailRiskMetrics | null>(null);
  const [regimeTailRisk, setRegimeTailRisk] = useState<RegimeTailRiskRow[]>([]);
  const [edgeBreakers, setEdgeBreakers] = useState<EdgeBreakerRow[]>([]);
  const [corrSource, setCorrSource] = useState<"dynamic" | "static_fallback" | "unknown">("unknown");
  const [shrinkageIntensity, setShrinkageIntensity] = useState(0);

  const doFetch = useCallback(async () => {
    setLoading(true);
    try {
      const [alphaRes, portRes, cbRes, rsRes, trRes, rtrRes, ebRes, corrRes] = await Promise.all([
        fetch(`/api/signal/alpha?capital=${capital}`).then((r) => r.json()).catch(() => null),
        fetch(`/api/signal/portfolio`).then((r) => r.json()).catch(() => null),
        fetch(`/api/signal/circuit-breakers`).then((r) => r.json()).catch(() => null),
        fetch(`/api/signal/recent-signals?limit=10`).then((r) => r.json()).catch(() => null),
        fetch(`/api/signal/tail-risk`).then((r) => r.json()).catch(() => null),
        fetch(`/api/signal/regime-tail-risk`).then((r) => r.json()).catch(() => null),
        fetch(`/api/signal/edge-breakers`).then((r) => r.json()).catch(() => null),
        fetch(`/api/signal/correlation`).then((r) => r.json()).catch(() => null),
      ]);
      if (alphaRes) setData(alphaRes);
      if (portRes) setPortfolio(portRes);
      if (cbRes?.breakers) setBreakers(cbRes.breakers);
      if (rsRes?.signals) setRecentSignals(rsRes.signals);
      if (trRes && !trRes.error) setTailRisk(trRes);
      if (rtrRes?.regimes) setRegimeTailRisk(rtrRes.regimes);
      if (ebRes?.breakers) setEdgeBreakers(ebRes.breakers);
      if (corrRes?.source) setCorrSource(corrRes.source);
      if (typeof corrRes?.shrinkageIntensity === "number") setShrinkageIntensity(corrRes.shrinkageIntensity);
    } catch { /* ignore */ }
    setLoading(false);
  }, [capital]);

  useEffect(() => {
    // Defer first fetch out of the effect body (avoids synchronous setState in effect).
    const initial = setTimeout(doFetch, 0);
    const interval = setInterval(doFetch, 60000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [doFetch]);

  const runWeeklyReview = async () => {
    setWeeklyLoading(true);
    try {
      const r = await fetch(`/api/signal/weekly-review`, { method: "GET" });
      const data = await r.json();
      if (!data.error) setWeeklyReview(data);
    } catch { /* ignore */ }
    setWeeklyLoading(false);
  };

  const fmtIdr = (n: number) => "Rp " + n.toLocaleString("id-ID", { maximumFractionDigits: 0 });
  const fmtAsset = (n: number) => n < 1 ? n.toFixed(6) : n.toFixed(4);

  function computePosition(signal: Signal) {
    const riskAmount = capital * (riskPct / 100);
    const stopDistance = Math.abs(signal.entry - signal.stopLoss);
    if (stopDistance <= 0) return { assetAmount: 0, riskAmount, notional: 0, leverage: 0 };
    const assetAmount = riskAmount / stopDistance;
    const notional = assetAmount * signal.entry;
    const leverage = notional / capital;
    return { assetAmount, riskAmount, notional, leverage };
  }

  function gate(signal: Signal): { status: "BELI" | "JUAL" | "TUNGGU" | "NONAKTIF" | "WATCHLIST"; reason: string } {
    const config = PAIR_CONFIG[signal.pair];
    if (!config?.enabled) {
      // Microcap pairs (UNMD) show WATCHLIST, not NONAKTIF
      if (config?.tier === "MICROCAP") {
        return { status: "WATCHLIST", reason: config.note };
      }
      return { status: "NONAKTIF", reason: config?.note ?? "Pair dinonaktifkan" };
    }
    // Microcap liquidity gate (even if enabled, check gate)
    if (signal.microcap?.isMicrocap && !signal.microcap.gatePassed) {
      return { status: "WATCHLIST", reason: signal.microcap.reason };
    }
    if (signal.circuitBreaker?.open) {
      const mins = Math.floor((signal.circuitBreaker.cooldownSec ?? 0) / 60);
      return { status: "TUNGGU", reason: `Circuit breaker aktif (${signal.circuitBreaker.consecutiveLosses} loss beruntun). Dijeda ${mins} menit.` };
    }
    if (signal.dataStale) {
      return { status: "TUNGGU", reason: "Data market tidak update. Tunggu data fresh." };
    }
    if (signal.action === "FLAT") {
      return { status: "TUNGGU", reason: simplifyReason(signal.rationale[0]) };
    }
    if (!signal.backtest?.honest) {
      return { status: "TUNGGU", reason: "Edge belum terkonfirmasi out-of-sample. Butuh lebih banyak data." };
    }
    if (signal.backtest?.kellyCI5 <= 0) {
      return { status: "TUNGGU", reason: "Kelly CI5 ≤ 0. Ukuran posisi belum bisa dihitung dengan keyakinan." };
    }
    if (signal.impact && signal.impact.expectedValueIdr <= 0) {
      return { status: "TUNGGU", reason: "Biaya (fee + slippage) lebih besar dari expected return. Tidak menguntungkan setelah biaya." };
    }
    return {
      status: signal.action === "LONG" ? "BELI" : "JUAL",
      reason: "Semua gate lolos: funding ekstrem, mikrostruktur konfirmasi, OOS honest, EV positif.",
    };
  }

  function simplifyReason(rationale: string): string {
    if (!rationale) return "Tidak ada edge saat ini.";
    if (rationale.includes("No aligned edge")) return "Tidak ada edge saat ini. Funding tidak ekstrem, regime tidak jelas.";
    if (rationale.includes("BLOCKED")) return "Sinyal funding ada tapi momentum masih kuat. Berbahaya untuk lawan arah.";
    if (rationale.includes("FLAT is a position")) return "Tidak ada edge. Menahan adalah keputusan yang benar.";
    if (rationale.includes("PORTFOLIO HALT")) return "PORTFOLIO HALT aktif — drawdown melebihi batas. Tidak ada posisi baru.";
    if (rationale.includes("DRAWDOWN RISK SCALE")) return "Drawdown aktif — ukuran posisi dikurangi untuk proteksi modal.";
    return rationale.slice(0, 120);
  }

  const enabledPairs = data?.signals.filter((s) => PAIR_CONFIG[s.pair]?.enabled && PAIR_CONFIG[s.pair]?.tier === "MAJOR") ?? [];
  const disabledPairs = data?.signals.filter((s) => !PAIR_CONFIG[s.pair]?.enabled && PAIR_CONFIG[s.pair]?.tier === "MAJOR") ?? [];
  const watchlistPairs = data?.signals.filter((s) => PAIR_CONFIG[s.pair]?.tier === "MICROCAP") ?? [];
  const dd = portfolio?.drawdown;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#e5e5e5", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: "800px", margin: "0 auto", padding: "24px 16px 64px" }}>
        {/* HEADER */}
        <header style={{ marginBottom: "24px" }}>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>Trading Assistant</h1>
          <p style={{ fontSize: "13px", color: "#737373", margin: "4px 0 0" }}>
            Keputusan sederhana: BELI / JUAL / TUNGGU. Dilengkapi paper trading dashboard, drawdown protection, dan circuit breaker per-pair.
          </p>
        </header>

        {/* INPUT */}
        <section style={{ marginBottom: "24px", background: "#141414", border: "1px solid #262626", borderRadius: "8px", padding: "16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "11px", color: "#737373", display: "block", marginBottom: "4px" }}>Dana Trading</label>
              <input
                type="number"
                value={capital}
                onChange={(e) => setCapital(Math.max(100000, parseInt(e.target.value) || 10000000))}
                style={{ width: "100%", background: "#0a0a0a", border: "1px solid #262626", borderRadius: "4px", color: "#e5e5e5", padding: "8px", fontSize: "14px", outline: "none" }}
              />
            </div>
            <div>
              <label style={{ fontSize: "11px", color: "#737373", display: "block", marginBottom: "4px" }}>Risk per Trade</label>
              <select
                value={riskPct}
                onChange={(e) => setRiskPct(parseFloat(e.target.value))}
                style={{ width: "100%", background: "#0a0a0a", border: "1px solid #262626", borderRadius: "4px", color: "#e5e5e5", padding: "8px", fontSize: "14px", outline: "none" }}
              >
                <option value={0.25}>0.25% (aman)</option>
                <option value={0.5}>0.5% (standar)</option>
                <option value={1}>1% (agresif)</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: "11px", color: "#737373", display: "block", marginBottom: "4px" }}>Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "paper" | "live")}
                style={{ width: "100%", background: "#0a0a0a", border: "1px solid #262626", borderRadius: "4px", color: "#e5e5e5", padding: "8px", fontSize: "14px", outline: "none" }}
              >
                <option value="paper">Paper Trading (virtual)</option>
                <option value="live">Live (uang nyata)</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: "8px", fontSize: "11px", color: "#525252" }}>
            Risk per trade: {fmtIdr(capital * riskPct / 100)} · {mode === "paper" ? "Mode virtual — tidak ada uang nyata" : "⚠ Mode live — uang nyata"}
          </div>
        </section>

        {/* DRAWDOWN + RISK SCALING STRIP */}
        {dd && (
          <DrawdownStrip dd={dd} fmtIdr={fmtIdr} corrSource={corrSource} shrinkageIntensity={shrinkageIntensity} />
        )}

        {/* ENABLED PAIRS */}
        <section style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", color: "#a3a3a3" }}>
            Pair Aktif <span style={{ color: "#525252", fontSize: "12px" }}>(KANDIDAT — bukan edge terkonfirmasi)</span>
          </h2>
          <div style={{ display: "grid", gap: "16px" }}>
            {enabledPairs.map((s) => {
              const g = gate(s);
              const pos = computePosition(s);
              return (
                <PairCard
                  key={s.pair}
                  signal={s}
                  gate={g}
                  position={pos}
                  fmtIdr={fmtIdr}
                  fmtAsset={fmtAsset}
                  riskPct={riskPct}
                  mode={mode}
                />
              );
            })}
          </div>
        </section>

        {/* DISABLED PAIRS */}
        {disabledPairs.length > 0 && (
          <section style={{ marginBottom: "24px" }}>
            <h2 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", color: "#525252" }}>
              Pair Nonaktif <span style={{ fontSize: "12px" }}>(NONAKTIF SEMENTARA — ditinjau mingguan)</span>
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "8px" }}>
              {disabledPairs.map((s) => {
                const config = PAIR_CONFIG[s.pair];
                return (
                  <div key={s.pair} style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                      <span style={{ fontSize: "13px", fontWeight: 600, color: "#525252" }}>{config.name}</span>
                      <span style={{ fontSize: "9px", fontWeight: 700, color: "#f59e0b", border: "1px solid #f59e0b30", borderRadius: "3px", padding: "2px 6px" }}>NONAKTIF SEMENTARA</span>
                    </div>
                    <div style={{ fontSize: "11px", color: "#525252" }}>{config.note}</div>
                    <div style={{ fontSize: "10px", color: "#404040", marginTop: "4px" }}>{config.evidence}</div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* WATCHLIST (MICROCAP) */}
        {watchlistPairs.length > 0 && (
          <section style={{ marginBottom: "24px" }}>
            <h2 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", color: "#a3a3a3" }}>
              Pair Watchlist <span style={{ fontSize: "12px", color: "#525252" }}>(MICROCAP — likuiditas rendah, risiko tinggi)</span>
            </h2>
            <div style={{ display: "grid", gap: "12px" }}>
              {watchlistPairs.map((s) => {
                const config = PAIR_CONFIG[s.pair];
                const g = gate(s);
                const mc = s.microcap;
                return (
                  <div key={s.pair} style={{ background: "#0f0f0f", border: "1px solid #3b82f630", borderRadius: "8px", padding: "14px" }}>
                    {/* Header */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                      <div>
                        <span style={{ fontSize: "14px", fontWeight: 700 }}>{config.name}</span>
                        <span style={{ fontSize: "10px", color: "#525252", marginLeft: "6px" }}>IDR · MICROCAP</span>
                      </div>
                      <span style={{
                        fontSize: "10px", fontWeight: 700, color: mc?.status === "WATCHLIST" ? "#f59e0b" : mc?.status === "KANDIDAT_EDGE" ? "#eab308" : "#16a34a",
                        border: `1px solid ${mc?.status === "WATCHLIST" ? "#f59e0b30" : mc?.status === "KANDIDAT_EDGE" ? "#eab30830" : "#16a34a30"}`,
                        borderRadius: "3px", padding: "3px 8px",
                      }}>{mc?.status ?? "WATCHLIST"}</span>
                    </div>

                    {/* Reason */}
                    <div style={{ fontSize: "12px", color: "#a3a3a3", marginBottom: "8px" }}>{g.reason}</div>

                    {/* Microcap gate checks */}
                    {mc && mc.checks.length > 0 && (
                      <div style={{ background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: "4px", padding: "8px", marginBottom: "8px" }}>
                        <div style={{ fontSize: "10px", color: "#525252", textTransform: "uppercase", marginBottom: "6px" }}>Liquidity Gate Checks</div>
                        <div style={{ display: "grid", gap: "3px" }}>
                          {mc.checks.map((c, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                              <span style={{ color: c.passed ? "#16a34a" : "#dc2626" }}>
                                {c.passed ? "✓" : "✗"} {c.name}
                              </span>
                              <span style={{ color: "#525252", fontSize: "10px" }}>
                                {c.unit === "IDR" ? `Rp ${c.actual.toLocaleString("id-ID", { maximumFractionDigits: 0 })}` : c.actual.toFixed(c.unit === "%" ? 2 : 0)}{c.unit} / {c.unit === "IDR" ? `Rp ${c.required.toLocaleString("id-ID", { maximumFractionDigits: 0 })}` : c.required}{c.unit}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Microcap sizing rules */}
                    {mc && (
                      <div style={{ fontSize: "10px", color: "#404040", display: "flex", gap: "12px", flexWrap: "wrap" }}>
                        <span>Max risk: {(mc.maxRiskPct * 100).toFixed(1)}%</span>
                        <span>Max notional: Rp {mc.maxNotionalIdr.toLocaleString("id-ID")}</span>
                        <span>Limit order only</span>
                        {config.evidence && <span style={{ color: "#525252" }}>· {config.evidence}</span>}
                      </div>
                    )}

                    {/* Price info */}
                    {s.raw && (
                      <div style={{ marginTop: "8px", fontSize: "11px", color: "#525252" }}>
                        Harga: Rp {s.raw.price.toLocaleString("id-ID", { maximumFractionDigits: 0 })} · Funding z: {s.raw.fundingZScore.toFixed(2)} · ADX: {s.raw.adx.toFixed(0)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* PAPER TRADING DASHBOARD */}
        <PaperTradingDashboard
          portfolio={portfolio}
          breakers={breakers}
          recentSignals={recentSignals}
          weeklyReview={weeklyReview}
          weeklyLoading={weeklyLoading}
          onRunWeekly={runWeeklyReview}
          tailRisk={tailRisk}
          regimeTailRisk={regimeTailRisk}
          edgeBreakers={edgeBreakers}
          fmtIdr={fmtIdr}
        />

        {/* FOOTER */}
        {data && (
          <footer style={{ marginTop: "32px", paddingTop: "16px", borderTop: "1px solid #262626" }}>
            <div style={{ fontSize: "11px", color: "#525252", background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "10px" }}>
              {data.disclaimer}
            </div>
            <div style={{ fontSize: "11px", color: "#404040", marginTop: "8px", textAlign: "center" }}>
              Update: {data.generatedAt} · Refresh 60d ·{" "}
              <a href="/api/signal/replay" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Replay</a>
              {" · "}
              <a href="/api/signal/portfolio" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Portfolio</a>
              {" · "}
              <a href="/api/signal/drawdown" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Drawdown</a>
              {" · "}
              <a href="/api/signal/tail-risk" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Tail Risk</a>
              {" · "}
              <a href="/api/signal/regime-tail-risk" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Regime VaR</a>
              {" · "}
              <a href="/api/signal/correlation" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Correlation</a>
              {" · "}
              <a href="/api/signal/circuit-breakers" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Circuit Breakers</a>
              {" · "}
              <a href="/api/signal/edge-breakers" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Edge Breakers</a>
              {" · "}
              <a href="/api/signal/telegram-command" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Telegram Commands</a>
              {" · "}
              <a href="/api/signal/weekly-review" target="_blank" rel="noopener noreferrer" style={{ color: "#525252" }}>Weekly Review</a>
              {loading && " · updating…"}
            </div>
          </footer>
        )}

        {!data && !loading && (
          <div style={{ textAlign: "center", padding: "40px", color: "#525252" }}>
            <button onClick={() => { doFetch(); }} style={{ padding: "12px 24px", background: "#171717", border: "1px solid #262626", borderRadius: "8px", color: "#e5e5e5", cursor: "pointer" }}>
              Mulai
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── DRAWDOWN STRIP ──
// Visual meter + dynamic risk multiplier + recovery ramp + weekly/daily loss pause.
function DrawdownStrip({ dd, fmtIdr, corrSource, shrinkageIntensity }: { dd: DrawdownState; fmtIdr: (n: number) => string; corrSource: "dynamic" | "static_fallback" | "unknown"; shrinkageIntensity: number }) {
  // Meter: 0% → -15% mapped to 100% → 0% width of "safe" bar
  const meterPct = Math.max(0, Math.min(100, (Math.abs(dd.currentDrawdownPct) / 15) * 100));
  const tierColor = dd.isHalted ? "#dc2626" : dd.riskMultiplier < 0.5 ? "#f59e0b" : dd.riskMultiplier < 1.0 ? "#eab308" : "#16a34a";
  const tierLabelMap: Record<string, string> = {
    in_profit: "Profit (full size)",
    neutral: "Neutral (full size)",
    cautious: "Cautious (75% size)",
    half_size: "Half size",
    quarter_size: "Quarter size",
    halted: "HALTED",
  };

  // Recovery ramp progress (0-100%)
  const rampProgressPct = dd.rampStage === 0 ? 0 : Math.min(100, (dd.rampAgeHours / 168) * 100);
  const rampStageLabels: Record<number, string> = {
    0: "none",
    1: "probe (0.25x)",
    2: "cautious (0.50x)",
    3: "steady (0.75x)",
    4: "full (1.00x)",
  };

  return (
    <section style={{ marginBottom: "24px", background: "#141414", border: `1px solid ${tierColor}40`, borderRadius: "8px", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "11px", color: "#737373", textTransform: "uppercase" }}>Drawdown Protection</div>
          <div style={{ fontSize: "22px", fontWeight: 700, color: tierColor, marginTop: "2px" }}>
            {dd.currentDrawdownPct.toFixed(2)}%
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "11px", color: "#737373", textTransform: "uppercase" }}>Risk Multiplier</div>
          <div style={{ fontSize: "22px", fontWeight: 700, color: tierColor, marginTop: "2px" }}>
            {dd.riskMultiplier.toFixed(2)}x
          </div>
        </div>
      </div>

      {/* Meter bar */}
      <div style={{ position: "relative", height: "8px", background: "#0a0a0a", borderRadius: "4px", overflow: "hidden", marginBottom: "8px" }}>
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0,
          width: `${meterPct}%`,
          background: `linear-gradient(90deg, #16a34a 0%, #eab308 50%, #dc2626 100%)`,
          transition: "width 0.3s ease",
        }} />
        {/* Threshold markers */}
        <div style={{ position: "absolute", left: "20%", top: 0, bottom: 0, width: "1px", background: "#eab308" }} title="-3%" />
        <div style={{ position: "absolute", left: "33.3%", top: 0, bottom: 0, width: "1px", background: "#f59e0b" }} title="-5%" />
        <div style={{ position: "absolute", left: "53.3%", top: 0, bottom: 0, width: "1px", background: "#dc2626" }} title="-8%" />
        <div style={{ position: "absolute", left: "66.6%", top: 0, bottom: 0, width: "1px", background: "#dc2626" }} title="-10%" />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#525252" }}>
        <span>0%</span><span>-3%</span><span>-5%</span><span>-8%</span><span>-10%</span><span>-15%</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "8px", marginTop: "12px" }}>
        <div>
          <div style={{ fontSize: "10px", color: "#404040" }}>Tier</div>
          <div style={{ fontSize: "13px", fontWeight: 600, color: tierColor }}>{tierLabelMap[dd.riskTierLabel] ?? dd.riskTierLabel}</div>
        </div>
        <div>
          <div style={{ fontSize: "10px", color: "#404040" }}>Cumulative P&L</div>
          <div style={{ fontSize: "13px", fontWeight: 600, color: dd.cumulativePnlIdr >= 0 ? "#16a34a" : "#dc2626" }}>{fmtIdr(dd.cumulativePnlIdr)}</div>
        </div>
        <div>
          <div style={{ fontSize: "10px", color: "#404040" }}>Peak P&L</div>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "#16a34a" }}>{fmtIdr(dd.peakPnlIdr)}</div>
        </div>
        <div>
          <div style={{ fontSize: "10px", color: "#404040" }}>Trough P&L</div>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "#dc2626" }}>{fmtIdr(dd.troughPnlIdr)}</div>
        </div>
      </div>

      {/* Weekly loss pause banner */}
      <div style={{ marginTop: "12px", padding: "8px 12px", background: dd.weeklyLossPauseActive ? "#dc262615" : "#0a0a0a", border: `1px solid ${dd.weeklyLossPauseActive ? "#dc262640" : "#1a1a1a"}`, borderRadius: "6px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: "10px", color: "#404040", textTransform: "uppercase" }}>Weekly Loss (7-day rolling)</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: dd.weeklyLossPct < -3 ? "#dc2626" : dd.weeklyLossPct < 0 ? "#f59e0b" : "#16a34a" }}>
              {dd.weeklyLossPct.toFixed(2)}% {dd.weeklyLossPauseActive && "· PAUSED"}
            </div>
          </div>
          {dd.weeklyLossPauseActive && dd.weeklyPauseExpiresAt && (
            <div style={{ fontSize: "10px", color: "#dc2626" }}>
              resumes in {Math.max(0, Math.floor((dd.weeklyPauseExpiresAt - Date.now() / 1000) / 3600))}h
            </div>
          )}
        </div>
        {!dd.weeklyLossPauseActive && (
          <div style={{ fontSize: "10px", color: "#404040", marginTop: "4px" }}>
            Pause triggers at -3% weekly loss. Auto-recovers Monday 00:00 WIB.
          </div>
        )}
      </div>

      {/* Daily loss pause banner (tighter than weekly) */}
      <div style={{ marginTop: "8px", padding: "8px 12px", background: dd.dailyLossPauseActive ? "#dc262615" : "#0a0a0a", border: `1px solid ${dd.dailyLossPauseActive ? "#dc262640" : "#1a1a1a"}`, borderRadius: "6px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: "10px", color: "#404040", textTransform: "uppercase" }}>Daily Loss (24h rolling)</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: dd.dailyLossPct < -1.5 ? "#dc2626" : dd.dailyLossPct < 0 ? "#f59e0b" : "#16a34a" }}>
              {dd.dailyLossPct.toFixed(2)}% {dd.dailyLossPauseActive && "· PAUSED"}
            </div>
          </div>
          {dd.dailyLossPauseActive && dd.dailyPauseExpiresAt && (
            <div style={{ fontSize: "10px", color: "#dc2626" }}>
              resumes in {Math.max(0, Math.floor((dd.dailyPauseExpiresAt - Date.now() / 1000) / 3600))}h
            </div>
          )}
        </div>
        {!dd.dailyLossPauseActive && (
          <div style={{ fontSize: "10px", color: "#404040", marginTop: "4px" }}>
            Pause triggers at -1.5% daily loss. Auto-recovers midnight WIB. Prevents intra-day tilt.
          </div>
        )}
      </div>

      {/* Recovery ramp banner (only shown if ramp is active) */}
      {dd.rampStage > 0 && (
        <div style={{ marginTop: "8px", padding: "10px 12px", background: "#3b82f610", border: "1px solid #3b82f640", borderRadius: "6px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <div style={{ fontSize: "11px", color: "#3b82f6", fontWeight: 700 }}>RECOVERY RAMP ACTIVE</div>
            <div style={{ fontSize: "11px", color: "#737373" }}>Stage {dd.rampStage}: {rampStageLabels[dd.rampStage]}</div>
          </div>
          {/* Ramp progress bar (0-168h) */}
          <div style={{ position: "relative", height: "4px", background: "#0a0a0a", borderRadius: "2px", overflow: "hidden", marginBottom: "4px" }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${rampProgressPct}%`, background: "#3b82f6", transition: "width 0.3s ease" }} />
            {/* Stage markers */}
            <div style={{ position: "absolute", left: "14.3%", top: 0, bottom: 0, width: "1px", background: "#1a1a1a" }} title="24h" />
            <div style={{ position: "absolute", left: "42.9%", top: 0, bottom: 0, width: "1px", background: "#1a1a1a" }} title="72h" />
            <div style={{ position: "absolute", left: "100%", top: 0, bottom: 0, width: "1px", background: "#1a1a1a" }} title="168h" />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9px", color: "#525252" }}>
            <span>0h</span><span>24h</span><span>72h</span><span>168h (full)</span>
          </div>
          <div style={{ fontSize: "10px", color: "#737373", marginTop: "4px" }}>
            Cap: {dd.rampMultiplierCap.toFixed(2)}x · Age: {dd.rampAgeHours.toFixed(1)}h · Anti-V-shape resume
          </div>
        </div>
      )}

      {/* Halt banner */}
      {dd.isHalted && (
        <div style={{ marginTop: "8px", padding: "8px 12px", background: "#dc262615", border: "1px solid #dc262640", borderRadius: "6px", fontSize: "12px", color: "#dc2626" }}>
          ⛑ PORTFOLIO HALT ({dd.haltReason}): {dd.haltReason === "weekly_loss_pause" ? "weekly loss > -3%" : "drawdown > -10%"}. Tidak ada posisi baru sampai recovery ramp selesai.
        </div>
      )}
      {!dd.isHalted && dd.riskMultiplier < 1.0 && (
        <div style={{ marginTop: "8px", padding: "8px 12px", background: "#f59e0b15", border: "1px solid #f59e0b40", borderRadius: "6px", fontSize: "12px", color: "#f59e0b" }}>
          ⚠ Risk scaling: multiplier {(dd.riskMultiplier * 100).toFixed(0)}% (drawdown tier {dd.drawdownMultiplier.toFixed(2)}x{dd.rampStage > 0 && `, ramp cap ${dd.rampMultiplierCap.toFixed(2)}x`}). Anti-martingale.
        </div>
      )}

      {/* Dynamic correlation matrix source indicator + shrinkage intensity */}
      <div style={{ marginTop: "8px", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "10px", color: "#404040" }}>Correlation matrix:</span>
        <span style={{
          fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "3px",
          color: corrSource === "dynamic" ? "#16a34a" : corrSource === "static_fallback" ? "#f59e0b" : "#525252",
          border: `1px solid ${corrSource === "dynamic" ? "#16a34a30" : corrSource === "static_fallback" ? "#f59e0b30" : "#262626"}`,
        }}>
          {corrSource === "dynamic" ? "DYNAMIC (30d)" : corrSource === "static_fallback" ? "STATIC FALLBACK" : "—"}
        </span>
        {corrSource === "dynamic" && shrinkageIntensity > 0 && (
          <span style={{
            fontSize: "10px", fontWeight: 600, padding: "2px 6px", borderRadius: "3px",
            color: "#3b82f6", border: "1px solid #3b82f630", background: "#3b82f610",
          }} title="Ledoit-Wolf shrinkage toward identity matrix (reduces noise when sample is small)">
            shrinkage δ*={shrinkageIntensity.toFixed(2)}
          </span>
        )}
      </div>
    </section>
  );
}

// ── TAIL RISK PANEL ──
// VaR 95/99 + ES 95/99 + worst trade + bootstrap CI.
function TailRiskPanel({ tr, fmtIdr }: { tr: TailRiskMetrics; fmtIdr: (n: number) => string }) {
  const fmtLoss = (pct: number) => `${Math.abs(pct * 100).toFixed(2)}%`;
  return (
    <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <div style={{ fontSize: "11px", color: "#525252", textTransform: "uppercase" }}>Tail Risk (VaR / ES)</div>
        {!tr.ciAdequate && (
          <span style={{ fontSize: "9px", color: "#f59e0b", border: "1px solid #f59e0b30", borderRadius: "3px", padding: "1px 4px" }}>
            low confidence (n={tr.sampleSize})
          </span>
        )}
      </div>
      {tr.sampleSize === 0 ? (
        <div style={{ fontSize: "11px", color: "#525252" }}>
          Belum ada closed trades. VaR/ES akan terhitung setelah ≥30 sinyal closed.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "8px" }}>
          <div>
            <div style={{ fontSize: "10px", color: "#404040" }}>VaR 95%</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#dc2626" }}>{fmtLoss(tr.var95Pct)}</div>
            <div style={{ fontSize: "10px", color: "#525252" }}>{fmtIdr(tr.var95Idr)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#404040" }}>ES 95%</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#dc2626" }}>{fmtLoss(tr.es95Pct)}</div>
            <div style={{ fontSize: "10px", color: "#525252" }}>{fmtIdr(tr.es95Idr)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#404040" }}>VaR 99%</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#dc2626" }}>{fmtLoss(tr.var99Pct)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#404040" }}>ES 99%</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#dc2626" }}>{fmtLoss(tr.es99Pct)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#404040" }}>Worst Trade</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#dc2626" }}>{fmtLoss(tr.worstTradePct)}</div>
            <div style={{ fontSize: "10px", color: "#525252" }}>{fmtIdr(tr.worstTradeIdr)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#404040" }}>Portfolio VaR 95</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "#f59e0b" }}>{fmtIdr(tr.portfolioVar95Idr)}</div>
            <div style={{ fontSize: "10px", color: "#525252" }}>3 concurrent max</div>
          </div>
        </div>
      )}
      {tr.sampleSize > 0 && (
        <div style={{ marginTop: "8px", fontSize: "10px", color: "#404040" }}>
          Sample: n={tr.sampleSize} (tail={tr.tailSampleSize}) · Bootstrap CI (1000 resamples):
          <div style={{ marginTop: "2px", paddingLeft: "8px", color: "#525252" }}>
            VaR 95: [{fmtLoss(tr.var95BootstrapCI5)}, {fmtLoss(tr.var95BootstrapCI95)}] ·
            ES 95: [{fmtLoss(tr.es95BootstrapCI5)}, {fmtLoss(tr.es95BootstrapCI95)}]
          </div>
          <div style={{ paddingLeft: "8px", color: "#525252" }}>
            VaR 99: [{fmtLoss(tr.var99BootstrapCI5)}, {fmtLoss(tr.var99BootstrapCI95)}] ·
            ES 99: [{fmtLoss(tr.es99BootstrapCI5)}, {fmtLoss(tr.es99BootstrapCI95)}]
          </div>
        </div>
      )}
    </div>
  );
}

// ── PAPER TRADING DASHBOARD ──
function PaperTradingDashboard({
  portfolio, breakers, recentSignals, weeklyReview, weeklyLoading, onRunWeekly, tailRisk, regimeTailRisk, edgeBreakers, fmtIdr,
}: {
  portfolio: PortfolioData | null;
  breakers: CircuitBreakerRow[] | null;
  recentSignals: RecentSignalRow[] | null;
  weeklyReview: WeeklyReview | null;
  weeklyLoading: boolean;
  onRunWeekly: () => void;
  tailRisk: TailRiskMetrics | null;
  regimeTailRisk: RegimeTailRiskRow[];
  edgeBreakers: EdgeBreakerRow[];
  fmtIdr: (n: number) => string;
}) {
  if (!portfolio) return null;

  return (
    <section style={{ marginBottom: "24px" }}>
      <h2 style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", color: "#a3a3a3" }}>
        Paper Trading Dashboard <span style={{ fontSize: "12px", color: "#525252" }}>(auto-journal setiap jam)</span>
      </h2>

      {/* Portfolio stats grid */}
      <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "8px" }}>
          <Stat label="Total Sinyal" value={portfolio.totalSignals ?? 0} />
          <Stat label="Open" value={portfolio.openSignals ?? 0} color="#eab308" />
          <Stat label="Closed" value={portfolio.closedSignals ?? 0} />
          <Stat label="Win Rate" value={`${((portfolio.winRate ?? 0) * 100).toFixed(0)}%`} color={(portfolio.winRate ?? 0) > 0.5 ? "#16a34a" : (portfolio.closedSignals ?? 0) > 0 ? "#dc2626" : "#737373"} />
          <Stat label="Net P&L" value={fmtIdr(portfolio.totalPnlIdr ?? 0)} color={(portfolio.totalPnlIdr ?? 0) >= 0 ? "#16a34a" : "#dc2626"} />
          <Stat label="Avg P&L" value={`${((portfolio.avgPnlPct ?? 0) * 100).toFixed(2)}%`} color={(portfolio.avgPnlPct ?? 0) >= 0 ? "#16a34a" : "#dc2626"} />
          <Stat label="Sharpe" value={(portfolio.sharpeRatio ?? 0).toFixed(1)} />
          <Stat label="Best" value={`${((portfolio.bestTrade ?? 0) * 100).toFixed(2)}%`} color="#16a34a" />
          <Stat label="Worst" value={`${((portfolio.worstTrade ?? 0) * 100).toFixed(2)}%`} color="#dc2626" />
        </div>
        {portfolio.signalCheck && (portfolio.signalCheck.checked > 0 || portfolio.signalCheck.closed > 0) && (
          <div style={{ marginTop: "8px", fontSize: "11px", color: "#525252" }}>
            Last check: {portfolio.signalCheck.checked} open signals checked · {portfolio.signalCheck.closed} closed ({portfolio.signalCheck.wins}W / {portfolio.signalCheck.losses}L)
          </div>
        )}
      </div>

      {/* Tail risk panel (VaR / ES) */}
      {tailRisk && (
        <TailRiskPanel tr={tailRisk} fmtIdr={fmtIdr} />
      )}

      {/* Regime-conditioned tail risk (only if we have data) */}
      {regimeTailRisk.length > 0 && (
        <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: "#525252", textTransform: "uppercase", marginBottom: "8px" }}>Regime-Conditioned VaR/ES + Bootstrap CI</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #262626" }}>
                  <th style={{ textAlign: "left", padding: "4px", color: "#525252", fontSize: "10px" }}>Regime</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>n</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>VaR 95 [CI]</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>ES 95 [CI]</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>VaR 99</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>ES 99</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>Worst</th>
                </tr>
              </thead>
              <tbody>
                {regimeTailRisk.map((r) => (
                  <tr key={r.regime} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td style={{ padding: "4px", fontWeight: 600 }}>{r.regime}{!r.ciAdequate && r.sampleSize > 0 && <span style={{ color: "#f59e0b" }}>*</span>}</td>
                    <td style={{ padding: "4px", textAlign: "right", color: r.ciAdequate ? "#e5e5e5" : "#f59e0b" }}>{r.sampleSize}</td>
                    <td style={{ padding: "4px", textAlign: "right", color: "#dc2626" }}>
                      {(Math.abs(r.var95Pct) * 100).toFixed(2)}%
                      <span style={{ color: "#525252", fontSize: "9px" }}> [{(Math.abs(r.var95BootstrapCI5) * 100).toFixed(1)}, {(Math.abs(r.var95BootstrapCI95) * 100).toFixed(1)}]</span>
                    </td>
                    <td style={{ padding: "4px", textAlign: "right", color: "#dc2626" }}>
                      {(Math.abs(r.es95Pct) * 100).toFixed(2)}%
                      <span style={{ color: "#525252", fontSize: "9px" }}> [{(Math.abs(r.es95BootstrapCI5) * 100).toFixed(1)}, {(Math.abs(r.es95BootstrapCI95) * 100).toFixed(1)}]</span>
                    </td>
                    <td style={{ padding: "4px", textAlign: "right", color: "#dc2626" }}>{(Math.abs(r.var99Pct) * 100).toFixed(2)}%</td>
                    <td style={{ padding: "4px", textAlign: "right", color: "#dc2626" }}>{(Math.abs(r.es99Pct) * 100).toFixed(2)}%</td>
                    <td style={{ padding: "4px", textAlign: "right", color: "#dc2626" }}>{(Math.abs(r.worstTradePct) * 100).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: "6px", fontSize: "10px", color: "#404040" }}>
            * n &lt; 20 — regime VaR estimate uncertain. CI = 500-resample bootstrap per regime. Wide CI = high uncertainty in tail estimate.
          </div>
        </div>
      )}

      {/* Per-edge circuit breakers (finer granularity than per-pair) */}
      {edgeBreakers.length > 0 && (
        <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: "#525252", textTransform: "uppercase", marginBottom: "8px" }}>Per-Edge Circuit Breakers (pair × edgeSource)</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #262626" }}>
                  <th style={{ textAlign: "left", padding: "4px", color: "#525252", fontSize: "10px" }}>Pair</th>
                  <th style={{ textAlign: "left", padding: "4px", color: "#525252", fontSize: "10px" }}>Edge</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>Status</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>n</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>Win%</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>Wilson CI</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>Boot CI</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>Trips</th>
                </tr>
              </thead>
              <tbody>
                {edgeBreakers.map((b) => (
                  <tr key={`${b.pair}-${b.edgeSource}`} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td style={{ padding: "4px", fontWeight: 600 }}>{b.pair.toUpperCase()}</td>
                    <td style={{ padding: "4px", color: "#a3a3a3" }}>{b.edgeSource}</td>
                    <td style={{ padding: "4px", textAlign: "right" }}>
                      {b.open ? (
                        <span style={{ color: "#dc2626", fontSize: "10px", fontWeight: 700 }}>OPEN {Math.floor(b.cooldownSec / 60)}m</span>
                      ) : (
                        <span style={{ color: "#16a34a", fontSize: "10px" }}>closed</span>
                      )}
                    </td>
                    <td style={{ padding: "4px", textAlign: "right" }}>{b.totalSignals}</td>
                    <td style={{ padding: "4px", textAlign: "right", color: b.winRate >= 0.5 ? "#16a34a" : "#dc2626" }}>{(b.winRate * 100).toFixed(0)}%</td>
                    <td style={{ padding: "4px", textAlign: "right", color: "#737373", fontSize: "10px" }}>[{(b.winRateCI5 * 100).toFixed(0)}, {(b.winRateCI95 * 100).toFixed(0)}]</td>
                    <td style={{ padding: "4px", textAlign: "right", color: "#525252", fontSize: "10px" }}>[{(b.winRateBootstrapCI5 * 100).toFixed(0)}, {(b.winRateBootstrapCI95 * 100).toFixed(0)}]</td>
                    <td style={{ padding: "4px", textAlign: "right", color: b.trips > 0 ? "#dc2626" : "#525252" }}>{b.trips}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: "6px", fontSize: "10px", color: "#404040" }}>
            Per-edge CB catches edge-specific degradation (e.g., BTC funding_contrarian fails while trend_follow still profitable).
          </div>
        </div>
      )}

      {/* Circuit breaker table */}
      {breakers && breakers.length > 0 && (
        <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: "#525252", textTransform: "uppercase", marginBottom: "8px" }}>Circuit Breaker (per-pair, Wilson + Bootstrap 95% CI)</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #262626" }}>
                  <th style={{ textAlign: "left", padding: "6px 4px", color: "#525252", fontSize: "10px", textTransform: "uppercase" }}>Pair</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", color: "#525252", fontSize: "10px" }}>Status</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", color: "#525252", fontSize: "10px" }}>n</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", color: "#525252", fontSize: "10px" }}>Win%</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", color: "#525252", fontSize: "10px" }}>Wilson [5, 95]</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", color: "#525252", fontSize: "10px" }}>Boot [5, 95]</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", color: "#525252", fontSize: "10px" }}>Losses</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", color: "#525252", fontSize: "10px" }}>Trips</th>
                </tr>
              </thead>
              <tbody>
                {breakers.map((b) => (
                  <tr key={b.pair} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td style={{ padding: "6px 4px", fontWeight: 600 }}>{b.pair.toUpperCase()}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>
                      {b.open ? (
                        <span style={{ color: "#dc2626", fontSize: "10px", fontWeight: 700 }}>OPEN {Math.floor(b.cooldownSec / 60)}m</span>
                      ) : (
                        <span style={{ color: "#16a34a", fontSize: "10px" }}>closed</span>
                      )}
                    </td>
                    <td style={{ padding: "6px 4px", textAlign: "right", color: b.ciSampleAdequate ? "#e5e5e5" : "#f59e0b" }}>{b.totalSignals}{!b.ciSampleAdequate && b.totalSignals > 0 && "*"}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right", color: b.winRate >= 0.5 ? "#16a34a" : b.totalSignals > 0 ? "#dc2626" : "#525252" }}>
                      {b.totalSignals > 0 ? `${(b.winRate * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td style={{ padding: "6px 4px", textAlign: "right", color: "#737373", fontSize: "11px" }}>
                      {b.totalSignals > 0 ? `[${(b.winRateCI5 * 100).toFixed(0)}, ${(b.winRateCI95 * 100).toFixed(0)}]` : "—"}
                    </td>
                    <td style={{ padding: "6px 4px", textAlign: "right", color: "#525252", fontSize: "11px" }}>
                      {b.totalSignals >= 5 ? `[${(b.winRateBootstrapCI5 * 100).toFixed(0)}, ${(b.winRateBootstrapCI95 * 100).toFixed(0)}]` : "—"}
                    </td>
                    <td style={{ padding: "6px 4px", textAlign: "right", color: b.consecutiveLosses > 0 ? "#f59e0b" : "#525252" }}>{b.consecutiveLosses}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right", color: b.trips > 0 ? "#dc2626" : "#525252" }}>{b.trips}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: "6px", fontSize: "10px", color: "#404040" }}>
            * n &lt; 20 — CI width &gt; 0.4, win rate belum statistik signifikan. Boot = 1000-resample bootstrap (non-parametric).
          </div>
        </div>
      )}

      {/* Recent signals */}
      {recentSignals && recentSignals.length > 0 && (
        <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: "#525252", textTransform: "uppercase", marginBottom: "8px" }}>Recent Signals (last 10)</div>
          <div style={{ maxHeight: "280px", overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
              <thead style={{ position: "sticky", top: 0, background: "#0f0f0f" }}>
                <tr style={{ borderBottom: "1px solid #262626" }}>
                  <th style={{ textAlign: "left", padding: "4px", color: "#525252", fontSize: "10px" }}>Pair</th>
                  <th style={{ textAlign: "left", padding: "4px", color: "#525252", fontSize: "10px" }}>Action</th>
                  <th style={{ textAlign: "left", padding: "4px", color: "#525252", fontSize: "10px" }}>Status</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>Size</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>PnL</th>
                  <th style={{ textAlign: "right", padding: "4px", color: "#525252", fontSize: "10px" }}>Risk×</th>
                  <th style={{ textAlign: "left", padding: "4px", color: "#525252", fontSize: "10px" }}>When</th>
                </tr>
              </thead>
              <tbody>
                {recentSignals.map((s) => (
                  <tr key={s.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td style={{ padding: "4px", fontWeight: 600 }}>{s.pair.toUpperCase()}</td>
                    <td style={{ padding: "4px", color: s.action === "LONG" ? "#16a34a" : "#dc2626" }}>{s.action}</td>
                    <td style={{ padding: "4px" }}>
                      <span style={{
                        fontSize: "9px", fontWeight: 700,
                        color: s.status === "open" ? "#eab308" : s.status === "target_hit" ? "#16a34a" : s.status === "stopped_out" ? "#dc2626" : "#525252",
                      }}>{s.status}</span>
                    </td>
                    <td style={{ padding: "4px", textAlign: "right" }}>{fmtIdr(s.positionSizeIdr)}</td>
                    <td style={{ padding: "4px", textAlign: "right", color: (s.pnlIdr ?? 0) > 0 ? "#16a34a" : (s.pnlIdr ?? 0) < 0 ? "#dc2626" : "#525252" }}>
                      {s.pnlIdr !== null ? `${s.pnlIdr >= 0 ? "+" : ""}${fmtIdr(s.pnlIdr)}` : "—"}
                    </td>
                    <td style={{ padding: "4px", textAlign: "right", color: s.riskMultiplier < 1 ? "#f59e0b" : "#525252" }}>{s.riskMultiplier.toFixed(2)}</td>
                    <td style={{ padding: "4px", color: "#525252", fontSize: "10px" }}>{timeAgo(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Alert feed */}
      {portfolio.recentAlerts && portfolio.recentAlerts.length > 0 && (
        <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: "#525252", textTransform: "uppercase", marginBottom: "8px" }}>Alert Feed (recent)</div>
          <div style={{ maxHeight: "240px", overflowY: "auto", display: "grid", gap: "6px" }}>
            {portfolio.recentAlerts.map((a) => {
              const sevColor = a.severity === "critical" ? "#dc2626" : a.severity === "error" ? "#ef4444" : a.severity === "warn" ? "#f59e0b" : "#3b82f6";
              return (
                <div key={a.id} style={{ padding: "6px 8px", background: "#0a0a0a", borderLeft: `2px solid ${sevColor}`, borderRadius: "3px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
                    <span style={{ fontSize: "10px", fontWeight: 700, color: sevColor, textTransform: "uppercase" }}>
                      {a.type.replace(/_/g, " ")} {a.pair && `· ${a.pair.toUpperCase()}`}
                    </span>
                    <span style={{ fontSize: "9px", color: "#525252" }}>{timeAgo(a.createdAt)}</span>
                  </div>
                  <div style={{ fontSize: "11px", color: "#a3a3a3", lineHeight: 1.4, whiteSpace: "pre-wrap" }}>{a.message.split("\n\n")[0].slice(0, 200)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Weekly review */}
      <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <div style={{ fontSize: "11px", color: "#525252", textTransform: "uppercase" }}>Weekly Auto-Review</div>
          <button
            onClick={onRunWeekly}
            disabled={weeklyLoading}
            style={{
              padding: "4px 10px", fontSize: "11px",
              background: weeklyLoading ? "#1a1a1a" : "#171717",
              border: "1px solid #262626", borderRadius: "4px",
              color: weeklyLoading ? "#525252" : "#a3a3a3",
              cursor: weeklyLoading ? "wait" : "pointer",
            }}
          >
            {weeklyLoading ? "Running…" : "Run Review"}
          </button>
        </div>
        {weeklyReview ? (
          <div>
            <div style={{ fontSize: "10px", color: "#404040", marginBottom: "6px" }}>
              Week of {weeklyReview.weekStart} · {weeklyReview.recommendations.length} recommendations
              {weeklyReview.deviations.length > 0 && ` · ${weeklyReview.deviations.length} deviations detected`}
            </div>
            <ul style={{ margin: 0, paddingLeft: "16px", fontSize: "12px", color: "#a3a3a3", lineHeight: 1.7 }}>
              {weeklyReview.recommendations.map((r, i) => (
                <li key={i} style={{ marginBottom: "4px" }}>{r}</li>
              ))}
            </ul>
            {weeklyReview.deviations.length > 0 && (
              <div style={{ marginTop: "8px", padding: "8px", background: "#f59e0b10", border: "1px solid #f59e0b30", borderRadius: "4px" }}>
                <div style={{ fontSize: "10px", color: "#f59e0b", fontWeight: 700, marginBottom: "4px" }}>PAPER vs REPLAY DEVIATIONS</div>
                {weeklyReview.deviations.map((d, i) => (
                  <div key={i} style={{ fontSize: "11px", color: "#a3a3a3" }}>
                    {d.pair.toUpperCase()}: replay {(d.replayWinRate * 100).toFixed(0)}% win vs paper {(d.paperWinRate * 100).toFixed(0)}% win (deviation {d.deviationPct.toFixed(1)}%)
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: "11px", color: "#525252" }}>
            Klik "Run Review" untuk generate rekomendasi otomatis (paper vs replay, circuit breaker status, drawdown state).
            Auto-jalan setiap Senin 9am Jakarta via cron.
          </div>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: "10px", color: "#404040" }}>{label}</div>
      <div style={{ fontSize: "16px", fontWeight: 600, color: color ?? "#e5e5e5" }}>{value}</div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function PairCard({
  signal, gate, position, fmtIdr, fmtAsset, riskPct, mode,
}: {
  signal: Signal;
  gate: { status: "BELI" | "JUAL" | "TUNGGU" | "NONAKTIF"; reason: string };
  position: { assetAmount: number; riskAmount: number; notional: number; leverage: number };
  fmtIdr: (n: number) => string;
  fmtAsset: (n: number) => string;
  riskPct: number;
  mode: "paper" | "live";
}) {
  const config = PAIR_CONFIG[signal.pair];
  const isAction = gate.status === "BELI" || gate.status === "JUAL";
  const statusColor = gate.status === "BELI" ? "#16a34a" : gate.status === "JUAL" ? "#dc2626" : gate.status === "TUNGGU" ? "#f59e0b" : "#525252";
  const statusBg = gate.status === "BELI" ? "#16a34a15" : gate.status === "JUAL" ? "#dc262615" : gate.status === "TUNGGU" ? "#f59e0b15" : "#52525210";

  return (
    <div style={{ background: "#141414", border: `2px solid ${statusColor}40`, borderRadius: "8px", overflow: "hidden" }}>
      {/* HEADER */}
      <div style={{ padding: "16px", borderBottom: `1px solid ${statusColor}30`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <span style={{ fontSize: "18px", fontWeight: 700 }}>{config.name}</span>
          <span style={{ fontSize: "12px", color: "#525252", marginLeft: "8px" }}>IDR</span>
          <div style={{ marginTop: "4px" }}>
            <span style={{
              fontSize: "9px", fontWeight: 700,
              color: config.label === "KANDIDAT EDGE" ? "#16a34a" : config.label === "MARGINAL" ? "#f59e0b" : "#525252",
              border: `1px solid ${config.label === "KANDIDAT EDGE" ? "#16a34a30" : config.label === "MARGINAL" ? "#f59e0b30" : "#262626"}`,
              borderRadius: "3px", padding: "2px 6px",
            }}>{config.label}</span>
            <span style={{ fontSize: "10px", color: "#404040", marginLeft: "6px" }}>{config.evidence}</span>
          </div>
        </div>
        <div style={{
          fontSize: "20px", fontWeight: 800, color: statusColor,
          padding: "4px 16px", background: statusBg, borderRadius: "6px",
          letterSpacing: "1px",
        }}>
          {gate.status}
        </div>
      </div>

      {/* TUNGGU / NONAKTIF — simple reason */}
      {!isAction && (
        <div style={{ padding: "16px" }}>
          <p style={{ fontSize: "14px", color: "#a3a3a3", margin: 0 }}>{gate.reason}</p>
          <div style={{ marginTop: "12px", fontSize: "12px", color: "#525252" }}>
            <span>Harga: {fmtIdr(signal.raw.price)}</span>
            {" · "}
            <span>Funding z: {signal.raw.fundingZScore.toFixed(2)}</span>
            {" · "}
            <span>ADX: {signal.raw.adx.toFixed(0)}</span>
            {" · "}
            <span>RSI: {signal.raw.rsi.toFixed(0)}</span>
          </div>
          {signal.circuitBreaker?.consecutiveLosses > 0 && (
            <div style={{ marginTop: "8px", fontSize: "12px", color: "#f59e0b" }}>
              Circuit breaker: {signal.circuitBreaker.consecutiveLosses} loss beruntun · {signal.circuitBreaker.trips}x trip
              {signal.circuitBreaker.totalSignals > 0 && (
                <span style={{ color: "#525252" }}> · win {(signal.circuitBreaker.winRate * 100).toFixed(0)}% [CI5 {(signal.circuitBreaker.winRateCI5 * 100).toFixed(0)}, CI95 {(signal.circuitBreaker.winRateCI95 * 100).toFixed(0)}] (n={signal.circuitBreaker.totalSignals}{!signal.circuitBreaker.ciSampleAdequate && "*"})</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* BELI / JUAL — full action card */}
      {isAction && (
        <div style={{ padding: "16px" }}>
          {/* Price levels */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginBottom: "16px" }}>
            <div>
              <div style={{ fontSize: "11px", color: "#525252" }}>Harga Masuk</div>
              <div style={{ fontSize: "16px", fontWeight: 600 }}>{fmtIdr(signal.entry)}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "#525252" }}>Stop Loss</div>
              <div style={{ fontSize: "16px", fontWeight: 600, color: "#dc2626" }}>{fmtIdr(signal.stopLoss)}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "#525252" }}>Target 1 (jual 50%)</div>
              <div style={{ fontSize: "16px", fontWeight: 600, color: "#16a34a" }}>{fmtIdr(signal.takeProfit1)}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "#525252" }}>Target 2 (jual sisa)</div>
              <div style={{ fontSize: "16px", fontWeight: 600, color: "#16a34a" }}>{fmtIdr(signal.takeProfit2)}</div>
            </div>
          </div>

          {/* Position sizing */}
          <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px", marginBottom: "16px" }}>
            <div style={{ fontSize: "11px", color: "#525252", marginBottom: "8px" }}>Ukuran Posisi (risk {riskPct}%)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px" }}>
              <div>
                <span style={{ fontSize: "11px", color: "#525252" }}>Beli: </span>
                <span style={{ fontSize: "14px", fontWeight: 600 }}>{fmtAsset(position.assetAmount)} {signal.pair.replace("_idr", "").toUpperCase()}</span>
              </div>
              <div>
                <span style={{ fontSize: "11px", color: "#525252" }}>Risiko: </span>
                <span style={{ fontSize: "14px", fontWeight: 600, color: "#dc2626" }}>{fmtIdr(position.riskAmount)}</span>
              </div>
              <div>
                <span style={{ fontSize: "11px", color: "#525252" }}>Notional: </span>
                <span style={{ fontSize: "14px", fontWeight: 600 }}>{fmtIdr(position.notional)}</span>
              </div>
              <div>
                <span style={{ fontSize: "11px", color: "#525252" }}>Leverage: </span>
                <span style={{ fontSize: "14px", fontWeight: 600, color: position.leverage > 2 ? "#f59e0b" : "#737373" }}>{position.leverage.toFixed(2)}x</span>
              </div>
            </div>
          </div>

          {/* Execution steps */}
          <div style={{ background: "#0a0f0a", border: "1px solid #16a34a30", borderRadius: "6px", padding: "12px", marginBottom: "12px" }}>
            <div style={{ fontSize: "11px", color: "#16a34a", fontWeight: 600, marginBottom: "8px" }}>INSTRUKSI EKSEKUSI</div>
            <ol style={{ margin: 0, paddingLeft: "20px", fontSize: "12px", color: "#a3a3a3", lineHeight: 1.8 }}>
              <li>Pasang {signal.limitOrder?.recommendation === "use_limit" ? "limit" : "market"} {gate.status === "BELI" ? "buy" : "sell"} di {fmtIdr(signal.entry)}.</li>
              <li>Jika terisi, langsung pasang stop loss di {fmtIdr(signal.stopLoss)}.</li>
              <li>Jual 50% di Target 1 ({fmtIdr(signal.takeProfit1)}).</li>
              <li>Setelah Target 1 tercapai, pindahkan stop ke breakeven (harga masuk).</li>
              <li>Jual sisa di Target 2 ({fmtIdr(signal.takeProfit2)}).</li>
              <li>Batalkan order jika sinyal berubah menjadi TUNGGU.</li>
            </ol>
          </div>

          {/* Important notes */}
          <div style={{ fontSize: "12px", color: "#525252", marginBottom: "8px" }}>
            <div style={{ color: "#f59e0b", marginBottom: "4px" }}>⚠ Penting:</div>
            <div>• Masuk setelah candle 1 jam ditutup (bukan "sekarang").</div>
            <div>• Jangan masuk jika harga sudah bergerak &gt;0.5% dari harga sinyal.</div>
            <div>• {gate.reason}</div>
            {signal.warning && <div style={{ color: "#f59e0b", marginTop: "4px" }}>• {signal.warning.slice(0, 100)}</div>}
          </div>

          {/* Invalidation */}
          <div style={{ fontSize: "11px", color: "#525252", borderTop: "1px solid #1a1a1a", paddingTop: "8px" }}>
            <strong>Batalkan jika:</strong> {signal.invalidation.slice(0, 120)}
          </div>
        </div>
      )}
    </div>
  );
}
