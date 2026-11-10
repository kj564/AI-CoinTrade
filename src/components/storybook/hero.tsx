"use client";

import { Scissors, Sparkles, Clapperboard, Music2, Layers, Box } from "lucide-react";

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-10 pb-6 sm:pt-14">
      {/* Decorative paper collage backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-10 top-10 h-40 w-40 rounded-full bg-[#e8b547]/40 blur-2xl" />
        <div className="absolute right-0 top-20 h-48 w-48 rounded-full bg-[#c7634a]/25 blur-3xl" />
        <div className="absolute left-1/3 bottom-0 h-32 w-64 rounded-full bg-[#7a9b6e]/30 blur-2xl" />
      </div>

      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#c98b5a]/40 bg-[#fff8e7] px-3 py-1 text-xs font-medium text-[#7a4a1e] shadow-sm">
          <Sparkles className="h-3.5 w-3.5 text-[#c7634a]" />
          Paper-cutout storybook film studio
        </div>

        <h1 className="mt-4 text-4xl font-black leading-[1.05] tracking-tight text-[#3a2210] sm:text-5xl md:text-6xl">
          Turn any story into a
          <span className="relative inline-block mx-2">
            <span className="relative z-10 text-[#c7634a]">paper-cutout</span>
            <span aria-hidden className="absolute inset-x-0 bottom-1 z-0 h-3 -rotate-1 rounded bg-[#e8b547]/60" />
          </span>
          storybook film
        </h1>

        <p className="mt-4 max-w-xl text-base text-[#7a5a3a] sm:text-lg">
          Soft clay-and-felt pieces, layered green hills, a warm sun, and props that
          pop, grow and slide into place like a child&apos;s collage — built from real
          low-poly 3D models. Give it a topic, script or brand message — get an
          editable MP4 in 1080p, 2K or 4K.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {[
            { icon: Scissors, label: "Plans the scenes" },
            { icon: Box, label: "3D props from polyfork.dev" },
            { icon: Layers, label: "Pops, grows & slides in" },
            { icon: Music2, label: "Optional music bed" },
            { icon: Clapperboard, label: "MP4 · 1080p / 2K / 4K" },
          ].map((f) => (
            <span
              key={f.label}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#c98b5a]/30 bg-[#fff8e7]/80 px-3 py-1 text-xs font-medium text-[#7a4a1e]"
            >
              <f.icon className="h-3.5 w-3.5 text-[#c7634a]" />
              {f.label}
            </span>
          ))}
        </div>
      </div>

      {/* Storybook scene illustration strip */}
      <div className="mx-auto mt-8 max-w-3xl">
        <div className="relative aspect-[16/5] w-full overflow-hidden rounded-2xl border-2 border-[#c98b5a]/30 bg-gradient-to-b from-[#fde9c8] to-[#f6cda0] shadow-[0_18px_44px_-20px_rgba(120,70,20,0.45)]">
          {/* sun */}
          <div className="absolute right-8 top-6 h-16 w-16 rounded-full bg-gradient-to-br from-[#ffe7a3] to-[#f2b233] shadow-[0_0_40px_rgba(255,209,128,0.6)]" />
          <div className="absolute right-6 top-4 h-20 w-20 rounded-full border-2 border-[#f2b233]/40" />
          {/* hills */}
          <div className="absolute bottom-0 left-0 right-0">
            <svg viewBox="0 0 800 200" preserveAspectRatio="none" className="h-full w-full">
              <path d="M0,120 Q150,60 300,100 T600,90 T900,110 L900,200 L0,200 Z" fill="#9fbf8a" />
              <path d="M0,150 Q150,100 300,130 T600,120 T900,140 L900,200 L0,200 Z" fill="#7fae6e" />
              <path d="M0,175 Q150,140 300,160 T600,155 T900,170 L900,200 L0,200 Z" fill="#5e9457" />
              <path d="M0,190 Q150,170 300,180 T600,178 T900,185 L900,200 L0,200 Z" fill="#4a7a44" />
            </svg>
          </div>
          {/* collage props */}
          <div className="absolute left-8 bottom-10 flex h-14 w-14 items-center justify-center rounded-full bg-[#fff8e7] text-2xl shadow-lg border border-[#c98b5a]/30">🌻</div>
          <div className="absolute left-24 bottom-6 flex h-12 w-12 items-center justify-center rounded-full bg-[#fff8e7] text-xl shadow-lg border border-[#c98b5a]/30">🐛</div>
          <div className="absolute left-1/2 bottom-12 flex h-16 w-16 items-center justify-center rounded-full bg-[#fff8e7] text-3xl shadow-lg border border-[#c98b5a]/30">🐰</div>
          <div className="absolute right-24 bottom-8 flex h-12 w-12 items-center justify-center rounded-full bg-[#fff8e7] text-xl shadow-lg border border-[#c98b5a]/30">🍎</div>
          <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-md bg-[#fff8e7]/90 px-3 py-1 text-xs font-bold text-[#7a4a1e] shadow border border-[#c98b5a]/30">
            ✨ Once upon a paper hill…
          </div>
        </div>
      </div>
    </section>
  );
}
