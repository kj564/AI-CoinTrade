// L2 Order Book Snapshot Storage
// Stores historical L2 snapshots from INDODAX depth API for backtest calibration.
// Each snapshot captures the order book structure at a specific point in time,
// enabling per-candle microstructure calibration instead of using a single
// current-time snapshot for the entire backtest.

import { db } from "@/lib/db";
import { getDepth } from "@/lib/indodax";
import { buildL2Snapshot, type L2Snapshot } from "@/lib/trading/backtest";

// Store an L2 snapshot to the database
export async function storeL2Snapshot(pair: string, depth: { buy: [string, string][]; sell: [string, string][] }, avgCandleVolume: number): Promise<L2Snapshot | null> {
  try {
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
