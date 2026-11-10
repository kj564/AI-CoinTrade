// Telegram notification helper — sends messages via Telegram Bot API.
// Used by the bot engine to notify on position open/close events.

export async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
    const d = await r.json();
    return d.ok === true;
  } catch {
    return false;
  }
}

export function formatOpenMessage(opts: {
  mode: string; pair: string; entryPrice: number; positionIdr: number;
  stopLoss: number; takeProfit: number; atr: number; strategy: string; dailyTrend: string;
}): string {
  const emoji = opts.mode === "live" ? "🔴" : "🟢";
  return `${emoji} *Position Opened* (${opts.mode.toUpperCase()})
Pair: ${opts.pair.toUpperCase()}
Strategy: ${opts.strategy}
Entry: Rp ${opts.entryPrice.toLocaleString("id-ID")}
Size: Rp ${opts.positionIdr.toLocaleString("id-ID")}
SL: Rp ${opts.stopLoss.toLocaleString("id-ID")} (ATR ${opts.atr.toLocaleString("id-ID")})
TP: Rp ${opts.takeProfit.toLocaleString("id-ID")}
Daily trend: ${opts.dailyTrend}`;
}

export function formatCloseMessage(opts: {
  mode: string; pair: string; reason: string; exitPrice: number;
  entryPrice: number; pnl: number; pnlPct: number;
}): string {
  const win = opts.pnl >= 0;
  const emoji = win ? "💰" : "📉";
  return `${emoji} *Position Closed* (${opts.mode.toUpperCase()})
Pair: ${opts.pair.toUpperCase()}
Reason: ${opts.reason}
Exit: Rp ${opts.exitPrice.toLocaleString("id-ID")}
PnL: ${win ? "+" : ""}Rp ${opts.pnl.toLocaleString("id-ID")} (${opts.pnlPct >= 0 ? "+" : ""}${opts.pnlPct.toFixed(2)}%)`;
}
