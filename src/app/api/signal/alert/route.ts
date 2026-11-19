import { NextRequest, NextResponse } from "next/server";
import { generateAlphaSignals } from "@/lib/trading/alpha-engine";
import { db } from "@/lib/db";
import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// POST /api/signal/alert
//
// Scans all pairs for confirmed edges and sends Telegram alerts ONLY when:
//   1. Action is LONG or SHORT (not FLAT)
//   2. Microstructure confirmation = "reversal_likely" (OI + absorption agree)
//   3. Walk-forward OOS win rate > 50% (edge confirmed out-of-sample)
//   4. Funding z-score > 2 (pair-adaptive extreme)
//
// This prevents notification noise — you only get pinged when ALL layers align.
// Returns the alerts that were sent (or would be sent if Telegram is configured).
export async function POST() {
  try {
    const result = await generateAlphaSignals();

    // Filter: only send alerts for confirmed, actionable signals
    const alertable = result.signals.filter((s) => {
      if (s.action !== "LONG" && s.action !== "SHORT") return false;
      if (!s.confirmed) return false; // microstructure must confirm
      if (!s.backtest.honest) return false; // OOS must confirm
      if (s.dataStale) return false; // don't alert on stale data
      return true;
    });

    if (alertable.length === 0) {
      return NextResponse.json({
        sent: 0,
        reason: "No confirmed edges. All signals are either FLAT, unconfirmed by microstructure, or OOS-validated as not honest.",
        regimeSummary: result.regimeSummary,
        checkedAt: result.generatedAt,
      });
    }

    // Load Telegram config
    let tgConfig: { telegramToken?: string | null; telegramChatId?: string | null } | null = null;
    try {
      tgConfig = await db.botConfig.findUnique({ where: { id: "singleton" } });
    } catch { /* ignore */ }

    const alerts: { pair: string; action: string; sent: boolean; error?: string }[] = [];

    for (const s of alertable) {
      const message = formatAlertMessage(s);
      if (tgConfig?.telegramToken && tgConfig?.telegramChatId) {
        try {
          const ok = await sendTelegram(tgConfig.telegramToken, tgConfig.telegramChatId, message);
          alerts.push({ pair: s.pair, action: s.action, sent: ok });
        } catch (e) {
          alerts.push({ pair: s.pair, action: s.action, sent: false, error: e instanceof Error ? e.message : String(e) });
        }
      } else {
        // Telegram not configured — return what WOULD be sent
        alerts.push({ pair: s.pair, action: s.action, sent: false, error: "Telegram not configured" });
      }
    }

    return NextResponse.json({
      sent: alerts.filter((a) => a.sent).length,
      attempted: alerts.length,
      alerts,
      regimeSummary: result.regimeSummary,
      checkedAt: result.generatedAt,
      telegramConfigured: !!(tgConfig?.telegramToken && tgConfig?.telegramChatId),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "alert check failed" }, { status: 500 });
  }
}

function formatAlertMessage(s: any): string {
  const lines: string[] = [];
  lines.push(`${s.action === "LONG" ? "🟢" : "🔴"} CONFIRMED EDGE: ${s.action} ${s.pair.toUpperCase()}`);
  lines.push("");
  lines.push(`Entry: Rp ${s.entry.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`);
  lines.push(`Stop: Rp ${s.stopLoss.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (2 ATR)`);
  lines.push(`TP1: Rp ${s.takeProfit1.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (1.5R)`);
  lines.push(`TP2: Rp ${s.takeProfit2.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (3R)`);
  lines.push(`Size: Rp ${s.positionSizeIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (${(s.positionSizePct * 100).toFixed(1)}% risk)`);
  lines.push(`Notional: Rp ${s.notionalIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (${(s.notionalCapPct * 100).toFixed(0)}% cap, ${s.leverage.toFixed(1)}x lev)`);
  lines.push("");
  lines.push(`Funding: ${(s.raw.fundingRate * 100).toFixed(4)}% (z=${s.raw.fundingZScore.toFixed(2)}, ${s.raw.fundingPercentile.toFixed(0)}th %ile)`);
  lines.push(`Regime: ADX ${s.raw.adx.toFixed(0)}, RSI ${s.raw.rsi.toFixed(0)}, ATR ${s.raw.atrPercent.toFixed(2)}%`);
  if (s.microstructure) {
    lines.push(`OI: ${s.microstructure.oiTrend} (${s.microstructure.oiChange4hPct.toFixed(1)}% 4h)`);
    lines.push(`CVD: ${s.microstructure.cvd1h > 0 ? "net buy" : "net sell"}, ${s.microstructure.absorptionDetected ? "absorption YES" : "no absorption"}`);
  }
  lines.push("");
  lines.push(`OOS backtest: ${(s.backtest.oosWinRate * 100).toFixed(0)}% win (n=${s.backtest.oosSampleSize}), Sharpe ${s.backtest.oosSharpe.toFixed(1)}, Kelly ${(s.backtest.kellyFraction * 100).toFixed(1)}%`);
  lines.push(`Overfit gap: ${(s.backtest.overfitGap * 100).toFixed(0)}% (honest=${s.backtest.honest})`);
  lines.push("");
  lines.push(`Invalidation: ${s.invalidation}`);
  return lines.join("\n");
}
