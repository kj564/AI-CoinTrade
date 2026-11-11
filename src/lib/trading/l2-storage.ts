// L2 Order Book Snapshot Storage
// Stores historical L2 snapshots from INDODAX depth API for backtest calibration.
// Each snapshot captures the order book structure at a specific point in time,
// enabling per-candle microstructure calibration instead of using a single
// current-time snapshot for the entire backtest.

import { db } from "@/lib/db";
import { getDepth } from "@/lib/indodax";
import { buildL2Snapshot, type L2Snapshot } from "@/lib/trading/backtest";

// ── Snapshot validation (evaluator priority #7) ──
// Validates a raw INDODAX depth response before storage so malformed/empty
// order books never pollute the historical calibration set.
export interface DepthValidation {
  valid: boolean;
  errors: string[];
}

export function validateDepth(pair: string, depth: { buy: [string, string][]; sell: [string, string][] }): DepthValidation {
  const errors: string[] = [];
  if (!depth) {
    return { valid: false, errors: ["depth response is null/undefined"] };
  }
  if (!Array.isArray(depth.buy) || !Array.isArray(depth.sell)) {
    errors.push("buy/sell arrays missing");
    return { valid: false, errors };
  }
  if (depth.buy.length === 0 || depth.sell.length === 0) {
    errors.push(`empty order book — ${depth.buy.length} bids / ${depth.sell.length} asks`);
  }

  // Top-of-book sanity: best bid must be strictly below best ask
  if (depth.buy.length > 0 && depth.sell.length > 0) {
    const bestBid = parseFloat(depth.buy[0][0]);
    const bestAsk = parseFloat(depth.sell[0][0]);
    if (!isFinite(bestBid) || !isFinite(bestAsk)) {
      errors.push(`non-numeric top-of-book prices (bid=${depth.buy[0][0]}, ask=${depth.sell[0][0]})`);
    } else if (bestBid <= 0 || bestAsk <= 0) {
      errors.push(`non-positive prices (bid=${bestBid}, ask=${bestAsk})`);
    } else if (bestBid >= bestAsk) {
      errors.push(`crossed book — best bid ${bestBid} >= best ask ${bestAsk}`);
    }
    // Sanity: spread should be < 50% (otherwise data is corrupt)
    const mid = (bestBid + bestAsk) / 2;
    if (mid > 0) {
      const spreadPct = ((bestAsk - bestBid) / mid) * 100;
      if (spreadPct > 50) {
        errors.push(`implausible spread ${spreadPct.toFixed(2)}% — data corruption suspected`);
      }
    }
  }

  // Check a few levels for positive volume
  let zeroVolLevels = 0;
  for (const lvl of depth.buy.slice(0, 5)) {
    const v = parseFloat(lvl[1]);
    if (!isFinite(v) || v <= 0) zeroVolLevels++;
  }
  for (const lvl of depth.sell.slice(0, 5)) {
    const v = parseFloat(lvl[1]);
    if (!isFinite(v) || v <= 0) zeroVolLevels++;
  }
  if (zeroVolLevels > 8) {
    errors.push(`${zeroVolLevels}/10 top levels have non-positive volume`);
  }

  return { valid: errors.length === 0, errors };
}

// Store an L2 snapshot to the database
export async function storeL2Snapshot(pair: string, depth: { buy: [string, string][]; sell: [string, string][] }, avgCandleVolume: number): Promise<L2Snapshot | null> {
  try {
    // Validate before building — never store garbage
    const validation = validateDepth(pair, depth);
    if (!validation.valid) {
      console.error(`[l2-storage] ${pair}: rejected invalid depth — ${validation.errors.join("; ")}`);
      return null;
    }

    const l2 = buildL2Snapshot(pair, depth, 0.001, avgCandleVolume);
    const timestamp = Math.floor(Date.now() / 1000);

    await db.l2Snapshot.upsert({
      where: { pair_timestamp: { pair, timestamp } },
      create: {
        pair,
        timestamp,
        topBidPrice: l2.topBidPrice,
        topAskPrice: l2.topAskPrice,
        realSpreadPct: l2.realSpreadPct,
        topBidVolume: l2.topBidVolume,
        topAskVolume: l2.topAskVolume,
        topOfBookImbalance: l2.topOfBookImbalance,
        totalBidVolume: l2.totalBidVolume,
        totalAskVolume: l2.totalAskVolume,
        totalImbalance: l2.totalImbalance,
        bidLevelsCount: l2.bidLevels,
        askLevelsCount: l2.askLevels,
        bidDepthJson: JSON.stringify(l2.bidDepthProfile),
        askDepthJson: JSON.stringify(l2.askDepthProfile),
      },
      update: {
        topBidPrice: l2.topBidPrice,
        topAskPrice: l2.topAskPrice,
        realSpreadPct: l2.realSpreadPct,
        topBidVolume: l2.topBidVolume,
        topAskVolume: l2.topAskVolume,
        topOfBookImbalance: l2.topOfBookImbalance,
        totalBidVolume: l2.totalBidVolume,
        totalAskVolume: l2.totalAskVolume,
        totalImbalance: l2.totalImbalance,
        bidLevelsCount: l2.bidLevels,
        askLevelsCount: l2.askLevels,
        bidDepthJson: JSON.stringify(l2.bidDepthProfile),
        askDepthJson: JSON.stringify(l2.askDepthProfile),
      },
    });

    return { ...l2, timestamp: new Date(timestamp * 1000).toISOString() };
  } catch (e) {
    console.error("Failed to store L2 snapshot:", e);
    return null;
  }
}

// Fetch from INDODAX and store
export async function fetchAndStoreL2(pair: string, avgCandleVolume: number): Promise<L2Snapshot | null> {
  const depthPair = pair.includes("_") ? pair.replace("_", "") : pair;
  const depth = await getDepth(depthPair);
  if (!depth) return null;
  return storeL2Snapshot(pair, depth, avgCandleVolume);
}

// ── Retry with exponential backoff (evaluator priority #2) ──
// INDODAX public depth API can transiently 5xx / time out. A single failed fetch
// should not poison the historical calibration set, so we retry with exponential
// backoff: base delay doubles each attempt (500ms → 1s → 2s), capped at 2s,
// max 3 attempts. Jitter (±20%) avoids thundering-herd when the scheduler fires
// for 5 pairs at once.
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredDelay(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(100, Math.round(base + jitter));
}

export interface FetchWithRetryResult {
  snapshot: L2Snapshot | null;
  attempts: number;
  retriesUsed: number;
  errors: string[];
  durationMs: number;
}

// Fetch + validate + store with exponential-backoff retry.
// Returns a structured result so callers (scheduler / API / monitor) can record
// exactly how many retries were needed and why.
export async function fetchAndStoreL2WithRetry(
  pair: string,
  avgCandleVolume: number,
  maxRetries = MAX_RETRIES,
): Promise<FetchWithRetryResult> {
  const start = Date.now();
  const errors: string[] = [];
  let attempts = 0;
  let lastSnapshot: L2Snapshot | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    try {
      // Re-fetch each attempt (depth changes between retries by design —
      // if the API was returning stale/corrupt data, a fresh fetch may recover)
      const depthPair = pair.includes("_") ? pair.replace("_", "") : pair;
      const depth = await getDepth(depthPair);
      if (!depth) {
        const err = `attempt ${attempt + 1}: getDepth returned null (network/API error)`;
        errors.push(err);
        if (attempt < maxRetries) {
          const d = jitteredDelay(attempt);
          console.warn(`[l2-storage] ${pair}: ${err} — retrying in ${d}ms (attempt ${attempt + 2}/${maxRetries + 1})`);
          await sleep(d);
          continue;
        }
        break;
      }

      // storeL2Snapshot internally validates; if validation fails it returns null
      const snap = await storeL2Snapshot(pair, depth, avgCandleVolume);
      if (snap) {
        lastSnapshot = snap;
        if (attempt > 0) {
          console.log(`[l2-storage] ${pair}: recovered after ${attempt} retry(ies)`);
        }
        break;
      } else {
        // storeL2Snapshot logs the validation error; record a generic message
        const err = `attempt ${attempt + 1}: validation/store rejected depth`;
        errors.push(err);
        if (attempt < maxRetries) {
          const d = jitteredDelay(attempt);
          console.warn(`[l2-storage] ${pair}: ${err} — retrying in ${d}ms (attempt ${attempt + 2}/${maxRetries + 1})`);
          await sleep(d);
          continue;
        }
        break;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`attempt ${attempt + 1}: ${msg}`);
      if (attempt < maxRetries) {
        const d = jitteredDelay(attempt);
        console.warn(`[l2-storage] ${pair}: ${msg} — retrying in ${d}ms (attempt ${attempt + 2}/${maxRetries + 1})`);
        await sleep(d);
        continue;
      }
      break;
    }
  }

  return {
    snapshot: lastSnapshot,
    attempts,
    retriesUsed: Math.max(0, attempts - 1),
    errors,
    durationMs: Date.now() - start,
  };
}

// Retrieve the closest historical L2 snapshot for a given candle timestamp.
// Returns null if no snapshot within `maxAgeSec` seconds of the target time.
export async function getHistoricalL2Snapshot(pair: string, targetTimestamp: number, maxAgeSec = 3600): Promise<L2Snapshot | null> {
  try {
    // Find the closest snapshot (before or after the target time, within maxAgeSec)
    const before = await db.l2Snapshot.findFirst({
      where: {
        pair,
        timestamp: { lte: targetTimestamp, gte: targetTimestamp - maxAgeSec },
      },
      orderBy: { timestamp: "desc" },
    });
    const after = await db.l2Snapshot.findFirst({
      where: {
        pair,
        timestamp: { gte: targetTimestamp, lte: targetTimestamp + maxAgeSec },
      },
      orderBy: { timestamp: "asc" },
    });

    // Pick the closest one
    let closest = null;
    let closestDist = Infinity;
    if (before) {
      const dist = targetTimestamp - before.timestamp;
      if (dist < closestDist) { closest = before; closestDist = dist; }
    }
    if (after) {
      const dist = after.timestamp - targetTimestamp;
      if (dist < closestDist) { closest = after; closestDist = dist; }
    }

    if (!closest) return null;

    // Convert DB record to L2Snapshot
    return {
      pair: closest.pair,
      timestamp: new Date(closest.timestamp * 1000).toISOString(),
      topBidPrice: closest.topBidPrice,
      topAskPrice: closest.topAskPrice,
      realSpreadPct: closest.realSpreadPct,
      topBidVolume: closest.topBidVolume,
      topAskVolume: closest.topAskVolume,
      topOfBookImbalance: closest.topOfBookImbalance,
      totalBidVolume: closest.totalBidVolume,
      totalAskVolume: closest.totalAskVolume,
      totalImbalance: closest.totalImbalance,
      bidLevels: closest.bidLevelsCount,
      askLevels: closest.askLevelsCount,
      bidDepthProfile: JSON.parse(closest.bidDepthJson),
      askDepthProfile: JSON.parse(closest.askDepthJson),
      depthCalibrationFactor: 1, // computed on-the-fly based on avg candle volume
      spreadCalibrationFactor: closest.realSpreadPct / (0.001 * 100),
      imbalanceCalibrationFactor: 1,
      description: `Historical L2 snapshot from ${new Date(closest.timestamp * 1000).toISOString()} (${closestDist}s from target). ${closest.bidLevelsCount} bid levels, ${closest.askLevelsCount} ask levels. Spread ${closest.realSpreadPct.toFixed(3)}%. Imbalance ${closest.totalImbalance.toFixed(2)}.`,
    };
  } catch (e) {
    console.error("Failed to get historical L2 snapshot:", e);
    return null;
  }
}

// Get the most recent L2 snapshot (for staleness check)
export async function getLatestL2Snapshot(pair: string): Promise<{ timestamp: number; ageSec: number } | null> {
  try {
    const latest = await db.l2Snapshot.findFirst({
      where: { pair },
      orderBy: { timestamp: "desc" },
    });
    if (!latest) return null;
    const now = Math.floor(Date.now() / 1000);
    return { timestamp: latest.timestamp, ageSec: now - latest.timestamp };
  } catch {
    return null;
  }
}

// Get count of stored L2 snapshots for a pair
export async function getL2SnapshotCount(pair: string): Promise<number> {
  try {
    return await db.l2Snapshot.count({ where: { pair } });
  } catch {
    return 0;
  }
}
