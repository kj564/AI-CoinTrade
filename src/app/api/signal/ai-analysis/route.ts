import { NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const maxDuration = 30;

// POST /api/signal/ai-analysis
// body: { signal data from /api/signal }
// Returns: multi-agent LLM qualitative analysis (TradingAgents-inspired)
export async function POST(req: Request) {
  try {
    const data = await req.json();
    if (!data) return NextResponse.json({ error: "signal data required" }, { status: 400 });

    const zai = await ZAI.create();

    const systemPrompt = `You are a multi-agent crypto trading desk for INDODAX (Indonesian crypto exchange). Analyze market data from 4 specialist perspectives, then synthesize a final recommendation.

Respond in this exact format:

📊 TECHNICAL ANALYSIS
[2-3 sentences evaluating RSI, MACD, SMA, Stochastic, Bollinger — what do the indicators say?]

📈 SENTIMENT & FLOW
[2-3 sentences evaluating OBV trend, volume ratio, funding rate — what is smart money doing?]

⚖️ RISK ASSESSMENT
[2-3 sentences evaluating market regime, ATR, strategy backtest performance — what are the risks?]

🎯 FINAL RECOMMENDATION: [BUY/SELL/HOLD]
[1-2 sentences synthesizing all perspectives into a clear recommendation]

⚠️ KEY RISK: [main risk if user follows this signal]

Keep it concise, data-driven, in Indonesian. Use the numbers provided. Be honest about weaknesses.`;

    const userData = `
Pair: ${data.pair?.toUpperCase()}
Current Price: Rp ${data.price?.toLocaleString("id-ID")}
Quantitative Signal: ${data.signal} (confidence ${data.confidence}%, bias ${data.bias})

MARKET REGIME: ${data.regime?.label} (ADX ${data.regime?.adx?.toFixed(0)}, ATR ratio ${data.regime?.atrRatio?.toFixed(2)}, BB width ${data.regime?.bbWidth?.toFixed(1)}%)
Daily Trend: ${data.dailyTrend}
Regime Description: ${data.regime?.description}

INDICATORS:
- RSI(14): ${data.indicators?.rsi?.toFixed(0)}
- MACD histogram: ${data.indicators?.macd != null ? data.indicators.macd : "N/A"}
- SMA10: ${data.indicators?.sma10} | SMA20: ${data.indicators?.sma20}
- Stochastic %K: ${data.indicators?.stochastic?.toFixed(0)}

VOLUME:
- VWAP: ${data.volume?.vwap} (price ${data.volume?.priceVsVwap} VWAP by ${data.volume?.vwapStrength?.toFixed(2)}%)
- OBV trend: ${data.volume?.obvTrend}
- Volume ratio: ${data.volume?.volumeRatio?.toFixed(2)}× (${data.volume?.volumeConviction} conviction)

FUNDING RATE (Binance Futures):
- Current: ${data.funding?.currentPct?.toFixed(4)}%
- Sentiment: ${data.funding?.sentiment}
- Contrarian signal: ${data.funding?.signal}
- 30d average: ${(data.funding?.avgRate ?? 0) * 100}%

STRATEGY BACKTEST (${data.strategyPerf?.days}d):
- Trades: ${data.strategyPerf?.trades}
- Win rate: ${data.strategyPerf?.winRate?.toFixed(0)}%
- Profit factor: ${data.strategyPerf?.profitFactor?.toFixed(2)}
- Net profit: Rp ${data.strategyPerf?.netProfit?.toLocaleString("id-ID")}
- Max drawdown: ${data.strategyPerf?.maxDrawdown?.toFixed(0)}%
- Monte Carlo bust: ${data.strategyPerf?.monteCarloBust?.toFixed(0)}%
- Total fees paid: Rp ${data.strategyPerf?.totalFees?.toLocaleString("id-ID")}

${data.regimeAdjustment ? `REGIME NOTE: ${data.regimeAdjustment}` : ""}
${data.fundingAdjustment ? `FUNDING NOTE: ${data.fundingAdjustment}` : ""}
${data.volumeWarning ? `VOLUME WARNING: ${data.volumeWarning}` : ""}

Analyze this data from all 4 perspectives and give a final recommendation.`;

    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: systemPrompt },
        { role: "user", content: userData },
      ],
      thinking: { type: "disabled" },
    });

    const analysis = completion.choices[0]?.message?.content;
    if (!analysis) return NextResponse.json({ error: "LLM returned empty response" }, { status: 500 });

    return NextResponse.json({ success: true, analysis, timestamp: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "AI analysis failed" }, { status: 500 });
  }
}
