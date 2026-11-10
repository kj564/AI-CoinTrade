"use client";

import { useEffect, useRef, useState } from "react";
import { Gamepad2, Trophy, Gauge, Gem } from "lucide-react";

export function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<{ start: () => void; stop: () => void; dispose: () => void; getSpeed: () => number } | null>(null);
  const [score, setScore] = useState(0);
  const [total, setTotal] = useState(12);
  const [won, setWon] = useState(false);
  const [ready, setReady] = useState(false);
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    (async () => {
      try {
        const mod = await import(/* webpackIgnore: true */ "/polyfork-game.mjs");
        if (disposed) return;
        const game = new mod.PolyforkGame(canvas, {
          onScore: (s: number, t: number) => { setScore(s); setTotal(t); },
          onWin: () => setWon(true),
          onReady: () => setReady(true),
        });
        gameRef.current = game;
        game.start();
      } catch (e) {
        console.error("[game] load failed", e);
      }
    })();
    const speedTimer = setInterval(() => {
      const g = gameRef.current;
      if (g) setSpeed(Math.round(g.getSpeed() * 10));
    }, 100);
    return () => {
      disposed = true;
      clearInterval(speedTimer);
      try { gameRef.current?.dispose(); } catch { /* ignore */ }
    };
  }, []);

  function restart() {
    setWon(false);
    setScore(0);
    setReady(false);
    window.location.reload();
  }

  return (
    <div className="relative w-full h-screen bg-[#a3d5ff] overflow-hidden">
      <canvas ref={canvasRef} className="block w-full h-full" />

      {/* HUD */}
      <div className="absolute top-4 left-4 flex flex-col gap-2 pointer-events-none">
        <div className="flex items-center gap-2 rounded-lg bg-black/60 px-3 py-1.5 text-white backdrop-blur">
          <Gem className="h-5 w-5 text-[#E8B547]" />
          <span className="text-lg font-bold tabular-nums">{score}</span>
          <span className="text-sm text-white/60">/ {total}</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-black/60 px-3 py-1.5 text-white backdrop-blur">
          <Gauge className="h-4 w-4 text-[#7a9b6e]" />
          <span className="text-sm font-mono tabular-nums">{speed} km/h</span>
        </div>
      </div>

      {/* Title + controls */}
      <div className="absolute top-4 right-4 rounded-lg bg-black/60 px-4 py-2 text-white backdrop-blur pointer-events-none">
        <div className="flex items-center gap-2 text-sm font-bold">
          <Gamepad2 className="h-4 w-4" /> Polyfork Drive
        </div>
        <div className="mt-1 text-[11px] text-white/70">
          <kbd className="rounded bg-white/20 px-1">W</kbd>/<kbd className="rounded bg-white/20 px-1">S</kbd> gas/brake ·
          <kbd className="rounded bg-white/20 px-1 ml-1">A</kbd>/<kbd className="rounded bg-white/20 px-1">D</kbd> steer ·
          mouse drag look
        </div>
      </div>

      {/* Loading */}
      {!ready && !won && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#a3d5ff]/80 backdrop-blur">
          <div className="text-center">
            <div className="text-2xl font-black text-[#1a3a5a]">Loading polyfork world…</div>
            <div className="mt-2 text-sm text-[#3a5a7a]">Fetching low-poly GLB assets from polyfork.dev</div>
          </div>
        </div>
      )}

      {/* Win screen */}
      {won && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur">
          <div className="text-center">
            <Trophy className="h-16 w-16 text-[#E8B547] mx-auto" />
            <div className="mt-4 text-4xl font-black text-white">You Win!</div>
            <div className="mt-2 text-lg text-white/70">All {total} Power Gems collected!</div>
            <button
              onClick={restart}
              className="mt-6 rounded-xl bg-[#c7634a] hover:bg-[#b15438] px-6 py-3 text-white font-bold transition-colors"
            >
              Play Again
            </button>
          </div>
        </div>
      )}

      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] text-white/50 pointer-events-none">
        Assets by polyfork.dev · built with three.js
      </div>
    </div>
  );
}
