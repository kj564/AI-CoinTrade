# Alpha Signal Engine — Runbook

## Scenarios

### 1. All signals FLAT
**Symptom:** All pairs show action=FLAT, 0 active signals.
**Diagnosis:** Market offers no edge right now. Funding z-scores all <2, ADX in transition (20-25), RSI neutral (40-60).
**Action:** This is correct behavior. Do NOT trade. The system preserves capital by saying FLAT. Check `/api/signal/alpha` for the rationale per pair.

### 2. WARN severity (edge forming)
**Symptom:** One or more pairs show WARN severity but no Telegram alert sent.
**Diagnosis:** Microstructure shows absorption + funding z > 1 but < 2. Edge is forming but not confirmed.
**Action:** Watch closely. When funding z breaks >2 AND OI declining AND OOS honest → severity upgrades to CRITICAL/ERROR → alert sent. Check `/api/signal/alert` for WARN details.

### 3. Absorption not validated (lift=1.0x)
**Symptom:** `absorptionValidation.validated=false`, `lift=1.0x`.
**Diagnosis:** The OOS backtest found that the absorption threshold (80th percentile of volume/body ratio) does NOT predict reversals better than random at the 0.3% reversal threshold. This is an honest negative result.
**Action:** The microstructure "absorptionDetected" flag is still used for confirmation, but treat it with caution. The system knows it's not validated and factors this into the `honest` check. If you want to improve absorption prediction, consider: (a) higher reversal threshold (1%+ instead of 0.3%), (b) different absorption metric (CVD divergence instead of volume/body), (c) regime-conditioned threshold.

### 4. Liquidity cap active
**Symptom:** `liquidity.liquidityCapActive=true`, notional reduced below 30% capital cap.
**Diagnosis:** The INDODAX order book is thin — walking the book shows >0.5% slippage before reaching the capital cap. The system auto-reduces notional to the liquidity limit.
**Action:** This prevents slippage from eating your edge. Check `liquidity.walkBookLevels` and `liquidity.walkBookSlippagePct` for details. If consistently triggered, the pair may be too illiquid for your capital size.

### 5. Kelly CI5 = 0 but Kelly point estimate > 0
**Symptom:** `backtest.kellyFraction > 0` but `backtest.kellyCI5 = 0`.
**Diagnosis:** The point estimate Kelly is positive, but 95% of bootstrap resamples include zero or negative Kelly. The edge is not statistically significant.
**Action:** The system uses CI5 (conservative) for sizing → Kelly=0 → no position. This is correct. Do NOT override. Wait for more OOS trades to accumulate so the CI narrows.

### 6. Regime unstable (anchoredRollingGap > 15%)
**Symptom:** `backtest.regimeStable=false`, `anchoredRollingGap > 0.15`.
**Diagnosis:** Anchored and rolling walk-forward disagree by >15% win rate. The regime is transitioning — old data (in the anchored window) is diluting the signal.
**Action:** The system sets `honest=false` → no CRITICAL alert. Wait for regime to stabilize. Check `/api/signal/metrics` → `alpha_regime_stable{pair}` gauge.

### 7. Data stale
**Symptom:** `dataStale=true`, warning says "Signal may be based on outdated prices."
**Diagnosis:** Binance klines API returned data older than the pair-specific threshold (BTC/ETH: 65min, SOL/BNB: 90min, XRP: 120min).
**Action:** Do NOT execute on stale signals. Check if Binance API is reachable. The system falls back to INDODAX DB candles if Binance fails, but those may have fewer data points.

### 8. Telegram not configured
**Symptom:** Alert route returns `telegramConfigured=false`.
**Diagnosis:** BotConfig.telegramToken/ChatId not set.
**Action:** Set Telegram credentials in Bot Config (UI) or via env vars. For multi-channel (Slack/Discord/webhook), set `L2_ALERT_SLACK_WEBHOOK_URL`, `L2_ALERT_DISCORD_WEBHOOK_URL`, `L2_ALERT_WEBHOOK_URL` env vars. CRITICAL alerts go to all channels; ERROR to Telegram+Slack; WARN/INFO logged only.

## Metrics
- `GET /api/signal/metrics` — Prometheus format (alpha_funding_zscore, alpha_oos_winrate, alpha_kelly_ci5, alpha_liquidity_cap_active, alpha_regime_stable, alpha_absorption_validated, alpha_capital_at_risk, alpha_data_stale)
- `GET /api/signal/alpha?capital=10000000` — Full JSON signal output
- `POST /api/signal/alert` — Severity-classified alerts + multi-channel dispatch

### 9. Circuit breaker tripped
**Symptom:** `circuitBreaker.open=true`, warning says "CIRCUIT BREAKER TRIPPED".
**Diagnosis:** Pair has 3 consecutive OOS-validated losing signals. Edge may have degraded for this pair.
**Action:** Do NOT override. Signals suppressed for cooldown (1h→2h→4h→8h exponential). After cooldown, half-open probe allows ONE signal. If it wins → circuit closes. If it loses → re-open with longer cooldown. Check `circuitBreaker.cooldownSec` for time remaining.

### 10. Limit order recommendation
**Symptom:** `limitOrder.recommendation` = "use_market" or "improve_price".
**Diagnosis:** Order book queue is too deep relative to your order size. Fill probability low (<30%). Adverse selection cost outweighs spread savings.
**Action:** Use market order instead of limit. Or improve your price (cross half-spread) for better fill probability. Check `limitOrder.fillProbability` and `limitOrder.netExpectedCostPct`.

### 11. Expected value negative (EV severity = WARN)
**Symptom:** `impact.evSeverity=WARN`, `impact.expectedValueIdr <= 0`.
**Diagnosis:** Impact × probability = negative expected value. Even though the signal fired, the OOS win rate is too low for the risk/reward ratio.
**Action:** Do NOT execute. The system correctly identifies this as negative EV. Wait for OOS win rate to improve (more data) or for a better risk/reward entry.

### 12. Email alert not received
**Symptom:** CRITICAL alert sent but no email.
**Diagnosis:** `L2_ALERT_SMTP_HOST` or `L2_ALERT_EMAIL_TO` env vars not set.
**Action:** Set SMTP env vars: `L2_ALERT_SMTP_HOST`, `L2_ALERT_SMTP_PORT` (default 587), `L2_ALERT_SMTP_USER`, `L2_ALERT_SMTP_PASS`, `L2_ALERT_EMAIL_TO`, `L2_ALERT_EMAIL_FROM`. Email is only sent for CRITICAL severity (not ERROR/WARN/INFO).

### 13. Absorption multi-level sweep all negative
**Symptom:** `absorptionValidation.validated=false`, description says "NO validated cell found across 6 reversal levels".
**Diagnosis:** Absorption ratio (volume/body) does not predict reversals at ANY reversal level (0.3% to 3%). This is a robust honest negative — not a threshold tuning issue.
**Action:** Accept that absorption is not predictive for this pair. The system still uses microstructure (OI trend, CVD divergence) for confirmation, but absorption alone is not sufficient. Consider alternative microstructure signals (e.g., delta volume divergence).
