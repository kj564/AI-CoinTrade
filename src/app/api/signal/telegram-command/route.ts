import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPortfolioStats } from "@/lib/trading/signal-journal";
import { getDrawdownState } from "@/lib/trading/drawdown-monitor";
import { getTailRiskMetrics } from "@/lib/trading/var-es";
import { getRecentAlertEvents } from "@/lib/trading/signal-alerts";
import { getAllEdgeCircuitBreakers } from "@/lib/trading/edge-circuit-breaker";
import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// POST /api/signal/telegram-command
//
// Telegram bot webhook handler. Receives a Telegram Update object (message with
// text command), processes it, and responds via Telegram sendMessage API.
//
// Set this endpoint as the Telegram webhook:
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain/api/signal/telegram-command"
//
// Supported commands:
//   /status     — portfolio overview (signals, P&L, drawdown, multiplier)
//   /portfolio  — detailed portfolio stats (win rate, Sharpe, best/worst)
//   /drawdown   — drawdown state + risk multiplier + recovery ramp
//   /breakers   — per-pair circuit breakers (Wilson + Bootstrap CI)
//   /edges      — per-edge circuit breakers (pair × edgeSource)
//   /tailrisk   — VaR 95/99 + ES 95/99 + bootstrap CI
//   /alerts     — recent alert events (last 5)
//   /help       — list available commands
//
// Security: validates the message came from Telegram by checking the bot token
// matches BotConfig.telegramToken. (Telegram doesn't sign webhooks, but we can
// verify the chat_id matches the configured telegramChatId.)

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text: string;
    from: { id: number; username?: string; first_name?: string };
  };
}

export async function POST(req: NextRequest) {
  try {
    const update: TelegramUpdate = await req.json();
    if (!update.message?.text) {
      return NextResponse.json({ ok: true });
    }

    const text = update.message.text.trim();
    const chatId = update.message.chat.id;

    // Load bot config to verify this is our bot
    const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
    if (!cfg?.telegramToken || !cfg?.telegramChatId) {
      return NextResponse.json({ ok: true, skipped: "no telegram config" });
    }

    // Verify chat_id matches configured chat (security: prevent unauthorized commands)
    // Note: telegramChatId is a string in config, chatId is a number from Telegram
    if (String(chatId) !== cfg.telegramChatId) {
      console.warn(`[telegram-cmd] unauthorized chat_id ${chatId} (expected ${cfg.telegramChatId})`);
      return NextResponse.json({ ok: true, skipped: "unauthorized chat" });
    }

    // Parse command (split on whitespace, take first token as command)
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase().split("@")[0]; // strip @botname suffix

    let response: string;
    switch (command) {
      case "/status":
        response = await cmdStatus();
        break;
      case "/portfolio":
        response = await cmdPortfolio();
        break;
      case "/drawdown":
        response = await cmdDrawdown();
        break;
      case "/breakers":
        response = await cmdBreakers();
        break;
      case "/edges":
        response = await cmdEdges();
        break;
      case "/tailrisk":
        response = await cmdTailRisk();
        break;
      case "/alerts":
        response = await cmdAlerts();
        break;
      case "/help":
        response = cmdHelp();
        break;
      default:
        response = `Unknown command: ${command}\n\nType /help for available commands.`;
    }

    // Send response via Telegram
    await sendTelegram(cfg.telegramToken, cfg.telegramChatId, response.slice(0, 4096)); // Telegram 4096 char limit

    return NextResponse.json({ ok: true, command, responseLength: response.length });
  } catch (e) {
    console.error("[telegram-cmd] error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: true, error: "command failed" });
  }
}

// ── COMMAND HANDLERS ──

async function cmdStatus(): Promise<string> {
  const [stats, dd] = await Promise.all([
    getPortfolioStats(),
    getDrawdownState(10_000_000),
  ]);
  const haltStatus = dd.isHalted ? `⛔ HALTED (${dd.haltReason})` : "✅ Active";
  const multStatus = dd.riskMultiplier < 1.0 ? `⚠️ ${dd.riskMultiplier.toFixed(2)}x` : "✅ 1.00x";
  return [
    "📊 *Portfolio Status*",
    "",
    `Signals: ${stats.totalSignals} (${stats.openSignals} open, ${stats.closedSignals} closed)`,
    `Win Rate: ${stats.closedSignals > 0 ? ((stats.winRate * 100).toFixed(0) + "%") : "—"}`,
    `Net P&L: Rp ${stats.totalPnlIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Sharpe: ${stats.sharpeRatio.toFixed(1)}`,
    "",
    `Drawdown: ${dd.currentDrawdownPct.toFixed(2)}%`,
    `Risk Multiplier: ${multStatus}`,
    `Status: ${haltStatus}`,
    dd.weeklyLossPauseActive ? ` Weekly Loss Pause: ACTIVE` : "",
    dd.dailyLossPauseActive ? ` Daily Loss Pause: ACTIVE` : "",
    "",
    `_Auto-update: hourly cron_`,
  ].filter(Boolean).join("\n");
}

async function cmdPortfolio(): Promise<string> {
  const stats = await getPortfolioStats();
  const lines = [
    "💼 *Portfolio Detail*",
    "",
    `Total: ${stats.totalSignals} | Open: ${stats.openSignals} | Closed: ${stats.closedSignals}`,
    `Wins: ${stats.wins} | Losses: ${stats.losses}`,
    `Win Rate: ${stats.closedSignals > 0 ? ((stats.winRate * 100).toFixed(1) + "%") : "—"}`,
    `Avg P&L: ${(stats.avgPnlPct * 100).toFixed(2)}%`,
    `Net P&L: Rp ${stats.totalPnlIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Avg Hold: ${stats.avgHoldHours.toFixed(1)}h`,
    `Sharpe: ${stats.sharpeRatio.toFixed(2)}`,
    `Best: +${(stats.bestTrade * 100).toFixed(2)}% | Worst: ${(stats.worstTrade * 100).toFixed(2)}%`,
  ];
  if (stats.byPair.length > 0) {
    lines.push("", "*Per Pair:*");
    for (const p of stats.byPair.slice(0, 5)) {
      lines.push(` ${p.pair.toUpperCase()}: ${p.signals} sig, ${(p.winRate * 100).toFixed(0)}% win, Rp ${p.pnlIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`);
    }
  }
  return lines.join("\n");
}

async function cmdDrawdown(): Promise<string> {
  const dd = await getDrawdownState(10_000_000);
  const lines = [
    "🛡 *Drawdown Protection*",
    "",
    `Current Drawdown: ${dd.currentDrawdownPct.toFixed(2)}%`,
    `Risk Multiplier: ${dd.riskMultiplier.toFixed(2)}x`,
    `Tier: ${dd.riskTierLabel}`,
    `Status: ${dd.isHalted ? "⛔ HALTED (" + dd.haltReason + ")" : "✅ Active"}`,
    "",
    `Cumulative P&L: Rp ${dd.cumulativePnlIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Peak: Rp ${dd.peakPnlIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Trough: Rp ${dd.troughPnlIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    "",
    `Weekly Loss: ${dd.weeklyLossPct.toFixed(2)}% ${dd.weeklyLossPauseActive ? "⛔ PAUSED" : ""}`,
    `Daily Loss: ${dd.dailyLossPct.toFixed(2)}% ${dd.dailyLossPauseActive ? "⛔ PAUSED" : ""}`,
  ];
  if (dd.rampStage > 0) {
    lines.push("", `*Recovery Ramp:* Stage ${dd.rampStage} (${dd.rampStageLabel})`);
    lines.push(`Age: ${dd.rampAgeHours.toFixed(1)}h / 168h`);
    lines.push(`Cap: ${dd.rampMultiplierCap.toFixed(2)}x`);
  }
  return lines.join("\n");
}

async function cmdBreakers(): Promise<string> {
  const pairs = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
  const rows = await Promise.all(
    pairs.map((p) => db.alphaCircuitBreaker.upsert({ where: { pair: p }, create: { pair: p }, update: {} })),
  );
  const lines = ["🔌 *Per-Pair Circuit Breakers*", ""];
  for (const r of rows) {
    const winRate = r.totalSignals > 0 ? (r.totalWins / r.totalSignals * 100).toFixed(0) + "%" : "—";
    const status = r.circuitOpen ? "⛔ OPEN" : "✅ closed";
    lines.push(`${r.pair.toUpperCase()}: ${status} | n=${r.totalSignals} | win=${winRate} | trips=${r.circuitTrips}`);
  }
  return lines.join("\n");
}

async function cmdEdges(): Promise<string> {
  const breakers = await getAllEdgeCircuitBreakers();
  if (breakers.length === 0) {
    return "🔌 *Per-Edge Circuit Breakers*\n\nNo edge breakers recorded yet. Will appear after signals fire + close.";
  }
  const lines = ["🔧 *Per-Edge Circuit Breakers*", ""];
  for (const b of breakers) {
    const winRate = b.totalSignals > 0 ? (b.winRate * 100).toFixed(0) + "%" : "—";
    const status = b.open ? "⛔ OPEN" : "✅ closed";
    lines.push(`${b.pair.toUpperCase()} · ${b.edgeSource}: ${status} | n=${b.totalSignals} | win=${winRate} | trips=${b.trips}`);
  }
  return lines.join("\n");
}

async function cmdTailRisk(): Promise<string> {
  const tr = await getTailRiskMetrics();
  if (tr.sampleSize === 0) {
    return "📉 *Tail Risk (VaR/ES)*\n\nNo closed trades yet. VaR/ES computed after ≥30 closed signals.";
  }
  const fmtLoss = (pct: number) => `${Math.abs(pct * 100).toFixed(2)}%`;
  return [
    "📉 *Tail Risk (VaR/ES)*",
    "",
    `Sample: n=${tr.sampleSize} (tail=${tr.tailSampleSize}) ${tr.ciAdequate ? "✅" : "⚠️ low confidence"}`,
    "",
    `VaR 95: ${fmtLoss(tr.var95Pct)} [CI: ${fmtLoss(tr.var95BootstrapCI5)}, ${fmtLoss(tr.var95BootstrapCI95)}]`,
    `ES 95:  ${fmtLoss(tr.es95Pct)} [CI: ${fmtLoss(tr.es95BootstrapCI5)}, ${fmtLoss(tr.es95BootstrapCI95)}]`,
    `VaR 99: ${fmtLoss(tr.var99Pct)} [CI: ${fmtLoss(tr.var99BootstrapCI5)}, ${fmtLoss(tr.var99BootstrapCI95)}]`,
    `ES 99:  ${fmtLoss(tr.es99Pct)} [CI: ${fmtLoss(tr.es99BootstrapCI5)}, ${fmtLoss(tr.es99BootstrapCI95)}]`,
    "",
    `Worst trade: ${fmtLoss(tr.worstTradePct)}`,
    `Portfolio VaR 95: Rp ${tr.portfolioVar95Idr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
  ].join("\n");
}

async function cmdAlerts(): Promise<string> {
  const events = await getRecentAlertEvents(5);
  if (events.length === 0) {
    return "🔔 *Recent Alerts*\n\nNo alerts fired yet.";
  }
  const lines = ["🔔 *Recent Alerts (last 5)*", ""];
  for (const e of events) {
    const sevIcon = e.severity === "critical" ? "🚨" : e.severity === "error" ? "🔴" : e.severity === "warn" ? "🟡" : "ℹ️";
    const pair = e.pair ? ` ${e.pair.toUpperCase()}` : "";
    lines.push(`${sevIcon} ${e.type.replace(/_/g, " ")}${pair}`);
    lines.push(`   ${e.message.split("\n\n")[0].slice(0, 100)}`);
  }
  return lines.join("\n");
}

function cmdHelp(): string {
  return [
    "📖 *Available Commands*",
    "",
    "/status — Portfolio overview (signals, P&L, drawdown, multiplier)",
    "/portfolio — Detailed stats (win rate, Sharpe, per-pair)",
    "/drawdown — Drawdown state + recovery ramp + weekly/daily loss",
    "/breakers — Per-pair circuit breakers (Wilson + Bootstrap CI)",
    "/edges — Per-edge circuit breakers (pair × edgeSource)",
    "/tailrisk — VaR 95/99 + ES 95/99 + bootstrap CI",
    "/alerts — Recent alert events (last 5)",
    "/help — This message",
    "",
    "_All data is paper trading (virtual). Not financial advice._",
  ].join("\n");
}

// GET endpoint — for health check / webhook verification
export async function GET() {
  return NextResponse.json({
    ok: true,
    commands: ["/status", "/portfolio", "/drawdown", "/breakers", "/edges", "/tailrisk", "/alerts", "/help"],
    setup: "Set webhook: curl 'https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain/api/signal/telegram-command'",
  });
}
