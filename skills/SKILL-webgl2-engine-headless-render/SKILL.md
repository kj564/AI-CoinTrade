---
name: webgl2-engine-headless-render
description: Menjalankan engine WebGL2 generatif-art (seperti lemomo-opuscar styles, shader-art, Three.js scenes) di headless Chromium via Playwright, capture frame-by-frame, dan encode ke video. Gunakan saat user mint "render video dari repo shader/engine WebGL", "jalankan lemomo-opuscar style", "capture WebGL canvas headless", atau engine JS mana pun yang render ke <canvas> WebGL2.
---

# Render Engine WebGL2 Headless → Video

Pipeline untuk menjalankan engine WebGL2 asli (bukan approximation) di headless Chromium, capture setiap frame, dan encode ke video MP4. Cocok untuk repo seperti lemomo-ai/lemo-opuscar (66+ film styles), shader-art, Three.js scenes, atau engine JS lain yang render ke canvas WebGL2.

## Prasyarat

- Node.js + Playwright (`bun add playwright`) dengan Chromium headless terinstall
- ffmpeg untuk encode
- Python3 untuk local HTTP server (serve engine files)
- Engine code (JS murni, tanpa asset eksternal yang butuh fetch)

## Langkah Eksekusi

### 1. Fetch engine code dari repo

```bash
mkdir -p engine-run/core
BASE="https://raw.githubusercontent.com/{owner}/{repo}/main/{path}"
# Contoh lemomo stained-glass:
for f in comp.js glass.js window.js scene.js subs.js knight.js dragon.js story.js frames.js test.js main.js; do
  curl -sf "$BASE/$f" -o "engine-run/$f"
done
# core/lib.js (helper functions)
curl -sf "{repo}/core/lib.js" -o "engine-run/core/lib.js"
```

**Penting:** Engine lemomo pakai import path `/core/lib.js` (absolute dari server root). Jadi `core/lib.js` harus ada di server root, bukan relatif. Struktur:
```
engine-run/
  index.html
  main.js
  comp.js, glass.js, window.js, scene.js, story.js, ...
  core/lib.js
```

### 2. Buat index.html + patched main.js

`index.html`:
```html
<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{position:absolute;left:0;top:0}</style>
</head><body><canvas id="gl" width="1920" height="1080"></canvas>
<script type="module" src="main.js"></script></body></html>
```

`main.js` (patched): skip font loading (serif fallback OK untuk capture), expose `window.render(t)`:
```js
import { makeComp } from './comp.js';
import { renderScene } from './scene.js';
import * as STORY from './story.js';
import { drawBanderole } from './subs.js';

const cv = document.getElementById('gl');
const comp = makeComp(cv);
const mk = (w,h) => { const c=document.createElement('canvas'); c.width=w; c.height=h; return c; };
const L = { G: mk(1920,1080), S: mk(1920,1080), R: mk(1920,1080), O: mk(1920,1080), P: mk(1024,768) };
const Lc = {}; for (const k in L) Lc[k] = L[k].getContext('2d');

try { await document.fonts.load('40px Cinzel'); } catch {}

window.DUR = STORY.DUR;
window.render = t => {
  const st = STORY.state(t);
  st.overlay = (O) => drawBanderole(O, STORY.SUBS, t);
  renderScene(Lc, L, comp, st);
};
window.READY = true;
```

### 3. Start local HTTP server (persistent)

```bash
cd engine-run
# PENTING: server harus persistent lewat setsid, kalau tidak akan mati saat command selesai
python3 -m http.server 8090 > /tmp/server.log 2>&1 &
```

### 4. Render script (Playwright + readPixels capture)

**INI BAGIAN PALING PENTING** — `page.screenshot()` dan `canvas.toDataURL()` di headless Chromium (software GL) return BLACK untuk WebGL canvas. Solusi: `gl.readPixels()` → Y-flip → 2D canvas → `toDataURL()`.

```js
import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();

await page.goto('http://localhost:8090/index.html', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.READY === true, null, { timeout: 15000 });
const dur = await page.evaluate(() => window.DUR);

const FPS = 24;
for (let f = startFrame; f <= endFrame; f++) {
  const t = f / FPS;
  const dataUrl = await page.evaluate((tt) => {
    window.render(tt);
    const cv = document.getElementById('gl');
    const gl = cv.getContext('webgl2');
    const w = cv.width, h = cv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Y-flip (WebGL bottom-up → image top-down)
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const ctx = c2.getContext('2d');
    const id = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const srcRow = (h - 1 - y) * w * 4;
      const dstRow = y * w * 4;
      for (let i = 0; i < w * 4; i++) id.data[dstRow + i] = px[srcRow + i];
    }
    ctx.putImageData(id, 0, 0);
    return c2.toDataURL('image/png');
  }, t);
  const base64 = dataUrl.slice('data:image/png;base64,'.length);
  fs.writeFileSync(`frames/frame_${String(f).padStart(5,'0')}.png`, Buffer.from(base64, 'base64'));
}
await browser.close();
```

### 5. Encode frames → video

```bash
ffmpeg -y -framerate 24 -start_number {START} -i frames/frame_%05d.png \
  -c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p -movflags +faststart out.mp4
```

Encode PNG besar (2.8MB/frame @ 1920×1080) lambat di 2-core sandbox. Run di background dengan `nohup ... &` lalu poll progress via `grep -oE "frame=[ ]*[0-9]+|speed=[ ]*[0-9.]+x" encode.log`.

## Verifikasi Output

Pakai VLM (z-ai vision) untuk konfirmasi frame bukan hitam dan sesuai style:
```bash
z-ai vision -p "Is this a stained-glass window with lead cames, knight figure, rose window? 2 sentences." -i frame_00240.png -o vlm.json
node -e "console.log(require('./vlm.json').choices[0].message.content)"
```

## Adaptasi Konten Sendiri

Untuk pakai engine dengan konten sendiri (bukan demo film repo), rewrite `story.js`:
- `export const DUR = X` — total durasi detik
- `export const LINES = [...]` — subtitle lines
- `export const SUBS = LINES.map(...)` — subtitle timing
- `export function state(t)` — return scene state object per timestamp: `cam`, `sunU`, `sunCol`, `sunI`, `lancets` (figure poses), `floorMode`, dll. Lihat `story.js` asli untuk struktur lengkap.

## Quality Checklist

- [ ] `gl.readPixels` return non-zero pixel (cek center pixel rgb bukan 0,0,0)
- [ ] PNG file size > 100KB (kalau 44KB = black frame, capture gagal)
- [ ] VLM konfirmasi visual content di frame terang (t > 1s, bukan intro gelap)
- [ ] Video duration = frame_count / fps

## Performance

- ~0.5 fps (2 detik per frame) di 2-core sandbox headless software-GL
- 10s proof clip (240 frame @ 24fps): ~8 menit render + ~2 menit encode
- Full 56s lemomo film (1356 frame): ~45 menit render. Bagi jadi batch 120-240 frame.
- Memory: 4GB sandbox, render per-frame (fresh page.evaluate call) tidak akumulasi. Tidak perlu chunked seperti Remotion.

## Pitfalls Nyata

1. **`page.screenshot()` dan `canvas.toDataURL()` return BLACK untuk WebGL di headless** — ini pitfall utama. Headless Chromium pakai software GL (SwiftShader) yang tidak composit WebGL ke surface yang bisa di-screenshot. **Solusi wajib: `gl.readPixels()` manual + Y-flip.** Jangan percaya `preserveDrawingBuffer: true` cukup — itu untuk non-headless only.

2. **HTTP server mati saat command selesai** — kalau pakai `python3 -m http.server &` di command yang selesai, server terbunuh. Pakai `setsid` atau gabung start+render dalam satu command: `python3 -m http.server 8090 & SRV=$!; ... kill $SRV`.

3. **`--use-gl=angle` wajib** untuk WebGL di headless Linux. Tanpa flag ini, WebGL context creation bisa gagal atau render black. Flag tambahan: `--enable-webgl`, `--ignore-gpu-blocklist`.

4. **Y-flip wajib** — `readPixels` return bottom-up (OpenGL convention), gambar langsung akan terbalik vertikal kalau tidak di-flip.

5. **Engine lemomo pakai import path absolute `/core/lib.js`** — bukan relative. Jadi `core/lib.js` harus ada di server root (`engine-run/core/lib.js`), bukan di subfolder lain.

6. **Frame awal gelap legitemat** — story.js lemomo punya intensity 0 sampai t=0.5 (dawn intro). Jangan panic "black frame" di frame 0-12. Test dengan frame di t>3s dulu untuk verifikasi engine jalan.

7. **Encode PNG besar lambat** — 1920×1080 PNG = 2.8MB/file. 240 frame = ~700MB sementara. Encode x264 ultrafast ~1x speed di 2 cores. Background + poll progress, jangan blocking.
