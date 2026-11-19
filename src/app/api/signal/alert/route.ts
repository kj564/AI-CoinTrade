import { NextRequest, NextResponse } from "next/server";
import { generateAlphaSignals, type AlphaSignal } from "@/lib/trading/alpha-engine";
import { db } from "@/lib/db";
import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// POST /api/signal/alert
//
// P7: Severity-based alerting. Scans all pairs and classifies each into:
//   CRITICAL — action≠FLAT + confirmed + honest + strong + fresh + OOS Kelly CI5>0
//   ERROR    — action≠FLAT + confirmed + honest + moderate
//   WARN     — absorption detected but funding not extreme (edge forming, not ready)
//   INFO     — regime change or stale data (status update, no action needed)
//
// Only CRITICAL and ERROR send Telegram alerts (actionable signals).
// WARN and INFO are logged but not pushed (avoid notification fatigue).
export async function POST() {
  try {
    const result = await generateAlphaSignals();

    // Classify each signal by severity
    const classified = result.signals.map((s) => ({
      signal: s,
      severity: classifySeverity(s),
    }));

    // Only CRITICAL + ERROR are "actionable" → send Telegram
    const actionable = classified.filter((c) => c.severity === "CRITICAL" || c.severity === "ERROR");

    // WARN signals (edge forming) — logged but not pushed
    const warnings = classified.filter((c) => c.severity === "WARN");

    let tgConfig: { telegramToken?: string | null; telegramChatId?: string | null } | null = null;
    try { tgConfig = await db.botConfig.findUnique({ where: { id: "singleton" } }); } catch { /* ignore */ }

    const alerts: { pair: string; severity: string; action: string; sent: boolean; error?: string }[] = [];

    for (const { signal: s, severity } of actionable) {
      const message = formatAlertMessage(s, severity);
      if (tgConfig?.telegramToken && tgConfig?.telegramChatId) {
        try {
          const ok = await sendTelegram(tgConfig.telegramToken, tgConfig.telegramChatId, message);
          alerts.push({ pair: s.pair, severity, action: s.action, sent: ok });
        } catch (e) {
          alerts.push({ pair: s.pair, severity, action: s.action, sent: false, error: e instanceof Error ? e.message : String(e) });
        }
      } else {
        alerts.push({ pair: s.pair, severity, action: s.action, sent: false, error: "Telegram not configured" });
      }
    }

    // Log WARN signals (edge forming — don't send but track)
    for (const { signal: s } of warnings) {
      console.log(`[alert] WARN ${s.pair}: edge forming (absorption=${s.microstructure?.absorptionDetected}, funding z=${s.raw.fundingZScore.toFixed(2)}) — not sending Telegram`);
    }

    return NextResponse.json({
      sent: alerts.filter((a) => a.sent).length,
      attempted: alerts.length,
      alerts,
      warnings: warnings.map((w) => ({ pair: w.signal.pair, severity: w.severity, detail: w.signal.microstructure?.confirmation })),
      regimeSummary: result.regimeSummary,
      checkedAt: result.generatedAt,
      telegramConfigured: !!(tgConfig?.telegramToken && tgConfig?.telegramChatId),
      severityBreakdown: {
        CRITICAL: classified.filter((c) => c.severity === "CRITICAL").length,
        ERROR: classified.filter((c) => c.severity === "ERROR").length,
        WARN: warnings.length,
        INFO: classified.filter((c) => c.severity === "INFO").length,
      },
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "alert check failed" }, { status: 500 });
  }
}

function classifySeverity(s: AlphaSignal): "CRITICAL" | "ERROR" | "WARN" | "INFO" {
  // CRITICAL: everything aligns — actionable, strong, OOS-confirmed
  if (s.action !== "FLAT" && s.confirmed && s.backtest.honest && s.strength === "strong" && !s.dataStale && s.backtest.kellyCI5 > 0) {
    return "CRITICAL";
  }
  // ERROR: actionable + confirmed but moderate strength or not OOS-confirmed
  if (s.action !== "FLAT" && s.confirmed && (s.backtest.honest || s.strength === "moderate")) {
    return "ERROR";
  }
  // WARN: edge forming — microstructure says reversal_likely but no signal yet
  if (s.action === "FLAT" && s.microstructure?.absorptionDetected && Math.abs(s.raw.fundingZScore) > 1) {
    return "WARN";
  }
  // INFO: everything else (regime change, stale data, neutral)
  return "INFO";
}

function formatAlertMessage(s: AlphaSignal, severity: string): string {
  const icon = severity === "CRITICAL" ? "🚨" : "🔴";
  const lines: string[] = [];
  lines.push(`${icon} [${severity}] CONFIRMED EDGE: ${s.action} ${s.pair.toUpperCase()}`);
  lines.push("");
  lines.push(`Entry: Rp ${s.entry.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`);
  lines.push(`Stop: Rp ${s.stopLoss.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (2 ATR)`);
  lines.push(`TP1: Rp ${s.takeProfit1.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (1.5R)`);
  lines.push(`TP2: Rp ${s.takeProfit2.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (3R)`);
  lines.push(`Size: Rp ${s.positionSizeIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (${(s.positionSizePct * 100).toFixed(1)}% risk)`);
  lines.push(`Notional: Rp ${s.notionalIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (${(s.notionalCapPct * 100).toFixed(0)}%, ${s.leverage.toFixed(1)}x)`);
  lines.push("");
  lines.push(`Funding: ${(s.raw.fundingRate * 100).toFixed(4)}% (z=${s.raw.fundingZScore.toFixed(2)}, ${s.raw.fundingPercentile.toFixed(0)}th)`);
  lines.push(`Regime: ADX ${s.raw.adx.toFixed(0)}, RSI ${s.raw.rsi.toFixed(0)}, ATR ${s.raw.atrPercent.toFixed(2)}%`);
  if (s.microstructure) {
    lines.push(`OI: ${s.microstructure.oiTrend} (${s.microstructure.oiChange4hPct.toFixed(1)}%) | CVD: ${s.microstructure.cvd1h > 0 ? "buy" : "sell"} | ${s.microstructure.absorptionDetected ? "absorption YES" : "no"}`);
  }
  if (s.liquidity) {
    lines.push(`Liquidity: spread ${s.liquidity.spreadPct.toFixed(3)}%, max notional Rp ${s.liquidity.maxNotionalWithoutSlippage.toLocaleString("id-ID", { maximumFractionDigits: 0 })} ${s.liquidity.liquidityCapActive ? "(LIQUIDITY CAP ACTIVE)" : ""}`);
  }
  lines.push("");
  lines.push(`OOS: ${(s.backtest.oosWinRate * 100).toFixed(0)}% win (n=${s.backtest.oosSampleSize}, ${s.backtest.anchoredWindows} anchored windows)`);
  lines.push(`Kelly: ${(s.backtest.kellyFraction * 100).toFixed(1)}% [CI5=${(s.backtest.kellyCI5 * 100).toFixed(1)}%, CI95=${(s.backtest.kellyCI95 * 100).toFixed(1)}%, uncertainty=${(s.backtest.kellyUncertainty * 100).toFixed(0)}%]`);
  lines.push(`Overfit gap: ${(s.backtest.overfitGap * 100).toFixed(0)}% (honest=${s.backtest.honest})`);
  lines.push("");
  lines.push(`Invalidation: ${s.invalidation}`);
  return lines.join("\n");
}
