import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "INDODAX Terminal — Trading Bot",
  description: "INDODAX trading bot: Riset (market research) → Eksekusi (signed orders) → Validasi (backtest + risk + position models). Real-time tickers, TA signals, order book, backtest engine.",
  keywords: ["INDODAX", "trading bot", "crypto", "backtest", "RSI", "MACD", "Bollinger", "Indonesia", "IDR", "Next.js"],
  authors: [{ name: "INDODAX Terminal" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "INDODAX Terminal — Trading Bot",
    description: "Riset → Eksekusi → Validasi. INDODAX trading bot with backtest + risk models.",
    type: "website",
  },
};

// Import map so polyfork's parametric ES modules (/cdn/{id}.mjs) can resolve the
// bare "three" specifier they use. Both the renderer and the polyfork modules
// share this one three.js instance, so createAsset() objects render correctly.
const IMPORT_MAP = {
  imports: {
    three: "https://unpkg.com/three@0.180.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.180.0/examples/jsm/",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="importmap"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(IMPORT_MAP) }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0b0e14] text-foreground`}
      >
        {children}
        <Toaster />
        <SonnerToaster position="top-center" richColors closeButton />
      </body>
    </html>
  );
}
