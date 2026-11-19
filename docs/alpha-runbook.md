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

---

## Capital Protection Scenarios (Layer 1-3)

### 14. Portfolio drawdown halt triggered
**Symptom:** Drawdown strip shows "PORTFOLIO HALT (drawdown_halt)", risk multiplier 0.00x, all new signals forced FLAT.
**Diagnosis:** Cumulative P&L drawdown exceeded -10% of capital. The portfolio-level circuit breaker (Layer 1) has tripped.
**Action:** Do NOT override. No new positions will open until:
  1. Drawdown recovers above -8% (recovery threshold), AND
  2. Recovery ramp completes (Layer 2, see scenario 15).
The halt is persisted in `PortfolioRiskState.haltedAt` so it survives dev server restarts. Investigate root cause: was there a cluster of bad signals? Did market regime shift? Check `/api/signal/recent-signals` for the losing streak.

### 15. Recovery ramp active (anti-V-shape)
**Symptom:** Drawdown strip shows "RECOVERY RAMP ACTIVE" banner with stage 1-4 and progress bar.
**Diagnosis:** Drawdown recovered above -8% after a halt. The system now ramps risk back up gradually over 7 days to prevent immediate full-size resumption:
  - Stage 1 (0-24h, probe):    cap 0.25x — only high-conviction signals
  - Stage 2 (24-72h, cautious): cap 0.50x
  - Stage 3 (72-168h, steady):  cap 0.75x
  - Stage 4 (>168h, full):      cap 1.00x — normal operation resumes
**Action:** Monitor that the ramp progresses. If drawdown re-worsens below -8% during ramp, the ramp clock RESETS (restarts from probe). This is intentional — prevents premature full-size resumption in choppy recovery. Check `PortfolioRiskState.recoveryStartedAt` + `recoveryStage`.

### 16. Weekly loss pause triggered
**Symptom:** Drawdown strip shows "Weekly Loss (7-day rolling) · PAUSED", risk multiplier 0.00x.
**Diagnosis:** Rolling 7-day realized P&L dropped below -3% of capital. The weekly loss pause (Layer 3) has triggered to prevent overtrading + tilt.
**Action:** Do NOT override. New positions suppressed until next Monday 00:00 Jakarta time. The pause auto-expires — no manual intervention needed. If P&L recovers above 0% within the same week, the pause clears early (positive week = no tilt). Check `PortfolioRiskState.weeklyPauseExpiresAt` for the exact resume time.

### 17. Paper-vs-replay deviation detected
**Symptom:** Weekly review shows "PAPER vs REPLAY DEVIATIONS" warning panel with deviation % > 15%.
**Diagnosis:** Actual paper trading win rate / avg P&L diverges >15% from the 21-day replay expectation. Edge hypothesis may have degraded OR sample is too small to draw conclusions.
**Action:**
  - If n < 30 paper trades: ignore — sample too small. Continue collecting data.
  - If n >= 30 AND deviation persists for 2+ weekly reviews: the edge has degraded. Disable the pair (move to NONAKTIF SEMENTARA) and investigate:
    - Did the funding rate regime shift? (Binance perp funding mechanics change)
    - Did INDODAX liquidity change? (check `liquidity.spreadPct`)
    - Did OI/CVD microstructure pattern change? (check `microstructure.confirmation`)
  - Run `/api/signal/replay` to refresh the 21-day baseline.

### 18. Tail risk (VaR/ES) exceeds tolerance
**Symptom:** Tail Risk panel shows VaR 95% > 5% per trade, or ES 95% > 8% per trade.
**Diagnosis:** The worst 5% of trades are losing more than expected. Position sizing may be too aggressive for the realized P&L distribution.
**Action:**
  - If `ciAdequate=false` (n<30): ignore — VaR/ES estimates are highly uncertain.
  - If `ciAdequate=true` AND VaR 95 > 5%: reduce risk per trade from 0.5% to 0.25%. The system's anti-martingale will also auto-scale via drawdown tiers, but manual reduction is faster.
  - If VaR 95 > 10%: halt live trading immediately. Investigate the worst trades in `/api/signal/recent-signals` — are the stops too wide? Are ATR multipliers miscalibrated?

### 19. Circuit breaker Wilson CI vs Bootstrap CI disagreement
**Symptom:** CB table shows Wilson CI [40, 80] but Bootstrap CI [35, 85] — different widths.
**Diagnosis:** Wilson (parametric) assumes binomial distribution; Bootstrap (non-parametric, 1000 resamples) captures skew + serial correlation. Disagreement > 10 percentage points suggests the win/loss distribution is NOT iid binomial.
**Action:**
  - Trust the Bootstrap CI (wider, more honest under skew).
  - If Bootstrap lower bound < 40%, the edge is not statistically confirmed — treat as hypothesis.
  - Investigate serial correlation: are wins clustered? Are losses clustered? This may indicate regime-dependence (edge works in trending markets, fails in ranging).

### 20. Email alert channel failed
**Symptom:** PortfolioAlertEvent shows `delivered=false` for a CRITICAL event despite `L2_ALERT_SMTP_HOST` being set.
**Diagnosis:** SMTP delivery failed. Check `channels` field — if `email` is missing, the send failed.
**Action:**
  - Check `/api/l2/health` for delivery tracker metrics.
  - Verify SMTP credentials: `L2_ALERT_SMTP_USER`, `L2_ALERT_SMTP_PASS`.
  - Test with `POST /api/l2/alerts/test` (sends a smoke-test email).
  - Note: email is only attempted for CRITICAL + ERROR severity events. WARN events go to Telegram + Slack only.

### 21. Recovery ramp stuck at probe stage
**Symptom:** Recovery ramp has been at stage 1 (probe, 0.25x) for >24h without advancing.
**Diagnosis:** Either (a) drawdown keeps re-worsening below -8%, resetting the ramp clock, or (b) a bug in `PortfolioRiskState.recoveryStartedAt` persistence.
**Action:**
  - Check `/api/signal/drawdown` — is `currentDrawdownPct` actually > -8%? If not, the system is correctly holding at probe.
  - If drawdown IS > -8% but ramp is stuck, query the DB directly:
    ```sql
    SELECT haltedAt, recoveryStartedAt, recoveryStage FROM PortfolioRiskState WHERE id='singleton';
    ```
  - If `recoveryStartedAt` is null but `haltedAt` is set and drawdown > -8%, there's a state transition bug. Manually clear: `UPDATE PortfolioRiskState SET haltedAt=NULL, recoveryStartedAt=NULL WHERE id='singleton';`

---

## Capital Protection Scenarios (Layer 4-7)

### 22. Daily loss pause triggered
**Symptom:** Drawdown strip shows "DAILY LOSS PAUSE" with 24h rolling P&L ≤ -1.5%, risk multiplier 0.00x.
**Diagnosis:** The 24h rolling realized P&L breached the -1.5% threshold. This is a tighter pause than weekly (-3%) — it catches intra-day tilt before it becomes a weekly problem.
**Action:** Do NOT override. New positions suppressed until next midnight Jakarta (00:00 WIB). The pause auto-expires — no manual intervention needed. If P&L recovers above 0% same day, the pause clears early. Check `/api/signal/recent-signals` for the losing trades — is there a pattern (same pair? same edge? consecutive revenge trades?).

### 23. Correlation-aware position sizing reduced a signal
**Symptom:** Signal rationale contains "CONCENTRATION CAP: correlated exposure X → penalty Yx. Notional Rp A → Rp B".
**Diagnosis:** There are already open positions in correlated pairs (e.g., LONG BTC open + new LONG ETH signal). The system computed a concentration penalty to avoid over-exposure to the BTC/ETH correlation (~0.85).
**Action:** Accept the reduced size — the system is correctly preventing concentrated risk. If you have 3+ correlated positions open, consider closing one before adding more. Check `/api/signal/correlation?pair=X&action=LONG` to see the effective exposure breakdown. The correlation matrix is static (approximate) — in production it should be recomputed weekly from rolling 30d returns.

### 24. Regime-conditioned VaR disagreement
**Symptom:** Overall VaR 95% = 3% but regime-conditioned VaR shows trend_follow = 2% and mean_revert = 6%.
**Diagnosis:** The loss distribution is NOT uniform across regimes. Mean-revert signals have fatter tails (fades can blow through stops in strong trends). The overall VaR masks this.
**Action:**
  - Trust the regime-conditioned VaR for the CURRENT regime.
  - If current regime is mean_revert AND its VaR 95 > 5%, reduce position size by 50% (on top of the drawdown multiplier).
  - If `ciAdequate=false` for a regime (n<20), ignore — sample too small.
  - Investigate WHY mean_revert has fatter tails: are stops too tight? Is ADX threshold miscalibrated?

### 25. SMS alert channel failed
**Symptom:** PortfolioAlertEvent shows `delivered=true` with channels `["telegram","slack"]` but `sms` is missing, despite `TWILIO_ACCOUNT_SID` being set.
**Diagnosis:** Twilio API call failed. Possible causes: invalid credentials, insufficient balance, wrong phone number format, rate limit.
**Action:**
  - Check `[signal-alerts] SMS failed:` in dev log for the Twilio error response.
  - Verify Twilio credentials: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `SMS_ALERT_TO`.
  - Phone numbers must be E.164 format (e.g., `+6281234567890` for Indonesia).
  - SMS is only attempted for CRITICAL severity (not ERROR/WARN/INFO).
  - Note: SMS is redundant to Telegram — if SMS fails but Telegram succeeds, the alert still reached you.

### 26. Grafana alert fired (proactive monitoring)
**Symptom:** Grafana alert rule "PortfolioHaltDrawdown" or "WeeklyLossPauseTriggered" fires.
**Diagnosis:** The Prometheus metrics endpoint reported a threshold breach. This is PROACTIVE monitoring — the alert fires BEFORE you check the UI.
**Action:**
  - The underlying system has ALREADY responded (halt triggered, pause active, etc.). The Grafana alert is informational.
  - Check `/api/signal/drawdown` for the full state.
  - If the alert is "RecoveryRampStuck" (stage 1 >24h), investigate why drawdown keeps re-worsening.
  - If the alert is "VaR95High" or "ES95Extreme", reduce risk per trade manually (the system's auto-scaling may not be enough).

### 27. Multiple halts stacked (drawdown + weekly + daily)
**Symptom:** Drawdown strip shows halt reason "daily_loss_pause" but weekly + drawdown are also in pause territory.
**Diagnosis:** All 3 pause layers are active simultaneously. The `haltReason` field shows the TIGHTEST layer (daily > weekly > drawdown) but the others are also active.
**Action:** Do NOT override any layer. The stacking is intentional — each layer catches a different failure mode:
  - Daily: intra-day tilt
  - Weekly: bad week / regime mismatch
  - Drawdown: cumulative capital erosion
  Wait for ALL layers to clear naturally (daily at midnight, weekly at Monday, drawdown via recovery ramp). Check `PortfolioRiskState` for the full state.

### 28. Recovery ramp + new halt (re-trip during recovery)
**Symptom:** Recovery ramp was at stage 2 (cautious, 0.50x), then drawdown re-worsened below -10%, halt re-triggered.
**Diagnosis:** The recovery was not sustained — drawdown came back. The ramp clock RESETS (back to stage 1 probe when it recovers again).
**Action:** This is a serious signal — the edge may have truly degraded. Investigate:
  - Is the same pair losing repeatedly? (check per-pair CB)
  - Is the same edge failing? (check per-edge CB at `/api/signal/edge-breakers`)
  - Has the market regime shifted permanently? (check ADX + funding trends)
  Consider disabling the pair (move to NONAKTIF SEMENTARA) until root cause is found.

### 29. Per-edge circuit breaker tripped (finer granularity)
**Symptom:** Alert shows "EDGE CIRCUIT TRIPPED: BTC_IDR · funding_contrarian" but the per-pair BTC CB is still closed.
**Diagnosis:** The funding_contrarian edge specifically has 3 consecutive losses, while the trend_follow edge (also on BTC) is still profitable. The per-pair CB averages this out, but the per-edge CB catches the specific degradation.
**Action:**
  - The per-edge CB suppresses ONLY funding_contrarian signals for BTC. Trend_follow signals can still fire.
  - This is more granular than disabling the pair entirely.
  - Investigate why funding_contrarian is failing: has Binance perp funding mechanics changed? Is the z-score window miscalibrated?
  - Check `/api/signal/edge-breakers` for all per-edge states.

### 30. Channel cascade failure (all alert channels failed)
**Symptom:** PortfolioAlertEvent shows `delivered=false` despite being CRITICAL severity.
**Diagnosis:** ALL channels failed (Telegram + Slack + Discord + Email + SMS + Webhook). This is a cascade failure — likely a network issue or credentials problem.
**Action:**
  - Check `channels` field in PortfolioAlertEvent — which channels were attempted?
  - Check dev log for `[signal-alerts]` warnings from each channel.
  - Common causes:
    - Network outage (sandbox can't reach external APIs)
    - All credentials expired simultaneously (unlikely but possible)
    - Rate limiting across all channels
  - The alert is STILL persisted in PortfolioAlertEvent (DB write doesn't depend on channel delivery).
  - Check `/api/signal/alerts` to see the persisted event even if no channel delivered it.
  - Manual mitigation: check the UI directly for the halt/pause state.

---

## Dynamic Risk Scenarios (Layer 8-10)

### 31. Dynamic correlation matrix recomputation
**Symptom:** Correlation API returns `source: "dynamic"` with `sampleSize: 29` and `ageSec: 1800`.
**Diagnosis:** The dynamic correlation matrix was successfully computed from 30 days of rolling returns (29 daily returns per pair). It's cached for 1 hour — the next recompute will fetch fresh Binance klines.
**Action:** No action needed — this is normal operation. The dynamic matrix is more accurate than the static fallback because it reflects current market conditions. Correlations drift over time (BTC/ETH was 0.95 in 2022, ~0.80 in 2024). Check `ageSec` — if it exceeds 3600, the next call will trigger a recompute (5-10 seconds latency for the Binance fetch).

### 32. ES 95 bootstrap CI wide disagreement
**Symptom:** Tail Risk panel shows ES 95% = 4.2% but bootstrap CI [2.1%, 7.8%] — wide interval.
**Diagnosis:** The Expected Shortfall estimate is highly uncertain. The CI width (7.8 - 2.1 = 5.7 percentage points) indicates the tail mean varies significantly across bootstrap resamples. This happens when:
  - Sample size is small (n < 50)
  - The tail has a few extreme outliers that dominate the mean
  - The loss distribution is heavy-tailed (not normal)
**Action:**
  - If `ciAdequate=false` (n<30), ignore — the ES estimate is too uncertain to act on.
  - If `ciAdequate=true` AND CI width > 5%, treat the ES as a RANGE, not a point estimate. Use the CI95 (upper bound) for worst-case planning: "we might lose up to 7.8% in the tail".
  - If ES CI95 > 8%, reduce risk per trade by 50% (the tail is too fat for current sizing).

### 33. Pushover alert channel failed
**Symptom:** PortfolioAlertEvent shows `channels: ["telegram","slack"]` but `pushover` missing, despite `PUSHOVER_APP_TOKEN` being set.
**Diagnosis:** Pushover API call failed. Possible causes: invalid token, expired user key, rate limit (500 messages/month free tier), network issue.
**Action:**
  - Check `[signal-alerts] Pushover failed:` in dev log for the error response.
  - Verify credentials: `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`.
  - Pushover is only attempted for CRITICAL + ERROR severity (not WARN/INFO).
  - Pushover is redundant to Telegram — if Pushover fails but Telegram succeeds, the alert still reached you.
  - Free tier limit: 500 messages/month. If exceeded, upgrade or disable Pushover.

### 34. Correlation matrix stale (static fallback)
**Symptom:** Correlation API returns `source: "static_fallback"` with `sampleSize: 0`.
**Diagnosis:** The dynamic matrix computation failed — likely Binance API was unreachable for 3+ pairs (the threshold for fallback). The system fell back to the static matrix from `correlation-matrix.ts`.
**Action:**
  - Check `[dynamic-corr] fetch failed for {pair}:` in dev log for which pairs failed.
  - Common causes: Binance API rate limit, network outage, sandbox firewall.
  - The static matrix is conservative (BTC/ETH=0.85, etc.) — it's a reasonable approximation but may not reflect current regime.
  - If fallback persists >24h, the correlation penalty may be inaccurate. Manual mitigation: reduce position sizes by 10% as a safety buffer until dynamic matrix recovers.

### 35. Per-edge recovery ramp active
**Symptom:** Edge Breakers table shows an edge with `edgeRecoveryStage: 2` (cautious, 0.50x cap).
**Diagnosis:** This edge (e.g., BTC funding_contrarian) tripped its CB, then a half-open probe succeeded. The edge is now in recovery ramp stage 2 — position sizes for this edge are capped at 0.50x for the next 24-72h.
**Action:** Monitor the ramp progression. If the edge wins again during ramp, it stays in ramp (the cap doesn't advance faster). If the edge loses again, the CB re-trips and the ramp resets. The ramp auto-completes to stage 4 (full 1.00x) after 7 days. This prevents immediate full-size resumption on a recently-broken edge.

### 36. Concentration exposure spike (sudden correlation increase)
**Symptom:** Effective exposure jumped from 0.3 to 0.8 in the last hour despite no new positions.
**Diagnosis:** The dynamic correlation matrix was recomputed and correlations increased (e.g., BTC/ETH went from 0.75 to 0.90 during a market-wide selloff). The same open positions now contribute more effective exposure because correlations tightened.
**Action:**
  - This is correct behavior — the system detected increased concentration risk.
  - New positions in correlated pairs will be heavily penalized (penalty < 0.3).
  - Consider closing one of the correlated positions to reduce concentration.
  - If the correlation spike is due to a market event (e.g., FOMC, CPI release), the spike may be temporary — wait for correlations to normalize before adding new positions.

### 37. Dynamic vs static correlation disagreement
**Symptom:** Static matrix says BTC/ETH = 0.85 but dynamic matrix shows 0.70 — significant disagreement.
**Diagnosis:** The static matrix is stale (from 2024-2025 averages) while the dynamic matrix reflects the last 30 days. Correlations have decreased — BTC and ETH are currently less correlated than the historical average.
**Action:**
  - Trust the dynamic matrix — it's more current.
  - If disagreement > 0.15 (15 percentage points), the static matrix should be updated. Consider regenerating the static fallback from a longer historical window (90d or 180d).
  - The concentration penalty will be SMALLER with the dynamic matrix (lower correlation = less concentration risk). This is correct — the system is allowing slightly larger positions because correlations are currently lower.

### 38. All redundancy channels failed (cascade)
**Symptom:** CRITICAL PortfolioAlertEvent shows `delivered: false` with `channels: []` — no channel succeeded.
**Diagnosis:** ALL 7 channels failed (Telegram + Slack + Discord + Email + SMS + Pushover + Webhook). This is a catastrophic cascade failure.
**Action:**
  - The alert IS still persisted in PortfolioAlertEvent (DB write doesn't depend on channels).
  - Check `/api/signal/alerts` to see all persisted events — you won't miss the alert, just the notification.
  - Common causes:
    - Complete network outage (sandbox can't reach ANY external API)
    - All credentials expired simultaneously (very unlikely)
    - DDoS or rate limiting across all services
  - Manual mitigation: check the UI directly at `/` for halt/pause state.
  - If this persists, consider adding a local alerting mechanism (e.g., write to a file that a cron job monitors).

---

## Adaptive Risk Scenarios (Layer 11-13)

### 39. Shrinkage estimator active (Ledoit-Wolf)
**Symptom:** Correlation API shows `shrinkageIntensity: 0.12` and `shrinkageMethod: "ledoit_wolf_identity"`.
**Diagnosis:** The dynamic correlation matrix is being shrunk toward the identity matrix (independence) by 12%. This reduces noise in the correlation estimates when the sample size (n=29 daily returns) is small relative to the number of assets squared (p²=25).
**Action:** No action needed — this is automatic. The shrinkage intensity δ* is computed optimally by the Ledoit-Wolf formula:
  - δ* = (π̂ - ρ̂) / (n × (γ̂ - ρ̂)) clamped to [0, 1]
  - Where π̂ = estimation noise, γ̂ = distance from target, ρ̂ = 0 for identity target
- When n is large (>100), shrinkage → 0 (trusting the sample).
- When n is small (<30), shrinkage → 0.15-0.25 (pulling toward independence).
- The shrunk matrix is MORE conservative (lower correlations = slightly larger concentration penalties avoided, but also slightly less accurate for high-correlation pairs).

### 40. Regime VaR bootstrap CI wide disagreement
**Symptom:** Regime-Conditioned VaR table shows trend_follow VaR 95 CI [1.2%, 3.1%] (width 1.9pp) but mean_revert CI [2.5%, 8.2%] (width 5.7pp).
**Diagnosis:** The mean_revert regime has a much wider bootstrap CI — its tail risk estimate is highly uncertain. This typically happens when:
  - mean_revert has fewer closed trades than trend_follow
  - mean_revert has extreme outliers in the tail (a few very bad fade trades)
  - The loss distribution for mean_revert is heavy-tailed
**Action:**
  - Trust the CI width as a measure of confidence in the estimate.
  - If mean_revert CI width > 5pp AND ciAdequate=false (n<20), do NOT use the point estimate for risk decisions — it's too uncertain.
  - If mean_revert CI UPPER bound > 8%, reduce position sizes for mean_revert signals by 50% (the tail is potentially catastrophic).
  - Consider disabling mean_revert signals entirely if the CI doesn't narrow after 30+ trades.

### 41. Telegram bot command received
**Symptom:** Telegram bot receives `/status` command, responds with portfolio overview.
**Diagnosis:** The webhook endpoint `/api/signal/telegram-command` processed the command and responded via Telegram sendMessage API.
**Action:** No action — this is normal operation. Supported commands: /status, /portfolio, /drawdown, /breakers, /edges, /tailrisk, /alerts, /help. Set up the webhook with:
```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain/api/signal/telegram-command"
```
The endpoint validates chat_id matches `BotConfig.telegramChatId` for security.

### 42. Telegram /halt or /resume command (not implemented)
**Symptom:** User sends `/halt` or `/resume` — bot responds "Unknown command".
**Diagnosis:** Halt/resume commands are NOT implemented by design — capital protection layers should not be manually overridable via chat. The system's anti-martingale logic (drawdown tiers, recovery ramp, weekly/daily loss pause) exists specifically to prevent emotional overrides.
**Action:** Do NOT implement halt/resume commands. If you want to manually halt:
  - Set `PortfolioRiskState.haltedAt` directly via DB (this is a deliberate action requiring DB access, not a chat command).
  - Better: reduce `capitalIdr` in the input, which naturally reduces all position sizes.
  - The recovery ramp + circuit breakers will auto-resume when conditions improve.

### 43. ES bootstrap CI width spike
**Symptom:** ES 95 CI width jumped from 2pp to 6pp in the last hour.
**Diagnosis:** A new closed trade was added to the tail (worst 5%), and it was an extreme outlier. The bootstrap distribution now has higher variance because some resamples include the outlier and others don't.
**Action:**
  - Check `/api/signal/recent-signals` for the recent extreme loss.
  - If the outlier is a genuine edge failure (not a data error), the wider CI is honest — the tail IS uncertain.
  - If the outlier was a gap stop or data anomaly, consider whether it should be excluded from the tail risk computation (currently all closed trades are included).
  - The CI width will narrow as more trades accumulate (the outlier becomes less influential).

### 44. Shrinkage vs raw correlation disagreement
**Symptom:** Raw BTC/ETH = 0.94 but shrunk BTC/ETH = 0.83 (shrinkage pulled it down 11pp).
**Diagnosis:** The shrinkage estimator is pulling the high correlation toward independence. This happens when:
  - Sample size is small (n < 50) — more noise in the raw estimate
  - The raw correlation is extreme (>0.85) — shrinkage targets these more
  - The Ledoit-Wolf formula determined the noise level warrants 12% shrinkage
**Action:**
  - Trust the SHRUNK matrix — it's statistically more robust.
  - The shrunk correlation (0.83) is still high, so concentration penalties still apply.
  - If you disagree with the shrinkage direction, check `shrinkageIntensity` — if it's >0.25, the sample may be too noisy to trust at all (consider extending the rolling window from 30d to 90d).
  - The raw matrix is available in the API response for comparison.

### 45. Telegram webhook setup
**Symptom:** Telegram commands not arriving — bot doesn't respond.
**Diagnosis:** The webhook hasn't been set, or is pointing to the wrong URL.
**Action:**
  1. Ensure `BotConfig.telegramToken` and `BotConfig.telegramChatId` are set (via /api/bot/config).
  2. Set the webhook:
     ```
     curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain/api/signal/telegram-command"
     ```
  3. Verify the webhook:
     ```
     curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
     ```
  4. Test by sending `/help` to the bot in Telegram.
  5. If webhook fails with SSL error, ensure your domain has a valid SSL certificate (Telegram requires HTTPS).
  6. The endpoint validates chat_id — only the configured chat can send commands.

### 46. Bootstrap CI adequacy transition (n crosses 30)
**Symptom:** Tail Risk panel's "low confidence" badge disappears after the 30th closed trade.
**Diagnosis:** The `ciAdequate` flag transitioned from false to true. This happens when n ≥ 30 AND tailSampleSize ≥ 3 (at least 3 trades in the worst 5%).
**Action:** No action — this is a positive milestone. The VaR/ES estimates are now statistically meaningful (though still approximate at n=30). Key transitions:
  - n < 10: CI width > 10pp — estimates are guesses, ignore for risk decisions
  - n = 10-29: CI width 5-10pp — directional only, use CI upper bound for planning
  - n = 30-99: CI width 3-5pp — usable for risk decisions with appropriate caution
  - n ≥ 100: CI width < 2pp — high confidence, point estimates are reliable
  The system will continue computing bootstrap CIs at all sample sizes — the adequacy flag just tells you when to start trusting them.
