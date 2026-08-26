// compositor.js — 特效合成：从绿幕版提取 mask，在原始版上合成特效 + 正反模式
import { applyEffect } from "./effects.js";

export class Compositor {
  constructor({ rawVideo, greenVideo, outputCanvas }) {
    this.rawVideo = rawVideo;
    this.greenVideo = greenVideo;
    this.outputCanvas = outputCanvas;
    this.outCtx = outputCanvas.getContext("2d");

    // 离屏 canvas
    this.maskCanvas = document.createElement("canvas");
    this.maskCtx = this.maskCanvas.getContext("2d", { willReadFrequently: true });
    this.fxCanvas = document.createElement("canvas");
    this.fxCtx = this.fxCanvas.getContext("2d", { willReadFrequently: true });

    this.w = 0;
    this.h = 0;
    this.lastMaskBBox = null;
    this.lastMaskQuad = null;
    this.smoothedQuad = null;  // 时间平滑后的四边形（防抖动）
    this.maskTrack = null;     // 录制时记录的精确 quad 时间线 [{t, quad}]（优先于色键检测）
    this.restyleVideo = null;  // AI 转绘视频（框内特效源）
  }

  static lerpPt(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
  static dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  setRestyleVideo(video) {
    this.restyleVideo = video;
  }

  // 设置录制时记录的精确 quad 时间线。track 非空时虚线框/遮罩直接用它，
  // 形状与录制时逐帧一致；否则回退色键检测（从绿幕视频反推，有压缩/极值法误差）
  setMaskTrack(track) {
    this.maskTrack = track && track.length > 0 ? track : null;
    this.smoothedQuad = null;
  }

  // 按时间从 maskTrack 插值 quad（track 录制时已平滑，这里只做相邻帧线性插值）
  _quadFromTrack(t) {
    const track = this.maskTrack;
    if (t <= track[0].t) {
      return track[0].quad ? track[0].quad.map((p) => ({ ...p })) : null;
    }
    const last = track[track.length - 1];
    if (t >= last.t) {
      return last.quad ? last.quad.map((p) => ({ ...p })) : null;
    }
    // 二分查找 t 所在的相邻两帧
    let lo = 0, hi = track.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (track[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = track[lo], b = track[hi];
    if (!a.quad || !b.quad) {
      // 出现/消失边界：取距离更近一侧的非空 quad
      const q = (t - a.t) < (b.t - t) ? a.quad : b.quad;
      return q ? q.map((p) => ({ ...p })) : null;
    }
    const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return a.quad.map((p, i) => Compositor.lerpPt(p, b.quad[i], f));
  }

  static quadBBox(q) {
    const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.outputCanvas.width = w; this.outputCanvas.height = h;
    this.maskCanvas.width = w; this.maskCanvas.height = h;
    this.fxCanvas.width = w; this.fxCanvas.height = h;
  }

  // 从绿幕版当前帧提取 mask（色键检测绿色）。
  // 返回 { bbox } 绿色区域外接框；mask 写入 maskCanvas（alpha mask）。
  extractMask() {
    const { w, h, maskCtx } = this;
    maskCtx.clearRect(0, 0, w, h);
    maskCtx.drawImage(this.greenVideo, 0, 0, w, h);
    const imgData = maskCtx.getImageData(0, 0, w, h);
    const d = imgData.data;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    let cx = 0, cy = 0, count = 0;
    let found = false;
    // 第一遍：色键检测 + bbox + 质心
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      // 放宽色键阈值，兼容 presence 较低时偏淡的绿色填充
      const isGreen = g > 55 && g > r * 1.25 && g > b * 1.25;
      if (isGreen) {
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255;
        const px = (i >> 2) % w, py = (i >> 2) / w | 0;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        cx += px; cy += py; count++;
        found = true;
      } else {
        d[i + 3] = 0;
      }
    }
    maskCtx.putImageData(imgData, 0, 0);
    if (!found) {
      this.lastMaskBBox = null;
      this.lastMaskQuad = null;
      return null;
    }
    cx /= count; cy /= count;
    // 第二遍：用极值法找四个角点（min/max x±y）
    // 对凸四边形，最远角点出现在 x+y 和 x-y 的极值处
    let tl = null, tr = null, br = null, bl = null; // top-left, top-right, bottom-right, bottom-left
    let tlV = Infinity, trV = -Infinity, brV = -Infinity, blV = Infinity;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const i = (py * w + px) * 4;
        if (d[i + 3] < 128) continue;
        const sum = px + py;   // top-left=min, bottom-right=max
        const diff = px - py;  // top-right=max, bottom-left=min
        if (sum < tlV) { tlV = sum; tl = { x: px, y: py }; }
        if (sum > brV) { brV = sum; br = { x: px, y: py }; }
        if (diff > trV) { trV = diff; tr = { x: px, y: py }; }
        if (diff < blV) { blV = diff; bl = { x: px, y: py }; }
      }
    }
    this.lastMaskBBox = { x0, y0, x1, y1 };
    this.lastMaskQuad = (tl && tr && br && bl) ? [tl, tr, br, bl] : null;
    return this.lastMaskBBox;
  }

  // 渲染一帧合成画面。
  // effectId: 滤镜 id 或 null（无特效）；mode: 'normal' | 'inverted'
  render(effectId, mode, presence, t) {
    const { w, h, outCtx, fxCtx, maskCtx } = this;
    if (!w || !h) return;

    // 1. 输出画布画原始画面
    outCtx.globalCompositeOperation = "source-over";
    outCtx.globalAlpha = 1;
    outCtx.drawImage(this.rawVideo, 0, 0, w, h);

    // 2. 确定当前帧的 mask quad：
    //    优先用录制时记录的精确 maskTrack（虚线框形状与录制时完全一致），
    //    无 track 数据时回退到色键检测（从绿幕视频逐像素反推）
    let bbox;
    if (this.maskTrack) {
      const q = this._quadFromTrack(this.greenVideo.currentTime);
      this.lastMaskQuad = q;
      this.lastMaskBBox = q ? Compositor.quadBBox(q) : null;
      this.smoothedQuad = null; // track 数据在录制时已平滑，无需二次平滑
      bbox = this.lastMaskBBox;
    } else {
      bbox = this.extractMask();
      const rawQuad = this.lastMaskQuad;
      // 自适应时间平滑：移动大时快速跟随，移动小时平滑抖动
      if (rawQuad) {
        if (!this.smoothedQuad) {
          this.smoothedQuad = rawQuad.map((p) => ({ ...p }));
        } else {
          const moved = rawQuad.reduce((s, p, i) => s + Compositor.dist(p, this.smoothedQuad[i]), 0) / 4;
          const alpha = Math.min(0.72, Math.max(0.22, moved / (w * 0.04)));
          this.smoothedQuad = rawQuad.map((p, i) => Compositor.lerpPt(this.smoothedQuad[i], p, alpha));
        }
        // 统一用平滑后的 quad，确保虚线框和遮罩完全对齐
        this.lastMaskQuad = this.smoothedQuad;
      } else {
        this.smoothedQuad = null;
        this.lastMaskQuad = null;
      }
    }
    const quad = this.lastMaskQuad;

    // 3. 如果有特效，合成特效
    if (effectId && presence > 0.01 && bbox) {
      fxCtx.globalCompositeOperation = "source-over";
      fxCtx.globalAlpha = 1;
      fxCtx.clearRect(0, 0, w, h);
      if (effectId === "restyle" && this.restyleVideo) {
        // AI 转绘：绘制转绘视频帧（cover 模式，保持宽高比，居中裁切）
        const rv = this.restyleVideo;
        const rw = rv.videoWidth || rv.width || w;
        const rh = rv.videoHeight || rv.height || h;
        const scale = Math.max(w / rw, h / rh);
        const dw = rw * scale, dh = rh * scale;
        fxCtx.drawImage(rv, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } else {
        applyEffect(fxCtx, this.rawVideo, w, h, effectId, presence, t, bbox);
      }
      // 用四边形遮罩（与虚线框同一形状，保证对齐）
      maskCtx.clearRect(0, 0, w, h);
      maskCtx.fillStyle = "#fff";
      if (quad && quad.length === 4) {
        maskCtx.beginPath();
        maskCtx.moveTo(quad[0].x, quad[0].y);
        for (let i = 1; i < 4; i++) maskCtx.lineTo(quad[i].x, quad[i].y);
        maskCtx.closePath();
        maskCtx.fill();
      } else {
        maskCtx.fillRect(bbox.x0, bbox.y0, bbox.x1 - bbox.x0, bbox.y1 - bbox.y0);
      }
      if (mode === "normal") {
        fxCtx.globalCompositeOperation = "destination-in";
      } else {
        fxCtx.globalCompositeOperation = "destination-out";
      }
      fxCtx.drawImage(this.maskCanvas, 0, 0);
      fxCtx.globalCompositeOperation = "source-over";
      outCtx.drawImage(this.fxCanvas, 0, 0);
    } else if (effectId && presence > 0.01 && !bbox && mode === "inverted") {
      // 无 mask 时反转模式：全屏特效
      applyEffect(outCtx, this.rawVideo, w, h, effectId, presence, t, { x0: 0, y0: 0, x1: w, y1: h });
    }

    // 4. 画虚线框（始终显示，方便用户定位特效区域）
    if (bbox) {
      this._drawDashedFrame(outCtx);
    }
  }

  // 画虚线框（跟随手指框的实际四边形形状）
  _drawDashedFrame(ctx) {
    const t = performance.now() / 1000;
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.lineDashOffset = -t * 40;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 6;
    const quad = this.lastMaskQuad;
    if (quad && quad.length === 4) {
      // 四边形虚线（跟随手指框形状）
      ctx.beginPath();
      ctx.moveTo(quad[0].x, quad[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
      ctx.closePath();
      ctx.stroke();
    } else {
      // 退化：bbox 矩形虚线
      const b = this.lastMaskBBox;
      if (b) ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }
}
