import { NextResponse } from "next/server";
import { generateAlphaSignals } from "@/lib/trading/alpha-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/signal/metrics — Prometheus text exposition for the alpha engine.
// Scrape with Prometheus/Grafana Agent to observe signal generation.
export async function GET() {
  try {
    const result = await generateAlphaSignals();
    const lines: string[] = [];

    lines.push("# HELP alpha_signals_total Total signals by action and severity");
    lines.push("# TYPE alpha_signals_total gauge");
    for (const s of result.signals) {
      const sev = s.action !== "FLAT" && s.confirmed && s.backtest.honest && s.strength === "strong" ? "critical"
        : s.action !== "FLAT" && s.confirmed ? "error"
        : s.action === "FLAT" && s.microstructure?.absorptionDetected && Math.abs(s.raw.fundingZScore) > 1 ? "warn"
        : "info";
      lines.push(`alpha_signals_total{pair="${s.pair}",action="${s.action}",severity="${sev}"} 1`);
    }

    lines.push("# HELP alpha_funding_zscore Current funding z-score per pair (180p window)");
    lines.push("# TYPE alpha_funding_zscore gauge");
    for (const s of result.signals) {
      lines.push(`alpha_funding_zscore{pair="${s.pair}"} ${s.raw.fundingZScore.toFixed(4)}`);
    }

    lines.push("# HELP alpha_oos_winrate Walk-forward OOS win rate per pair");
    lines.push("# TYPE alpha_oos_winrate gauge");
    for (const s of result.signals) {
      lines.push(`alpha_oos_winrate{pair="${s.pair}"} ${s.backtest.oosWinRate.toFixed(4)}`);
    }

    lines.push("# HELP alpha_kelly_ci5 Bootstrap 5th percentile Kelly per pair");
    lines.push("# TYPE alpha_kelly_ci5 gauge");
    for (const s of result.signals) {
      lines.push(`alpha_kelly_ci5{pair="${s.pair}"} ${s.backtest.kellyCI5.toFixed(4)}`);
    }

    lines.push("# HELP alpha_kelly_uncertainty Bootstrap Kelly CI width (uncertainty)");
    lines.push("# TYPE alpha_kelly_uncertainty gauge");
    for (const s of result.signals) {
      lines.push(`alpha_kelly_uncertainty{pair="${s.pair}"} ${s.backtest.kellyUncertainty.toFixed(4)}`);
    }

    lines.push("# HELP alpha_liquidity_cap_active Whether liquidity cap is binding (1/0)");
    lines.push("# TYPE alpha_liquidity_cap_active gauge");
    for (const s of result.signals) {
      const active = s.liquidity?.liquidityCapActive ? 1 : 0;
      lines.push(`alpha_liquidity_cap_active{pair="${s.pair}"} ${active}`);
    }

    lines.push("# HELP alpha_regime_stable Whether anchored vs rolling WF agree (1/0)");
    lines.push("# TYPE alpha_regime_stable gauge");
    for (const s of result.signals) {
      lines.push(`alpha_regime_stable{pair="${s.pair}"} ${s.backtest.regimeStable ? 1 : 0}`);
    }

    lines.push("# HELP alpha_capital_at_risk Total portfolio capital at risk (%)");
    lines.push("# TYPE alpha_capital_at_risk gauge");
    lines.push(`alpha_capital_at_risk ${result.capitalAtRisk.toFixed(4)}`);

    lines.push("# HELP alpha_data_stale Whether candle data is stale (1/0)");
    lines.push("# TYPE alpha_data_stale gauge");
    for (const s of result.signals) {
      lines.push(`alpha_data_stale{pair="${s.pair}"} ${s.dataStale ? 1 : 0}`);
    }

    lines.push("# HELP alpha_absorption_validated Whether absorption threshold is OOS-validated (1/0)");
    lines.push("# TYPE alpha_absorption_validated gauge");
    for (const s of result.signals) {
      const v = s.absorptionValidation?.validated ? 1 : 0;
      lines.push(`alpha_absorption_validated{pair="${s.pair}"} ${v}`);
    }

    return new NextResponse(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (e) {
    return new NextResponse(`# error\n# ${e instanceof Error ? e.message : "failed"}\n`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
