// effects.js — 滤镜渲染引擎（从 main.js 提取并参数化）
// 每个滤镜在传入的 ctx 上全屏绘制；clip / mask 由调用方（compositor）处理。
// source 可以是 HTMLVideoElement 或 Canvas，作为滤镜的输入画面。

export const EFFECTS = [
  { id: "pixelate", label: "像素化" },
  { id: "blur", label: "模糊" },
  { id: "invert", label: "反色" },
  { id: "noir", label: "黑白" },
  { id: "glitch", label: "故障" },
  { id: "toon", label: "卡通" },
  { id: "vangogh", label: "梵高" },
];

// 绘制源画面到任意 ctx（源视频已在录制时镜像，此处不再翻转）
function drawSource(c, source, w, h, dx = 0) {
  c.save();
  c.drawImage(source, -dx, 0, w, h);
  c.restore();
}

// ---- 卡通：赛璐璐风格 ----
const toon = document.createElement("canvas");
const tctx = toon.getContext("2d", { willReadFrequently: true });
const POSTER_LEVELS = 6;
const posterLUT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  posterLUT[i] = Math.round(
    (Math.round((i / 255) * (POSTER_LEVELS - 1)) / (POSTER_LEVELS - 1)) * 255
  );
}

// ---- 梵高：实时绘画式渲染 ----
const vg = document.createElement("canvas");
const vgCtx = vg.getContext("2d", { willReadFrequently: true });
const VG_SCALE = 4;
let vgAngle = null, vgMag = null, vgData = null, vgW = 0, vgH = 0;
let vgLum = null, vgGx = null, vgGy = null, vgTx = null, vgTy = null;

function vgHash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function vgBuildField(source, w, h, bb) {
  vgW = Math.ceil(w / VG_SCALE);
  vgH = Math.ceil(h / VG_SCALE);
  if (vg.width !== vgW || vg.height !== vgH) {
    vg.width = vgW; vg.height = vgH;
  }
  vgCtx.filter = "saturate(1.8) contrast(1.1)";
  drawSource(vgCtx, source, vgW, vgH);
  vgCtx.filter = "none";
  vgData = vgCtx.getImageData(0, 0, vgW, vgH).data;

  const n = vgW * vgH;
  if (!vgLum || vgLum.length !== n) {
    vgLum = new Float32Array(n);
    vgGx = new Float32Array(n); vgGy = new Float32Array(n);
    vgTx = new Float32Array(n); vgTy = new Float32Array(n);
    vgAngle = new Float32Array(n); vgMag = new Float32Array(n);
  }
  const lum = vgLum, gx = vgGx, gy = vgGy, tmpx = vgTx, tmpy = vgTy;

  const M = 4;
  const cx0 = Math.max(1, Math.floor(bb.x0 / VG_SCALE) - M);
  const cx1 = Math.min(vgW - 2, Math.ceil(bb.x1 / VG_SCALE) + M);
  const cy0 = Math.max(1, Math.floor(bb.y0 / VG_SCALE) - M);
  const cy1 = Math.min(vgH - 2, Math.ceil(bb.y1 / VG_SCALE) + M);

  for (let y = cy0 - 1; y <= cy1 + 1; y++) {
    for (let x = cx0 - 1; x <= cx1 + 1; x++) {
      const i = y * vgW + x, p = i * 4;
      lum[i] = 0.299 * vgData[p] + 0.587 * vgData[p + 1] + 0.114 * vgData[p + 2];
    }
  }
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const i = y * vgW + x;
      gx[i] = -lum[i - vgW - 1] - 2 * lum[i - 1] - lum[i + vgW - 1] +
        lum[i - vgW + 1] + 2 * lum[i + 1] + lum[i + vgW + 1];
      gy[i] = -lum[i - vgW - 1] - 2 * lum[i - vgW] - lum[i - vgW + 1] +
        lum[i + vgW - 1] + 2 * lum[i + vgW] + lum[i + vgW + 1];
    }
  }
  const R = 2;
  for (let y = cy0; y <= cy1; y++) {
    const row = y * vgW;
    for (let x = cx0; x <= cx1; x++) {
      let sx = 0, sy = 0, c = 0;
      for (let k = -R; k <= R; k++) {
        const xx = x + k;
        if (xx < cx0 || xx > cx1) continue;
        sx += gx[row + xx]; sy += gy[row + xx]; c++;
      }
      tmpx[row + x] = sx / c; tmpy[row + x] = sy / c;
    }
  }
  for (let x = cx0; x <= cx1; x++) {
    for (let y = cy0; y <= cy1; y++) {
      let sx = 0, sy = 0, c = 0;
      for (let k = -R; k <= R; k++) {
        const yy = y + k;
        if (yy < cy0 || yy > cy1) continue;
        sx += tmpx[yy * vgW + x]; sy += tmpy[yy * vgW + x]; c++;
      }
      const i = y * vgW + x;
      vgMag[i] = Math.hypot(sx / c, sy / c);
      vgAngle[i] = Math.atan2(sy / c, sx / c) + Math.PI / 2;
    }
  }
}

function vgFieldAngle(px, py, t) {
  const sx = Math.min(vgW - 1, Math.max(0, Math.round(px / VG_SCALE)));
  const sy = Math.min(vgH - 1, Math.max(0, Math.round(py / VG_SCALE)));
  const i = sy * vgW + sx;
  if (vgMag[i] > 14) return vgAngle[i];
  return Math.sin(px * 0.011 + t * 0.35) * 1.7 + Math.cos(py * 0.013 - t * 0.28) * 1.7;
}

function vgStroke(ctx, px, py, segments, segLen, t) {
  ctx.beginPath();
  ctx.moveTo(px, py);
  let a = vgFieldAngle(px, py, t), x = px, y = py;
  for (let s = 0; s < segments; s++) {
    const na = vgFieldAngle(x, y, t);
    a = Math.cos(na - a) < 0 ? na + Math.PI : na;
    x += Math.cos(a) * segLen; y += Math.sin(a) * segLen;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function vgColor(px, py, jitter) {
  const sx = Math.min(vgW - 1, Math.max(0, Math.round(px / VG_SCALE)));
  const sy = Math.min(vgH - 1, Math.max(0, Math.round(py / VG_SCALE)));
  const p = (sy * vgW + sx) * 4;
  const v = 1 + (jitter - 0.5) * 0.3;
  const r = Math.min(255, vgData[p] * v);
  const g = Math.min(255, vgData[p + 1] * v);
  const b = Math.min(255, vgData[p + 2] * (1 + (jitter - 0.5) * 0.22));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function vgMagAt(px, py) {
  const sx = Math.min(vgW - 1, Math.max(0, Math.round(px / VG_SCALE)));
  const sy = Math.min(vgH - 1, Math.max(0, Math.round(py / VG_SCALE)));
  return vgMag[sy * vgW + sx];
}

// 像素化用的离屏画布
const small = document.createElement("canvas");
const sctx = small.getContext("2d");

// 主入口：在 ctx 上全屏绘制指定滤镜。
// source: 输入画面；bbox: 特效区域外接框（梵高用于限制计算范围，可选）。
export function applyEffect(ctx, source, w, h, effectId, presence, t, bbox) {
  ctx.save();
  ctx.globalAlpha = presence;

  switch (effectId) {
    case "pixelate": {
      const factor = 24;
      const sw = Math.max(2, Math.round(w / factor));
      const sh = Math.max(2, Math.round(h / factor));
      if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
      drawSource(sctx, source, sw, sh);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      break;
    }
    case "blur":
      ctx.filter = "blur(14px) saturate(1.1)";
      drawSource(ctx, source, w, h);
      ctx.filter = "none";
      break;
    case "invert":
      ctx.filter = "invert(1)";
      drawSource(ctx, source, w, h);
      ctx.filter = "none";
      break;
    case "noir":
      ctx.filter = "grayscale(1) contrast(1.5) brightness(0.95)";
      drawSource(ctx, source, w, h);
      ctx.filter = "none";
      break;
    case "glitch": {
      ctx.filter = "saturate(1.6) contrast(1.1)";
      drawSource(ctx, source, w, h);
      ctx.globalAlpha = presence * 0.35;
      ctx.filter = "hue-rotate(120deg)";
      drawSource(ctx, source, w, h, 8 + Math.sin(t * 9) * 5);
      ctx.filter = "hue-rotate(-120deg)";
      drawSource(ctx, source, w, h, -8 - Math.sin(t * 9) * 5);
      ctx.filter = "none";
      ctx.globalAlpha = presence;
      const slices = 7;
      for (let i = 0; i < slices; i++) {
        const seed = Math.sin(i * 127.1 + Math.floor(t * 12) * 311.7);
        const sy = ((seed * 0.5 + 0.5) * h) | 0;
        const sliceH = 6 + ((Math.abs(seed) * 26) | 0);
        const dx = (seed * 34) | 0;
        ctx.drawImage(source, 0, (sy / h) * source.videoHeight,
          source.videoWidth, (sliceH / h) * source.videoHeight,
          dx, sy, w, sliceH);
      }
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      for (let y = 0; y < h; y += 6) ctx.fillRect(0, y, w, 2);
      break;
    }
    case "toon":
      drawToon(ctx, source, w, h);
      break;
    case "vangogh":
      drawVanGogh(ctx, source, w, h, presence, t, bbox || { x0: 0, y0: 0, x1: w, y1: h });
      break;
  }
  ctx.restore();
}

function drawToon(ctx, source, w, h) {
  const tw = 320;
  const th = Math.max(2, Math.round((tw * h) / w));
  if (toon.width !== tw || toon.height !== th) { toon.width = tw; toon.height = th; }
  tctx.filter = "saturate(1.6) blur(0.6px) brightness(1.05)";
  drawSource(tctx, source, tw, th);
  tctx.filter = "none";

  const imgData = tctx.getImageData(0, 0, tw, th);
  const d = imgData.data;
  const lum = new Float32Array(tw * th);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  for (let p = 0; p < d.length; p += 4) {
    d[p] = posterLUT[d[p]]; d[p + 1] = posterLUT[d[p + 1]]; d[p + 2] = posterLUT[d[p + 2]];
  }
  for (let y = 1; y < th - 1; y++) {
    for (let x = 1; x < tw - 1; x++) {
      const i = y * tw + x;
      const gx = -lum[i - tw - 1] - 2 * lum[i - 1] - lum[i + tw - 1] +
        lum[i - tw + 1] + 2 * lum[i + 1] + lum[i + tw + 1];
      const gy = -lum[i - tw - 1] - 2 * lum[i - tw] - lum[i - tw + 1] +
        lum[i + tw - 1] + 2 * lum[i + tw] + lum[i + tw + 1];
      if (Math.abs(gx) + Math.abs(gy) > 90) {
        const p = i * 4;
        d[p] *= 0.18; d[p + 1] *= 0.18; d[p + 2] *= 0.18;
      }
    }
  }
  tctx.putImageData(imgData, 0, 0);
  ctx.drawImage(toon, 0, 0, tw, th, 0, 0, w, h);
}

function drawVanGogh(ctx, source, w, h, presence, t, bb) {
  vgBuildField(source, w, h, bb);
  ctx.filter = "blur(10px) saturate(1.7) brightness(0.92)";
  drawSource(ctx, source, w, h);
  ctx.filter = "none";

  const x0 = Math.max(6, bb.x0), y0 = Math.max(6, bb.y0);
  const x1 = Math.min(w - 6, bb.x1), y1 = Math.min(h - 6, bb.y1);
  ctx.lineCap = "round"; ctx.lineJoin = "round";

  const bigStep = 14;
  for (let y = y0; y < y1; y += bigStep) {
    for (let x = x0; x < x1; x += bigStep) {
      const j = vgHash(x, y);
      const px = x + (j - 0.5) * bigStep;
      const py = y + (vgHash(y, x) - 0.5) * bigStep;
      ctx.strokeStyle = vgColor(px, py, j);
      ctx.lineWidth = 8 + j * 4;
      ctx.globalAlpha = presence * 0.85;
      vgStroke(ctx, px, py, 4, 6.5, t);
    }
  }
  const fineStep = 6;
  for (let y = y0; y < y1; y += fineStep) {
    for (let x = x0; x < x1; x += fineStep) {
      const j = vgHash(x + 7, y + 3);
      const px = x + (j - 0.5) * fineStep;
      const py = y + (vgHash(y + 5, x + 1) - 0.5) * fineStep;
      const onEdge = vgMagAt(px, py) > 20;
      if (!onEdge && j > 0.35) continue;
      ctx.strokeStyle = vgColor(px, py, vgHash(x, y + 11));
      ctx.lineWidth = onEdge ? 3 + j * 1.5 : 4 + j * 2;
      ctx.globalAlpha = presence * (onEdge ? 0.95 : 0.7);
      vgStroke(ctx, px, py, onEdge ? 2 : 3, 5, t);
    }
  }
  ctx.globalAlpha = presence;
}
