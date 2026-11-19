// PSYOP//TERMINAL — Confession Classifier
//
// Classifies a trader's pre-execution confession text into:
//   plan_driven    — references specific levels, risk management, strategy
//   tilt_driven    — references emotion, urgency, FOMO, revenge, "can't miss"
//   rationalization — appears plan-driven but contains hedging/justification patterns
//
// The classifier is lexicon-based + pattern-matched (no LLM needed — it needs
// to be fast and deterministic, available even when the ZAI config is mid-refresh).

export interface ConfessionClassification {
  classification: "plan_driven" | "tilt_driven" | "rationalization";
  wordCount: number;
  signals: {
    hasFomo: boolean;
    hasRevenge: boolean;
    hasLossAversion: boolean;
    hasOverconfidence: boolean;
    hasPlanReference: boolean;
    hasRiskManagement: boolean;
    hasHedging: boolean;
  };
  tiltContribution: number; // 0-30, how much this confession adds to tilt
  verdict: string; // blunt assessment of the confession quality
}

// Lexicons — curated for Indonesian + English (traders mix both)
const FOMO_LEXICON = [
  "can't miss", "tidak boleh ketinggalan", "fomo", "takut ketinggalan",
  "segera", "cepat", "sekarang", "now", "before it pumps", "muat",
  "akhirnya", "kesempatan", "opportunity", "moon", "take off", "lewat",
  "bulan ini", "hari ini", "before moon",
];

const REVENGE_LEXICON = [
  "revenge", "balas dendam", "bumbal", "win back", "recover loss",
  "diem aja rugi", "pas lagi loss", "biar balik modal", "ambil balik",
  "setelah loss", "baru loss", "baru rugi", "pinjam dulu",
  "tambah margin", "double down", "all in", "nombok", "berhutang",
];

const LOSS_AVERSION_LEXICON = [
  "sayang", " Rugi", "udah rugi", "takut rugi", "ga boleh rugi",
  "cut loss", "panik", "panic", "takut turun", "jangan sampai loss",
  "amankan", "kunci profit", "greedy",
];

const OVERCONFIDENCE_LEXICON = [
  "pasti", "certain", "guaranteed", "100%", "confident", "yakin banget",
  "sudah pasti", "no brainer", "gampang", "easy money", "free money",
  "印刷", "print money", "pasti profit", "can't lose", "tidak mungkin rugi",
];

const PLAN_LEXICON = [
  "strategy", "strategi", "rsi", "macd", "sma", "support", "resistance",
  "backtest", "win rate", "risk reward", "1:2", "1:3", "stop loss",
  "take profit", "plan", "rencana", "rule", "sistem", "setup",
  "confluence", "divergence", "breakout", "retest",
];

const RISK_LEXICON = [
  "risk", "risiko", "position size", "capital", "modal", "1%", "2%",
  "stop", "sl", "max loss", "drawdown", "toleransi",
];

const HEDGING_LEXICON = [
  "mungkin", "maybe", "kayaknya", "sepertinya", "probably", "agak",
  "coba", "try", "sedikit", "a bit", "small", "kecil dulu",
  "if", "kalau", "just in case", "jaga-jaga",
];

function matches(text: string, lexicon: string[]): string[] {
  const lower = text.toLowerCase();
  return lexicon.filter((w) => lower.includes(w.toLowerCase()));
}

export function classifyConfession(text: string): ConfessionClassification {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const lower = text.toLowerCase();

  const fomo = matches(text, FOMO_LEXICON);
  const revenge = matches(text, REVENGE_LEXICON);
  const lossAv = matches(text, LOSS_AVERSION_LEXICON);
  const overconf = matches(text, OVERCONFIDENCE_LEXICON);
  const plan = matches(text, PLAN_LEXICON);
  const risk = matches(text, RISK_LEXICON);
  const hedging = matches(text, HEDGING_LEXICON);

  const hasFomo = fomo.length > 0;
  const hasRevenge = revenge.length > 0;
  const hasLossAversion = lossAv.length > 0;
  const hasOverconfidence = overconf.length > 0;
  const hasPlanReference = plan.length > 0;
  const hasRiskManagement = risk.length > 0;
  const hasHedging = hedging.length > 0;

  // Tilt contribution: each tilt signal adds points
  let tiltContribution = 0;
  if (hasFomo) tiltContribution += 8;
  if (hasRevenge) tiltContribution += 12;
  if (hasLossAversion) tiltContribution += 5;
  if (hasOverconfidence) tiltContribution += 6;
  if (hasHedging && !hasPlanReference) tiltContribution += 4;
  // Short confessions = less articulated = more tilt
  if (wordCount < 20) tiltContribution += 10;
  else if (wordCount < 30) tiltContribution += 5;
  tiltContribution = Math.min(30, tiltContribution);

  // Classification logic
  let classification: ConfessionClassification["classification"];
  let verdict: string;

  const tiltSignals = [hasFomo, hasRevenge, hasLossAversion, hasOverconfidence].filter(Boolean).length;
  const planSignals = [hasPlanReference, hasRiskManagement].filter(Boolean).length;

  if (tiltSignals >= 2 && planSignals === 0) {
    classification = "tilt_driven";
    verdict = `TILT-DRIVEN. ${tiltSignals} emotional signal(s) detected, zero plan references. This is your pattern: ${[...revenge, ...fomo, ...overconf].slice(0, 3).join(", ") || "emotional language"}. You've done this before. It ended badly.`;
  } else if (planSignals >= 1 && tiltSignals === 0) {
    classification = "plan_driven";
    verdict = `PLAN-DRIVEN. ${plan.length + risk.length} strategy/risk reference(s). This reads like a disciplined entry. But remember: the market doesn't care about your plan.`;
  } else if (planSignals >= 1 && tiltSignals >= 1) {
    classification = "rationalization";
    verdict = `RATIONALIZATION. You reference your plan (${plan.slice(0, 2).join(", ")}) but also leak emotional signals (${[...revenge, ...fomo, ...overconf].slice(0, 2).join(", ")}). This is the most dangerous pattern — you're using strategy language to justify a tilt-driven decision.`;
  } else if (wordCount < 20) {
    classification = "tilt_driven";
    verdict = `TOO SHORT. ${wordCount} words. If you can't articulate 20 words of reasoning, you haven't thought it through. This is impulse wearing a costume.`;
  } else {
    classification = "rationalization";
    verdict = `UNCLEAR. No strong plan signals, no strong tilt signals. This is the grey zone where most bad decisions hide. Be more specific: what setup? what level? what risk?`;
  }

  return {
    classification,
    wordCount,
    signals: {
      hasFomo, hasRevenge, hasLossAversion, hasOverconfidence,
      hasPlanReference, hasRiskManagement, hasHedging,
    },
    tiltContribution,
    verdict,
  };
}
