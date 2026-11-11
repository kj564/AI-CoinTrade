"use client";

import { useEffect, useState, useRef } from "react";
import {
  TrendingUp, TrendingDown, Minus, Newspaper, FlaskConical, Wallet,
  Send, Activity, AlertTriangle, Zap, Target, Shield, BarChart3,
  ChevronRight, Clock, Layers, Gauge, CircleDot, ArrowUpRight, ArrowDownRight,
  CheckCircle2, XCircle, AlertCircle, Sparkles,
  ChevronDown, Microscope, GitBranch, Split, Scale, Sigma, Dice5,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// ── Types (match actual API / library shapes) ──

interface PairTicker { pair: string; ticker: { high: string; low: string; last: string; buy: string; sell: string; vol_idr?: string } }
interface Sentiment { score: number; label: string; sources?: string[]; articles?: number; positive?: string[]; negative?: string[]; neutral?: number }

interface Indicators {
  currentPrice: number;
  sma10: number | null; sma20: number | null;
  ema12: number | null; ema26: number | null;
  rsi14: number;
  bb: { upper: number; middle: number; lower: number } | null;
  macd: { line: number; signal: number; histogram: number } | null;
  stochasticK: number;
  volume24h: number;
}
interface Research {
  pair: string;
  signal: "BUY" | "SELL" | "HOLD";
  bias: "bullish" | "bearish" | "neutral";
  strength: number;
  entry: number; stopLoss: number; takeProfit: number;
  positionSize: string; timeframe: string;
  indicators: Indicators;
  sentiment: { score: number; label: string };
  signals: string[];
  narrative: string;
  riskWarning: string;
}
interface Depth { buy: [string, string][]; sell: [string, string][] }

interface BtTrade { entryTime: number; exitTime: number; entryPrice: number; exitPrice: number; side: "long" | "short"; pnl: number; pnlPct: number }
interface MonteCarloResult {
  simulations: number; bustProbability: number; bustThreshold: number;
  medianMaxDrawdown: number; p95MaxDrawdown: number;
  medianFinalEquity: number; p5FinalEquity: number; p95FinalEquity: number;
  profitProbability: number;
}
interface BacktestResult {
  trades: BtTrade[];
  netProfit: number; profitFactor: number; maxDrawdown: number;
  winRate: number; avgTrade: number; tradeCount: number;
  avgWin: number; avgLoss: number; sharpeRatio: number;
  longPerformance: number; shortPerformance: number;
  equity: { time: number; value: number }[];
  verdict: string;
  totalFees: number; sortinoRatio: number; calmarRatio: number;
  monteCarlo: MonteCarloResult | null;
  feeScenarios?: FeeScenario[];
  feeBreakdown?: FeeBreakdown;
  realisticLimitAnalysis?: RealisticLimitAnalysis;
}
interface FeeScenario {
  name: string; description: string;
  entryFeeRate: number; exitFeeRate: number;
  totalFees: number; netProfit: number; profitFactor: number; winRate: number;
  feeSavingVsTaker: number; feeSavingPct: number;
}
interface FeeBreakdown {
  takerFeeRate: number; makerFeeRate: number; spreadPct: number; slippagePct: number;
  costPerSideTaker: number; costPerSideMaker: number; costPerSideHybrid: number;
  savingsMakerVsTakerPct: number; savingsHybridVsTakerPct: number; note: string;
}
interface RealisticLimitAnalysis {
  totalLimitOrders: number; filledOrders: number; missedOrders: number;
  fillProbability: number; fillProbabilityPct: number; avgWaitBarsToFill: number;
  fullFills: number; partialFills: number; partialFillRate: number; avgFillFraction: number;
  avgAdverseSelectionPct: number; adverseSelectionRate: number;
  realisticMakerNetProfit: number; realisticMakerProfitFactor: number; realisticMakerWinRate: number;
  netProfitVsPureMaker: number; executionCostPct: number;
  description: string;
  // P1 (new): Queue position
  avgQueueAheadPct: number; queueAdjustedFillRate: number;
  // P2 (new): Market impact
  avgMarketImpactPct: number; largeOrderRate: number; worstMarketImpactPct: number;
  // P3 (new): Latency
  latencyBars: number; latencyMissedEntries: number; latencyPriceDriftPct: number;
  // P4 (new): Volume-aware fill
  avgVolumeAtLimitPct: number; thinMarketRate: number;
  // This round: microstructure
  avgBookDepthAtLimitPct: number; queueConsistencyPct: number;
  avgVolumeProfileImpactPct: number; volumeProfileConcentration: number;
  networkLatencyMs: number; networkLatencyBarsPct: number;
  avgOrderBookImbalance: number; imbalanceAdverseRate: number;
  // L2 calibration
  l2Snapshot: L2SnapshotData | null;
}
interface L2SnapshotData {
  pair: string; timestamp: string;
  topBidPrice: number; topAskPrice: number; realSpreadPct: number;
  topBidVolume: number; topAskVolume: number; topOfBookImbalance: number;
  totalBidVolume: number; totalAskVolume: number; totalImbalance: number;
  bidLevels: number; askLevels: number;
  bidDepthProfile: { priceLevelPct: number; cumulativeVol: number }[];
  askDepthProfile: { priceLevelPct: number; cumulativeVol: number }[];
  depthCalibrationFactor: number; spreadCalibrationFactor: number; imbalanceCalibrationFactor: number;
  description: string;
}
interface RiskFlags { red: string[]; yellow: string[]; green: string[]; verdict: string }
interface PositionModels {
  fixedRisk: { sizePct: number; riskAmount: number };
  kellyFraction: { kellyPct: number };
  volAdjusted: { sizePct: number; atrRatio: number };
  drawdownAware: { rules: string[] };
}
interface BtResponse { result: BacktestResult; risk: RiskFlags; positions: PositionModels; report: string; dataSource?: { source: string; timeframe: string; candleCount: number; windowDays: number; feeRate?: number } }

// ── Formatters ──

function fmtIDR(v: string | number | null | undefined) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n === null || n === undefined || !isFinite(n) || n === 0) return "—";
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}
function fmtNum(v: number | null | undefined, decimals = 2) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return v.toLocaleString("id-ID", { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}
function fmtCompact(v: number | null | undefined) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}
// Format a unix-second timestamp as a relative age (e.g. "3m ago", "2h5m ago").
function formatL2Age(ts: number | null | undefined): string {
  if (!ts || !isFinite(ts)) return "—";
  const now = Math.floor(Date.now() / 1000);
  const sec = Math.max(0, now - ts);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${m > 0 ? `${m}m` : ""}`;
}

const PAIRS = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr", "ada_idr", "doge_idr", "avax_idr", "matic_idr", "dot_idr"];
const COIN_NAMES: Record<string, string> = {
  btc_idr: "Bitcoin", eth_idr: "Ethereum", sol_idr: "Solana", bnb_idr: "BNB",
  xrp_idr: "XRP", ada_idr: "Cardano", doge_idr: "Dogecoin", avax_idr: "Avalanche",
  matic_idr: "Polygon", dot_idr: "Polkadot",
};

// ── Visual sub-components ──

function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex h-2 w-2", className)}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
    </span>
  );
}

function RsiGauge({ rsi }: { rsi: number }) {
  const pct = Math.max(0, Math.min(100, rsi));
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">RSI (14)</span>
        <span className={cn("text-base font-bold tabular-nums", pct > 70 ? "text-rose-400" : pct < 30 ? "text-emerald-400" : "text-slate-200")}>
          {pct.toFixed(0)}
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-800/60">
        <div className="absolute inset-y-0 left-0 w-[30%] bg-emerald-500/30" />
        <div className="absolute inset-y-0 left-[30%] w-[40%] bg-slate-600/30" />
        <div className="absolute inset-y-0 right-0 w-[30%] bg-rose-500/30" />
        <div className="absolute inset-y-0 w-[2px] bg-white shadow-[0_0_8px_rgba(255,255,255,0.6)]" style={{ left: `calc(${pct}% - 1px)` }} />
      </div>
      <div className="flex justify-between text-[9px] text-slate-600">
        <span>0</span><span className="text-emerald-500/70">30</span><span>50</span><span className="text-rose-500/70">70</span><span>100</span>
      </div>
    </div>
  );
}

function BiasMeter({ bias, strength }: { bias: string; strength: number }) {
  // map bias + strength to a position on red→amber→emerald
  const pos = bias === "bullish" ? 50 + strength / 2 : bias === "bearish" ? 50 - strength / 2 : 50;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Bias Strength</span>
        <span className={cn("text-sm font-bold tabular-nums", bias === "bullish" ? "text-emerald-400" : bias === "bearish" ? "text-rose-400" : "text-amber-400")}>
          {strength}%
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-gradient-to-r from-rose-500/40 via-amber-500/40 to-emerald-500/40">
        <div className="absolute inset-y-0 w-[3px] rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.7)]" style={{ left: `calc(${Math.max(0, Math.min(100, pos))}% - 1.5px)` }} />
      </div>
      <div className="flex justify-between text-[9px] text-slate-600">
        <span className="text-rose-500/70">Bearish</span><span>Neutral</span><span className="text-emerald-500/70">Bullish</span>
      </div>
    </div>
  );
}

function RangeBar({ low, high, last }: { low: number; high: number; last: number }) {
  const range = high - low;
  const pct = range > 0 ? Math.max(0, Math.min(100, ((last - low) / range) * 100)) : 50;
  return (
    <div className="space-y-1">
      <div className="relative h-1.5 w-full rounded-full bg-slate-800/60">
        <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-500/60 via-amber-500/60 to-emerald-500/60" style={{ width: "100%", opacity: 0.5 }} />
        <div className="absolute top-1/2 h-3 w-[2px] -translate-y-1/2 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]" style={{ left: `calc(${pct}% - 1px)` }} />
      </div>
      <div className="flex justify-between text-[9px] text-slate-600 tabular-nums">
        <span>{fmtCompact(low)}</span>
        <span>{fmtCompact(high)}</span>
      </div>
    </div>
  );
}

function EquityCurve({ equity, initial }: { equity: { time: number; value: number }[]; initial: number }) {
  if (!equity || equity.length < 2) {
    return <div className="flex h-32 items-center justify-center text-xs text-slate-600">No equity data</div>;
  }
  const values = [initial, ...equity.map(e => e.value)];
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const W = 600, H = 120, pad = 4;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (W - pad * 2);
    const y = H - pad - ((v - min) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M ${pts.join(" L ")}`;
  const areaPath = `${linePath} L ${(W - pad).toFixed(1)},${(H - pad).toFixed(1)} L ${pad.toFixed(1)},${(H - pad).toFixed(1)} Z`;
  const lastVal = values[values.length - 1];
  const isUp = lastVal >= initial;
  const stroke = isUp ? "#34d399" : "#fb7185";
  const fill = isUp ? "rgba(52,211,153,0.15)" : "rgba(251,113,133,0.15)";
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-32" preserveAspectRatio="none">
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={fill} />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#eqFill)" />
        <path d={linePath} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="absolute top-1 right-2 text-[10px] text-slate-500 tabular-nums">{fmtCompact(max)}</div>
      <div className="absolute bottom-1 right-2 text-[10px] text-slate-600 tabular-nums">{fmtCompact(min)}</div>
    </div>
  );
}

// ── Main dashboard ──

export function TradingDashboard() {
  const [tickers, setTickers] = useState<PairTicker[]>([]);
  const [sentiment, setSentiment] = useState<Sentiment | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPair, setSelectedPair] = useState("btc_idr");
  const [research, setResearch] = useState<Research | null>(null);
  const [depth, setDepth] = useState<Depth | null>(null);

  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [balances, setBalances] = useState<Record<string, string> | null>(null);

  const [tradeType, setTradeType] = useState<"buy" | "sell">("buy");
  const [tradePrice, setTradePrice] = useState("");
  const [tradeAmount, setTradeAmount] = useState("");
  const [tradeStatus, setTradeStatus] = useState<string>("");

  const [btStrategy, setBtStrategy] = useState("sma_cross");
  const [btCapital, setBtCapital] = useState("10000000");
  const [btSL, setBtSL] = useState("3");
  const [btTP, setBtTP] = useState("5");
  const [btResult, setBtResult] = useState<BtResponse | null>(null);
  const [btError, setBtError] = useState<string | null>(null);
  const [btLoading, setBtLoading] = useState(false);
  const [btTf, setBtTf] = useState("1h");
  const [histLoading, setHistLoading] = useState(false);
  const [compareResult, setCompareResult] = useState<any>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  // signal advisor
  const [signal, setSignal] = useState<any>(null);
  const [signalLoading, setSignalLoading] = useState(false);
  const [sigCapital, setSigCapital] = useState("10000000");
  const [sigRisk, setSigRisk] = useState("2");
  const [sigStrategy, setSigStrategy] = useState("rsi_reversal");
  // AI analysis (TradingAgents-inspired multi-agent LLM)
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  // Research Lab collapsible (advanced ML metrics)
  const [labOpen, setLabOpen] = useState(false);
  // L2 collector health monitoring (polls /api/l2/health)
  const [l2Health, setL2Health] = useState<any>(null);
  const [l2HealthLoading, setL2HealthLoading] = useState(false);
  const [l2Collecting, setL2Collecting] = useState(false);
  const [l2DeepCheck, setL2DeepCheck] = useState<any>(null);
  const [l2DeepCheckLoading, setL2DeepCheckLoading] = useState(false);
  const [l2RunbookOpen, setL2RunbookOpen] = useState(false);
  // refs to always have latest capital/risk in interval without re-triggering effect
  const sigCapitalRef = useRef(sigCapital);
  const sigRiskRef = useRef(sigRisk);
  sigCapitalRef.current = sigCapital;
  sigRiskRef.current = sigRisk;
  // bot
  const [botCfg, setBotCfg] = useState<any>(null);
  const [botStatus, setBotStatus] = useState<any>(null);
  const [botSaving, setBotSaving] = useState(false);
  const [botTickLoading, setBotTickLoading] = useState(false);
  const [liveApiKey, setLiveApiKey] = useState("");
  const [liveSecretKey, setLiveSecretKey] = useState("");
  const [keyTest, setKeyTest] = useState<{ status: "idle" | "testing" | "ok" | "fail"; msg?: string }>({ status: "idle" });
  const [tgToken, setTgToken] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  const [tgTest, setTgTest] = useState<{ status: "idle" | "testing" | "ok" | "fail"; msg?: string }>({ status: "idle" });

  // market overview
  useEffect(() => {
    let active = true;
    const doFetch = async () => {
      try {
        const r = await fetch("/api/indodax/market?sentiment=1");
        const d = await r.json();
        if (!active) return;
        if (d.tickers) setTickers(d.tickers);
        if (d.sentiment) setSentiment(d.sentiment);
      } catch { /* ignore */ }
      if (active) setLoading(false);
    };
    doFetch();
    const t = setInterval(doFetch, 30000);
    return () => { active = false; clearInterval(t); };
  }, []);

  // L2 collector health — polls every 30s when Research Lab is open
  useEffect(() => {
    if (!labOpen) return;
    let active = true;
    const doFetch = async () => {
      try {
        setL2HealthLoading(true);
        const r = await fetch("/api/l2/health");
        if (!active) return;
        const d = await r.json();
        setL2Health(d);
      } catch { /* ignore */ }
      if (active) setL2HealthLoading(false);
    };
    doFetch();
    const t = setInterval(doFetch, 30000);
    return () => { active = false; clearInterval(t); };
  }, [labOpen]);

  // Manual L2 collection trigger (forces a snapshot for all pairs)
  const triggerL2Collect = async () => {
    setL2Collecting(true);
    try {
      await fetch("/api/l2/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      // refresh health immediately
      const r = await fetch("/api/l2/health");
      const d = await r.json();
      setL2Health(d);
    } catch { /* ignore */ }
    setL2Collecting(false);
  };

  // Deep check — runs full end-to-end pipeline verification
  const runL2DeepCheck = async () => {
    setL2DeepCheckLoading(true);
    try {
      const r = await fetch("/api/l2/health?deep=1");
      const d = await r.json();
      setL2DeepCheck(d.deepCheck);
    } catch { /* ignore */ }
    setL2DeepCheckLoading(false);
  };

  // pair detail
  useEffect(() => {
    let active = true;
    const doFetch = async () => {
      try {
        const r = await fetch(`/api/indodax/market?pair=${selectedPair}&depth=1&research=1`);
        const d = await r.json();
        if (!active) return;
        if (d.research) setResearch(d.research);
        if (d.depth) setDepth(d.depth);
        if (d.ticker) setTradePrice(d.ticker.last);
      } catch { /* ignore */ }
    };
    doFetch();
    const t = setInterval(doFetch, 20000);
    return () => { active = false; clearInterval(t); };
  }, [selectedPair]);

  async function fetchAccount() {
    setTradeStatus("Connecting…");
    try {
      const r = await fetch("/api/indodax/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey, secretKey }) });
      const d = await r.json();
      if (d.error) { setTradeStatus(`Error: ${d.error}`); return; }
      setBalances(d.balances || {});
      setTradeStatus("Account connected");
    } catch { setTradeStatus("Connection failed"); }
  }

  async function placeTrade() {
    if (!apiKey || !secretKey) { setTradeStatus("Enter API keys in Account tab first"); return; }
    setTradeStatus("Placing order…");
    try {
      const r = await fetch("/api/indodax/trade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey, secretKey, pair: selectedPair, type: tradeType, price: Number(tradePrice), amount: Number(tradeAmount) }) });
      const d = await r.json();
      if (d.error) { setTradeStatus(`Error: ${d.error}`); return; }
      setTradeStatus(`Order placed · ID ${d.order?.order_id}`);
    } catch { setTradeStatus("Order failed"); }
  }

  async function runBt() {
    setBtLoading(true); setBtError(null); setTradeStatus("Running backtest on real historical candles + Monte Carlo…");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      const r = await fetch("/api/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pair: selectedPair, strategy: btStrategy, initialCapital: Number(btCapital), stopLossPct: Number(btSL) / 100, takeProfitPct: Number(btTP) / 100, params: { timeframe: btTf } }), signal: controller.signal });
      clearTimeout(timeout);
      const d = await r.json();
      if (d.error) { setBtError(d.error); setTradeStatus(`BT error: ${d.error}`); return; }
      setBtResult(d as BtResponse);
      setTradeStatus(`Backtest complete: ${d.dataSource?.candleCount} ${d.dataSource?.timeframe} candles · ${d.dataSource?.windowDays}d · ${d.result?.tradeCount} trades`);
    } catch (e) {
      const msg = e instanceof Error && e.name === "AbortError" ? "Backtest timed out (30s) — server may be under heavy load. Try again." : "Backtest failed — server may be unavailable. Try again.";
      setBtError(msg);
      setTradeStatus(msg);
    }
    finally { setBtLoading(false); }
  }

  async function fetchHistory() {
    setHistLoading(true); setTradeStatus("Fetching 90 days of historical candles from INDODAX…");
    try {
      const r = await fetch("/api/indodax/backfill-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pair: selectedPair, tf: btTf, days: 90 }) });
      const d = await r.json();
      if (d.error) { setTradeStatus(`History fetch error: ${d.error}`); }
      else { setTradeStatus(`History fetched: ${d.fetched} candles stored`); }
    } catch { setTradeStatus("History fetch failed"); }
    finally { setHistLoading(false); }
  }

  // compare all 7 strategies + grid search for selected strategy
  async function compareStrategies() {
    setCompareLoading(true); setTradeStatus("Running all 7 strategies + grid search on real data…");
    try {
      const r = await fetch("/api/backtest/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pair: selectedPair, timeframe: btTf, initialCapital: Number(btCapital), stopLossPct: Number(btSL) / 100, takeProfitPct: Number(btTP) / 100, gridSearch: btStrategy }) });
      const d = await r.json();
      if (d.error) { setTradeStatus(`Compare error: ${d.error}`); return; }
      setCompareResult(d);
      const best = d.comparison?.[0];
      setTradeStatus(`Compared 7 strategies · best: ${best?.strategy} (PF ${best?.profitFactor?.toFixed(2)}, Sharpe ${best?.sharpeRatio?.toFixed(2)})`);
    } catch { setTradeStatus("Compare failed"); }
    finally { setCompareLoading(false); }
  }

  // signal advisor — generate BUY/SELL/HOLD + position sizing
  async function fetchSignal() {
    setSignalLoading(true);
    try {
      const r = await fetch(`/api/signal?pair=${selectedPair}&capital=${sigCapitalRef.current}&riskPct=${sigRiskRef.current}&strategy=${sigStrategy}`);
      const d = await r.json();
      if (d.error) { setTradeStatus(`Signal error: ${d.error}`); return; }
      setSignal(d);
    } catch { setTradeStatus("Signal fetch failed"); }
    finally { setSignalLoading(false); }
  }

  // auto-refresh signal every 60s — only re-fetch when pair or strategy changes
  // refs ensure latest capital/risk without re-triggering effect on input typing
  useEffect(() => {
    fetchSignal();
    const t = setInterval(fetchSignal, 60000);
    return () => clearInterval(t);
  }, [selectedPair, sigStrategy]);

  // AI multi-agent analysis (TradingAgents-inspired)
  async function fetchAiAnalysis() {
    if (!signal) return;
    setAiLoading(true);
    try {
      const r = await fetch("/api/signal/ai-analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signal) });
      const d = await r.json();
      if (d.error) { setAiAnalysis(`Error: ${d.error}`); }
      else { setAiAnalysis(d.analysis); }
    } catch { setAiAnalysis("AI analysis request failed"); }
    finally { setAiLoading(false); }
  }

  // bot: load config + status
  async function fetchBot() {
    try {
      const [c, s] = await Promise.all([fetch("/api/bot/config").then(r => r.json()), fetch("/api/bot/status").then(r => r.json())]);
      setBotCfg(c); setBotStatus(s);
    } catch { /* ignore */ }
  }
  async function saveBot(patch: Record<string, unknown>) {
    setBotSaving(true);
    try {
      const r = await fetch("/api/bot/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const d = await r.json();
      if (d.error) setTradeStatus(`Bot error: ${d.error}`); else { setBotCfg(d); setTradeStatus("Bot config saved"); }
    } catch { setTradeStatus("Bot config failed"); }
    finally { setBotSaving(false); }
  }
  async function saveKeys() {
    if (!liveApiKey || !liveSecretKey) { setTradeStatus("Enter both API key + secret first"); return; }
    setBotSaving(true);
    try {
      const r = await fetch("/api/bot/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: liveApiKey, secretKey: liveSecretKey }) });
      const d = await r.json();
      if (d.error) setTradeStatus(`Save keys error: ${d.error}`); else { setBotCfg(d); setLiveApiKey(""); setLiveSecretKey(""); setTradeStatus("API keys saved ✓"); }
    } catch { setTradeStatus("Save keys failed"); }
    finally { setBotSaving(false); }
  }
  async function testKeys() {
    const key = liveApiKey || (botCfg?.apiKey && !botCfg.apiKey.includes("•") ? botCfg.apiKey : "");
    const secret = liveSecretKey || (botCfg?.secretKey && !botCfg.secretKey.includes("•") ? botCfg.secretKey : "");
    if (!key || !secret) { setKeyTest({ status: "fail", msg: "Enter API key + secret first" }); return; }
    setKeyTest({ status: "testing" });
    try {
      const r = await fetch("/api/bot/test-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key, secretKey: secret }) });
      const d = await r.json();
      setKeyTest(d.ok ? { status: "ok", msg: `Connected · ${d.nonZeroCount} non-zero balances` } : { status: "fail", msg: d.error || "Failed" });
    } catch { setKeyTest({ status: "fail", msg: "Request failed" }); }
  }
  async function saveTelegram() {
    if (!tgToken || !tgChatId) { setTradeStatus("Enter Telegram token + chat ID first"); return; }
    setBotSaving(true);
    try {
      const r = await fetch("/api/bot/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telegramToken: tgToken, telegramChatId: tgChatId }) });
      const d = await r.json();
      if (d.error) setTradeStatus(`Telegram save error: ${d.error}`); else { setBotCfg(d); setTgToken(""); setTgChatId(""); setTradeStatus("Telegram config saved ✓"); }
    } catch { setTradeStatus("Telegram save failed"); }
    finally { setBotSaving(false); }
  }
  async function testTelegram() {
    const token = tgToken || (botCfg?.telegramToken && !botCfg.telegramToken.includes("•") ? botCfg.telegramToken : "");
    const chatId = tgChatId || botCfg?.telegramChatId || "";
    if (!token || !chatId) { setTgTest({ status: "fail", msg: "Enter token + chat ID first" }); return; }
    setTgTest({ status: "testing" });
    try {
      const r = await fetch("/api/bot/test-telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, chatId }) });
      const d = await r.json();
      setTgTest(d.ok ? { status: "ok", msg: "Test message sent ✓" } : { status: "fail", msg: d.error || "Failed" });
    } catch { setTgTest({ status: "fail", msg: "Request failed" }); }
  }
  async function manualTick() {
    setBotTickLoading(true);
    try { const r = await fetch("/api/bot/tick", { method: "POST" }); const d = await r.json(); setTradeStatus(d.error ? `Tick error: ${d.error}` : `Tick: ${d.action} · ${d.signal} ${d.strength}% · ATR ${d.atr?.toFixed(0)}`); }
    catch { setTradeStatus("Tick failed"); }
    finally { setBotTickLoading(false); fetchBot(); }
  }
  useEffect(() => { fetchBot(); const t = setInterval(fetchBot, 15000); return () => clearInterval(t); }, []);

  const signalMeta = research ? {
    color: research.signal === "BUY" ? "emerald" : research.signal === "SELL" ? "rose" : "amber",
    Icon: research.signal === "BUY" ? ArrowUpRight : research.signal === "SELL" ? ArrowDownRight : Minus,
  } : null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen flex-col bg-[#0b0e14] text-slate-100">
        {/* ambient glow */}
        <div className="pointer-events-none fixed inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,rgba(16,185,129,0.10),transparent_70%)]" />

        {/* Header */}
        <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#0b0e14]/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-3 lg:px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 font-black text-[#0b0e14] shadow-lg shadow-emerald-500/20">ID</div>
              <div>
                <div className="text-sm font-bold tracking-tight">INDODAX Terminal</div>
                <div className="text-[10px] text-slate-500">Riset → Eksekusi → Validasi</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
                <LiveDot /> LIVE
              </div>
              {sentiment && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge className={cn("gap-1 border px-2.5 py-1 text-[11px] font-medium", sentiment.label === "Bullish" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : sentiment.label === "Bearish" ? "border-rose-500/30 bg-rose-500/10 text-rose-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300")}>
                      <Newspaper className="h-3 w-3" /> {sentiment.label} <span className="tabular-nums opacity-70">({sentiment.score.toFixed(2)})</span>
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p className="text-[11px]">News sentiment dari RSS crypto (Coindesk, Cointelegraph, CryptoPotato, CryptoSlate). Score −1 → +1.</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </header>

        <main className="relative mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 lg:px-6">
          <Tabs defaultValue="signal" className="w-full">
            <TabsList className="mb-6 grid h-auto w-full grid-cols-3 gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
              <TabsTrigger value="signal" className="gap-1.5 rounded-lg py-2 text-xs data-[state=active]:bg-white/[0.06] data-[state=active]:shadow-sm"><Zap className="h-4 w-4" /> Signal</TabsTrigger>
              <TabsTrigger value="market" className="gap-1.5 rounded-lg py-2 text-xs data-[state=active]:bg-white/[0.06] data-[state=active]:shadow-sm"><TrendingUp className="h-4 w-4" /> Market</TabsTrigger>
              <TabsTrigger value="backtest" className="gap-1.5 rounded-lg py-2 text-xs data-[state=active]:bg-white/[0.06] data-[state=active]:shadow-sm"><FlaskConical className="h-4 w-4" /> Backtest</TabsTrigger>
            </TabsList>

            {/* ════ SIGNAL ADVISOR TAB ════ */}
            <TabsContent value="signal" className="space-y-5">
              {/* Input row */}
              <Card className="border-white/[0.08] bg-white/[0.03]">
                <div className="p-5">
                  <div className="mb-4 flex items-center gap-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/15"><Zap className="h-4 w-4 text-blue-400" /></div>
                    <div>
                      <h3 className="text-sm font-bold">Trading Signal Advisor</h3>
                      <div className="text-[10px] text-slate-500">Rekomendasi BUY/SELL/HOLD + kalkulasi posisi · auto-refresh 60s · data real INDODAX</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div>
                      <Label className="text-[11px] text-slate-400">Pair</Label>
                      <Select value={selectedPair} onValueChange={setSelectedPair}>
                        <SelectTrigger className="mt-1 border-white/10 bg-white/[0.03]"><SelectValue /></SelectTrigger>
                        <SelectContent>{PAIRS.map(p => <SelectItem key={p} value={p}>{p.toUpperCase()}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-[11px] text-slate-400">Strategy</Label>
                      <Select value={sigStrategy} onValueChange={setSigStrategy}>
                        <SelectTrigger className="mt-1 border-white/10 bg-white/[0.03]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="rsi_reversal">RSI Reversal (best walk-forward)</SelectItem>
                          <SelectItem value="sma_cross">SMA Crossover</SelectItem>
                          <SelectItem value="macd_trend">MACD Trend</SelectItem>
                          <SelectItem value="bollinger_breakout">Bollinger Breakout</SelectItem>
                          <SelectItem value="stochastic_reversal">Stochastic Reversal</SelectItem>
                          <SelectItem value="mean_reversion">Mean Reversion</SelectItem>
                          <SelectItem value="donchian_breakout">Donchian Breakout</SelectItem>
                          <SelectItem value="trend_filter_sma">Trend Filter SMA (ADX)</SelectItem>
                          <SelectItem value="multi_confluence">Multi Confluence</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-[11px] text-slate-400">Dana (IDR)</Label>
                      <div className="relative mt-1">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">Rp</span>
                        <Input value={sigCapital} onChange={e => setSigCapital(e.target.value)} className="border-white/10 bg-white/[0.03] pl-7 font-mono text-sm tabular-nums" placeholder="10000000" />
                      </div>
                    </div>
                    <div>
                      <Label className="text-[11px] text-slate-400">Risk per Trade (%)</Label>
                      <Input value={sigRisk} onChange={e => setSigRisk(e.target.value)} className="mt-1 border-white/10 bg-white/[0.03] font-mono text-sm tabular-nums" placeholder="2" />
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Button onClick={fetchSignal} disabled={signalLoading} size="sm" className="gap-2 bg-blue-600 hover:bg-blue-700">
                      {signalLoading ? <><Clock className="h-3.5 w-3.5 animate-spin" /> Analyzing…</> : <><Zap className="h-3.5 w-3.5" /> Generate Signal</>}
                    </Button>
                    <span className="text-[10px] text-slate-500">Auto-refresh setiap 60 detik · signal dihitung dari {signal?.candleCount ?? 0} candle 1h real</span>
                  </div>
                </div>
              </Card>

              {/* Signal result */}
              {signal && (
                <div className="space-y-4">
                  {/* P4: Research mode guardrail */}
                  <div className="flex items-center justify-between rounded-lg border border-amber-500/15 bg-amber-500/[0.04] px-3 py-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-amber-400/80">🔬 Research Mode — Not Investment Advice</span>
                    <span className="text-[9px] text-slate-500">walk-forward di bawah 70% · MC bust di atas 90% · edge belum terbukti</span>
                  </div>
                  {/* P4: "Why not trade" when not BUY */}
                  {signal.signal !== "BUY" && (
                    <Card className="border-amber-500/20 bg-amber-500/[0.03]">
                      <div className="p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                          <span className="text-[11px] font-bold text-amber-400">Why not trade? — {signal.signal}</span>
                        </div>
                        <p className="text-[10px] leading-relaxed text-slate-400">
                          {signal.regimeAdjustment || `Signal ${signal.signal} dengan confidence ${signal.confidence}% — belum mencapai threshold BUY.`}
                          {signal.regime?.regime === "bearish_trending" ? " Market bearish trending — counter-trend risk tinggi." : ""}
                          {signal.regime?.regime === "volatile" ? " Market volatile — risk tidak terkontrol." : ""}
                          {signal.volume?.obvTrend === "distribution" ? " OBV distribution — smart money selling." : ""}
                        </p>
                      </div>
                    </Card>
                  )}
                  {/* Big signal banner */}
                  <div className={cn("flex items-center justify-between rounded-xl border p-5", signal.signal === "BUY" ? "border-emerald-500/40 bg-emerald-500/[0.08]" : signal.signal === "SELL" ? "border-rose-500/40 bg-rose-500/[0.08]" : "border-amber-500/40 bg-amber-500/[0.08]")}>
                    <div className="flex items-center gap-4">
                      <div className={cn("flex h-14 w-14 items-center justify-center rounded-xl text-2xl font-black", signal.signal === "BUY" ? "bg-emerald-500/20 text-emerald-400" : signal.signal === "SELL" ? "bg-rose-500/20 text-rose-400" : "bg-amber-500/20 text-amber-400")}>
                        {signal.signal === "BUY" ? "BUY" : signal.signal === "SELL" ? "SELL" : "HOLD"}
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">{signal.pair.toUpperCase()} · {signal.strategy.replace(/_/g, " ")}</div>
                        <div className="text-xl font-bold tabular-nums">{fmtIDR(signal.price)}</div>
                        <div className="text-[11px] text-slate-400">Confidence: {signal.confidence}% · {signal.bias} · Daily: {signal.dailyTrend}</div>
                      </div>
                    </div>
                    {signal.mtfFiltered && (
                      <Badge className="border-amber-500/30 bg-amber-500/10 text-[9px] text-amber-300">⚠️ MTF Filtered</Badge>
                    )}
                  </div>

                  {/* Market Regime Detection */}
                  {signal.regime && (
                    <Card className={cn("border bg-white/[0.03]",
                      signal.regime.regime === "bullish_trending" ? "border-emerald-500/20 bg-emerald-500/[0.03]" :
                      signal.regime.regime === "bearish_trending" ? "border-rose-500/20 bg-rose-500/[0.03]" :
                      signal.regime.regime === "volatile" ? "border-amber-500/20 bg-amber-500/[0.03]" :
                      "border-blue-500/20 bg-blue-500/[0.03]")}>
                      <div className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Gauge className={cn("h-4 w-4",
                              signal.regime.regime === "bullish_trending" ? "text-emerald-400" :
                              signal.regime.regime === "bearish_trending" ? "text-rose-400" :
                              signal.regime.regime === "volatile" ? "text-amber-400" : "text-blue-400")} />
                            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-300">Market Regime</span>
                          </div>
                          <Badge className={cn("border px-2 py-1 text-[10px] font-bold",
                            signal.regime.regime === "bullish_trending" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" :
                            signal.regime.regime === "bearish_trending" ? "border-rose-500/30 bg-rose-500/10 text-rose-300" :
                            signal.regime.regime === "volatile" ? "border-amber-500/30 bg-amber-500/10 text-amber-300" :
                            "border-blue-500/30 bg-blue-500/10 text-blue-300")}>
                            {signal.regime.label}
                          </Badge>
                        </div>
                        <div className="grid grid-cols-4 gap-2 mb-2">
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">ADX</div><div className="font-bold tabular-nums">{signal.regime.adx.toFixed(0)}</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">ATR Ratio</div><div className={cn("font-bold tabular-nums", signal.regime.atrRatio > 1.5 ? "text-amber-400" : "text-slate-200")}>{signal.regime.atrRatio.toFixed(2)}</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">BB Width</div><div className="font-bold tabular-nums">{signal.regime.bbWidth.toFixed(1)}%</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Confidence</div><div className="font-bold tabular-nums">{signal.regime.confidence.toFixed(0)}%</div></div>
                        </div>
                        <p className="text-[11px] leading-relaxed text-slate-400">{signal.regime.description}</p>
                        <div className="mt-1 text-[10px] text-slate-500">Favored: <span className="font-bold text-slate-300">{signal.regime.favoredStrategy}</span></div>
                        {signal.regimeAdjustment && (
                          <div className="mt-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5 text-[10px] text-amber-300">{signal.regimeAdjustment}</div>
                        )}
                      </div>
                    </Card>
                  )}

                  {/* Position sizing (only if BUY) */}
                  {signal.sizing ? (
                    <Card className="border-emerald-500/20 bg-emerald-500/[0.03]">
                      <div className="p-5">
                        <div className="mb-3 flex items-center gap-2"><Target className="h-4 w-4 text-emerald-400" /><h4 className="text-sm font-bold">Position Sizing — Berapa Beli & Kapan</h4></div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
                            <div className="text-[10px] uppercase text-slate-500">Beli Sekarang</div>
                            <div className="text-sm font-bold tabular-nums text-emerald-400">{fmtIDR(signal.sizing.positionIdr)}</div>
                            <div className="text-[10px] text-slate-500">{signal.sizing.coinAmount.toFixed(6)} {signal.pair.replace("_idr","").toUpperCase()}</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                            <div className="text-[10px] uppercase text-slate-500">Entry Price</div>
                            <div className="text-sm font-bold tabular-nums">{fmtIDR(signal.price)}</div>
                            <div className="text-[10px] text-slate-500">harga sekarang</div>
                          </div>
                          <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.04] p-3">
                            <div className="flex items-center gap-1 text-[10px] uppercase text-rose-400/70"><Shield className="h-3 w-3" /> Stop Loss</div>
                            <div className="text-sm font-bold tabular-nums text-rose-400">{fmtIDR(signal.sizing.stopLoss)}</div>
                            <div className="text-[10px] text-rose-400/60">-{signal.sizing.stopDistPct.toFixed(1)}% · rugi max {fmtIDR(signal.sizing.potentialLoss)}</div>
                          </div>
                          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
                            <div className="flex items-center gap-1 text-[10px] uppercase text-emerald-400/70"><Zap className="h-3 w-3" /> Take Profit</div>
                            <div className="text-sm font-bold tabular-nums text-emerald-400">{fmtIDR(signal.sizing.takeProfit)}</div>
                            <div className="text-[10px] text-emerald-400/60">+{signal.sizing.tpDistPct.toFixed(1)}% · profit {fmtIDR(signal.sizing.potentialProfit)}</div>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-3 border-t border-white/[0.06] pt-3 text-xs">
                          <div><div className="text-[9px] text-slate-500">Risk Amount</div><div className="font-bold tabular-nums">{fmtIDR(signal.sizing.riskAmount)} ({signal.sizing.riskPct}% dari {fmtIDR(signal.sizing.capital)})</div></div>
                          <div><div className="text-[9px] text-slate-500">Risk : Reward</div><div className="font-bold text-emerald-400">1 : {signal.sizing.riskRewardRatio.toFixed(1)}</div></div>
                          <div><div className="text-[9px] text-slate-500">ATR</div><div className="font-bold tabular-nums">{fmtIDR(signal.atr)}</div></div>
                        </div>
                        <div className="mt-3 flex items-start gap-2 rounded-lg border border-blue-500/15 bg-blue-500/[0.04] p-3">
                          <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-400" />
                          <p className="text-[11px] leading-relaxed text-blue-200/80">
                            <b>Eksekusi manual di INDODAX:</b> Beli <b>{signal.sizing.coinAmount.toFixed(6)} {signal.pair.replace("_idr","").toUpperCase()}</b> seharga <b>{fmtIDR(signal.sizing.positionIdr)}</b> di harga market <b>{fmtIDR(signal.price)}</b>. Pasang Stop Loss di <b>{fmtIDR(signal.sizing.stopLoss)}</b> dan Take Profit di <b>{fmtIDR(signal.sizing.takeProfit)}</b>. Kalau SL kena, rugi <b>{fmtIDR(signal.sizing.potentialLoss)}</b>. Kalau TP kena, profit <b>{fmtIDR(signal.sizing.potentialProfit)}</b>.
                          </p>
                        </div>
                      </div>
                    </Card>
                  ) : (
                    <Card className="border-amber-500/20 bg-amber-500/[0.03]">
                      <div className="p-5 text-center">
                        <Minus className="mx-auto h-8 w-8 text-amber-400 mb-2" />
                        <div className="text-sm font-bold text-amber-400">Signal {signal.signal} — Tidak Ada Entry Saat Ini</div>
                        <div className="text-[11px] text-slate-500 mt-1">Bot menunggu kondisi yang lebih mendukung. {signal.mtfFiltered ? "BUY signal difilter karena daily trend bearish (MTF confirmation)." : "Signal belum mencapai threshold BUY."}</div>
                      </div>
                    </Card>
                  )}

                  {/* Reasoning */}
                  <Card className="border-white/[0.08] bg-white/[0.03]">
                    <div className="p-5">
                      <div className="mb-3 flex items-center gap-2"><Activity className="h-4 w-4 text-blue-400" /><h4 className="text-sm font-bold">Reasoning — Kenapa {signal.signal}?</h4></div>
                      <div className="space-y-1.5">
                        {signal.reasoning?.map((r: string, i: number) => (
                          <div key={i} className="flex items-start gap-2 rounded-md border border-white/[0.04] bg-white/[0.02] px-2 py-1.5 text-[11px] text-slate-300">
                            <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-slate-500" /> {r}
                          </div>
                        ))}
                      </div>
                      {/* Indicators snapshot */}
                      <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2 border-t border-white/[0.06] pt-3">
                        <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">RSI</div><div className="font-bold tabular-nums">{signal.indicators?.rsi?.toFixed(0) ?? "—"}</div></div>
                        <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">MACD</div><div className="font-bold tabular-nums">{signal.indicators?.macd != null ? fmtCompact(signal.indicators.macd) : "—"}</div></div>
                        <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">SMA10</div><div className="font-bold tabular-nums">{signal.indicators?.sma10 ? fmtCompact(signal.indicators.sma10) : "—"}</div></div>
                        <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">SMA20</div><div className="font-bold tabular-nums">{signal.indicators?.sma20 ? fmtCompact(signal.indicators.sma20) : "—"}</div></div>
                        <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Stoch</div><div className="font-bold tabular-nums">{signal.indicators?.stochastic?.toFixed(0) ?? "—"}</div></div>
                        <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Daily</div><div className={cn("font-bold capitalize", signal.dailyTrend === "bullish" ? "text-emerald-400" : signal.dailyTrend === "bearish" ? "text-rose-400" : "text-amber-400")}>{signal.dailyTrend}</div></div>
                      </div>
                      {/* Volume analysis */}
                      {signal.volume && (
                        <div className="mt-3 border-t border-white/[0.06] pt-3">
                          <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Volume Analysis</div>
                          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">VWAP</div><div className="font-bold tabular-nums">{fmtCompact(signal.volume.vwap)}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Price vs VWAP</div><div className={cn("font-bold capitalize", signal.volume.priceVsVwap === "above" ? "text-emerald-400" : signal.volume.priceVsVwap === "below" ? "text-rose-400" : "text-slate-400")}>{signal.volume.priceVsVwap}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">OBV Trend</div><div className={cn("font-bold capitalize", signal.volume.obvTrend === "accumulation" ? "text-emerald-400" : signal.volume.obvTrend === "distribution" ? "text-rose-400" : "text-slate-400")}>{signal.volume.obvTrend}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Vol Ratio</div><div className={cn("font-bold tabular-nums", signal.volume.volumeConviction === "high" ? "text-emerald-400" : signal.volume.volumeConviction === "low" ? "text-amber-400" : "text-slate-200")}>{signal.volume.volumeRatio.toFixed(2)}×</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Conviction</div><div className={cn("font-bold capitalize", signal.volume.volumeConviction === "high" ? "text-emerald-400" : signal.volume.volumeConviction === "low" ? "text-amber-400" : "text-slate-200")}>{signal.volume.volumeConviction}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">VWAP Range</div><div className="font-bold tabular-nums text-[10px]">{fmtCompact(signal.volume.vwapLower)} - {fmtCompact(signal.volume.vwapUpper)}</div></div>
                          </div>
                          {signal.volumeWarning && (
                            <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/[0.05] px-2 py-1.5 text-[10px] text-amber-300">{signal.volumeWarning}</div>
                          )}
                        </div>
                      )}
                      {/* Funding Rate analysis (Binance perpetual futures) */}
                      {signal.funding && (
                        <div className="mt-3 border-t border-white/[0.06] pt-3">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[10px] uppercase tracking-wide text-slate-500">Funding Rate (Binance Futures)</span>
                            <Badge className={cn("border px-1.5 py-0 text-[8px] font-bold",
                              signal.funding.extremeHigh ? "border-rose-500/30 bg-rose-500/10 text-rose-300" :
                              signal.funding.extremeLow ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" :
                              "border-white/10 bg-white/[0.02] text-slate-400")}>
                              {signal.funding.sentiment.replace(/_/g, " ")}
                            </Badge>
                          </div>
                          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Funding Rate</div><div className={cn("font-bold tabular-nums", signal.funding.extremeHigh ? "text-rose-400" : signal.funding.extremeLow ? "text-emerald-400" : "text-slate-200")}>{signal.funding.currentPct.toFixed(4)}%</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">30d Average</div><div className="font-bold tabular-nums text-slate-300">{(signal.funding.avgRate * 100).toFixed(4)}%</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Mark Price</div><div className="font-bold tabular-nums">${signal.funding.markPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Signal</div><div className={cn("font-bold capitalize", signal.funding.signal === "contrarian_buy" ? "text-emerald-400" : signal.funding.signal === "contrarian_sell" ? "text-rose-400" : "text-slate-400")}>{signal.funding.signal.replace(/_/g, " ")}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Next Funding</div><div className="font-bold tabular-nums text-[10px]">{new Date(signal.funding.nextFundingTime).toLocaleString("id-ID", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })}</div></div>
                          </div>
                          <p className="mt-1 text-[10px] text-slate-500">{signal.funding.description}</p>
                          {signal.fundingAdjustment && (
                            <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/[0.05] px-2 py-1.5 text-[10px] text-amber-300">{signal.fundingAdjustment}</div>
                          )}
                        </div>
                      )}
                      {/* Strategy historical performance */}
                      {signal.strategyPerf && (
                        <div className="mt-3 border-t border-white/[0.06] pt-3">
                          <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Strategy Performance ({signal.strategyPerf.days}d backtest · {signal.strategyPerf.candleCount} candles)</div>
                          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Trades</div><div className="font-bold tabular-nums">{signal.strategyPerf.trades}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Win Rate</div><div className="font-bold tabular-nums">{signal.strategyPerf.winRate.toFixed(0)}%</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Profit Factor</div><div className={cn("font-bold tabular-nums", signal.strategyPerf.profitFactor > 1.4 ? "text-emerald-400" : signal.strategyPerf.profitFactor > 1 ? "text-amber-400" : "text-rose-400")}>{signal.strategyPerf.profitFactor >= 999 ? "∞" : signal.strategyPerf.profitFactor.toFixed(2)}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Net Profit</div><div className={cn("font-bold tabular-nums", signal.strategyPerf.netProfit >= 0 ? "text-emerald-400" : "text-rose-400")}>{fmtIDR(signal.strategyPerf.netProfit)}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Max DD</div><div className="font-bold tabular-nums text-rose-400">{signal.strategyPerf.maxDrawdown.toFixed(0)}%</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">MC Bust</div><div className={cn("font-bold tabular-nums", signal.strategyPerf.monteCarloBust == null ? "text-slate-600" : signal.strategyPerf.monteCarloBust > 30 ? "text-rose-400" : signal.strategyPerf.monteCarloBust > 10 ? "text-amber-400" : "text-emerald-400")}>{signal.strategyPerf.monteCarloBust == null ? "—" : signal.strategyPerf.monteCarloBust.toFixed(0) + "%"}</div></div>
                          </div>
                          <div className="mt-1 text-[9px] text-slate-600">Backtest {signal.strategyPerf.days} hari dengan fee 0.3% · {signal.strategyPerf.trades} trades · Net {fmtIDR(signal.strategyPerf.netProfit)} · Total fees {fmtIDR(signal.strategyPerf.totalFees)}</div>
                        </div>
                      )}
                      {/* Kelly Criterion position sizing */}
                      {signal.kelly && (
                        <div className="mt-3 border-t border-white/[0.06] pt-3">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[10px] uppercase tracking-wide text-slate-500">Kelly Criterion Sizing</span>
                            <Badge className={cn("border px-1.5 py-0 text-[8px] font-bold", signal.kelly.fullKelly <= 0 ? "border-rose-500/30 bg-rose-500/10 text-rose-300" : signal.kelly.fullKelly > 25 ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300")}>
                              K = {signal.kelly.fullKelly.toFixed(1)}%
                            </Badge>
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Win Rate (W)</div><div className="font-bold tabular-nums">{(signal.kelly.winRate * 100).toFixed(0)}%</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Payoff (R)</div><div className="font-bold tabular-nums">{signal.kelly.payoffRatio >= 999 ? "∞" : signal.kelly.payoffRatio.toFixed(2)}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Avg Win/Loss</div><div className="font-bold tabular-nums text-[10px]">{fmtIDR(signal.kelly.avgWin)} / {fmtIDR(signal.kelly.avgLoss)}</div></div>
                            <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Formula</div><div className="font-bold text-[9px] text-slate-400">K = W − (1−W)/R</div></div>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2">
                            <div className={cn("rounded border px-2 py-1.5", signal.kelly.fullKelly <= 0 ? "border-rose-500/20 bg-rose-500/[0.03]" : "border-white/[0.06] bg-white/[0.02]")}>
                              <div className="text-[9px] text-slate-500">Full Kelly</div>
                              <div className={cn("font-bold tabular-nums", signal.kelly.fullKelly <= 0 ? "text-rose-400" : "text-amber-400")}>{signal.kelly.fullKelly.toFixed(1)}%</div>
                              <div className="text-[8px] text-slate-600">max aggressive</div>
                            </div>
                            <div className="rounded border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                              <div className="text-[9px] text-slate-500">Half Kelly</div>
                              <div className="font-bold tabular-nums text-amber-400">{signal.kelly.halfKelly.toFixed(1)}%</div>
                              <div className="text-[8px] text-slate-600">moderate risk</div>
                            </div>
                            <div className={cn("rounded border px-2 py-1.5", signal.kelly.quarterKelly > 0 ? "border-emerald-500/20 bg-emerald-500/[0.03]" : "border-rose-500/20 bg-rose-500/[0.03]")}>
                              <div className="text-[9px] text-slate-500">Quarter Kelly ✓</div>
                              <div className={cn("font-bold tabular-nums", signal.kelly.quarterKelly > 0 ? "text-emerald-400" : "text-rose-400")}>{signal.kelly.quarterKelly.toFixed(1)}%</div>
                              <div className="text-[8px] text-slate-600">{fmtIDR(signal.kelly.recommendedSizeIdr)}</div>
                            </div>
                          </div>
                          <div className="mt-1 text-[9px] text-slate-600">{signal.kelly.note}</div>
                        </div>
                      )}
                    </div>
                  </Card>

                  {/* ML Direction Prediction */}
                  {signal.ml && (
                    <Card className={cn("border bg-white/[0.03]",
                      signal.ml.direction === "up" ? "border-emerald-500/20 bg-emerald-500/[0.03]" :
                      signal.ml.direction === "down" ? "border-rose-500/20 bg-rose-500/[0.03]" :
                      "border-slate-500/20 bg-white/[0.03]")}>
                      <div className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <BarChart3 className={cn("h-4 w-4",
                              signal.ml.direction === "up" ? "text-emerald-400" :
                              signal.ml.direction === "down" ? "text-rose-400" : "text-slate-400")} />
                            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-300">ML Direction Prediction</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge className={cn("border px-2 py-1 text-[10px] font-bold",
                              signal.ml.direction === "up" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" :
                              signal.ml.direction === "down" ? "border-rose-500/30 bg-rose-500/10 text-rose-300" :
                              "border-slate-500/30 bg-slate-500/10 text-slate-300")}>
                              {signal.ml.direction === "up" ? "↑ UP" : signal.ml.direction === "down" ? "↓ DOWN" : "≈ NEUTRAL"} {signal.ml.probabilityPct.toFixed(0)}%
                            </Badge>
                            <Badge variant="outline" className="border-white/10 text-[8px] text-slate-400">acc {signal.ml.modelAccuracy.toFixed(0)}%</Badge>
                          </div>
                        </div>
                        <div className="grid grid-cols-4 gap-2 mb-2">
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">RSI</div><div className="font-bold tabular-nums">{(signal.ml.features.rsi * 100).toFixed(0)}</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">MACD</div><div className="font-bold tabular-nums">{signal.ml.features.macdHist.toFixed(4)}</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">SMA Ratio</div><div className="font-bold tabular-nums">{signal.ml.features.smaRatio.toFixed(3)}</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Stoch</div><div className="font-bold tabular-nums">{(signal.ml.features.stoch * 100).toFixed(0)}</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">OBV Slope</div><div className="font-bold tabular-nums">{signal.ml.features.obvSlope.toFixed(4)}</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Vol Ratio</div><div className="font-bold tabular-nums">{(signal.ml.features.volRatio * 3).toFixed(2)}×</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">ATR %</div><div className="font-bold tabular-nums">{(signal.ml.features.atrPct * 100).toFixed(2)}%</div></div>
                          <div className="rounded bg-white/[0.02] px-2 py-1"><div className="text-[9px] text-slate-500">Momentum</div><div className={cn("font-bold tabular-nums", signal.ml.features.priceMomentum > 0 ? "text-emerald-400" : "text-rose-400")}>{(signal.ml.features.priceMomentum * 100).toFixed(2)}%</div></div>
                        </div>
                        {/* Probability bar */}
                        <div className="relative h-6 w-full overflow-hidden rounded-full bg-slate-800/60 mb-2">
                          <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-rose-500/30 via-amber-500/30 to-emerald-500/30" style={{ width: "100%" }} />
                          <div className="absolute inset-y-0 w-[3px] bg-white shadow-[0_0_8px_rgba(255,255,255,0.6)]" style={{ left: `calc(${signal.ml.probabilityPct}% - 1.5px)` }} />
                          <div className="absolute inset-0 flex items-center justify-between px-2 text-[9px] text-white/60"><span>↓ DOWN</span><span>{signal.ml.probabilityPct.toFixed(0)}% UP</span><span>UP ↑</span></div>
                        </div>
                        <p className="text-[10px] text-slate-500">{signal.ml.description}</p>
                        <div className="mt-1 text-[9px] text-slate-600">Logistic regression · 8 features · {signal.ml.trainingSamples} samples · acc {signal.ml.modelAccuracy.toFixed(0)}% · Brier {signal.ml.brierScore?.toFixed(3) ?? "—"} (0=perfect, 0.25=random) · confidence {signal.ml.confidence.toFixed(0)}%</div>

                        {/* ── Research Lab (collapsible advanced metrics) ── */}
                        <Collapsible open={labOpen} onOpenChange={setLabOpen} className="mt-3">
                          <CollapsibleTrigger asChild>
                            <button className="flex w-full items-center justify-between rounded-lg border border-purple-500/20 bg-purple-500/[0.04] px-3 py-2 text-left transition-colors hover:bg-purple-500/[0.07]">
                              <div className="flex items-center gap-2">
                                <Microscope className="h-3.5 w-3.5 text-purple-400" />
                                <span className="text-[11px] font-bold uppercase tracking-wide text-purple-300">Research Lab</span>
                                <span className="text-[9px] text-slate-500">· effect sizes · calibration · MDI/MDA · meta-labeling · dynamic barriers</span>
                              </div>
                              <ChevronDown className={cn("h-4 w-4 text-purple-300 transition-transform", labOpen && "rotate-180")} />
                            </button>
                          </CollapsibleTrigger>
                          <CollapsibleContent className="mt-3 space-y-3">
                            {/* ── Effect sizes summary ── */}
                            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                              <div className="mb-2 flex items-center gap-1.5"><Scale className="h-3 w-3 text-amber-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Effect Sizes (AUC/PR-AUC/F1)</span></div>
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                <div className="rounded bg-white/[0.03] px-2 py-1.5">
                                  <div className="text-[9px] text-slate-500">AUC-ROC Lift</div>
                                  <div className={cn("font-bold tabular-nums", (signal.ml.metaModel?.aucROCLift ?? 0) > 0.05 ? "text-emerald-400" : (signal.ml.metaModel?.aucROCLift ?? 0) < 0 ? "text-rose-400" : "text-slate-300")}>{(signal.ml.metaModel?.aucROCLift ?? 0).toFixed(3)}</div>
                                  <div className="text-[8px] text-slate-600">vs 0.5 base</div>
                                </div>
                                <div className="rounded bg-white/[0.03] px-2 py-1.5">
                                  <div className="text-[9px] text-slate-500">PR-AUC Lift</div>
                                  <div className={cn("font-bold tabular-nums", (signal.ml.metaModel?.prAUCLift ?? 0) > 0.05 ? "text-emerald-400" : (signal.ml.metaModel?.prAUCLift ?? 0) < 0 ? "text-rose-400" : "text-slate-300")}>{(signal.ml.metaModel?.prAUCLift ?? 0).toFixed(3)}</div>
                                  <div className="text-[8px] text-slate-600">vs barrier hit rate</div>
                                </div>
                                <div className="rounded bg-white/[0.03] px-2 py-1.5">
                                  <div className="text-[9px] text-slate-500">AUC Effect Size</div>
                                  <div className={cn("font-bold tabular-nums", (signal.ml.metaModel?.aucEffectSize ?? 0) > 0.1 ? "text-emerald-400" : "text-slate-300")}>{(signal.ml.metaModel?.aucEffectSize ?? 0).toFixed(3)}</div>
                                  <div className="text-[8px] text-slate-600">lift / 0.5</div>
                                </div>
                                <div className="rounded bg-white/[0.03] px-2 py-1.5">
                                  <div className="text-[9px] text-slate-500">F1 Effect Size</div>
                                  <div className={cn("font-bold tabular-nums", (signal.ml.metaModel?.f1EffectSize ?? 0) < 0 ? "text-rose-400" : (signal.ml.metaModel?.f1EffectSize ?? 0) > 0.1 ? "text-emerald-400" : "text-slate-300")}>{(signal.ml.metaModel?.f1EffectSize ?? 0).toFixed(3)}</div>
                                  <div className="text-[8px] text-slate-600">nested CV vs random</div>
                                </div>
                              </div>
                              <p className="mt-2 text-[9px] leading-relaxed text-slate-500">
                                Paradox test: AUC lift &gt; 0.05 → moderate <b>ranking ability</b>; F1 effect size &lt; 0 → no <b>usable threshold</b>.{(signal.ml.metaModel?.aucROCLift ?? 0) > 0.05 && (signal.ml.metaModel?.f1EffectSize ?? 0) < 0 ? " ← PARADOX confirmed: model ranks well but no deployable threshold exists." : ""}
                              </p>
                            </div>

                            {/* ── Calibration per regime ── */}
                            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                              <div className="mb-2 flex items-center gap-1.5"><Sigma className="h-3 w-3 text-blue-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Calibration Per Regime (Wilson 95% CI)</span></div>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                {["trending", "ranging", "volatile"].map((regime) => {
                                  const bins = signal.ml.calibrationPerRegime?.[regime] || [];
                                  const metaBins = signal.ml.metaModel?.calibratedCalibrationPerRegime?.[regime] || [];
                                  const hasData = bins.some((b: any) => b.count > 0);
                                  return (
                                    <div key={regime} className="rounded bg-white/[0.03] p-2">
                                      <div className="mb-1 flex items-center justify-between">
                                        <span className="text-[10px] font-bold capitalize text-slate-300">{regime}</span>
                                        <span className="text-[8px] text-slate-600">{bins.reduce((a: number, b: any) => a + b.count, 0)} pts</span>
                                      </div>
                                      {!hasData ? (
                                        <div className="py-2 text-center text-[9px] text-slate-600">no samples</div>
                                      ) : (
                                        <div className="space-y-0.5">
                                          {bins.filter((b: any) => b.count > 0).map((b: any, i: number) => {
                                            const meta = metaBins.find((m: any) => m.bin === b.bin);
                                            const observedPct = b.observed * 100;
                                            const predictedPct = b.predicted * 100;
                                            const ciLoPct = b.ciLo * 100, ciHiPct = b.ciHi * 100;
                                            return (
                                              <div key={i} className="text-[9px]">
                                                <div className="flex items-center justify-between">
                                                  <span className="text-slate-500 tabular-nums">{b.bin}</span>
                                                  <span className="text-slate-400 tabular-nums">pred {predictedPct.toFixed(0)}% / obs {observedPct.toFixed(0)}% <span className="text-slate-600">[{ciLoPct.toFixed(0)}-{ciHiPct.toFixed(0)}]</span></span>
                                                </div>
                                                <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800/60">
                                                  <div className="absolute inset-y-0 left-0 bg-blue-500/40" style={{ width: `${predictedPct}%` }} />
                                                  <div className="absolute inset-y-0 w-[3px] bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]" style={{ left: `calc(${observedPct}% - 1.5px)` }} />
                                                  {meta && <div className="absolute inset-y-0 w-[2px] bg-purple-400/70" style={{ left: `calc(${meta.observed * 100}% - 1px)` }} />}
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="mt-2 flex gap-3 text-[8px] text-slate-600">
                                <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 bg-blue-500/40" /> predicted</span>
                                <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-[2px] bg-emerald-400" /> observed</span>
                                <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-[2px] bg-purple-400/70" /> isotonic-calibrated</span>
                              </div>
                            </div>

                            {/* ── Feature selection (3-method combined, NEW) ── */}
                            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                              <div className="mb-2 flex items-center gap-1.5"><GitBranch className="h-3 w-3 text-emerald-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Feature Selection (Wald + MDA + MDI — 3-method agreement)</span></div>
                              <div className="overflow-x-auto">
                                <table className="w-full text-[9px] tabular-nums">
                                  <thead>
                                    <tr className="text-left text-slate-500">
                                      <th className="py-1 pr-2 font-medium">Feature</th>
                                      <th className="px-1 font-medium text-center">Wald rank</th>
                                      <th className="px-1 font-medium text-center">MDA rank</th>
                                      <th className="px-1 font-medium text-center">MDI rank</th>
                                      <th className="px-1 font-medium text-center">Avg</th>
                                      <th className="pl-1 font-medium text-left">Verdict</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(signal.ml.featureSelection || []).map((fs: any) => (
                                      <tr key={fs.feature} className="border-t border-white/[0.04]">
                                        <td className="py-1 pr-2 text-slate-300">{fs.feature}</td>
                                        <td className="px-1 text-center text-slate-400">{fs.waldRank}</td>
                                        <td className="px-1 text-center text-slate-400">{fs.mdaRank}</td>
                                        <td className="px-1 text-center text-slate-400">{fs.mdiRank}</td>
                                        <td className="px-1 text-center text-slate-300">{fs.combinedScore.toFixed(1)}</td>
                                        <td className="pl-1">
                                          <Badge className={cn("border px-1 py-0 text-[8px] font-bold",
                                            fs.verdict === "useful" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" :
                                            fs.verdict === "borderline" ? "border-amber-500/30 bg-amber-500/10 text-amber-300" :
                                            "border-rose-500/30 bg-rose-500/10 text-rose-300")}>
                                            {fs.verdict}
                                          </Badge>
                                          <span className="ml-1 text-[8px] text-slate-600">{fs.recommendation}</span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <p className="mt-2 text-[9px] leading-relaxed text-slate-500">
                                3 independent methods must agree before a feature is "useful". Wald = coefficient significance, MDA = permutation accuracy drop, MDI = Gini decrease in CART tree. All "noise" → no feature has real predictive value.
                              </p>
                            </div>

                            {/* ── Stability Selection (Meinshausen & Bühlmann 2010) — NEW ── */}
                            {signal.ml.stabilitySelection && signal.ml.stabilitySelection.length > 0 && (
                              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.03] p-3">
                                <div className="mb-2 flex items-center gap-1.5">
                                  <Sigma className="h-3 w-3 text-emerald-400" />
                                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Stability Selection <Badge className="ml-1 border border-emerald-500/30 bg-emerald-500/10 px-1 py-0 text-[7px] font-bold text-emerald-300">NEW</Badge></span>
                                  {signal.ml.stabilityParams && (
                                    <span className="text-[8px] text-slate-600">· {signal.ml.stabilityParams.nIterations}× bootstrap · top-{signal.ml.stabilityParams.topK} selection</span>
                                  )}
                                </div>
                                <div className="space-y-1">
                                  {signal.ml.stabilitySelection.map((s: any) => (
                                    <div key={s.feature} className="flex items-center gap-2 text-[9px]">
                                      <span className="w-20 shrink-0 text-slate-400">{s.feature}</span>
                                      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-800/60">
                                        {/* Threshold line at 70% (stable cutoff) */}
                                        <div className="absolute inset-y-0 left-[70%] w-[1px] bg-amber-400/40" />
                                        {/* CI range indicator (light band) */}
                                        <div className="absolute inset-y-0 bg-slate-600/30" style={{ left: `${(s.ciLo * 100).toFixed(1)}%`, width: `${((s.ciHi - s.ciLo) * 100).toFixed(1)}%` }} />
                                        <div className={cn("absolute inset-y-0 left-0",
                                          s.verdict === "stable" ? "bg-emerald-500/60" :
                                          s.verdict === "borderline" ? "bg-amber-500/50" :
                                          "bg-rose-500/40"
                                        )} style={{ width: `${s.selectionPct.toFixed(1)}%` }} />
                                      </div>
                                      <span className="w-24 shrink-0 text-right tabular-nums text-slate-300">{s.selectionPct.toFixed(0)}% <span className="text-[7px] text-slate-600">[{(s.ciLo * 100).toFixed(0)}-{(s.ciHi * 100).toFixed(0)}]</span></span>
                                      <Badge className={cn("border px-1 py-0 text-[7px] font-bold shrink-0",
                                        s.verdict === "stable" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" :
                                        s.verdict === "borderline" ? "border-amber-500/30 bg-amber-500/10 text-amber-300" :
                                        "border-rose-500/30 bg-rose-500/10 text-rose-300")}>
                                        {s.verdict}
                                      </Badge>
                                    </div>
                                  ))}
                                </div>
                                <p className="mt-2 text-[9px] leading-relaxed text-slate-500">
                                  {signal.ml.stabilityParams?.description || "Subsample-bootstrap × 50 iterations."}
                                  <br />
                                  <span className="text-slate-400">Stable (≥70% selected):</span> reliably useful across resamples — survives multiple-testing pressure.
                                  <br />
                                  <span className="text-slate-400">Unstable (&lt;40%):</span> only looked important on the full sample by chance.
                                </p>
                              </div>
                            )}

                            {/* ── MDI + MDA importance ranking ── */}
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                                <div className="mb-2 flex items-center gap-1.5"><Split className="h-3 w-3 text-teal-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">MDI (Mean Decrease Impurity)</span></div>
                                <div className="space-y-1">
                                  {(signal.ml.mdiImportance || []).slice(0, 8).map((m: any) => (
                                    <div key={m.feature} className="flex items-center gap-2 text-[9px]">
                                      <span className="w-20 shrink-0 text-slate-400">{m.feature}</span>
                                      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-800/60">
                                        <div className="absolute inset-y-0 left-0 bg-teal-500/50" style={{ width: `${(m.importance * 100).toFixed(1)}%` }} />
                                      </div>
                                      <span className="w-12 shrink-0 text-right tabular-nums text-slate-300">{(m.importance * 100).toFixed(1)}%</span>
                                      <span className="w-3 shrink-0 text-center text-[8px] text-slate-600">#{m.rank}</span>
                                    </div>
                                  ))}
                                </div>
                                <p className="mt-2 text-[9px] text-slate-600">CART ensemble (20 trees, depth 4). % of total Gini decrease attributed to each feature.</p>
                              </div>

                              <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                                <div className="mb-2 flex items-center gap-1.5"><Dice5 className="h-3 w-3 text-fuchsia-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">MDA (Permutation Importance)</span></div>
                                <div className="space-y-1">
                                  {(signal.ml.mdaImportance || []).slice(0, 8).map((m: any) => (
                                    <div key={m.feature} className="flex items-center gap-2 text-[9px]">
                                      <span className="w-20 shrink-0 text-slate-400">{m.feature}</span>
                                      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-800/60">
                                        <div className={cn("absolute inset-y-0 left-0", m.significant ? "bg-fuchsia-500/60" : "bg-fuchsia-500/30")} style={{ width: `${Math.min(100, Math.abs(m.importance) * 5).toFixed(1)}%` }} />
                                      </div>
                                      <span className="w-12 shrink-0 text-right tabular-nums text-slate-300">{m.importance.toFixed(2)}%</span>
                                      <span className="w-3 shrink-0 text-center text-[8px] text-slate-600">#{m.rank}</span>
                                    </div>
                                  ))}
                                </div>
                                <p className="mt-2 text-[9px] text-slate-600">Shuffle feature, measure accuracy drop. CI [2.5%, 97.5%] from 50 permutations.</p>
                              </div>
                            </div>

                            {/* ── Triple-barrier: fixed vs dynamic ── */}
                            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                              <div className="mb-2 flex items-center gap-1.5"><Target className="h-3 w-3 text-amber-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Triple-Barrier Labeling (Fixed vs Dynamic)</span></div>
                              <div className="grid grid-cols-2 gap-2">
                                <div className="rounded bg-white/[0.03] p-2">
                                  <div className="mb-1 text-[9px] font-bold text-slate-400">Fixed ±2% / 6h</div>
                                  {signal.ml.tripleBarrier && (
                                    <div className="space-y-0.5 text-[9px] tabular-nums">
                                      <div className="flex justify-between"><span className="text-emerald-500/70">↑ up</span><span className="text-slate-300">{signal.ml.tripleBarrier.upPct.toFixed(1)}% <span className="text-[8px] text-slate-600">[{(signal.ml.tripleBarrier.upPctCiLo * 100).toFixed(1)}-{(signal.ml.tripleBarrier.upPctCiHi * 100).toFixed(1)}%]</span></span></div>
                                      <div className="flex justify-between"><span className="text-rose-500/70">↓ down</span><span className="text-slate-300">{signal.ml.tripleBarrier.downPct.toFixed(1)}% <span className="text-[8px] text-slate-600">[{(signal.ml.tripleBarrier.downPctCiLo * 100).toFixed(1)}-{(signal.ml.tripleBarrier.downPctCiHi * 100).toFixed(1)}%]</span></span></div>
                                      <div className="flex justify-between"><span className="text-slate-500">⏱ timeout</span><span className="text-slate-300">{signal.ml.tripleBarrier.timeoutPct.toFixed(1)}% <span className="text-[8px] text-slate-600">[{(signal.ml.tripleBarrier.timeoutPctCiLo * 100).toFixed(1)}-{(signal.ml.tripleBarrier.timeoutPctCiHi * 100).toFixed(1)}%]</span></span></div>
                                    </div>
                                  )}
                                </div>
                                <div className="rounded bg-white/[0.03] p-2">
                                  <div className="mb-1 text-[9px] font-bold text-slate-400">Dynamic ±2×ATR / 6h <Badge className="ml-1 border border-amber-500/30 bg-amber-500/10 px-1 py-0 text-[7px] font-bold text-amber-300">NEW</Badge></div>
                                  {signal.ml.dynamicTripleBarrier && (
                                    <div className="space-y-0.5 text-[9px] tabular-nums">
                                      <div className="flex justify-between"><span className="text-emerald-500/70">↑ up</span><span className="text-slate-300">{signal.ml.dynamicTripleBarrier.upPct.toFixed(1)}% <span className="text-[8px] text-slate-600">[{(signal.ml.dynamicTripleBarrier.upPctCiLo * 100).toFixed(1)}-{(signal.ml.dynamicTripleBarrier.upPctCiHi * 100).toFixed(1)}%]</span></span></div>
                                      <div className="flex justify-between"><span className="text-rose-500/70">↓ down</span><span className="text-slate-300">{signal.ml.dynamicTripleBarrier.downPct.toFixed(1)}% <span className="text-[8px] text-slate-600">[{(signal.ml.dynamicTripleBarrier.downPctCiLo * 100).toFixed(1)}-{(signal.ml.dynamicTripleBarrier.downPctCiHi * 100).toFixed(1)}%]</span></span></div>
                                      <div className="flex justify-between"><span className="text-slate-500">⏱ timeout</span><span className="text-slate-300">{signal.ml.dynamicTripleBarrier.timeoutPct.toFixed(1)}% <span className="text-[8px] text-slate-600">[{(signal.ml.dynamicTripleBarrier.timeoutPctCiLo * 100).toFixed(1)}-{(signal.ml.dynamicTripleBarrier.timeoutPctCiHi * 100).toFixed(1)}%]</span></span></div>
                                      <div className="flex justify-between text-[8px] text-slate-600"><span>avg barrier</span><span>{(signal.ml.dynamicTripleBarrier.avgUpBarrierPct * 100).toFixed(2)}%</span></div>
                                    </div>
                                  )}
                                </div>
                              </div>
                              <p className="mt-2 text-[9px] leading-relaxed text-slate-500">{signal.ml.dynamicTripleBarrier?.description}</p>
                            </div>

                            {/* ── Meta-model summary + return attribution (NEW) ── */}
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                                <div className="mb-2 flex items-center gap-1.5"><Layers className="h-3 w-3 text-purple-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Meta-Labeling Model</span></div>
                                {signal.ml.metaModel && (
                                  <div className="space-y-1 text-[9px]">
                                    <div className="grid grid-cols-2 gap-1">
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">AUC-ROC</div><div className="font-bold tabular-nums text-slate-200">{signal.ml.metaModel.aucROC.toFixed(3)}</div></div>
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">PR-AUC</div><div className="font-bold tabular-nums text-slate-200">{signal.ml.metaModel.prAUC.toFixed(3)}</div></div>
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">Nested CV F1</div><div className={cn("font-bold tabular-nums", signal.ml.metaModel.nestedCVF1 > 0.2 ? "text-emerald-400" : "text-rose-400")}>{signal.ml.metaModel.nestedCVF1.toFixed(2)}</div></div>
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">OOS F1</div><div className={cn("font-bold tabular-nums", signal.ml.metaModel.oosF1 > 0.2 ? "text-emerald-400" : "text-rose-400")}>{signal.ml.metaModel.oosF1.toFixed(2)}</div></div>
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">Isotonic Brier</div><div className="font-bold tabular-nums text-slate-200">{signal.ml.metaModel.isotonicBrier.toFixed(3)}</div></div>
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">Platt Brier</div><div className="font-bold tabular-nums text-slate-200">{signal.ml.metaModel.plattBrier.toFixed(3)}</div></div>
                                    </div>
                                    <div className="text-[8px] text-slate-600">avg uniqueness: {signal.ml.metaModel.avgUniqueness.toFixed(3)} · samples: {signal.ml.metaModel.samples}</div>
                                    {signal.ml.metaModel.dynamicBarrierMetaModel && (
                                      <div className="mt-1 rounded bg-purple-500/[0.06] px-1.5 py-1 text-[8px]">
                                        <div className="font-bold text-purple-300">Return-Attribution Weighting <Badge className="ml-1 border border-purple-500/30 bg-purple-500/10 px-1 py-0 text-[7px] text-purple-300">NEW</Badge></div>
                                        <div className="mt-0.5 text-slate-400">AUC {signal.ml.metaModel.dynamicBarrierMetaModel.aucROC.toFixed(3)} · F1 {signal.ml.metaModel.dynamicBarrierMetaModel.f1Score.toFixed(2)}</div>
                                      </div>
                                    )}
                                    <p className="text-[8px] leading-relaxed text-slate-500">{signal.ml.metaModel.description}</p>
                                  </div>
                                )}
                              </div>

                              <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                                <div className="mb-2 flex items-center gap-1.5"><Wallet className="h-3 w-3 text-cyan-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Return Attribution Weighting <Badge className="ml-1 border border-cyan-500/30 bg-cyan-500/10 px-1 py-0 text-[7px] font-bold text-cyan-300">NEW</Badge></span></div>
                                {signal.ml.returnAttribution && (
                                  <div className="space-y-1 text-[9px]">
                                    <div className="grid grid-cols-2 gap-1">
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">Avg Uniqueness</div><div className="font-bold tabular-nums text-slate-200">{signal.ml.returnAttribution.avgUniqueness.toFixed(3)}</div></div>
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">Avg |return|</div><div className="font-bold tabular-nums text-slate-200">{(signal.ml.returnAttribution.avgReturnAbs * 100).toFixed(2)}%</div></div>
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">Avg Combined W</div><div className="font-bold tabular-nums text-slate-200">{signal.ml.returnAttribution.avgCombinedWeight.toFixed(3)}</div></div>
                                      <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">Weight Range</div><div className="font-bold tabular-nums text-slate-200">[{signal.ml.returnAttribution.minWeight.toFixed(2)}, {signal.ml.returnAttribution.maxWeight.toFixed(2)}]</div></div>
                                    </div>
                                    <p className="text-[8px] leading-relaxed text-slate-500">{signal.ml.returnAttribution.description}</p>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* ── LR test + ablation ── */}
                            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                              <div className="mb-2 flex items-center gap-1.5"><BarChart3 className="h-3 w-3 text-orange-400" /><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Likelihood Ratio + Ablation</span></div>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div>
                                  <div className="mb-1 text-[9px] font-bold text-slate-400">LR Test (whole-model significance)</div>
                                  <div className="grid grid-cols-3 gap-1 text-[9px]">
                                    <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">statistic</div><div className="font-bold tabular-nums text-slate-200">{signal.ml.lrStat.toFixed(2)}</div></div>
                                    <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">df</div><div className="font-bold tabular-nums text-slate-200">{signal.ml.lrDF}</div></div>
                                    <div className="rounded bg-white/[0.03] px-1.5 py-1"><div className="text-[8px] text-slate-500">p-value</div><div className={cn("font-bold tabular-nums", signal.ml.lrPValue < 0.05 ? "text-emerald-400" : "text-rose-400")}>{signal.ml.lrPValue.toFixed(3)}</div></div>
                                  </div>
                                  <p className="mt-1 text-[8px] text-slate-600">{signal.ml.lrPValue < 0.05 ? "Model significant (reject null)." : "Model NOT significant — 8 features collectively no better than base rate."}</p>
                                </div>
                                <div>
                                  <div className="mb-1 text-[9px] font-bold text-slate-400">Ablation (drop each feature, Δ accuracy)</div>
                                  <div className="space-y-0.5 text-[9px]">
                                    {(signal.ml.ablation || []).slice(0, 4).map((a: any) => (
                                      <div key={a.feature} className="flex items-center justify-between rounded bg-white/[0.03] px-1.5 py-0.5">
                                        <span className="text-slate-400">{a.feature}</span>
                                        <span className={cn("tabular-nums", a.accuracyDelta > 0.5 ? "text-rose-400" : a.accuracyDelta < -0.5 ? "text-emerald-400" : "text-slate-400")}>Δ{a.accuracyDelta.toFixed(2)}%</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* ── L2 Collector Health Monitor (infra hardening) ── */}
                            <div className="rounded-lg border border-teal-500/20 bg-teal-500/[0.03] p-3">
                              <div className="mb-2 flex items-center justify-between">
                                <div className="flex items-center gap-1.5">
                                  <Activity className="h-3 w-3 text-teal-400" />
                                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">L2 Collector Health</span>
                                  <Badge className="ml-0.5 border border-teal-500/30 bg-teal-500/10 px-1 py-0 text-[7px] font-bold text-teal-300">MONITOR</Badge>
                                  {l2Health && (
                                    <Badge className={cn(
                                      "ml-1 px-1 py-0 text-[7px] font-bold",
                                      l2Health.status === "healthy" ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                      : l2Health.status === "degraded" ? "border border-amber-500/30 bg-amber-500/10 text-amber-300"
                                      : "border border-rose-500/30 bg-rose-500/10 text-rose-300"
                                    )}>
                                      {l2Health.status?.toUpperCase()}
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[8px] text-slate-600">
                                    {l2HealthLoading ? "refreshing…" : l2Health ? `updated ${formatL2Age(l2Health.generatedAt)}` : "—"}
                                  </span>
                                  {l2Health?.persistedAt && (
                                    <span className="rounded bg-teal-500/10 px-1 py-0 text-[7px] font-bold text-teal-300" title={`Monitor state persisted to DB ${formatL2Age(l2Health.persistedAt)} ago`}>DB✓</span>
                                  )}
                                  <span className={cn("rounded px-1 py-0 text-[7px] font-bold", botCfg?.telegramToken && botCfg?.telegramChatId ? "bg-sky-500/10 text-sky-300" : "bg-slate-500/10 text-slate-500")} title={botCfg?.telegramToken && botCfg?.telegramChatId ? "Telegram alerting configured" : "Telegram not configured (set in Bot Config)"}>
                                    {botCfg?.telegramToken && botCfg?.telegramChatId ? "TG✓" : "TG—"}
                                  </span>
                                  <Button size="sm" variant="outline" className="h-5 border-purple-500/30 bg-purple-500/[0.04] px-1.5 text-[8px] text-purple-300 hover:bg-purple-500/10" onClick={runL2DeepCheck} disabled={l2DeepCheckLoading}>
                                    {l2DeepCheckLoading ? <><Clock className="mr-1 h-2.5 w-2.5 animate-spin" />Checking…</> : "Deep Check"}
                                  </Button>
                                  <Button size="sm" variant="outline" className="h-5 border-teal-500/30 bg-teal-500/[0.04] px-1.5 text-[8px] text-teal-300 hover:bg-teal-500/10" onClick={triggerL2Collect} disabled={l2Collecting}>
                                    {l2Collecting ? <><Clock className="mr-1 h-2.5 w-2.5 animate-spin" />Collecting…</> : "Collect Now"}
                                  </Button>
                                </div>
                              </div>

                              {!l2Health ? (
                                <div className="py-3 text-center text-[9px] text-slate-600">
                                  {l2HealthLoading ? "Loading collector health…" : "Open to load health data."}
                                </div>
                              ) : (
                                <>
                                  {/* Aggregate stats */}
                                  <div className="mb-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                                    <div className="rounded bg-white/[0.03] px-2 py-1.5">
                                      <div className="text-[8px] uppercase text-slate-500">Scheduler</div>
                                      <div className={cn("font-bold tabular-nums", l2Health.schedulerRunning ? "text-emerald-400" : "text-rose-400")}>
                                        {l2Health.schedulerRunning ? "RUNNING" : "STOPPED"}
                                      </div>
                                      <div className="text-[7px] text-slate-600">{l2Health.lastSchedulerTickAt ? `tick ${formatL2Age(l2Health.lastSchedulerTickAt)} ago` : "no tick yet"}</div>
                                    </div>
                                    <div className="rounded bg-white/[0.03] px-2 py-1.5">
                                      <div className="text-[8px] uppercase text-slate-500">Total Attempts</div>
                                      <div className="font-bold tabular-nums text-slate-200">{l2Health.totalAttempts}</div>
                                      <div className="text-[7px] text-slate-600">{l2Health.totalSuccesses} ok · {l2Health.totalFailures} fail</div>
                                    </div>
                                    <div className="rounded bg-white/[0.03] px-2 py-1.5">
                                      <div className="text-[8px] uppercase text-slate-500">Success Rate</div>
                                      <div className={cn("font-bold tabular-nums", l2Health.successRate > 0.9 ? "text-emerald-400" : l2Health.successRate > 0.5 ? "text-amber-400" : "text-rose-400")}>
                                        {(l2Health.successRate * 100).toFixed(0)}%
                                      </div>
                                      <div className="text-[7px] text-slate-600">{l2Health.totalAttempts > 0 ? `${l2Health.totalAttempts} attempts` : "no data"}</div>
                                    </div>
                                    <div className="rounded bg-white/[0.03] px-2 py-1.5">
                                      <div className="text-[8px] uppercase text-slate-500">Active Alerts</div>
                                      <div className={cn("font-bold tabular-nums", (l2Health.alerts?.length ?? 0) === 0 ? "text-emerald-400" : "text-amber-400")}>
                                        {l2Health.alerts?.length ?? 0}
                                      </div>
                                      <div className="text-[7px] text-slate-600">{(l2Health.alerts?.filter((a: any) => a.level === "error").length ?? 0)} error · {(l2Health.alerts?.filter((a: any) => a.level === "warn").length ?? 0)} warn</div>
                                    </div>
                                  </div>

                                  {/* Circuit breaker + persistence row */}
                                  {l2Health.circuitBreaker && (
                                    <div className={cn("mb-2 grid grid-cols-2 gap-1.5 rounded p-2 sm:grid-cols-4", l2Health.circuitBreaker.open ? "border border-rose-500/30 bg-rose-500/[0.06]" : "border border-white/[0.06] bg-white/[0.02]")}>
                                      <div>
                                        <div className="text-[8px] uppercase text-slate-500">Circuit Breaker</div>
                                        <div className={cn("font-bold tabular-nums", l2Health.circuitBreaker.open ? "text-rose-400" : "text-emerald-400")}>
                                          {l2Health.circuitBreaker.open ? "OPEN" : "CLOSED"}
                                        </div>
                                        <div className="text-[7px] text-slate-600">{l2Health.circuitBreaker.open ? (l2Health.circuitBreaker.openUntil && l2Health.circuitBreaker.openUntil > l2Health.generatedAt ? `cooldown ${formatL2Age(l2Health.circuitBreaker.openUntil - l2Health.generatedAt + l2Health.generatedAt)} left` : "half-open probe") : "collecting normally"}</div>
                                      </div>
                                      <div>
                                        <div className="text-[8px] uppercase text-slate-500">CB Trips</div>
                                        <div className="font-bold tabular-nums text-slate-200">{l2Health.circuitBreaker.trips}</div>
                                        <div className="text-[7px] text-slate-600">{l2Health.circuitBreaker.consecutiveBadCycles} bad cycles</div>
                                      </div>
                                      <div>
                                        <div className="text-[8px] uppercase text-slate-500">Persisted</div>
                                        <div className={cn("font-bold tabular-nums", l2Health.persistedAt ? "text-emerald-400" : "text-slate-500")}>
                                          {l2Health.persistedAt ? formatL2Age(l2Health.persistedAt) : "never"}
                                        </div>
                                        <div className="text-[7px] text-slate-600">DB-backed state</div>
                                      </div>
                                      <div>
                                        <div className="text-[8px] uppercase text-slate-500">Metrics</div>
                                        <a href="/api/l2/metrics" target="_blank" rel="noopener noreferrer" className="font-bold text-teal-400 hover:underline">/api/l2/metrics</a>
                                        <div className="text-[7px] text-slate-600">Prometheus format</div>
                                      </div>
                                    </div>
                                  )}

                                  {/* Deep check results */}
                                  {l2DeepCheck && (
                                    <div className={cn("mb-2 rounded border p-2", l2DeepCheck.overall === "pass" ? "border-emerald-500/30 bg-emerald-500/[0.04]" : "border-rose-500/30 bg-rose-500/[0.04]")}>
                                      <div className="mb-1 flex items-center justify-between">
                                        <span className="text-[8px] font-bold uppercase text-slate-400">Deep Check — {l2DeepCheck.overall === "pass" ? "PASS" : "FAIL"}</span>
                                        <span className="text-[7px] text-slate-600">end-to-end pipeline</span>
                                      </div>
                                      <div className="space-y-0.5">
                                        {l2DeepCheck.checks?.map((c: any, i: number) => (
                                          <div key={i} className="flex items-start gap-1 text-[8px]">
                                            {c.status === "pass" ? <CheckCircle2 className="mt-0.5 h-2.5 w-2.5 flex-shrink-0 text-emerald-400" /> : <XCircle className="mt-0.5 h-2.5 w-2.5 flex-shrink-0 text-rose-400" />}
                                            <span className="flex-1"><b className="font-mono text-slate-300">{c.name}</b> <span className="text-slate-500">· {c.durationMs}ms</span> — {c.detail}</span>
                                          </div>
                                        ))}
                                      </div>
                                      {l2DeepCheck.runbookHint && <p className="mt-1 text-[7px] text-slate-500">{l2DeepCheck.runbookHint}</p>}
                                    </div>
                                  )}

                                  {/* Per-pair grid */}
                                  <div className="mb-2">
                                    <div className="mb-1 text-[8px] font-bold text-slate-500">Per-Pair Collection Status (30-min cycle · 3-attempt backoff · validated · circuit-protected)</div>
                                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                                      {(l2Health.pairs || []).map((p: any) => {
                                        const pairStatus = p.consecutiveFailures >= 3 ? "down" : p.consecutiveFailures >= 1 ? "degraded" : (p.lastSuccessAt && (l2Health.generatedAt - p.lastSuccessAt) > 7200) ? "stale" : "healthy";
                                        return (
                                          <div key={p.pair} className="rounded bg-white/[0.03] p-1.5">
                                            <div className="mb-0.5 flex items-center justify-between">
                                              <span className="text-[9px] font-bold text-slate-300">{p.pair}</span>
                                              <span className={cn(
                                                "rounded px-1 py-0 text-[7px] font-bold",
                                                pairStatus === "healthy" ? "bg-emerald-500/15 text-emerald-300"
                                                : pairStatus === "degraded" ? "bg-amber-500/15 text-amber-300"
                                                : pairStatus === "stale" ? "bg-amber-500/15 text-amber-300"
                                                : "bg-rose-500/15 text-rose-300"
                                              )}>{pairStatus.toUpperCase()}</span>
                                            </div>
                                            <div className="space-y-0.5 text-[8px]">
                                              <div className="flex justify-between"><span className="text-slate-500">last success</span><span className="tabular-nums text-slate-300">{p.lastSuccessAt ? `${formatL2Age(p.lastSuccessAt)} ago` : "never"}</span></div>
                                              <div className="flex justify-between"><span className="text-slate-500">consec fails</span><span className={cn("tabular-nums font-bold", p.consecutiveFailures > 0 ? "text-rose-400" : "text-emerald-400")}>{p.consecutiveFailures}</span></div>
                                              <div className="flex justify-between"><span className="text-slate-500">snapshots</span><span className="tabular-nums text-slate-300">{p.lastSnapshotCount}</span></div>
                                              <div className="flex justify-between"><span className="text-slate-500">last retries</span><span className="tabular-nums text-slate-400">{p.lastRetriesUsed}</span></div>
                                              <div className="flex justify-between"><span className="text-slate-500">success rate</span><span className={cn("tabular-nums font-bold", p.totalAttempts > 0 ? (p.totalSuccesses / p.totalAttempts > 0.9 ? "text-emerald-400" : p.totalSuccesses / p.totalAttempts > 0.5 ? "text-amber-400" : "text-rose-400") : "text-slate-500")}>{p.totalAttempts > 0 ? `${((p.totalSuccesses / p.totalAttempts) * 100).toFixed(0)}%` : "—"}<span className="text-slate-600"> ({p.totalAttempts})</span></span></div>
                                            </div>
                                            {p.lastError && (
                                              <div className="mt-0.5 rounded bg-rose-500/[0.06] px-1 py-0.5 text-[7px] leading-tight text-rose-300/80" title={p.lastError}>
                                                {p.lastError.length > 60 ? p.lastError.slice(0, 60) + "…" : p.lastError}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>

                                  {/* Alerts */}
                                  {l2Health.alerts && l2Health.alerts.length > 0 && (
                                    <div className="mb-2 rounded border border-amber-500/20 bg-amber-500/[0.04] p-2">
                                      <div className="mb-1 flex items-center justify-between">
                                        <span className="text-[8px] font-bold uppercase text-amber-400">Alerts ({l2Health.alerts.length})</span>
                                        <button onClick={() => setL2RunbookOpen(true)} className="text-[7px] font-bold text-sky-400 hover:underline">Open Runbook →</button>
                                      </div>
                                      <div className="max-h-24 space-y-0.5 overflow-y-auto">
                                        {l2Health.alerts.map((a: any, i: number) => (
                                          <div key={i} className={cn("flex items-start gap-1 text-[8px]", a.level === "error" ? "text-rose-300" : "text-amber-300")}>
                                            {a.level === "error" ? <XCircle className="mt-0.5 h-2.5 w-2.5 flex-shrink-0" /> : <AlertCircle className="mt-0.5 h-2.5 w-2.5 flex-shrink-0" />}
                                            <span className="flex-1"><b className="font-mono">[{a.pair}]</b> {a.message}{a.detail ? ` — ${a.detail}` : ""}</span>
                                            {a.runbook && (
                                              <button onClick={() => setL2RunbookOpen(true)} className="flex-shrink-0 text-[7px] text-sky-400 hover:underline" title={a.runbook}>runbook</button>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {/* Recent history (per-pair, last few attempts) */}
                                  {(() => {
                                    const allHistory = (l2Health.pairs || []).flatMap((p: any) => (p.history || []).map((h: any) => ({ ...h, pair: p.pair })));
                                    const recent = allHistory.sort((a: any, b: any) => b.ts - a.ts).slice(0, 8);
                                    if (recent.length === 0) return null;
                                    return (
                                      <div className="rounded border border-white/[0.06] bg-white/[0.02] p-2">
                                        <div className="mb-1 text-[8px] font-bold text-slate-500">Recent Collection Attempts</div>
                                        <div className="max-h-28 space-y-0.5 overflow-y-auto">
                                          {recent.map((h: any, i: number) => (
                                            <div key={i} className="flex items-center justify-between text-[8px]">
                                              <span className="flex items-center gap-1">
                                                {h.success ? <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400" /> : <XCircle className="h-2.5 w-2.5 text-rose-400" />}
                                                <span className="font-mono text-slate-400">{h.pair}</span>
                                              </span>
                                              <span className="flex items-center gap-2 text-slate-500">
                                                {h.retriesUsed > 0 && <span className="text-amber-400">{h.retriesUsed}r</span>}
                                                <span className="tabular-nums">{h.durationMs}ms</span>
                                                <span className="tabular-nums">{formatL2Age(h.ts)} ago</span>
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    );
                                  })()}

                                  <p className="mt-1.5 text-[8px] leading-relaxed text-slate-500">
                                    Tracks in-process L2 snapshot collection (every 30 ticks ≈ 30 min for 5 pairs). Each fetch uses 3-attempt exponential backoff (500ms → 1s → 2s, jittered). Snapshots are validated before storage. Circuit breaker opens after 3 consecutive 0-success cycles (5-min→30-min cooldown). State persisted to DB survives hot-reload. External alerts fire on new incidents via Telegram + webhook. Status: <b className="text-emerald-300">healthy</b> = no failures &amp; fresh; <b className="text-amber-300">degraded</b> = recent failure or stale; <b className="text-rose-300">down</b> = 3+ consecutive failures, circuit open, or scheduler dead.
                                  </p>

                                  {/* Runbook (collapsible troubleshooting) */}
                                  <Collapsible open={l2RunbookOpen} onOpenChange={setL2RunbookOpen} className="mt-2">
                                    <CollapsibleTrigger asChild>
                                      <button className="flex w-full items-center justify-between rounded border border-sky-500/20 bg-sky-500/[0.04] px-2 py-1 text-left hover:bg-sky-500/[0.07]">
                                        <span className="text-[8px] font-bold uppercase text-sky-300">L2 Collector Runbook</span>
                                        <ChevronDown className={cn("h-3 w-3 text-sky-300 transition-transform", l2RunbookOpen && "rotate-180")} />
                                      </button>
                                    </CollapsibleTrigger>
                                    <CollapsibleContent className="mt-1 space-y-1.5">
                                      {[
                                        { id: "runbook-outage", title: "outage — 3+ consecutive failures", steps: ["1. Check /api/l2/health?deep=1 → is indodax_depth_api passing?", "2. If INDODAX API down: wait for recovery (circuit breaker auto-skips).", "3. If API up but collection fails: check dev.log for [l2-collector] errors.", "4. Manual probe: curl -X POST /api/l2/collect?force=1", "5. If persists: INDODAX may have rate-limited the depth endpoint."] },
                                        { id: "runbook-stale", title: "stale — snapshot older than 2× candle duration", steps: ["1. Check scheduler status in aggregate stats (RUNNING?).", "2. If STOPPED: the in-process scheduler died — restart dev server.", "3. If RUNNING but stale: last collection cycle may have been skipped by circuit breaker.", "4. Click 'Collect Now' to force a fresh snapshot.", "5. Stale snapshots degrade backtest calibration accuracy but don't break live signals."] },
                                        { id: "runbook-consecutive-failures", title: "consecutive_failures — 1-2 recent failures", steps: ["1. Transient — the retry w/ backoff usually self-heals.", "2. Monitor the per-pair grid; if it escalates to outage (3+), follow the outage runbook.", "3. Check lastError field for the specific failure reason."] },
                                        { id: "runbook-circuit-open", title: "circuit_open — cascade-failure protection active", steps: ["1. The circuit opened after 3 consecutive 0-success collection cycles.", "2. Collection is auto-skipped until cooldown elapses (5min→30min exponential).", "3. After cooldown, a half-open probe runs ONE cycle.", "4. If probe succeeds → circuit closes. If fails → re-opens with longer cooldown.", "5. To override (debugging): curl -X POST '/api/l2/collect?force=1'"] },
                                        { id: "runbook-scheduler-dead", title: "scheduler_dead — no tick in 5 min", steps: ["1. The in-process bot scheduler stopped (dev server crash or hot-reload gap).", "2. Restart: the scheduler auto-starts on first page load via ensureBotScheduler().", "3. If persistent: check dev.log for [bot-scheduler] startup errors.", "4. Note: monitor state is DB-persisted, so stats survive the restart."] },
                                        { id: "runbook-never-collected", title: "never_collected — no snapshot yet", steps: ["1. Normal on first deploy / fresh DB.", "2. Click 'Collect Now' to trigger the first collection.", "3. The scheduler will collect every 30 min going forward."] },
                                      ].map((rb) => (
                                        <div key={rb.id} id={rb.id} className="rounded bg-white/[0.02] p-1.5">
                                          <div className="mb-0.5 text-[8px] font-bold text-sky-300">{rb.title}</div>
                                          <div className="space-y-0.5">
                                            {rb.steps.map((s, si) => (
                                              <div key={si} className="text-[7px] leading-relaxed text-slate-400">{s}</div>
                                            ))}
                                          </div>
                                        </div>
                                      ))}
                                      <div className="rounded bg-sky-500/[0.04] p-1.5 text-[7px] leading-relaxed text-slate-400">
                                        <b className="text-sky-300">Endpoints:</b> GET /api/l2/health (summary) · GET /api/l2/health?deep=1 (end-to-end check) · GET /api/l2/metrics (Prometheus) · POST /api/l2/collect (manual collect, rate-limited 3/60s) · POST /api/l2/collect?force=1 (override circuit breaker)
                                      </div>
                                    </CollapsibleContent>
                                  </Collapsible>
                                </>
                              )}
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    </Card>
                  )}

                  {/* AI Multi-Agent Analysis (TradingAgents-inspired) */}
                  <Card className="border-purple-500/20 bg-purple-500/[0.03]">
                    <div className="p-5">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/15"><Sparkles className="h-4 w-4 text-purple-400" /></div>
                          <div>
                            <h4 className="text-sm font-bold">AI Trading Desk Analysis</h4>
                            <div className="text-[10px] text-slate-500">Multi-agent LLM · Technical + Sentiment + Risk → Final recommendation</div>
                          </div>
                        </div>
                        <Button size="sm" variant="outline" className="border-purple-500/30 bg-purple-500/[0.04] text-purple-300 hover:bg-purple-500/10" onClick={fetchAiAnalysis} disabled={aiLoading || !signal}>
                          {aiLoading ? <><Clock className="h-3.5 w-3.5 animate-spin" /> Analyzing…</> : <><Sparkles className="h-3.5 w-3.5" /> Run AI Analysis</>}
                        </Button>
                      </div>
                      {aiAnalysis ? (
                        <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-300 rounded-lg border border-purple-500/10 bg-purple-500/[0.02] p-3 max-h-96 overflow-y-auto">{aiAnalysis}</div>
                      ) : (
                        <div className="text-center py-6 text-[11px] text-slate-600">
                          Klik "Run AI Analysis" untuk generate multi-perspective analysis dari LLM trading desk. AI akan synthesize semua data (regime + TA + volume + funding + backtest) jadi rekomendasi qualitative.
                        </div>
                      )}
                    </div>
                  </Card>

                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.05] p-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <p className="text-[11px] leading-relaxed text-amber-200/80">
                      Signal ini dihitung dari data real INDODAX ({signal.candleCount} candle 1h) + daily trend filter + ATR-based sizing. <b>Tapi:</b> walk-forward strategy masih di bawah 70% consistent (overfit risk). Backtest dulu di tab Backtest sebelum eksekusi. Fee INDODAX 0.3% taker belum termasuk di P&L. <b>Bukan saran investasi</b> — lakukan riset sendiri, gunakan stop loss, mulai modal kecil.
                    </p>
                  </div>
                </div>
              )}
            </TabsContent>


            {/* ════ MARKET TAB ════ */}
            <TabsContent value="market" className="space-y-5">
              {/* Ticker grid */}
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <CircleDot className="h-3.5 w-3.5 text-slate-500" />
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Live Tickers</h2>
                  <span className="text-[10px] text-slate-600">refreshes every 30s</span>
                </div>
                {loading ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-[112px] animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]" />)}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    {tickers.map((t) => {
                      const isSel = t.pair === selectedPair;
                      const last = parseFloat(t.ticker.last);
                      const high = parseFloat(t.ticker.high);
                      const low = parseFloat(t.ticker.low);
                      const buy = parseFloat(t.ticker.buy);
                      const spread = last - buy;
                      const spreadPct = last > 0 ? (spread / last) * 100 : 0;
                      return (
                        <button key={t.pair} onClick={() => setSelectedPair(t.pair)} className={cn("group relative overflow-hidden rounded-xl border p-3 text-left transition-all", isSel ? "border-emerald-500/40 bg-emerald-500/[0.04] ring-1 ring-emerald-500/20" : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]")}>
                          {isSel && <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-emerald-400 to-teal-500" />}
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="text-sm font-bold uppercase text-slate-200">{t.pair.replace("_idr", "")}</div>
                              <div className="text-[9px] text-slate-500">{COIN_NAMES[t.pair] || "—"}</div>
                            </div>
                            {isSel && <div className="rounded bg-emerald-500/15 px-1 py-0.5 text-[8px] font-bold text-emerald-400">ACTIVE</div>}
                          </div>
                          <div className="mt-1.5 text-sm font-bold tabular-nums text-slate-100">{fmtIDR(last)}</div>
                          <div className="mt-2"><RangeBar low={low} high={high} last={last} /></div>
                          <div className="mt-1 flex justify-between text-[9px] text-slate-600">
                            <span>spread <span className="tabular-nums text-slate-400">{spreadPct.toFixed(2)}%</span></span>
                            <span>vol <span className="tabular-nums text-slate-400">{fmtCompact(parseFloat(t.ticker.vol_idr || "0"))}</span></span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Research + Order book */}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
                {/* Research card */}
                <Card className="relative col-span-1 overflow-hidden border-white/[0.08] bg-white/[0.03] lg:col-span-2">
                  {research && signalMeta && (
                    <div className={cn("absolute inset-x-0 top-0 h-[3px]", signalMeta.color === "emerald" ? "bg-gradient-to-r from-emerald-400 to-teal-500" : signalMeta.color === "rose" ? "bg-gradient-to-r from-rose-500 to-red-600" : "bg-gradient-to-r from-amber-400 to-orange-500")} />
                  )}
                  <div className="p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/15"><Activity className="h-4 w-4 text-blue-400" /></div>
                        <div>
                          <h3 className="text-sm font-bold">Market Research</h3>
                          <div className="text-[10px] text-slate-500">{selectedPair.toUpperCase()} · TA + sentiment</div>
                        </div>
                      </div>
                      {research && signalMeta && (
                        <div className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold", signalMeta.color === "emerald" ? "bg-emerald-500/15 text-emerald-400" : signalMeta.color === "rose" ? "bg-rose-500/15 text-rose-400" : "bg-amber-500/15 text-amber-400")}>
                          <signalMeta.Icon className="h-4 w-4" /> {research.signal}
                        </div>
                      )}
                    </div>

                    {!research ? (
                      <div className="flex h-40 items-center justify-center text-xs text-slate-600">Loading research…</div>
                    ) : (
                      <div className="space-y-4">
                        {/* top metrics */}
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
                            <div className="text-[10px] uppercase text-slate-500">Last Price</div>
                            <div className="mt-0.5 text-sm font-bold tabular-nums">{fmtIDR(research.indicators.currentPrice)}</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
                            <div className="text-[10px] uppercase text-slate-500">Timeframe</div>
                            <div className="mt-0.5 text-sm font-bold capitalize">{research.timeframe}</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
                            <div className="text-[10px] uppercase text-slate-500">Position Size</div>
                            <div className="mt-0.5 text-sm font-bold text-blue-300">{research.positionSize}</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
                            <div className="text-[10px] uppercase text-slate-500">Vol 24h</div>
                            <div className="mt-0.5 text-sm font-bold tabular-nums">{fmtCompact(research.indicators.volume24h)}</div>
                          </div>
                        </div>

                        {/* Entry / SL / TP */}
                        <div className="grid grid-cols-3 gap-3">
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                            <div className="flex items-center gap-1 text-[10px] uppercase text-slate-500"><Target className="h-3 w-3" /> Entry</div>
                            <div className="mt-1 text-sm font-bold tabular-nums text-slate-200">{fmtIDR(research.entry)}</div>
                          </div>
                          <div className="rounded-lg border border-rose-500/15 bg-rose-500/[0.04] p-3">
                            <div className="flex items-center gap-1 text-[10px] uppercase text-rose-400/70"><Shield className="h-3 w-3" /> Stop Loss</div>
                            <div className="mt-1 text-sm font-bold tabular-nums text-rose-300">{fmtIDR(research.stopLoss)}</div>
                          </div>
                          <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.04] p-3">
                            <div className="flex items-center gap-1 text-[10px] uppercase text-emerald-400/70"><Zap className="h-3 w-3" /> Take Profit</div>
                            <div className="mt-1 text-sm font-bold tabular-nums text-emerald-300">{fmtIDR(research.takeProfit)}</div>
                          </div>
                        </div>

                        {/* gauges */}
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <RsiGauge rsi={research.indicators.rsi14} />
                          <BiasMeter bias={research.bias} strength={research.strength} />
                        </div>

                        {/* indicator chips */}
                        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                          {[
                            { label: "SMA10", v: research.indicators.sma10, f: (x: number) => fmtCompact(x) },
                            { label: "SMA20", v: research.indicators.sma20, f: (x: number) => fmtCompact(x) },
                            { label: "EMA12", v: research.indicators.ema12, f: (x: number) => fmtCompact(x) },
                            { label: "EMA26", v: research.indicators.ema26, f: (x: number) => fmtCompact(x) },
                            { label: "MACD", v: research.indicators.macd?.histogram, f: (x: number) => x.toFixed(2) },
                            { label: "Stoch %K", v: research.indicators.stochasticK, f: (x: number) => x.toFixed(0) },
                          ].map((m) => (
                            <div key={m.label} className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                              <div className="text-[9px] uppercase text-slate-500">{m.label}</div>
                              <div className="text-xs font-bold tabular-nums">{m.v != null ? m.f(m.v as number) : "—"}</div>
                            </div>
                          ))}
                        </div>

                        {/* signals list */}
                        <div>
                          <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500"><Layers className="h-3 w-3" /> Signals ({research.signals.length})</div>
                          <ScrollArea className="max-h-40">
                            <div className="space-y-1 pr-2">
                              {research.signals.map((s, i) => (
                                <div key={i} className="flex items-start gap-2 rounded-md border border-white/[0.04] bg-white/[0.02] px-2 py-1.5 text-[11px] text-slate-300">
                                  <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-slate-500" /> {s}
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        </div>

                        {/* narrative */}
                        <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[11px] leading-relaxed text-slate-400">{research.narrative}</p>

                        <div className="flex items-start gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.05] p-2.5">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                          <p className="text-[10px] leading-relaxed text-amber-200/80">{research.riskWarning}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </Card>

                {/* Order book */}
                <Card className="overflow-hidden border-white/[0.08] bg-white/[0.03]">
                  <div className="p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/15"><BarChart3 className="h-4 w-4 text-purple-400" /></div>
                        <div>
                          <h3 className="text-sm font-bold">Order Book</h3>
                          <div className="text-[10px] text-slate-500">{selectedPair.toUpperCase()}</div>
                        </div>
                      </div>
                    </div>

                    {!depth ? (
                      <div className="flex h-40 items-center justify-center text-xs text-slate-600">Loading depth…</div>
                    ) : (
                      <DepthBook depth={depth} />
                    )}
                  </div>
                </Card>
              </div>
            </TabsContent>

            {/* ════ BACKTEST TAB ════ */}
            <TabsContent value="backtest" className="space-y-5">
              <Card className="border-white/[0.08] bg-white/[0.03]">
                <div className="p-5">
                  <div className="mb-4 flex items-center gap-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/15"><FlaskConical className="h-4 w-4 text-purple-400" /></div>
                    <div>
                      <h3 className="text-sm font-bold">Backtest Engine</h3>
                      <div className="text-[10px] text-slate-500">{selectedPair.toUpperCase()} · DaviddTech strategy framework · risk + position models</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div>
                      <Label className="text-[11px] text-slate-400">Strategy</Label>
                      <Select value={btStrategy} onValueChange={setBtStrategy}>
                        <SelectTrigger className="mt-1 border-white/10 bg-white/[0.03]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sma_cross">SMA Crossover</SelectItem>
                          <SelectItem value="rsi_reversal">RSI Reversal</SelectItem>
                          <SelectItem value="bollinger_breakout">Bollinger Breakout</SelectItem>
                          <SelectItem value="macd_trend">MACD Trend</SelectItem>
                          <SelectItem value="stochastic_reversal">Stochastic Reversal</SelectItem>
                          <SelectItem value="mean_reversion">Mean Reversion (z-score)</SelectItem>
                          <SelectItem value="multi_confluence">Multi Confluence</SelectItem>
                          <SelectItem value="trend_filter_sma">Trend Filter SMA (ADX)</SelectItem>
                          <SelectItem value="donchian_breakout">Donchian Breakout</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-[11px] text-slate-400">Timeframe</Label>
                      <Select value={btTf} onValueChange={setBtTf}>
                        <SelectTrigger className="mt-1 border-white/10 bg-white/[0.03]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1h">1 hour</SelectItem>
                          <SelectItem value="1d">1 day</SelectItem>
                          <SelectItem value="15m">15 min</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div><Label className="text-[11px] text-slate-400">Capital (IDR)</Label><Input value={btCapital} onChange={e => setBtCapital(e.target.value)} className="mt-1 border-white/10 bg-white/[0.03] font-mono text-sm tabular-nums" /></div>
                    <div><Label className="text-[11px] text-slate-400">Stop Loss (%)</Label><Input value={btSL} onChange={e => setBtSL(e.target.value)} className="mt-1 border-white/10 bg-white/[0.03] font-mono text-sm tabular-nums" /></div>
                    <div><Label className="text-[11px] text-slate-400">Take Profit (%)</Label><Input value={btTP} onChange={e => setBtTP(e.target.value)} className="mt-1 border-white/10 bg-white/[0.03] font-mono text-sm tabular-nums" /></div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button onClick={runBt} disabled={btLoading} className="gap-2 bg-purple-600 hover:bg-purple-700">
                      {btLoading ? <><Clock className="h-4 w-4 animate-spin" /> Running…</> : <><FlaskConical className="h-4 w-4" /> Run Backtest</>}
                    </Button>
                    <Button onClick={fetchHistory} disabled={histLoading} variant="outline" className="gap-2 border-white/10 bg-white/[0.03]">
                      {histLoading ? <><Clock className="h-4 w-4 animate-spin" /> Fetching…</> : <><BarChart3 className="h-4 w-4" /> Fetch 90d History</>}
                    </Button>
                    <Button onClick={compareStrategies} disabled={compareLoading} variant="outline" className="gap-2 border-purple-500/30 bg-purple-500/[0.04] text-purple-300 hover:bg-purple-500/10">
                      {compareLoading ? <><Clock className="h-4 w-4 animate-spin" /> Comparing…</> : <><Sparkles className="h-4 w-4" /> Compare All Strategies</>}
                    </Button>
                    <span className="text-[10px] text-slate-500">Fee 0.3% taker · MC 1000 sims · ATR sizing · grid search</span>
                  </div>
                  {tradeStatus && <div className="mt-2 text-[11px] text-slate-400">{tradeStatus}</div>}
                </div>
              </Card>

              {compareResult && (
                <Card className="border-purple-500/20 bg-purple-500/[0.03]">
                  <div className="p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-purple-400" /><h3 className="text-sm font-bold">Strategy Comparison</h3></div>
                      {compareResult.dataSource && <Badge className="border-purple-500/30 bg-purple-500/10 text-[9px] text-purple-300">{compareResult.dataSource.candleCount}×{compareResult.dataSource.timeframe} · {compareResult.dataSource.windowDays}d</Badge>}
                    </div>
                    {/* Buy & Hold benchmark banner */}
                    {compareResult.buyHold && (
                      <div className={cn("mb-4 flex items-center justify-between rounded-lg border p-3", compareResult.buyHold.pct >= 0 ? "border-emerald-500/20 bg-emerald-500/[0.04]" : "border-rose-500/20 bg-rose-500/[0.04]")}>
                        <div className="flex items-center gap-2"><TrendingUp className={cn("h-4 w-4", compareResult.buyHold.pct >= 0 ? "text-emerald-400" : "text-rose-400")} /><span className="text-xs font-bold uppercase text-slate-300">Buy &amp; Hold Benchmark</span></div>
                        <div className="text-right">
                          <div className={cn("text-sm font-bold tabular-nums", compareResult.buyHold.pct >= 0 ? "text-emerald-400" : "text-rose-400")}>{compareResult.buyHold.pct >= 0 ? "+" : ""}{compareResult.buyHold.pct.toFixed(1)}%</div>
                          <div className="text-[10px] text-slate-500 tabular-nums">{fmtIDR(compareResult.buyHold.netProfit)} · target to beat</div>
                        </div>
                      </div>
                    )}
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-white/10 text-[10px] uppercase text-slate-500">
                            <th className="py-2 pr-3 text-left">#</th><th className="pr-3 text-left">Strategy</th><th className="pr-3 text-right">Trades</th>
                            <th className="pr-3 text-right">Net P&L</th><th className="pr-3 text-right">PF</th><th className="pr-3 text-right">Win%</th>
                            <th className="pr-3 text-right">Sharpe</th><th className="pr-3 text-right">MaxDD</th>
                            <th className="pr-3 text-right">MC Bust</th><th className="pr-2 text-right">vs B&H</th>
                          </tr>
                        </thead>
                        <tbody>
                          {compareResult.comparison?.map((s: any) => {
                            const beats = compareResult.buyHold ? s.netProfit > compareResult.buyHold.netProfit : null;
                            const isBH = s.strategy === "buy_hold";
                            return (
                            <tr key={s.strategy} className={cn("border-b border-white/[0.04]", s.rank === 1 ? "bg-emerald-500/[0.04]" : "", isBH ? "bg-white/[0.02] italic" : "")}>
                              <td className="py-2 pr-3"><span className={cn("font-bold", s.rank === 1 ? "text-emerald-400" : "text-slate-400")}>{s.rank}</span></td>
                              <td className="pr-3 font-medium text-slate-200">{isBH ? "buy & hold" : s.strategy.replace(/_/g, " ")}</td>
                              <td className="pr-3 text-right tabular-nums text-slate-400">{s.trades ?? 0}</td>
                              <td className={cn("pr-3 text-right tabular-nums font-bold", (s.netProfit ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>{fmtIDR(s.netProfit ?? 0)}</td>
                              <td className="pr-3 text-right tabular-nums text-slate-300">{(s.profitFactor ?? 0) >= 999 ? "∞" : (s.profitFactor ?? 0).toFixed(2)}</td>
                              <td className="pr-3 text-right tabular-nums text-slate-400">{(s.winRate ?? 0).toFixed(0)}%</td>
                              <td className={cn("pr-3 text-right tabular-nums", (s.sharpeRatio ?? 0) > 1 ? "text-emerald-400" : (s.sharpeRatio ?? 0) < 0 ? "text-rose-400" : "text-slate-400")}>{(s.sharpeRatio ?? 0).toFixed(2)}</td>
                              <td className="pr-3 text-right tabular-nums text-rose-400">{(s.maxDrawdown ?? 0).toFixed(0)}%</td>
                              <td className={cn("pr-3 text-right tabular-nums font-bold", s.monteCarloBust == null ? "text-slate-600" : s.monteCarloBust > 30 ? "text-rose-400" : s.monteCarloBust > 10 ? "text-amber-400" : "text-emerald-400")}>{s.monteCarloBust == null ? "—" : s.monteCarloBust.toFixed(0) + "%"}</td>
                              <td className="pr-2 text-right">{isBH ? <span className="text-slate-600 text-[9px]">benchmark</span> : beats ? <span className="text-emerald-400 text-[9px] font-bold">✓ beats</span> : <span className="text-rose-400 text-[9px] font-bold">✗ below</span>}</td>
                            </tr>
                          ); })}
                        </tbody>
                      </table>
                    </div>
                    {compareResult.gridSearch && compareResult.gridSearch.length > 0 && (
                      <div className="mt-4">
                        <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Grid Search — top SL/TP combos for {btStrategy.replace(/_/g, " ")}</div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                          {compareResult.gridSearch.slice(0, 5).map((g: any, i: number) => (
                            <div key={i} className={cn("rounded-lg border p-2", i === 0 ? "border-emerald-500/30 bg-emerald-500/[0.04]" : "border-white/[0.06] bg-white/[0.02]")}>
                              <div className="text-[9px] text-slate-500">SL {g.stopLoss * 100}% / TP {g.takeProfit * 100}%</div>
                              <div className="text-xs font-bold tabular-nums">{fmtIDR(g.netProfit)}</div>
                              <div className="text-[9px] text-slate-400">PF {g.profitFactor >= 999 ? "∞" : g.profitFactor.toFixed(2)} · {g.trades} trades</div>
                              <div className="text-[9px] text-slate-500">{g.monteCarloBust === null ? "" : "MC bust " + g.monteCarloBust.toFixed(0) + "%"}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Walk-Forward Analysis */}
                    {compareResult.walkForward && (
                      <div className="mt-4">
                        <div className="mb-2 flex items-center gap-2">
                          <Shield className="h-3.5 w-3.5 text-blue-400" />
                          <span className="text-[10px] uppercase tracking-wide text-slate-500">Walk-Forward Validation — {btStrategy.replace(/_/g, " ")}</span>
                          <Badge className={cn("border px-1.5 py-0 text-[8px] font-bold", compareResult.walkForward.overfitRisk === "low" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : compareResult.walkForward.overfitRisk === "medium" ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300")}>
                            overfit: {compareResult.walkForward.overfitRisk.toUpperCase()}
                          </Badge>
                          {compareResult.walkForward.profitabilityScore !== undefined && (
                            <Badge className={cn("border px-1.5 py-0 text-[8px] font-bold", compareResult.walkForward.profitabilityScore >= 70 ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : compareResult.walkForward.profitabilityScore >= 40 ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300")}>
                              test-profitable: {compareResult.walkForward.profitabilityScore.toFixed(0)}%
                            </Badge>
                          )}
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                          {compareResult.walkForward.segments.map((seg: any) => (
                            <div key={seg.segment} className={cn("rounded-lg border p-2", seg.testProfitable ? "border-emerald-500/20 bg-emerald-500/[0.03]" : "border-rose-500/20 bg-rose-500/[0.03]")}>
                              <div className="text-[9px] text-slate-500">Seg {seg.segment}</div>
                              <div className="text-[9px] text-slate-400">train PF {seg.trainPF >= 999 ? "∞" : seg.trainPF.toFixed(2)} ({seg.trainTrades}t)</div>
                              <div className="text-[9px] text-slate-300">test PF {seg.testPF >= 999 ? "∞" : seg.testPF.toFixed(2)} ({seg.testTrades}t)</div>
                              <div className={cn("text-[10px] font-bold", seg.testProfitable ? "text-emerald-400" : "text-rose-400")}>{seg.testProfitable ? "✓ profit" : "✗ loss"}</div>
                            </div>
                          ))}
                        </div>
                        <p className="mt-2 text-[10px] text-slate-500">
                          {compareResult.walkForward.summary}. Walk-forward split jadi 4 segment (70% train / 30% test). "✓ profit" = test segment menghasilkan net profit. <b>test-profitable ≥70%</b> = strategi profitable di mayoritas periode (overfit LOW). <b>PF-consistency</b> = test PF ≥ 50% train PF (metric lebih ketat).
                        </p>
                      </div>
                    )}
                    <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
                      Ranked by composite score (log(PF) + Sharpe − bust penalty). Buy &amp; Hold = benchmark yang harus dikalahin. #1 (green) = strategi terbaik. "✓ beats" = ngalahin buy &amp; hold. Grid search + walk-forward untuk strategi terpilih. Fee 0.3% masuk semua.
                    </p>

                    {/* P4: Block Correlation Analysis */}
                    {compareResult.deflatedSharpe?.effTrialsInfo?.blockCorrelation && (
                      <div className="mt-3 rounded-lg border border-orange-500/20 bg-orange-500/[0.03] p-3">
                        <div className="mb-2 flex items-center gap-1.5">
                          <GitBranch className="h-3 w-3 text-orange-400" />
                          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Block Correlation Analysis <Badge className="ml-1 border border-orange-500/30 bg-orange-500/10 px-1 py-0 text-[7px] font-bold text-orange-300">NEW</Badge></span>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          {[
                            { label: "Trend-following", block: compareResult.deflatedSharpe.effTrialsInfo.blockCorrelation.trendBlock, color: "text-amber-400" },
                            { label: "Mean-reversion", block: compareResult.deflatedSharpe.effTrialsInfo.blockCorrelation.reversionBlock, color: "text-cyan-400" },
                            { label: "Confluence", block: compareResult.deflatedSharpe.effTrialsInfo.blockCorrelation.confluenceBlock, color: "text-purple-400" },
                          ].map(({ label, block, color }) => (
                            <div key={label} className="rounded bg-white/[0.03] p-2">
                              <div className="mb-1 flex items-center justify-between">
                                <span className={cn("text-[10px] font-bold", color)}>{label}</span>
                                <span className="text-[8px] text-slate-600">{block.size} strat · {block.pairs} pairs</span>
                              </div>
                              <div className="grid grid-cols-3 gap-1 text-[9px]">
                                <div><div className="text-[8px] text-slate-500">avg ρ</div><div className={cn("font-bold tabular-nums", block.avgCorrelation > 0.7 ? "text-rose-400" : block.avgCorrelation > 0.4 ? "text-amber-400" : "text-emerald-400")}>{block.avgCorrelation.toFixed(2)}</div></div>
                                <div><div className="text-[8px] text-slate-500">max ρ</div><div className="font-bold tabular-nums text-slate-300">{block.maxCorrelation.toFixed(2)}</div></div>
                                <div><div className="text-[8px] text-slate-500">min ρ</div><div className="font-bold tabular-nums text-slate-300">{block.minCorrelation.toFixed(2)}</div></div>
                              </div>
                              {/* P4: Effective N per block (both methods) */}
                              <div className="mt-1 rounded bg-orange-500/[0.08] px-1.5 py-0.5 text-[8px]">
                                <div className="flex justify-between">
                                  <span className="text-slate-500">Eff N (avg-ρ)</span>
                                  <span className={cn("font-bold tabular-nums", block.effectiveNPct < 50 ? "text-rose-400" : block.effectiveNPct < 80 ? "text-amber-400" : "text-emerald-400")}>{block.effectiveN.toFixed(1)} / {block.size} <span className="text-slate-600">({block.effectiveNPct.toFixed(0)}%)</span></span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-slate-500">Eff N (eigen)</span>
                                  <span className={cn("font-bold tabular-nums", block.effectiveNEigenPct < 50 ? "text-rose-400" : block.effectiveNEigenPct < 80 ? "text-amber-400" : "text-emerald-400")}>{block.effectiveNEigen.toFixed(1)} / {block.size} <span className="text-slate-600">({block.effectiveNEigenPct.toFixed(0)}%)</span></span>
                                </div>
                                <div className="mt-0.5 flex items-center justify-between border-t border-orange-500/10 pt-0.5">
                                  <span className="text-slate-500">Consistency</span>
                                  <span className={cn("font-bold", block.methodsAgree ? "text-emerald-400" : "text-rose-400")}>
                                    {block.methodsAgree ? "✓ agree" : "✗ disagree"} <span className="text-slate-600">Δ={block.agreementDelta.toFixed(2)}</span>
                                  </span>
                                </div>
                              </div>
                              <p className="mt-1 text-[8px] leading-relaxed text-slate-600">{block.interpretation}</p>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 rounded bg-white/[0.02] p-2 text-[9px] sm:grid-cols-3">
                          <div><div className="text-[8px] text-slate-500">Cross-block avg ρ</div><div className="font-bold tabular-nums text-slate-300">{compareResult.deflatedSharpe.effTrialsInfo.blockCorrelation.crossBlockAvg.toFixed(3)}</div></div>
                          <div><div className="text-[8px] text-slate-500">Cross-block max ρ</div><div className="font-bold tabular-nums text-slate-300">{compareResult.deflatedSharpe.effTrialsInfo.blockCorrelation.crossBlockMax.toFixed(3)}</div></div>
                          <div><div className="text-[8px] text-slate-500">Overall avg ρ</div><div className="font-bold tabular-nums text-slate-300">{compareResult.deflatedSharpe.effTrialsInfo.blockCorrelation.overallAvg.toFixed(3)}</div></div>
                        </div>
                        <p className="mt-2 text-[9px] leading-relaxed text-slate-500">
                          Intra-block ρ &gt; 0.7 = strategies redundant (effectively 1 strategy). Cross-block ρ &gt; 0.5 = trend and reversion strategies move together (rare). High overall ρ inflates the apparent trial count → PBO/DSR must use the <i>effective</i> trials (participation ratio), not the raw N. Here: N={compareResult.deflatedSharpe.trials} effective trials from {compareResult.deflatedSharpe.nStrategies} strategies.
                        </p>
                      </div>
                    )}
                  </div>
                </Card>
              )}

              {btError && !btResult && (
                <Card className="border-rose-500/20 bg-rose-500/[0.03]">
                  <div className="p-6 text-center">
                    <AlertTriangle className="mx-auto h-8 w-8 text-rose-400 mb-2" />
                    <h4 className="text-sm font-bold text-rose-300">Backtest Error</h4>
                    <p className="mt-1 text-[11px] text-slate-400">{btError}</p>
                    {/* Structured error detail (priority #5) — classify the failure mode */}
                    <div className="mx-auto mt-3 max-w-md rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-left">
                      <div className="mb-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-500">Diagnostic Detail</div>
                      {(() => {
                        const isTimeout = btError.toLowerCase().includes("timed out");
                        const isL2 = btError.toLowerCase().includes("l2") || btError.toLowerCase().includes("depth") || btError.toLowerCase().includes("order book");
                        const isUnavailable = btError.toLowerCase().includes("unavailable") || btError.toLowerCase().includes("failed");
                        return (
                          <div className="space-y-1 text-[9px] text-slate-400">
                            <div className="flex items-start gap-1.5">
                              <span className={cn("mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full", isTimeout ? "bg-amber-400" : isL2 ? "bg-teal-400" : "bg-rose-400")} />
                              <span><b className="text-slate-300">Failure mode:</b> {isTimeout ? "Server timeout (30s) — heavy compute (Monte Carlo + L2 fetch + microstructure) exceeded the client-side abort threshold." : isL2 ? "L2 order book fetch/validate failure — INDODAX depth API returned empty or invalid data. The collector now retries with exponential backoff." : isUnavailable ? "Server unreachable — the API route may have crashed or the dev server restarted." : "API returned an error response."}</span>
                            </div>
                            <div className="flex items-start gap-1.5">
                              <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
                              <span><b className="text-slate-300">Likely cause:</b> {isTimeout ? "Sandbox resource limits under concurrent load." : isL2 ? "Transient INDODAX API issue or invalid depth payload (crossed book / empty OB rejected by validator)." : "Process restart or unhandled exception in backtest route."}</span>
                            </div>
                            <div className="flex items-start gap-1.5">
                              <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
                              <span><b className="text-slate-300">Suggested action:</b> {isTimeout ? "Retry — the engine auto-retries L2 fetches 3× with backoff. If persistent, reduce backtest window." : isL2 ? "Retry. Check the L2 Collector Health monitor in Research Lab for per-pair status." : "Retry after a few seconds; check dev server logs if persistent."}</span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-500">The backtest engine includes L2 order book fetching (3-attempt exponential backoff), realistic limit execution simulation, and microstructure analysis which may require significant server resources.</p>
                    <div className="mt-3 flex items-center justify-center gap-2">
                      <Button size="sm" variant="outline" className="border-rose-500/30 bg-rose-500/[0.04] text-rose-300 hover:bg-rose-500/10" onClick={runBt} disabled={btLoading}>
                        {btLoading ? <><Clock className="h-3.5 w-3.5 animate-spin" /> Retrying…</> : "Retry Backtest"}
                      </Button>
                      {!labOpen && (
                        <Button size="sm" variant="ghost" className="text-teal-300 hover:bg-teal-500/10" onClick={() => setLabOpen(true)}>
                          <Activity className="mr-1 h-3.5 w-3.5" /> Open L2 Health Monitor
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              )}

              {btResult && (
                <div className="space-y-5">
                  {/* verdict banner + data source */}
                  <div className={cn("flex items-center justify-between rounded-xl border p-4", btResult.risk.verdict === "Reject" ? "border-rose-500/30 bg-rose-500/[0.06]" : btResult.risk.verdict.includes("Production") ? "border-emerald-500/30 bg-emerald-500/[0.06]" : btResult.risk.verdict === "Watchlist" ? "border-amber-500/30 bg-amber-500/[0.06]" : "border-slate-500/20 bg-white/[0.03]")}>
                    <div className="flex items-center gap-3">
                      <Sparkles className={cn("h-5 w-5", btResult.risk.verdict === "Reject" ? "text-rose-400" : btResult.risk.verdict.includes("Production") ? "text-emerald-400" : "text-amber-400")} />
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">Risk Verdict</div>
                        <div className="text-base font-bold">{btResult.risk.verdict}</div>
                        {btResult.dataSource && (
                          <div className="text-[10px] text-slate-400 mt-0.5">{btResult.dataSource.source === "historical" ? "HISTORICAL" : "REAL"} · {btResult.dataSource.candleCount}×{btResult.dataSource.timeframe} · {btResult.dataSource.windowDays}d · fee {(btResult.dataSource.feeRate ?? 0.003) * 100}%</div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {btResult.risk.red.length > 0 && <Badge className="border-rose-500/30 bg-rose-500/10 text-rose-300">{btResult.risk.red.length} red</Badge>}
                      {btResult.risk.yellow.length > 0 && <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-300">{btResult.risk.yellow.length} yellow</Badge>}
                      {btResult.risk.green.length > 0 && <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">{btResult.risk.green.length} green</Badge>}
                    </div>
                  </div>

                  {/* metric cards — fee-adjusted */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                    <MetricCard label="Net Profit" value={fmtIDR(btResult.result.netProfit)} tone={btResult.result.netProfit >= 0 ? "up" : "down"} />
                    <MetricCard label="Win Rate" value={`${btResult.result.winRate.toFixed(1)}%`} tone={btResult.result.winRate >= 50 ? "up" : "down"} />
                    <MetricCard label="Max DD" value={`${btResult.result.maxDrawdown.toFixed(1)}%`} tone="down" />
                    <MetricCard label="Sharpe" value={btResult.result.sharpeRatio.toFixed(2)} tone={btResult.result.sharpeRatio > 1 ? "up" : "neutral"} />
                    <MetricCard label="Sortino" value={btResult.result.sortinoRatio.toFixed(2)} tone={btResult.result.sortinoRatio > 1.5 ? "up" : "neutral"} />
                    <MetricCard label="Profit Factor" value={isFinite(btResult.result.profitFactor) ? btResult.result.profitFactor.toFixed(2) : "∞"} tone={btResult.result.profitFactor > 1.4 ? "up" : "neutral"} />
                    <MetricCard label="Total Fees" value={fmtIDR(btResult.result.totalFees)} tone="down" />
                  </div>

                  {/* Monte Carlo panel */}
                  {btResult.result.monteCarlo ? (
                    <Card className="border-purple-500/20 bg-purple-500/[0.03]">
                      <div className="p-5">
                        <div className="mb-3 flex items-center justify-between">
                          <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-purple-400" /><h4 className="text-sm font-bold">Monte Carlo Analysis</h4></div>
                          <Badge className="border-purple-500/30 bg-purple-500/10 text-[9px] text-purple-300">{btResult.result.monteCarlo.simulations} sims · bust @ -{btResult.result.monteCarlo.bustThreshold}%</Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <div className={cn("rounded-lg border p-3", btResult.result.monteCarlo.bustProbability > 30 ? "border-rose-500/20 bg-rose-500/[0.04]" : btResult.result.monteCarlo.bustProbability > 10 ? "border-amber-500/20 bg-amber-500/[0.04]" : "border-emerald-500/20 bg-emerald-500/[0.04]")}>
                            <div className="text-[10px] uppercase text-slate-500">Bust Probability</div>
                            <div className={cn("text-lg font-bold tabular-nums", btResult.result.monteCarlo.bustProbability > 30 ? "text-rose-400" : btResult.result.monteCarlo.bustProbability > 10 ? "text-amber-400" : "text-emerald-400")}>{btResult.result.monteCarlo.bustProbability.toFixed(1)}%</div>
                            <div className="text-[9px] text-slate-600">chance of -{btResult.result.monteCarlo.bustThreshold}% ruin</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                            <div className="text-[10px] uppercase text-slate-500">Profit Probability</div>
                            <div className={cn("text-lg font-bold tabular-nums", btResult.result.monteCarlo.profitProbability >= 80 ? "text-emerald-400" : btResult.result.monteCarlo.profitProbability >= 50 ? "text-amber-400" : "text-rose-400")}>{btResult.result.monteCarlo.profitProbability.toFixed(1)}%</div>
                            <div className="text-[9px] text-slate-600">sims ended profitable</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                            <div className="text-[10px] uppercase text-slate-500">Median Max DD</div>
                            <div className="text-lg font-bold tabular-nums text-slate-200">{btResult.result.monteCarlo.medianMaxDrawdown.toFixed(1)}%</div>
                            <div className="text-[9px] text-slate-600">p95: {btResult.result.monteCarlo.p95MaxDrawdown.toFixed(1)}%</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                            <div className="text-[10px] uppercase text-slate-500">Median Final Equity</div>
                            <div className="text-lg font-bold tabular-nums text-slate-200">{fmtIDR(btResult.result.monteCarlo.medianFinalEquity)}</div>
                            <div className="text-[9px] text-slate-600">p5: {fmtIDR(btResult.result.monteCarlo.p5FinalEquity)} · p95: {fmtIDR(btResult.result.monteCarlo.p95FinalEquity)}</div>
                          </div>
                        </div>
                        <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
                          Monte Carlo mengacak urutan trade 1000x untuk ngetes apakah profitabilitas dari skill atau cuma kebetulan urutan. Bust probability tinggi = strategi bergantung urutan trade yang beruntung (tidak robust). Dihitung dengan fee {((btResult.dataSource?.feeRate ?? 0.003) * 100)}% sudah masuk.
                        </p>
                      </div>
                    </Card>
                  ) : (
                    <Card className="border-white/[0.08] bg-white/[0.03]"><div className="p-4 text-center text-[11px] text-slate-600">Monte Carlo butuh minimal 10 trades (sekarang {btResult.result.tradeCount})</div></Card>
                  )}

                  {/* P3: Maker Fee Scenario Comparison */}
                  {btResult.result.feeScenarios && btResult.result.feeScenarios.length > 0 && (
                    <Card className="border-cyan-500/20 bg-cyan-500/[0.03]">
                      <div className="p-5">
                        <div className="mb-3 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/15"><Scale className="h-4 w-4 text-cyan-400" /></div>
                            <div>
                              <h4 className="text-sm font-bold">Maker Fee Modeling <Badge className="ml-1 border border-cyan-500/30 bg-cyan-500/10 px-1 py-0 text-[8px] font-bold text-cyan-300">NEW</Badge></h4>
                              <div className="text-[10px] text-slate-500">3 execution scenarios — how much do you save with limit orders?</div>
                            </div>
                          </div>
                          {btResult.result.feeBreakdown && (
                            <Badge className="border-cyan-500/30 bg-cyan-500/10 text-[9px] text-cyan-300">taker {(btResult.result.feeBreakdown.takerFeeRate * 100).toFixed(2)}% · maker {(btResult.result.feeBreakdown.makerFeeRate * 100).toFixed(2)}% · spread {(btResult.result.feeBreakdown.spreadPct * 100).toFixed(2)}% · slip {(btResult.result.feeBreakdown.slippagePct * 100).toFixed(2)}%</Badge>
                          )}
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                          {btResult.result.feeScenarios.map((scn) => {
                            const isBest = scn.feeSavingPct === Math.max(...(btResult.result.feeScenarios || []).map(s => s.feeSavingPct));
                            return (
                              <div key={scn.name} className={cn("rounded-lg border p-3", isBest && scn.feeSavingPct > 0 ? "border-cyan-500/30 bg-cyan-500/[0.06]" : "border-white/[0.06] bg-white/[0.02]")}>
                                <div className="mb-2 flex items-center justify-between">
                                  <span className="text-[11px] font-bold text-slate-200">{scn.name}</span>
                                  {isBest && scn.feeSavingPct > 0 && <Badge className="border-cyan-500/30 bg-cyan-500/15 px-1 py-0 text-[8px] font-bold text-cyan-300">BEST</Badge>}
                                </div>
                                <div className="space-y-1 text-[9px]">
                                  <div className="flex justify-between"><span className="text-slate-500">Net Profit</span><span className={cn("font-bold tabular-nums", scn.netProfit >= 0 ? "text-emerald-400" : "text-rose-400")}>{fmtIDR(scn.netProfit)}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-500">Total Fees</span><span className="font-bold tabular-nums text-slate-300">{fmtIDR(scn.totalFees)}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-500">Profit Factor</span><span className="font-bold tabular-nums text-slate-300">{isFinite(scn.profitFactor) ? scn.profitFactor.toFixed(2) : "∞"}</span></div>
                                  <div className="flex justify-between"><span className="text-slate-500">Win Rate</span><span className="font-bold tabular-nums text-slate-300">{scn.winRate.toFixed(1)}%</span></div>
                                  {scn.feeSavingPct > 0 && (
                                    <div className="mt-1 rounded bg-cyan-500/[0.08] px-1.5 py-0.5 text-center">
                                      <div className="text-[8px] text-cyan-400">save {scn.feeSavingPct.toFixed(1)}% vs taker</div>
                                      <div className="text-[8px] tabular-nums text-cyan-300">{fmtIDR(scn.feeSavingVsTaker)}</div>
                                    </div>
                                  )}
                                </div>
                                <p className="mt-2 text-[8px] leading-relaxed text-slate-600">{scn.description}</p>
                              </div>
                            );
                          })}
                        </div>
                        {btResult.result.feeBreakdown && (
                          <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[10px] sm:grid-cols-4">
                            <div><div className="text-[9px] text-slate-500">Cost / side (taker)</div><div className="font-bold tabular-nums text-slate-300">{(btResult.result.feeBreakdown.costPerSideTaker * 100).toFixed(3)}%</div></div>
                            <div><div className="text-[9px] text-slate-500">Cost / side (maker)</div><div className="font-bold tabular-nums text-emerald-400">{(btResult.result.feeBreakdown.costPerSideMaker * 100).toFixed(3)}%</div></div>
                            <div><div className="text-[9px] text-slate-500">Hybrid savings</div><div className="font-bold tabular-nums text-cyan-400">{btResult.result.feeBreakdown.savingsHybridVsTakerPct.toFixed(1)}%</div></div>
                            <div><div className="text-[9px] text-slate-500">Maker savings</div><div className="font-bold tabular-nums text-emerald-400">{btResult.result.feeBreakdown.savingsMakerVsTakerPct.toFixed(1)}%</div></div>
                          </div>
                        )}
                        <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
                          INDODAX fee structure: <b>taker 0.3%</b> (market order, immediate fill) vs <b>maker 0%</b> (limit order, provides liquidity). Realistic execution = hybrid (limit entry + market exit). Stop-loss/take-profit exits MUST be market orders because they need immediate fill. Entry can be limit if patient.
                        </p>
                      </div>
                    </Card>
                  )}

                  {/* P1-3: Realistic Limit Order Execution Analysis (fill probability + partial fill + adverse selection) */}
                  {btResult.result.realisticLimitAnalysis && (
                    <Card className="border-rose-500/20 bg-rose-500/[0.03]">
                      <div className="p-5">
                        <div className="mb-3 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-500/15"><Target className="h-4 w-4 text-rose-400" /></div>
                            <div>
                              <h4 className="text-sm font-bold">Realistic Limit Execution <Badge className="ml-1 border border-rose-500/30 bg-rose-500/10 px-1 py-0 text-[8px] font-bold text-rose-300">NEW</Badge></h4>
                              <div className="text-[10px] text-slate-500">Fill probability + partial fill + adverse selection — the real cost of maker execution</div>
                            </div>
                          </div>
                          <Badge className={cn("border px-1.5 py-0 text-[9px] font-bold",
                            btResult.result.realisticLimitAnalysis.fillProbabilityPct < 50 ? "border-rose-500/30 bg-rose-500/10 text-rose-300" :
                            btResult.result.realisticLimitAnalysis.fillProbabilityPct < 80 ? "border-amber-500/30 bg-amber-500/10 text-amber-300" :
                            "border-emerald-500/30 bg-emerald-500/10 text-emerald-300")}>
                            fill {btResult.result.realisticLimitAnalysis.fillProbabilityPct.toFixed(1)}%
                          </Badge>
                        </div>

                        {/* 3 pillars: fill prob, partial fill, adverse selection */}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                          {/* P1: Fill Probability */}
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                            <div className="mb-2 flex items-center gap-1.5"><CircleDot className="h-3 w-3 text-blue-400" /><span className="text-[10px] font-bold uppercase text-slate-400">P1: Fill Probability</span></div>
                            <div className="space-y-1 text-[9px]">
                              <div className="flex justify-between"><span className="text-slate-500">Total limit orders</span><span className="font-bold tabular-nums text-slate-300">{btResult.result.realisticLimitAnalysis.totalLimitOrders}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Filled</span><span className="font-bold tabular-nums text-emerald-400">{btResult.result.realisticLimitAnalysis.filledOrders}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Missed (no fill in 3 bars)</span><span className="font-bold tabular-nums text-rose-400">{btResult.result.realisticLimitAnalysis.missedOrders}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Fill rate</span><span className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.fillProbabilityPct < 50 ? "text-rose-400" : btResult.result.realisticLimitAnalysis.fillProbabilityPct < 80 ? "text-amber-400" : "text-emerald-400")}>{btResult.result.realisticLimitAnalysis.fillProbabilityPct.toFixed(1)}%</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Avg wait to fill</span><span className="font-bold tabular-nums text-slate-300">{btResult.result.realisticLimitAnalysis.avgWaitBarsToFill.toFixed(1)} bars</span></div>
                            </div>
                            {/* Visual fill probability bar */}
                            <div className="mt-2 relative h-2 w-full overflow-hidden rounded-full bg-slate-800/60">
                              <div className={cn("absolute inset-y-0 left-0", btResult.result.realisticLimitAnalysis.fillProbabilityPct < 50 ? "bg-rose-500/50" : btResult.result.realisticLimitAnalysis.fillProbabilityPct < 80 ? "bg-amber-500/50" : "bg-emerald-500/50")} style={{ width: `${btResult.result.realisticLimitAnalysis.fillProbabilityPct}%` }} />
                            </div>
                            <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">Limit order placed at entry close. Fills only if subsequent candle low ≤ limit (within 3 bars). Missed entries = canceled orders.</p>
                          </div>

                          {/* P2: Partial Fill Modeling */}
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                            <div className="mb-2 flex items-center gap-1.5"><Layers className="h-3 w-3 text-amber-400" /><span className="text-[10px] font-bold uppercase text-slate-400">P2: Partial Fill</span></div>
                            <div className="space-y-1 text-[9px]">
                              <div className="flex justify-between"><span className="text-slate-500">Full fills</span><span className="font-bold tabular-nums text-emerald-400">{btResult.result.realisticLimitAnalysis.fullFills}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Partial fills</span><span className="font-bold tabular-nums text-amber-400">{btResult.result.realisticLimitAnalysis.partialFills}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Partial fill rate</span><span className="font-bold tabular-nums text-slate-300">{(btResult.result.realisticLimitAnalysis.partialFillRate * 100).toFixed(1)}%</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Avg fill fraction</span><span className="font-bold tabular-nums text-slate-300">{(btResult.result.realisticLimitAnalysis.avgFillFraction * 100).toFixed(1)}%</span></div>
                            </div>
                            {/* Visual: fill fraction */}
                            <div className="mt-2 relative h-2 w-full overflow-hidden rounded-full bg-slate-800/60">
                              <div className="absolute inset-y-0 left-0 bg-amber-500/50" style={{ width: `${btResult.result.realisticLimitAnalysis.avgFillFraction * 100}%` }} />
                            </div>
                            <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">Fill fraction = volume_at_limit / avg_volume. Small-volume fills = queue ahead of us absorbed most liquidity. Capped at [10%, 100%].</p>
                          </div>

                          {/* P3: Adverse Selection */}
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                            <div className="mb-2 flex items-center gap-1.5"><AlertTriangle className="h-3 w-3 text-rose-400" /><span className="text-[10px] font-bold uppercase text-slate-400">P3: Adverse Selection</span></div>
                            <div className="space-y-1 text-[9px]">
                              <div className="flex justify-between"><span className="text-slate-500">Adverse selection rate</span><span className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.adverseSelectionRate > 0.5 ? "text-rose-400" : "text-amber-400")}>{(btResult.result.realisticLimitAnalysis.adverseSelectionRate * 100).toFixed(1)}%</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Avg next-bar move</span><span className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.avgAdverseSelectionPct < 0 ? "text-rose-400" : "text-emerald-400")}>{btResult.result.realisticLimitAnalysis.avgAdverseSelectionPct >= 0 ? "+" : ""}{btResult.result.realisticLimitAnalysis.avgAdverseSelectionPct.toFixed(3)}%</span></div>
                              <div className="text-[8px] text-slate-600">Negative = price moved against filled buy (adverse).</div>
                            </div>
                            {/* Visual: adverse selection rate */}
                            <div className="mt-2 relative h-2 w-full overflow-hidden rounded-full bg-slate-800/60">
                              <div className={cn("absolute inset-y-0 left-0", btResult.result.realisticLimitAnalysis.adverseSelectionRate > 0.5 ? "bg-rose-500/50" : "bg-amber-500/40")} style={{ width: `${btResult.result.realisticLimitAnalysis.adverseSelectionRate * 100}%` }} />
                            </div>
                            <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">When limit fills, it's often because price was dropping. Adverse selection = fraction of fills where next-bar move was unfavorable.</p>
                          </div>
                        </div>

                        {/* 4 new pillars: queue position, market impact, latency, volume-aware */}
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          {/* P1 (new): Queue Position */}
                          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.03] p-3">
                            <div className="mb-2 flex items-center gap-1.5"><Layers className="h-3 w-3 text-emerald-400" /><span className="text-[10px] font-bold uppercase text-slate-400">Queue Position <Badge className="ml-0.5 border border-emerald-500/30 bg-emerald-500/10 px-1 py-0 text-[7px] font-bold text-emerald-300">NEW</Badge></span></div>
                            <div className="space-y-1 text-[9px]">
                              <div className="flex justify-between"><span className="text-slate-500">Avg queue ahead</span><span className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.avgQueueAheadPct > 70 ? "text-rose-400" : btResult.result.realisticLimitAnalysis.avgQueueAheadPct > 50 ? "text-amber-400" : "text-emerald-400")}>{btResult.result.realisticLimitAnalysis.avgQueueAheadPct.toFixed(0)}%</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Queue-adj fill rate</span><span className="font-bold tabular-nums text-slate-300">{(btResult.result.realisticLimitAnalysis.queueAdjustedFillRate * 100).toFixed(1)}%</span></div>
                              <div className="text-[8px] text-slate-600">vs raw touch rate</div>
                            </div>
                            <div className="mt-2 relative h-2 w-full overflow-hidden rounded-full bg-slate-800/60">
                              <div className="absolute inset-y-0 left-0 bg-emerald-500/50" style={{ width: `${btResult.result.realisticLimitAnalysis.queueAdjustedFillRate * 100}%` }} />
                            </div>
                            <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">Order joins queue at limit price. Random queue position. Fill qty = max(0, vol_at_limit - queue_ahead).</p>
                          </div>

                          {/* P2 (new): Market Impact */}
                          <div className="rounded-lg border border-purple-500/20 bg-purple-500/[0.03] p-3">
                            <div className="mb-2 flex items-center gap-1.5"><Zap className="h-3 w-3 text-purple-400" /><span className="text-[10px] font-bold uppercase text-slate-400">Market Impact <Badge className="ml-0.5 border border-purple-500/30 bg-purple-500/10 px-1 py-0 text-[7px] font-bold text-purple-300">NEW</Badge></span></div>
                            <div className="space-y-1 text-[9px]">
                              <div className="flex justify-between"><span className="text-slate-500">Avg impact</span><span className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.avgMarketImpactPct > 0.1 ? "text-amber-400" : "text-emerald-400")}>{btResult.result.realisticLimitAnalysis.avgMarketImpactPct.toFixed(4)}%</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Worst impact</span><span className="font-bold tabular-nums text-rose-400">{btResult.result.realisticLimitAnalysis.worstMarketImpactPct.toFixed(4)}%</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Large order rate</span><span className="font-bold tabular-nums text-slate-300">{(btResult.result.realisticLimitAnalysis.largeOrderRate * 100).toFixed(1)}%</span></div>
                            </div>
                            <div className="mt-2 relative h-2 w-full overflow-hidden rounded-full bg-slate-800/60">
                              <div className="absolute inset-y-0 left-0 bg-purple-500/50" style={{ width: `${Math.min(100, btResult.result.realisticLimitAnalysis.avgMarketImpactPct * 1000)}%` }} />
                            </div>
                            <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">Square-root law: Δp/p = σ × √(Q/V). Large orders move market against trader. Order = 0.5% of avg volume.</p>
                          </div>

                          {/* P3 (new): Latency */}
                          <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-3">
                            <div className="mb-2 flex items-center gap-1.5"><Clock className="h-3 w-3 text-amber-400" /><span className="text-[10px] font-bold uppercase text-slate-400">Latency <Badge className="ml-0.5 border border-amber-500/30 bg-amber-500/10 px-1 py-0 text-[7px] font-bold text-amber-300">NEW</Badge></span></div>
                            <div className="space-y-1 text-[9px]">
                              <div className="flex justify-between"><span className="text-slate-500">Latency modeled</span><span className="font-bold tabular-nums text-slate-300">{btResult.result.realisticLimitAnalysis.latencyBars} bar{btResult.result.realisticLimitAnalysis.latencyBars !== 1 ? "s" : ""}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Missed (drift &gt; -1%)</span><span className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.latencyMissedEntries > 0 ? "text-rose-400" : "text-emerald-400")}>{btResult.result.realisticLimitAnalysis.latencyMissedEntries}</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Avg price drift</span><span className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.latencyPriceDriftPct < 0 ? "text-rose-400" : "text-emerald-400")}>{btResult.result.realisticLimitAnalysis.latencyPriceDriftPct >= 0 ? "+" : ""}{btResult.result.realisticLimitAnalysis.latencyPriceDriftPct.toFixed(3)}%</span></div>
                            </div>
                            <div className="mt-2 relative h-2 w-full overflow-hidden rounded-full bg-slate-800/60">
                              <div className={cn("absolute inset-y-0 left-0", btResult.result.realisticLimitAnalysis.latencyPriceDriftPct < 0 ? "bg-rose-500/50" : "bg-amber-500/40")} style={{ width: `${Math.min(100, Math.abs(btResult.result.realisticLimitAnalysis.latencyPriceDriftPct) * 50)}%` }} />
                            </div>
                            <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">Signal at time t → order placed at t+latency. If price dropped &gt;1% during latency, entry is skipped (stale signal).</p>
                          </div>

                          {/* P4 (new): Volume-aware Fill */}
                          <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.03] p-3">
                            <div className="mb-2 flex items-center gap-1.5"><Activity className="h-3 w-3 text-cyan-400" /><span className="text-[10px] font-bold uppercase text-slate-400">Volume-aware Fill <Badge className="ml-0.5 border border-cyan-500/30 bg-cyan-500/10 px-1 py-0 text-[7px] font-bold text-cyan-300">NEW</Badge></span></div>
                            <div className="space-y-1 text-[9px]">
                              <div className="flex justify-between"><span className="text-slate-500">Vol at limit (avg)</span><span className="font-bold tabular-nums text-slate-300">{btResult.result.realisticLimitAnalysis.avgVolumeAtLimitPct.toFixed(1)}%</span></div>
                              <div className="flex justify-between"><span className="text-slate-500">Thin market rate</span><span className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.thinMarketRate > 0.3 ? "text-rose-400" : "text-emerald-400")}>{(btResult.result.realisticLimitAnalysis.thinMarketRate * 100).toFixed(1)}%</span></div>
                              <div className="text-[8px] text-slate-600">of avg volume</div>
                            </div>
                            <div className="mt-2 relative h-2 w-full overflow-hidden rounded-full bg-slate-800/60">
                              <div className="absolute inset-y-0 left-0 bg-cyan-500/50" style={{ width: `${Math.min(100, btResult.result.realisticLimitAnalysis.avgVolumeAtLimitPct)}%` }} />
                            </div>
                            <p className="mt-1.5 text-[8px] leading-relaxed text-slate-600">Only ~30% of bar volume is at the limit price. Thin markets (&lt;50% avg vol) reduce fill probability.</p>
                          </div>
                        </div>

                        {/* Microstructure deep dive — order book depth, volume profile, imbalance, network latency */}
                        <div className="mt-3 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.03] p-3">
                          <div className="mb-2 flex items-center gap-1.5">
                            <Microscope className="h-3 w-3 text-indigo-400" />
                            <span className="text-[10px] font-bold uppercase text-slate-400">Microstructure Deep Dive <Badge className="ml-0.5 border border-indigo-500/30 bg-indigo-500/10 px-1 py-0 text-[7px] font-bold text-indigo-300">NEW</Badge></span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {/* Order book depth at limit */}
                            <div className="rounded bg-white/[0.03] p-2">
                              <div className="text-[8px] uppercase text-slate-500">Book Depth @ Limit</div>
                              <div className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.avgBookDepthAtLimitPct > 30 ? "text-emerald-400" : "text-amber-400")}>{btResult.result.realisticLimitAnalysis.avgBookDepthAtLimitPct.toFixed(1)}%</div>
                              <div className="text-[7px] text-slate-600">of avg vol</div>
                              <div className="mt-1 text-[7px] text-slate-500">Queue consistency: <span className={cn("font-bold", btResult.result.realisticLimitAnalysis.queueConsistencyPct > 70 ? "text-emerald-400" : "text-amber-400")}>{btResult.result.realisticLimitAnalysis.queueConsistencyPct.toFixed(0)}%</span></div>
                            </div>
                            {/* Volume profile impact */}
                            <div className="rounded bg-white/[0.03] p-2">
                              <div className="text-[8px] uppercase text-slate-500">VP Impact</div>
                              <div className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.avgVolumeProfileImpactPct > 0.1 ? "text-amber-400" : "text-emerald-400")}>{btResult.result.realisticLimitAnalysis.avgVolumeProfileImpactPct.toFixed(4)}%</div>
                              <div className="text-[7px] text-slate-600">concentration-adjusted</div>
                              <div className="mt-1 text-[7px] text-slate-500">Concentration: <span className="font-bold text-slate-300">{btResult.result.realisticLimitAnalysis.volumeProfileConcentration.toFixed(2)}</span></div>
                            </div>
                            {/* Network latency */}
                            <div className="rounded bg-white/[0.03] p-2">
                              <div className="text-[8px] uppercase text-slate-500">Network Latency</div>
                              <div className="font-bold tabular-nums text-slate-300">{btResult.result.realisticLimitAnalysis.networkLatencyMs}ms</div>
                              <div className="text-[7px] text-slate-600">{btResult.result.realisticLimitAnalysis.networkLatencyBarsPct.toFixed(4)}% of bar</div>
                              <div className="mt-1 text-[7px] text-slate-500">{btResult.result.realisticLimitAnalysis.networkLatencyBarsPct < 1 ? "Negligible vs signal latency" : "Significant"}</div>
                            </div>
                            {/* Order book imbalance */}
                            <div className="rounded bg-white/[0.03] p-2">
                              <div className="text-[8px] uppercase text-slate-500">OB Imbalance</div>
                              <div className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.avgOrderBookImbalance > 0 ? "text-emerald-400" : "text-rose-400")}>{btResult.result.realisticLimitAnalysis.avgOrderBookImbalance >= 0 ? "+" : ""}{btResult.result.realisticLimitAnalysis.avgOrderBookImbalance.toFixed(2)}</div>
                              <div className="text-[7px] text-slate-600">{btResult.result.realisticLimitAnalysis.avgOrderBookImbalance > 0 ? "more buyers" : "more sellers"}</div>
                              <div className="mt-1 text-[7px] text-slate-500">Adverse: <span className={cn("font-bold", btResult.result.realisticLimitAnalysis.imbalanceAdverseRate > 0.5 ? "text-rose-400" : "text-amber-400")}>{(btResult.result.realisticLimitAnalysis.imbalanceAdverseRate * 100).toFixed(0)}%</span></div>
                            </div>
                          </div>
                          <p className="mt-2 text-[8px] leading-relaxed text-slate-600">
                            <b>Book depth @ limit</b>: estimated resting orders at limit price, derived from volume profile (triangular distribution centered at close). Higher = more liquidity at our price.
                            <b> VP impact</b>: market impact adjusted by volume concentration. Concentrated volume (high concentration) = less dispersed liquidity = higher impact.
                            <b> Network latency</b>: 400ms typical (API 200ms + processing 150ms + execution 50ms). Negligible for 1h bars but matters for sub-minute.
                            <b> OB imbalance</b>: (close-open)/(high-low). Positive = bullish candle = more buyers = adverse for buy limits.
                          </p>
                        </div>

                        {/* L2 Order Book Snapshot — real INDODAX depth data */}
                        {btResult.result.realisticLimitAnalysis.l2Snapshot && (
                          <div className="mt-3 rounded-lg border border-teal-500/20 bg-teal-500/[0.03] p-3">
                            <div className="mb-2 flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <Layers className="h-3 w-3 text-teal-400" />
                                <span className="text-[10px] font-bold uppercase text-slate-400">L2 Order Book Snapshot <Badge className="ml-0.5 border border-teal-500/30 bg-teal-500/10 px-1 py-0 text-[7px] font-bold text-teal-300">LIVE</Badge></span>
                              </div>
                              <span className="text-[8px] text-slate-600">Real INDODAX depth · calibrates synthesized model</span>
                            </div>
                            {(() => {
                              const l2 = btResult.result.realisticLimitAnalysis.l2Snapshot!;
                              return (
                                <>
                                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                    <div className="rounded bg-white/[0.03] p-2">
                                      <div className="text-[8px] uppercase text-slate-500">Real Spread</div>
                                      <div className={cn("font-bold tabular-nums", l2.realSpreadPct > 0.2 ? "text-amber-400" : "text-emerald-400")}>{l2.realSpreadPct.toFixed(3)}%</div>
                                      <div className="text-[7px] text-slate-600">vs 0.1% assumed</div>
                                      <div className="mt-0.5 text-[7px] text-slate-500">Calibration: <span className={cn("font-bold", l2.spreadCalibrationFactor > 2 ? "text-rose-400" : "text-slate-300")}>{l2.spreadCalibrationFactor.toFixed(2)}×</span></div>
                                    </div>
                                    <div className="rounded bg-white/[0.03] p-2">
                                      <div className="text-[8px] uppercase text-slate-500">Top-of-Book Imbalance</div>
                                      <div className={cn("font-bold tabular-nums", l2.topOfBookImbalance > 0 ? "text-emerald-400" : "text-rose-400")}>{l2.topOfBookImbalance >= 0 ? "+" : ""}{l2.topOfBookImbalance.toFixed(2)}</div>
                                      <div className="text-[7px] text-slate-600">{l2.topOfBookImbalance > 0 ? "more buyers" : "more sellers"}</div>
                                    </div>
                                    <div className="rounded bg-white/[0.03] p-2">
                                      <div className="text-[8px] uppercase text-slate-500">Total Imbalance</div>
                                      <div className={cn("font-bold tabular-nums", l2.totalImbalance > 0 ? "text-emerald-400" : "text-rose-400")}>{l2.totalImbalance >= 0 ? "+" : ""}{l2.totalImbalance.toFixed(2)}</div>
                                      <div className="text-[7px] text-slate-600">all levels</div>
                                    </div>
                                    <div className="rounded bg-white/[0.03] p-2">
                                      <div className="text-[8px] uppercase text-slate-500">Depth Calibration</div>
                                      <div className={cn("font-bold tabular-nums", l2.depthCalibrationFactor > 2 ? "text-emerald-400" : l2.depthCalibrationFactor < 0.5 ? "text-rose-400" : "text-slate-300")}>{l2.depthCalibrationFactor.toFixed(2)}×</div>
                                      <div className="text-[7px] text-slate-600">synthesized vs real</div>
                                    </div>
                                  </div>
                                  {/* Top-of-book details */}
                                  <div className="mt-2 grid grid-cols-2 gap-2 text-[9px]">
                                    <div className="rounded bg-emerald-500/[0.06] p-2">
                                      <div className="text-[8px] font-bold text-emerald-400">Best Bid</div>
                                      <div className="font-bold tabular-nums text-slate-200">{fmtIDR(l2.topBidPrice)}</div>
                                      <div className="text-[7px] text-slate-500">vol: <span className="tabular-nums text-slate-300">{l2.topBidVolume.toFixed(6)}</span></div>
                                      <div className="text-[7px] text-slate-500">{l2.bidLevels} levels · total {l2.totalBidVolume.toFixed(4)}</div>
                                    </div>
                                    <div className="rounded bg-rose-500/[0.06] p-2">
                                      <div className="text-[8px] font-bold text-rose-400">Best Ask</div>
                                      <div className="font-bold tabular-nums text-slate-200">{fmtIDR(l2.topAskPrice)}</div>
                                      <div className="text-[7px] text-slate-500">vol: <span className="tabular-nums text-slate-300">{l2.topAskVolume.toFixed(6)}</span></div>
                                      <div className="text-[7px] text-slate-500">{l2.askLevels} levels · total {l2.totalAskVolume.toFixed(4)}</div>
                                    </div>
                                  </div>
                                  {/* Depth profile visualization */}
                                  <div className="mt-2">
                                    <div className="mb-1 text-[8px] font-bold text-slate-500">Cumulative Depth Profile (top 10 levels)</div>
                                    <div className="flex items-end gap-1 h-16">
                                      {/* Bid side (left) */}
                                      {l2.bidDepthProfile.slice(0, 10).reverse().map((d, i) => {
                                        const maxVol = Math.max(...l2.bidDepthProfile.concat(l2.askDepthProfile).map(p => p.cumulativeVol), 1);
                                        const h = (d.cumulativeVol / maxVol) * 100;
                                        return <div key={`b${i}`} className="flex-1 bg-emerald-500/40 rounded-t" style={{ height: `${h}%` }} title={`${d.priceLevelPct.toFixed(2)}% from mid: ${d.cumulativeVol.toFixed(4)}`} />;
                                      })}
                                      {/* Separator */}
                                      <div className="w-[2px] bg-slate-500/30" />
                                      {/* Ask side (right) */}
                                      {l2.askDepthProfile.slice(0, 10).map((d, i) => {
                                        const maxVol = Math.max(...l2.bidDepthProfile.concat(l2.askDepthProfile).map(p => p.cumulativeVol), 1);
                                        const h = (d.cumulativeVol / maxVol) * 100;
                                        return <div key={`a${i}`} className="flex-1 bg-rose-500/40 rounded-t" style={{ height: `${h}%` }} title={`${d.priceLevelPct.toFixed(2)}% from mid: ${d.cumulativeVol.toFixed(4)}`} />;
                                      })}
                                    </div>
                                    <div className="mt-1 flex justify-between text-[7px] text-slate-600">
                                      <span>← bids (deep)</span>
                                      <span>spread</span>
                                      <span>asks (deep) →</span>
                                    </div>
                                  </div>
                                  <p className="mt-2 text-[8px] leading-relaxed text-slate-500">{l2.description}</p>
                                  <p className="mt-1 text-[8px] leading-relaxed text-slate-600">
                                    Real L2 snapshot from INDODAX depth API. Used to calibrate the synthesized microstructure model: real spread replaces assumed 0.1%, real imbalance (70% weight) blends with candle-shape estimate, real depth scales volume-at-limit estimate. For historical backtests, this is a representative snapshot applied to past candles.
                                  </p>

                                  {/* P2: Staleness indicator */}
                                  {l2.snapshotAgeSec !== undefined && (
                                    <div className={cn("mt-1 rounded px-1.5 py-0.5 text-[8px]", l2.isStale ? "bg-rose-500/[0.08] text-rose-300" : "bg-emerald-500/[0.08] text-emerald-300")}>
                                      {l2.stalenessWarning}
                                    </div>
                                  )}

                                  {/* P7: L2 vs Synthetic comparison */}
                                  {btResult.result.realisticLimitAnalysis.l2Comparison && (
                                    <div className="mt-2 rounded border border-teal-500/10 bg-teal-500/[0.04] p-2">
                                      <div className="mb-1 text-[8px] font-bold uppercase text-teal-400">L2 Calibration Impact (vs Synthetic-Only)</div>
                                      <div className="grid grid-cols-2 gap-1 text-[8px] sm:grid-cols-4">
                                        <div><div className="text-slate-500">Fill prob Δ</div><div className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.l2Comparison.fillProbabilityDelta > 0 ? "text-emerald-400" : btResult.result.realisticLimitAnalysis.l2Comparison.fillProbabilityDelta < 0 ? "text-rose-400" : "text-slate-300")}>{(btResult.result.realisticLimitAnalysis.l2Comparison.fillProbabilityDelta * 100).toFixed(1)}pp</div></div>
                                        <div><div className="text-slate-500">Fill frac Δ</div><div className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.l2Comparison.fillFractionDelta > 0 ? "text-emerald-400" : "text-rose-400")}>{(btResult.result.realisticLimitAnalysis.l2Comparison.fillFractionDelta * 100).toFixed(1)}pp</div></div>
                                        <div><div className="text-slate-500">P&L Δ</div><div className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.l2Comparison.netProfitDelta >= 0 ? "text-emerald-400" : "text-rose-400")}>{btResult.result.realisticLimitAnalysis.l2Comparison.netProfitDelta >= 0 ? "+" : ""}{fmtIDR(btResult.result.realisticLimitAnalysis.l2Comparison.netProfitDelta)}</div></div>
                                        <div><div className="text-slate-500">Imbalance Δ</div><div className="font-bold tabular-nums text-slate-300">{btResult.result.realisticLimitAnalysis.l2Comparison.imbalanceDelta.toFixed(2)}</div></div>
                                      </div>
                                      <p className="mt-1 text-[7px] leading-relaxed text-slate-500">{btResult.result.realisticLimitAnalysis.l2Comparison.description}</p>
                                    </div>
                                  )}

                                  {/* P6: Walk-the-book analysis */}
                                  {btResult.walkBookAnalysis && (() => {
                                    const wb = btResult.walkBookAnalysis;
                                    return (
                                    <div className="mt-2 rounded border border-purple-500/10 bg-purple-500/[0.04] p-2">
                                      <div className="mb-1 text-[8px] font-bold uppercase text-purple-400">Walk-the-Book (Market Order Taker Cost) — {wb.orderSize} units</div>
                                      <div className="grid grid-cols-2 gap-2 text-[8px]">
                                        <div className="rounded bg-white/[0.03] p-1.5">
                                          <div className="text-[7px] font-bold text-emerald-400">Market BUY</div>
                                          <div className="flex justify-between"><span className="text-slate-500">Avg fill</span><span className="font-bold tabular-nums text-slate-200">{fmtIDR(wb.buy.avgFillPrice)}</span></div>
                                          <div className="flex justify-between"><span className="text-slate-500">Slippage</span><span className={cn("font-bold tabular-nums", wb.buy.slippagePct > 0.01 ? "text-amber-400" : "text-emerald-400")}>{wb.buy.slippagePct.toFixed(4)}%</span></div>
                                          <div className="flex justify-between"><span className="text-slate-500">Levels</span><span className="font-bold tabular-nums text-slate-300">{wb.buy.levelsConsumed}</span></div>
                                        </div>
                                        <div className="rounded bg-white/[0.03] p-1.5">
                                          <div className="text-[7px] font-bold text-rose-400">Market SELL</div>
                                          <div className="flex justify-between"><span className="text-slate-500">Avg fill</span><span className="font-bold tabular-nums text-slate-200">{fmtIDR(wb.sell.avgFillPrice)}</span></div>
                                          <div className="flex justify-between"><span className="text-slate-500">Slippage</span><span className={cn("font-bold tabular-nums", wb.sell.slippagePct > 0.01 ? "text-amber-400" : "text-emerald-400")}>{wb.sell.slippagePct.toFixed(4)}%</span></div>
                                          <div className="flex justify-between"><span className="text-slate-500">Levels</span><span className="font-bold tabular-nums text-slate-300">{wb.sell.levelsConsumed}</span></div>
                                        </div>
                                      </div>
                                      <p className="mt-1 text-[7px] leading-relaxed text-slate-500">Walks through order book levels to compute actual taker execution price. Slippage &gt; 0.01% means thin liquidity forces walking multiple levels.</p>
                                    </div>
                                    );
                                  })()}
                                </>
                              );
                            })()}
                          </div>
                        )}

                        {/* Net economic impact */}
                        <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.04] p-3">
                          <div className="mb-2 flex items-center gap-1.5"><Wallet className="h-3 w-3 text-rose-400" /><span className="text-[10px] font-bold uppercase text-slate-400">Net Economic Impact (Realistic vs Theoretical Maker)</span></div>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            <div className="rounded bg-white/[0.03] px-2 py-1.5">
                              <div className="text-[9px] text-slate-500">Realistic Maker P&L</div>
                              <div className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.realisticMakerNetProfit >= 0 ? "text-emerald-400" : "text-rose-400")}>{fmtIDR(btResult.result.realisticLimitAnalysis.realisticMakerNetProfit)}</div>
                            </div>
                            <div className="rounded bg-white/[0.03] px-2 py-1.5">
                              <div className="text-[9px] text-slate-500">Realistic Win Rate</div>
                              <div className="font-bold tabular-nums text-slate-200">{btResult.result.realisticLimitAnalysis.realisticMakerWinRate.toFixed(1)}%</div>
                            </div>
                            <div className="rounded bg-white/[0.03] px-2 py-1.5">
                              <div className="text-[9px] text-slate-500">vs Pure Maker (theoretical)</div>
                              <div className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.netProfitVsPureMaker >= 0 ? "text-emerald-400" : "text-rose-400")}>{btResult.result.realisticLimitAnalysis.netProfitVsPureMaker >= 0 ? "+" : ""}{fmtIDR(btResult.result.realisticLimitAnalysis.netProfitVsPureMaker)}</div>
                            </div>
                            <div className="rounded bg-white/[0.03] px-2 py-1.5">
                              <div className="text-[9px] text-slate-500">Execution Cost %</div>
                              <div className={cn("font-bold tabular-nums", btResult.result.realisticLimitAnalysis.executionCostPct < 0 ? "text-rose-400" : "text-emerald-400")}>{btResult.result.realisticLimitAnalysis.executionCostPct >= 0 ? "+" : ""}{btResult.result.realisticLimitAnalysis.executionCostPct.toFixed(1)}%</div>
                              <div className="text-[8px] text-slate-600">% of pure-maker profit lost to realism</div>
                            </div>
                          </div>
                          <p className="mt-2 text-[9px] leading-relaxed text-slate-500">{btResult.result.realisticLimitAnalysis.description}</p>
                        </div>

                        <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
                          Pure-maker P&L assumed all entries filled at limit price. Realistic limit execution pays 3 penalties: (1) <b>fill probability</b> — limit only fills if price touches, so some entries are missed entirely; (2) <b>partial fills</b> — even when filled, only part of the order executes (queue position); (3) <b>adverse selection</b> — fills happen because price is moving against you. Combined, these can turn a "theoretically profitable maker strategy" into a losing one.
                        </p>
                      </div>
                    </Card>
                  )}

                  {/* equity curve + breakdown */}
                  <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
                    <Card className="col-span-1 border-white/[0.08] bg-white/[0.03] lg:col-span-2">
                      <div className="p-5">
                        <div className="mb-3 flex items-center justify-between">
                          <h4 className="text-sm font-bold">Equity Curve</h4>
                          <div className="text-[10px] text-slate-500">{btResult.dataSource ? `${btResult.dataSource.candleCount} real ${btResult.dataSource.timeframe} candles · ${btResult.dataSource.windowDays}d` : "real candles"}</div>
                        </div>
                        <EquityCurve equity={btResult.result.equity} initial={Number(btCapital)} />
                        <div className="mt-3 grid grid-cols-4 gap-3 border-t border-white/[0.06] pt-3 text-xs">
                          <div><div className="text-[9px] text-slate-500">Trades</div><div className="font-bold tabular-nums">{btResult.result.tradeCount}</div></div>
                          <div><div className="text-[9px] text-slate-500">Avg Trade</div><div className="font-bold tabular-nums">{fmtCompact(btResult.result.avgTrade)}</div></div>
                          <div><div className="text-[9px] text-slate-500">Avg Win</div><div className="font-bold tabular-nums text-emerald-400">{fmtCompact(btResult.result.avgWin)}</div></div>
                          <div><div className="text-[9px] text-slate-500">Avg Loss</div><div className="font-bold tabular-nums text-rose-400">{fmtCompact(btResult.result.avgLoss)}</div></div>
                        </div>
                      </div>
                    </Card>

                    {/* position optimization */}
                    <Card className="border-white/[0.08] bg-white/[0.03]">
                      <div className="p-5">
                        <div className="mb-3 flex items-center gap-2"><Gauge className="h-4 w-4 text-blue-400" /><h4 className="text-sm font-bold">Position Models</h4></div>
                        <div className="space-y-3 text-xs">
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
                            <div className="text-[10px] uppercase text-slate-500">Fixed Risk (2%)</div>
                            <div className="font-bold tabular-nums">{btResult.positions.fixedRisk.sizePct.toFixed(2)}% · {fmtCompact(btResult.positions.fixedRisk.riskAmount)} IDR</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
                            <div className="text-[10px] uppercase text-slate-500">Kelly Fraction</div>
                            <div className="font-bold tabular-nums">{btResult.positions.kellyFraction.kellyPct.toFixed(1)}% full</div>
                          </div>
                          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
                            <div className="text-[10px] uppercase text-slate-500">Vol-Adjusted</div>
                            <div className="font-bold tabular-nums">{btResult.positions.volAdjusted.sizePct.toFixed(2)}%</div>
                          </div>
                        </div>
                      </div>
                    </Card>
                  </div>

                  {/* risk flags */}
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                    <RiskFlagList title="Red Flags" items={btResult.risk.red} icon={XCircle} tone="rose" />
                    <RiskFlagList title="Yellow Flags" items={btResult.risk.yellow} icon={AlertCircle} tone="amber" />
                    <RiskFlagList title="Green Flags" items={btResult.risk.green} icon={CheckCircle2} tone="emerald" />
                  </div>
                </div>
              )}
            </TabsContent>

          </Tabs>
        </main>

        <footer className="mt-auto border-t border-white/[0.06] py-4">
          <div className="mx-auto max-w-[1400px] px-4 text-center text-[10px] text-slate-600 lg:px-6">
            INDODAX Trading Bot · Riset (kukapay/crypto-skills) · Eksekusi (INDODAX API) · Validasi (DaviddTech/backtest) · Bukan saran investasi
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
}

// ── Inline sub-components ──

function DepthBook({ depth }: { depth: Depth }) {
  const asks = depth.sell.slice(0, 8).reverse(); // high → low for display
  const bids = depth.buy.slice(0, 8);
  const maxVol = Math.max(...asks.concat(bids).map(o => parseFloat(o[1])), 1);
  const bestBid = parseFloat(bids[0]?.[0] || "0");
  const bestAsk = parseFloat(asks[asks.length - 1]?.[0] || "0");
  const spread = bestAsk - bestBid;
  const spreadPct = bestAsk > 0 ? (spread / bestAsk) * 100 : 0;
  return (
    <div className="space-y-2 text-xs">
      {/* asks (top) */}
      <div className="space-y-0.5">
        {asks.map((o, i) => {
          const vol = parseFloat(o[1]);
          const w = (vol / maxVol) * 100;
          return (
            <div key={`a${i}`} className="relative flex justify-between overflow-hidden rounded px-2 py-0.5">
              <div className="absolute inset-y-0 right-0 bg-rose-500/10" style={{ width: `${w}%` }} />
              <span className="relative tabular-nums text-rose-400">{fmtIDR(o[0])}</span>
              <span className="relative tabular-nums text-slate-400">{vol.toFixed(6)}</span>
            </div>
          );
        })}
      </div>
      {/* spread */}
      <div className="flex items-center justify-between rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
        <span className="text-[10px] text-slate-500">Spread</span>
        <div className="flex items-center gap-2">
          <span className="font-bold tabular-nums text-slate-200">{fmtIDR(spread)}</span>
          <Badge variant="outline" className="border-white/10 text-[9px] text-slate-400">{spreadPct.toFixed(2)}%</Badge>
        </div>
      </div>
      {/* bids */}
      <div className="space-y-0.5">
        {bids.map((o, i) => {
          const vol = parseFloat(o[1]);
          const w = (vol / maxVol) * 100;
          return (
            <div key={`b${i}`} className="relative flex justify-between overflow-hidden rounded px-2 py-0.5">
              <div className="absolute inset-y-0 right-0 bg-emerald-500/10" style={{ width: `${w}%` }} />
              <span className="relative tabular-nums text-emerald-400">{fmtIDR(o[0])}</span>
              <span className="relative tabular-nums text-slate-400">{vol.toFixed(6)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: "up" | "down" | "neutral" }) {
  return (
    <div className={cn("rounded-xl border p-3", tone === "up" ? "border-emerald-500/20 bg-emerald-500/[0.04]" : tone === "down" ? "border-rose-500/20 bg-rose-500/[0.04]" : "border-white/[0.08] bg-white/[0.03]")}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cn("mt-1 text-base font-bold tabular-nums", tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-slate-200")}>{value}</div>
    </div>
  );
}

function RiskFlagList({ title, items, icon: Icon, tone }: { title: string; items: string[]; icon: any; tone: "rose" | "amber" | "emerald" }) {
  const toneClasses = tone === "rose" ? "text-rose-400 border-rose-500/20" : tone === "amber" ? "text-amber-400 border-amber-500/20" : "text-emerald-400 border-emerald-500/20";
  return (
    <Card className={cn("border bg-white/[0.03]", toneClasses.split(" ")[1])}>
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className={cn("h-4 w-4", tone === "rose" ? "text-rose-400" : tone === "amber" ? "text-amber-400" : "text-emerald-400")} />
            <h4 className="text-sm font-bold">{title}</h4>
          </div>
          <Badge variant="outline" className={cn("text-[10px]", toneClasses)}>{items.length}</Badge>
        </div>
        {items.length === 0 ? (
          <div className="py-4 text-center text-[11px] text-slate-600">None</div>
        ) : (
          <div className="space-y-1.5">
            {items.map((f, i) => (
              <div key={i} className="flex items-start gap-2 rounded-md bg-white/[0.02] px-2 py-1.5 text-[11px] text-slate-300">
                <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", tone === "rose" ? "text-rose-400" : tone === "amber" ? "text-amber-400" : "text-emerald-400")} />
                {f}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
