import { NextResponse } from "next/server";
import { loadCandles, candlesToArrays, ensureCandles, type Timeframe } from "@/lib/trading/candles";
import { generateStrategy } from "@/lib/trading/research";
import { calcATR, runBacktest, type BacktestConfig, type StrategyName } from "@/lib/trading/backtest";
import { detectRegime } from "@/lib/trading/regime";
import { calcVWAP, calcOBV, calcVolumeRatio, vwapSignal } from "@/lib/trading/volume";
import { getFundingRate } from "@/lib/trading/funding";
import { predictDirection } from "@/lib/trading/ml-predict";
import { getTicker } from "@/lib/indodax";

export const runtime = "nodejs";
export const maxDuration = 30;

// GET /api/signal?pair=btc_idr&capital=1000000&riskPct=2&strategy=rsi_reversal
// Returns: BUY/SELL/HOLD recommendation + position sizing + entry/SL/TP + potential P&L + reasoning
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const pair = url.searchParams.get("pair") || "btc_idr";
    const capital = parseFloat(url.searchParams.get("capital") || "1000000");
    const riskPct = parseFloat(url.searchParams.get("riskPct") || "2");
    const strategy = url.searchParams.get("strategy") || "rsi_reversal";

    // Tuned params per strategy (from grid search optimization)
    const tunedParams: Record<string, number> = { timeframe: "1h" as unknown as number };
    if (strategy === "rsi_reversal") { tunedParams.oversold = 35; tunedParams.overbought = 70; tunedParams.period = 14; }
    if (strategy === "sma_cross") { tunedParams.fast = 5; tunedParams.slow = 20; }
    if (strategy === "donchian_breakout") { tunedParams.entryPeriod = 20; tunedParams.exitPeriod = 10; }
    if (strategy === "mean_reversion") { tunedParams.period = 20; tunedParams.entryZ = 2; }

    // Load real 1h candles for signal generation
    let candles1h = await loadCandles(pair, "1h", 300);
    if (candles1h.length < 30) {
      const { candles } = await ensureCandles(pair, "1m", 30);
      candles1h = candles;
    }
    if (candles1h.length < 10) {
      return NextResponse.json({ error: "Not enough candle data" }, { status: 400 });
    }

    // Generate strategy signal on 1h candles
    const { closes, highs, lows, volumes } = candlesToArrays(candles1h);
    const strat = await generateStrategy(pair, closes, highs, lows, volumes);
    const currentPrice = strat.indicators.currentPrice;

    // Daily trend (MTF confirmation)
    const candles1d = await loadCandles(pair, "1d", 50);
    let dailyTrend: "bullish" | "bearish" | "neutral" = "neutral";
    let dailySma10 = 0, dailySma20 = 0;
    if (candles1d.length >= 20) {
      const dCloses = candles1d.map(c => c.close);
      dailySma10 = dCloses.slice(-10).reduce((a, b) => a + b, 0) / 10;
      dailySma20 = dCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;
      dailyTrend = dailySma10 > dailySma20 ? "bullish" : dailySma10 < dailySma20 ? "bearish" : "neutral";
    }

    // ATR for position sizing
    const atr = calcATR(candles1h.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })), 14);

    // Market regime detection (trending / ranging / volatile)
    const regime = detectRegime(
      candles1h.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
      (candles1d || []).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    );

    // Apply regime-aware signal filtering:
    // - Volatile → downgrade to HOLD (stay out)
    // - Bearish trending → downgrade BUY to HOLD (don't fight the trend)
    // - Ranging → boost mean-reversion signals (RSI, Stochastic, Bollinger)
    let signal = strat.signal;
    let mtfFiltered = false;
    let regimeFiltered = false;
    let regimeAdjustment = "";

    if (regime.regime === "volatile" && signal !== "HOLD") {
      signal = "HOLD";
      regimeFiltered = true;
      regimeAdjustment = `Regime volatile (ATR ratio ${regime.atrRatio.toFixed(2)}, BB width ${regime.bbWidth.toFixed(1)}%) → stay out`;
    } else if (regime.regime === "bearish_trending" && signal === "BUY") {
      signal = "HOLD";
      mtfFiltered = true;
      regimeAdjustment = `Bearish trending (ADX ${regime.adx.toFixed(0)}) → BUY difilter, jangan lawan downtrend`;
    } else if (regime.regime === "ranging" && signal === "BUY") {
      // In ranging market, mean-reversion BUY signals are stronger
      regimeAdjustment = `Ranging market (ADX ${regime.adx.toFixed(0)}) → mean-reversion BUY favored`;
    } else if (regime.regime === "bullish_trending" && signal === "BUY") {
      regimeAdjustment = `Bullish trending (ADX ${regime.adx.toFixed(0)}) → trend-following BUY confirmed`;
    }

    // Position sizing (only relevant if BUY)
    const riskAmount = capital * (riskPct / 100);
    const stopLoss = atr > 0 ? currentPrice - atr * 1.5 : currentPrice * (1 - 0.03);
    const takeProfit = atr > 0 ? currentPrice + atr * 3 : currentPrice * (1 + 0.05);
    const stopDist = Math.abs(currentPrice - stopLoss);
    const tpDist = Math.abs(takeProfit - currentPrice);
    const coinAmount = stopDist > 0 ? riskAmount / stopDist : 0;
    const positionIdr = coinAmount * currentPrice;
    const potentialLoss = riskAmount; // if SL hit, lose exactly riskAmount
    const potentialProfit = coinAmount * tpDist; // if TP hit
    const riskRewardRatio = tpDist / stopDist;

    // Strategy historical performance (quick backtest on all available 1h data)
    const allCandles = await loadCandles(pair, "1h", 9999);
    const btCandles = allCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const btConfig: BacktestConfig = { strategy: strategy as StrategyName, initialCapital: capital, pair, stopLossPct: 0.03, takeProfitPct: 0.05, params: tunedParams, feeRate: 0.003 };
    const btResult = runBacktest(btCandles, btConfig);
    const btDays = allCandles.length > 0 ? Math.round((allCandles[allCandles.length - 1].time - allCandles[0].time) / 86400) : 0;
    const strategyPerf = {
      trades: btResult.tradeCount, netProfit: btResult.netProfit, profitFactor: isFinite(btResult.profitFactor) ? btResult.profitFactor : 999,
      winRate: btResult.winRate, maxDrawdown: btResult.maxDrawdown, totalFees: btResult.totalFees,
      avgWin: btResult.avgWin, avgLoss: btResult.avgLoss,
      monteCarloBust: btResult.monteCarlo?.bustProbability ?? null, days: btDays, candleCount: allCandles.length,
    };

    // Build reasoning — formatted numbers for readability
    const fmtCompact = (v: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
    const fmtIDR = (v: number) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(v);
    const reasoning: string[] = [];
    if (strat.indicators.rsi14 < 30) reasoning.push(`RSI ${strat.indicators.rsi14.toFixed(0)} oversold → bullish reversal signal`);
    else if (strat.indicators.rsi14 > 70) reasoning.push(`RSI ${strat.indicators.rsi14.toFixed(0)} overbought → bearish signal`);
    else reasoning.push(`RSI ${strat.indicators.rsi14.toFixed(0)} neutral`);

    if (strat.indicators.macd) {
      const h = strat.indicators.macd.histogram;
      if (h > 0) reasoning.push(`MACD histogram +${fmtCompact(h)} bullish momentum`);
      else reasoning.push(`MACD histogram ${fmtCompact(h)} bearish momentum`);
    }

    if (strat.indicators.sma10 && strat.indicators.sma20) {
      if (strat.indicators.sma10 > strat.indicators.sma20) reasoning.push(`SMA golden cross (SMA10 ${fmtCompact(strat.indicators.sma10)} > SMA20 ${fmtCompact(strat.indicators.sma20)}) → uptrend`);
      else reasoning.push(`SMA death cross (SMA10 ${fmtCompact(strat.indicators.sma10)} < SMA20 ${fmtCompact(strat.indicators.sma20)}) → downtrend`);
    }

    if (strat.indicators.stochasticK < 20) reasoning.push(`Stochastic ${strat.indicators.stochasticK.toFixed(0)} oversold`);
    else if (strat.indicators.stochasticK > 80) reasoning.push(`Stochastic ${strat.indicators.stochasticK.toFixed(0)} overbought`);

    if (dailyTrend === "bullish") reasoning.push(`Daily trend bullish (SMA10 ${fmtCompact(dailySma10)} > SMA20 ${fmtCompact(dailySma20)}) → MTF confirmed`);
    else if (dailyTrend === "bearish") reasoning.push(`Daily trend bearish (SMA10 ${fmtCompact(dailySma10)} < SMA20 ${fmtCompact(dailySma20)}) → counter-trend, cautious`);
    else reasoning.push(`Daily trend neutral`);

    if (mtfFiltered) reasoning.push(`⚠️ BUY signal filtered by MTF (daily bearish) — wait for daily trend to turn bullish`);

    reasoning.push(`ATR ${fmtIDR(atr)} → SL 1.5×ATR (${fmtIDR(atr * 1.5)}) di bawah entry, TP 3×ATR (${fmtIDR(atr * 3)}) di atas`);

    // Volume analysis — VWAP, OBV, volume ratio
    const volCandles = candles1h.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const vwap = calcVWAP(volCandles, 24);
    const obv = calcOBV(volCandles);
    const volRatio = calcVolumeRatio(volCandles, 20);
    const vwapSig = vwapSignal(volCandles);

    if (vwap && vwapSig) {
      if (vwapSig.position === "above") reasoning.push(`Price ${fmtCompact(currentPrice)} above VWAP ${fmtCompact(vwap.vwap)} (+${vwapSig.strength.toFixed(2)}%) → buyers in control`);
      else if (vwapSig.position === "below") reasoning.push(`Price ${fmtCompact(currentPrice)} below VWAP ${fmtCompact(vwap.vwap)} (-${vwapSig.strength.toFixed(2)}%) → sellers in control`);
      else reasoning.push(`Price at VWAP ${fmtCompact(vwap.vwap)} → equilibrium`);
    }

    if (obv.trend === "accumulation") reasoning.push(`OBV rising → accumulation (smart money buying)`);
    else if (obv.trend === "distribution") reasoning.push(`OBV falling → distribution (smart money selling)`);

    if (volRatio.conviction === "high") reasoning.push(`Volume ratio ${volRatio.ratio.toFixed(2)}× → HIGH conviction move (institutional activity)`);
    else if (volRatio.conviction === "low") reasoning.push(`Volume ratio ${volRatio.ratio.toFixed(2)}× → LOW conviction (possible false signal, be cautious)`);
    else reasoning.push(`Volume ratio ${volRatio.ratio.toFixed(2)}× → normal`);

    // Volume confirmation filter: if BUY signal but volume conviction is low, warn
    let volumeWarning = "";
    if (signal === "BUY" && volRatio.conviction === "low") {
      volumeWarning = `⚠️ BUY signal tapi volume rendah (${volRatio.ratio.toFixed(2)}×) — kemungkinan false breakout, tunggu volume konfirmasi`;
    }

    // Funding Rate analysis (Binance perpetual futures — crypto-specific contrarian signal)
    const funding = await getFundingRate(pair);
    let fundingAdjustment = "";
    if (funding) {
      if (funding.extremeHigh && signal === "BUY") {
        fundingAdjustment = `⚠️ Funding rate ${funding.currentPct.toFixed(4)}% EXTREME HIGH → longs overleveraged. BUY signal lemah (contrarian SELL bias).`;
      } else if (funding.extremeLow && signal !== "BUY") {
        fundingAdjustment = `💡 Funding rate ${funding.currentPct.toFixed(4)}% NEGATIVE → shorts overleveraged. Contrarian BUY opportunity (smart money positioned long).`;
      }
      reasoning.push(`Funding rate ${funding.currentPct.toFixed(4)}% (${funding.sentiment.replace(/_/g, " ")}) → ${funding.signal.replace(/_/g, " ")}`);
    }

    // Get ticker for current market context
    const ticker = await getTicker(pair);

    return NextResponse.json({
      pair,
      strategy,
      signal,
      confidence: strat.strength,
      bias: strat.bias,
      price: currentPrice,
      ticker: ticker ? { high: ticker.high, low: ticker.low, last: ticker.last, vol_idr: ticker.vol_idr } : null,
      dailyTrend,
      mtfFiltered,
      regimeFiltered,
      regimeAdjustment,
      regime,
      atr,
      // Position sizing (only meaningful if BUY)
      sizing: signal === "BUY" ? {
        capital,
        riskPct,
        riskAmount,
        positionIdr,
        coinAmount,
        stopLoss,
        takeProfit,
        stopDistPct: (stopDist / currentPrice) * 100,
        tpDistPct: (tpDist / currentPrice) * 100,
        potentialLoss,
        potentialProfit,
        riskRewardRatio,
        // P7: Risk caps — conservative defaults for crypto
        riskCaps: {
          maxRiskPerTradePct: Math.min(riskPct, 1), // hard cap 1% per trade (was 5%)
          maxRiskPerTradeIdr: capital * Math.min(riskPct, 1) / 100,
          maxPortfolioExposurePct: 20, // max 20% of capital in open positions
          maxPortfolioExposureIdr: capital * 0.20,
          dailyLossLimitPct: 2, // stop trading if daily loss > 2%
          dailyLossLimitIdr: capital * 0.02,
          maxConsecutiveLosses: 3, // stop after 3 consecutive losing trades
          correlationCapNote: "BTC/ETH/SOL correlated — treat as 1 position, not 3 independent",
          positionSizeWithinCaps: positionIdr <= capital * 0.20,
        },
      } : null,
      // Kelly Criterion (always computed — useful even when signal is HOLD)
      kelly: (() => {
        const sp = strategyPerf;
        const W = sp.winRate / 100;
        const R = sp.avgLoss > 0 ? sp.avgWin / sp.avgLoss : (sp.avgWin > 0 ? 999 : 1);
        const kellyFull = W - (1 - W) / R;
        return {
          formula: "K = W - (1-W)/R",
          winRate: W,
          payoffRatio: R,
          avgWin: sp.avgWin ?? 0,
          avgLoss: sp.avgLoss ?? 0,
          fullKelly: kellyFull * 100,
          halfKelly: kellyFull * 0.5 * 100,
          quarterKelly: kellyFull * 0.25 * 100,
          recommendedSizePct: Math.max(0, kellyFull * 0.25 * 100),
          recommendedSizeIdr: Math.max(0, kellyFull * 0.25 * capital),
          note: kellyFull <= 0 ? "K ≤ 0 → strategi tidak profitable, jangan trade" : kellyFull > 0.25 ? "K > 25% → terlalu agresif, pakai quarter Kelly" : "Quarter Kelly recommended (25% of full Kelly)",
        };
      })(),
      indicators: {
        rsi: strat.indicators.rsi14,
        macd: strat.indicators.macd?.histogram ?? null,
        sma10: strat.indicators.sma10,
        sma20: strat.indicators.sma20,
        stochastic: strat.indicators.stochasticK,
        bb: strat.indicators.bb ? { upper: strat.indicators.bb.upper, lower: strat.indicators.bb.lower } : null,
      },
      reasoning,
      signals: strat.signals,
      strategyPerf,
      volume: vwap ? {
        vwap: vwap.vwap, vwapUpper: vwap.upperBand, vwapLower: vwap.lowerBand,
        priceVsVwap: vwapSig?.position ?? "neutral", vwapStrength: vwapSig?.strength ?? 0,
        obv: obv.obv, obvTrend: obv.trend,
        volumeRatio: volRatio.ratio, volumeConviction: volRatio.conviction,
      } : null,
      volumeWarning,
      funding,
      fundingAdjustment,
      // ML Direction Prediction (logistic regression on 8 features)
      ml: predictDirection(volCandles.length > 0 ? volCandles : candles1h.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))),
      candleCount: candles1h.length,
      timeframe: "1h",
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Signal generation failed" }, { status: 500 });
  }
}
