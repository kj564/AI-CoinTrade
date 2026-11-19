"use client";

import { useState, useEffect } from "react";

// ── TRADING ASSISTANT ──
// Simple BELI / JUAL / TUNGGU per pair.
// Translates the quant engine into decisions a beginner can follow.

// Pair config — HONEST labels based on 21-day cost-adjusted replay.
// These are NOT permanent conclusions. All statuses auto-review weekly.
// 21 days is enough to disable temporarily, not enough to conclude permanently.
const PAIR_CONFIG: Record<string, {
  enabled: boolean;
  name: string;
  label: string;        // KANDIDAT EDGE | MARGINAL | NONAKTIF SEMENTARA
  note: string;
  evidence: string;     // what proof we have
}> = {
  eth_idr: {
    enabled: true, name: "Ethereum",
    label: "KANDIDAT EDGE",
    note: "+25.1% net setelah biaya (21 hari replay)",
    evidence: "21 hari replay, 75% win, Sharpe 13.1 — belum cukup untuk live",
  },
  btc_idr: {
    enabled: true, name: "Bitcoin",
    label: "MARGINAL",
    note: "+4.5% net setelah biaya (21 hari replay)",
    evidence: "EV tipis setelah biaya, 64% win — butuh validasi lebih lanjut",
  },
  sol_idr: {
    enabled: false, name: "Solana",
    label: "NONAKTIF SEMENTARA",
    note: "-20.8% net setelah biaya (21 hari replay)",
    evidence: "EV negatif setelah biaya. Ditinjau ulang mingguan.",
  },
  bnb_idr: {
    enabled: false, name: "BNB",
    label: "NONAKTIF SEMENTARA",
    note: "-6.2% net setelah biaya (21 hari replay)",
    evidence: "EV negatif setelah biaya. Ditinjau ulang mingguan.",
  },
  xrp_idr: {
    enabled: false, name: "XRP",
    label: "NONAKTIF SEMENTARA",
    note: "-18.9% net setelah biaya (21 hari replay)",
    evidence: "EV negatif setelah biaya. Ditinjau ulang mingguan.",
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
  circuitBreaker: { open: boolean; consecutiveLosses: number; cooldownSec: number; trips: number };
  rationale: string[];
  invalidation: string;
  warning: string | null;
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

export default function TradingAssistant() {
  const [data, setData] = useState<AlphaResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [capital, setCapital] = useState(10000000);
  const [riskPct, setRiskPct] = useState(0.5);
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [portfolio, setPortfolio] = useState<any>(null);

  useEffect(() => {
    let active = true;
    const doFetch = async () => {
      setLoading(true);
      try {
        const [alphaRes, portRes] = await Promise.all([
          fetch(`/api/signal/alpha?capital=${capital}`).then((r) => r.json()),
          fetch(`/api/signal/portfolio`).then((r) => r.json()).catch(() => null),
        ]);
        if (active) {
          setData(alphaRes);
          if (portRes) setPortfolio(portRes);
        }
      } catch { /* ignore */ }
      if (active) setLoading(false);
    };
    doFetch();
    const interval = setInterval(doFetch, 60000);
    return () => { active = false; clearInterval(interval); };
  }, [capital]);

  const fmtIdr = (n: number) => "Rp " + n.toLocaleString("id-ID", { maximumFractionDigits: 0 });
  const fmtAsset = (n: number) => n < 1 ? n.toFixed(6) : n.toFixed(4);

  // Compute position size from risk
  function computePosition(signal: Signal) {
    const riskAmount = capital * (riskPct / 100);
    const stopDistance = Math.abs(signal.entry - signal.stopLoss);
    if (stopDistance <= 0) return { assetAmount: 0, riskAmount, notional: 0, leverage: 0 };
    const assetAmount = riskAmount / stopDistance;
    const notional = assetAmount * signal.entry;
    const leverage = notional / capital;
    return { assetAmount, riskAmount, notional, leverage };
  }

  // Gate logic: determine BELI/JUAL/TUNGGU
  function gate(signal: Signal): { status: "BELI" | "JUAL" | "TUNGGU" | "NONAKTIF"; reason: string } {
    const config = PAIR_CONFIG[signal.pair];
    if (!config?.enabled) {
      return { status: "NONAKTIF", reason: config?.note ?? "Pair dinonaktifkan" };
    }
    // Gate 1: circuit breaker
    if (signal.circuitBreaker?.open) {
      const mins = Math.floor((signal.circuitBreaker.cooldownSec ?? 0) / 60);
      return { status: "TUNGGU", reason: `Circuit breaker aktif (${signal.circuitBreaker.consecutiveLosses} loss beruntun). Dijeda ${mins} menit.` };
    }
    // Gate 2: data stale
    if (signal.dataStale) {
      return { status: "TUNGGU", reason: "Data market tidak update. Tunggu data fresh." };
    }
    // Gate 3: action FLAT
    if (signal.action === "FLAT") {
      return { status: "TUNGGU", reason: simplifyReason(signal.rationale[0]) };
    }
    // Gate 4: OOS not honest
    if (!signal.backtest?.honest) {
      return { status: "TUNGGU", reason: "Edge belum terkonfirmasi out-of-sample. Butuh lebih banyak data." };
    }
    // Gate 5: Kelly CI5 ≤ 0
    if (signal.backtest?.kellyCI5 <= 0) {
      return { status: "TUNGGU", reason: "Kelly CI5 ≤ 0. Ukuran posisi belum bisa dihitung dengan keyakinan." };
    }
    // Gate 6: EV ≤ 0
    if (signal.impact && signal.impact.expectedValueIdr <= 0) {
      return { status: "TUNGGU", reason: "Biaya (fee + slippage) lebih besar dari expected return. Tidak menguntungkan setelah biaya." };
    }
    // All gates passed → BELI or JUAL
    return {
      status: signal.action === "LONG" ? "BELI" : "JUAL",
      reason: "Semua gate lolos: funding ekstrem, mikrostruktur konfirmasi, OOS honest, EV positif.",
    };
  }

  function simplifyReason(rationale: string): string {
    if (rationale.includes("No aligned edge")) return "Tidak ada edge saat ini. Funding tidak ekstrem, regime tidak jelas.";
    if (rationale.includes("BLOCKED")) return "Sinyal funding ada tapi momentum masih kuat. Berbahaya untuk lawan arah.";
    if (rationale.includes("FLAT is a position")) return "Tidak ada edge. Menahan adalah keputusan yang benar.";
    return rationale.slice(0, 100);
  }

  const enabledPairs = data?.signals.filter((s) => PAIR_CONFIG[s.pair]?.enabled) ?? [];
  const disabledPairs = data?.signals.filter((s) => !PAIR_CONFIG[s.pair]?.enabled) ?? [];

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#e5e5e5", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: "800px", margin: "0 auto", padding: "24px 16px" }}>
        {/* HEADER */}
        <header style={{ marginBottom: "24px" }}>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>Trading Assistant</h1>
          <p style={{ fontSize: "13px", color: "#737373", margin: "4px 0 0" }}>
            Keputusan sederhana: BELI / JUAL / TUNGGU. Berdasarkan funding rate, mikrostruktur, dan validasi out-of-sample.
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

        {/* PAPER TRADING STATUS */}
        {portfolio && (
          <section style={{ marginBottom: "24px" }}>
            <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: "6px", padding: "12px" }}>
              <div style={{ fontSize: "11px", color: "#525252", textTransform: "uppercase", marginBottom: "8px" }}>
                Paper Trading Status
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "8px" }}>
                <div>
                  <div style={{ fontSize: "10px", color: "#404040" }}>Total Sinyal</div>
                  <div style={{ fontSize: "16px", fontWeight: 600 }}>{portfolio.totalSignals ?? 0}</div>
                </div>
                <div>
                  <div style={{ fontSize: "10px", color: "#404040" }}>Win Rate</div>
                  <div style={{ fontSize: "16px", fontWeight: 600, color: (portfolio.winRate ?? 0) > 0.5 ? "#16a34a" : "#dc2626" }}>
                    {((portfolio.winRate ?? 0) * 100).toFixed(0)}%
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "10px", color: "#404040" }}>Net P&L</div>
                  <div style={{ fontSize: "16px", fontWeight: 600, color: (portfolio.totalPnlIdr ?? 0) > 0 ? "#16a34a" : "#dc2626" }}>
                    {fmtIdr(portfolio.totalPnlIdr ?? 0)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "10px", color: "#404040" }}>Sharpe</div>
                  <div style={{ fontSize: "16px", fontWeight: 600 }}>{(portfolio.sharpeRatio ?? 0).toFixed(1)}</div>
                </div>
              </div>
              <div style={{ fontSize: "11px", color: "#404040", marginTop: "8px" }}>
                {portfolio.openSignals > 0
                  ? `${portfolio.openSignals} posisi terbuka · ${portfolio.closedSignals} closed`
                  : "Belum ada sinyal terekam. Paper trading berjalan otomatis setiap jam."}
              </div>
            </div>
          </section>
        )}

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
              {loading && " · updating…"}
            </div>
          </footer>
        )}

        {!data && !loading && (
          <div style={{ textAlign: "center", padding: "40px", color: "#525252" }}>
            <button onClick={() => { setData(null); }} style={{ padding: "12px 24px", background: "#171717", border: "1px solid #262626", borderRadius: "8px", color: "#e5e5e5", cursor: "pointer" }}>
              Mulai
            </button>
          </div>
        )}
      </div>
    </div>
  );
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
