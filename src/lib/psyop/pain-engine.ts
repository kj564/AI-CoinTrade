// PSYOP//TERMINAL — Pain Engine
//
// Converts unrealized P&L into visceral, human-scale metrics.
// "You're down Rp 500,000" is a number. "That's 23 meals for a family.
// You held through every single one." is a feeling.
//
// The Pain Engine makes losses REAL by translating them into units that
// carry emotional weight: meals, hours of minimum-wage work, months of
// Spotify, kilometers of gas. Profit is NOT translated — only losses
// get the visceral treatment. This is deliberate: loss aversion is
// twice as strong as gain seeking, and the system amplifies it to
// prevent reckless risk-taking.

export interface PainBreakdown {
  pnlIdr: number;
  pnlPct: number;
  isLoss: boolean;
  visceral: {
    meals: number;        // nasi padang portions (~Rp 22k each)
    workHours: number;    // minimum wage Jakarta (~Rp 31k/hour)
    spotifyMonths: number; // premium monthly (~Rp 55k)
    gasLiters: number;    // pertalite (~Rp 7.6k/L)
    gojekRides: number;   // short ride (~Rp 15k)
  };
  painText: string;       // the visceral sentence
}

const NASI_PADANG = 22000;
const MIN_WAGE_HOURLY = 31000;
const SPOTIFY_MONTHLY = 55000;
const PERTALITE_PER_L = 7600;
const GOJEK_RIDE = 15000;

export function computePain(pnlIdr: number, capitalIdr: number): PainBreakdown {
  const isLoss = pnlIdr < 0;
  const absPnl = Math.abs(pnlIdr);
  const pnlPct = capitalIdr > 0 ? (pnlIdr / capitalIdr) * 100 : 0;

  const visceral = {
    meals: Math.floor(absPnl / NASI_PADANG),
    workHours: Math.floor(absPnl / MIN_WAGE_HOURLY),
    spotifyMonths: Math.floor(absPnl / SPOTIFY_MONTHLY),
    gasLiters: Math.floor(absPnl / PERTALITE_PER_L),
    gojekRides: Math.floor(absPnl / GOJEK_RIDE),
  };

  let painText = "";
  if (!isLoss) {
    // Profits are stated flatly — no celebration, no visceral translation.
    // The system's design principle: don't make winning feel too good.
    painText = `+Rp ${absPnl.toLocaleString("id-ID")} (${pnlPct.toFixed(2)}%). Don't get comfortable. The market gives, the market takes.`;
  } else if (absPnl < 50000) {
    painText = `−Rp ${absPnl.toLocaleString("id-ID")}. Small cut. But cuts accumulate. You've lost ${visceral.gojekRides} Gojek rides.`;
  } else if (absPnl < 500000) {
    painText = `−Rp ${absPnl.toLocaleString("id-ID")} (${pnlPct.toFixed(1)}%). That's ${visceral.meals} meals for a family. ${visceral.workHours} hours of someone's minimum-wage labor. You held through all of it.`;
  } else if (absPnl < 5000000) {
    painText = `−Rp ${absPnl.toLocaleString("id-ID")} (${pnlPct.toFixed(1)}%). ${visceral.meals} meals. ${visceral.spotifyMonths} months of Spotify. ${visceral.workHours} hours of minimum-wage work. This is the amount where your hands start shaking. That's the feeling of loss aversion activating. USE IT.`;
  } else {
    painText = `−Rp ${absPnl.toLocaleString("id-ID")} (${pnlPct.toFixed(1)}%). ${visceral.meals} meals. ${visceral.gasLiters} liters of gas. ${visceral.workHours} hours of labor. This is catastrophic territory. If you're about to "make it back", STOP. Your shadow self is screaming to revenge trade. That's how this number doubles.`;
  }

  return { pnlIdr, pnlPct, isLoss, visceral, painText };
}
