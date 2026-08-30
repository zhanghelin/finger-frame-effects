// recorder.js — 录制模块：手势检测 + 双视频（原始版/绿幕版）+ 背景音混入
import { HandLandmarker, FilesetResolver } from "../vendor/vision_bundle.mjs";

const WASM_URL = "vendor/wasm";
const MODEL_URL = "vendor/hand_landmarker.task";

// 带进度回调的 fetch（用于模型下载进度条）
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败: ${res.status}`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    onProgress(1);
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  const buf = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { buf.set(c, pos); pos += c.length; }
  return buf;
}

// MediaPipe 关键点索引
const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8, INDEX_MCP = 5, MIDDLE_MCP = 9;
// 标准绿幕色键绿
const GREEN_FILL = "rgba(0, 177, 64, 1)";

export class Recorder {
  constructor({ video, rawCanvas, greenCanvas, displayCanvas, hintEl, onStatus, onProgress }) {
    this.video = video;
    this.rawCanvas = rawCanvas;
    this.greenCanvas = greenCanvas;
    this.displayCanvas = displayCanvas;
    this.rawCtx = rawCanvas.getContext("2d");
    this.greenCtx = greenCanvas.getContext("2d");
    this.displayCtx = displayCanvas.getContext("2d");
    this.hintEl = hintEl;
    this.onStatus = onStatus;
    this.onProgress = onProgress;

    // 手势检测状态
    this.corners = null;
    this.presence = 0;
    this.frameActive = false;
    // 本次会话是否激活过取景框：掉出激活态后重新进入用中间阈值，避免迟滞死区
    this.everActivated = false;
    // 单手张开状态：框无效但恰好有一只手张开（另一只闭合/丢失），用于提示
    this.singleHandOpen = false;
    // 双手都在但都未张开的状态，用于提示
    this.handsAllTight = false;
    this.lostFrames = 0;
    this.jumpFrames = 0;
    this.MAX_LOST_FRAMES = 3;
    this.JUMP_CONFIRM_FRAMES = 2;
    this.smoothedQuad = null; // 当前帧平滑后的框（供外部读取）

    this.landmarker = null;
    this.lastVideoTime = -1;
    this.lastResults = null;
    this.running = false;
    this.mirrored = true; // 摄像头画面镜像

    // 录制状态
    this.rawRecorder = null;
    this.greenRecorder = null;
    this.rawChunks = [];
    this.greenChunks = [];
    this.recording = false;
    this.recStart = 0;
    // 录制时每帧的精确虚线框 [{t, quad}]，供编辑器还原与录制时一致的形状
    this.maskTrack = [];

    // 背景音
    this.audioCtx = null;
    this.audioDest = null;
    this.sourceMap = new Map(); // audioEl -> MediaElementAudioSourceNode
    this.currentSource = null;
    this.bgAudioEl = null;
  }

  async init() {
    this.onStatus?.("正在加载运行时…");
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);

    this.onStatus?.("正在下载手势模型…");
    const modelBuffer = await fetchWithProgress(MODEL_URL, (p) => {
      this.onProgress?.(p);
    });

    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: modelBuffer, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });

    this.onStatus?.("正在请求摄像头…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = stream;
    await new Promise((res) => (this.video.onloadedmetadata = res));
    await this.video.play();

    const w = this.video.videoWidth, h = this.video.videoHeight;
    this.rawCanvas.width = w; this.rawCanvas.height = h;
    this.greenCanvas.width = w; this.greenCanvas.height = h;
    this.displayCanvas.width = w; this.displayCanvas.height = h;

    this.running = true;
    this.loop();
  }

  // ---- 画面绘制 ----
  drawMirrored(c, w, h) {
    c.save();
    c.translate(w, 0);
    c.scale(-1, 1);
    c.drawImage(this.video, 0, 0, w, h);
    c.restore();
  }

  // ---- 手势检测（从 main.js 提取）----
  toPixel(lm) {
    const x = this.mirrored ? (1 - lm.x) : lm.x;
    return { x: x * this.rawCanvas.width, y: lm.y * this.rawCanvas.height };
  }
  static dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  static lerpPt(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

  computeQuad(hands) {
    const info = hands.map((lm) => {
      const index = this.toPixel(lm[INDEX_TIP]);
      const thumb = this.toPixel(lm[THUMB_TIP]);
      const wrist = this.toPixel(lm[WRIST]);
      const scale = Recorder.dist(wrist, this.toPixel(lm[MIDDLE_MCP])) + 1;
      return { index, thumb, wristX: wrist.x, scale, openness: Recorder.dist(thumb, index) / scale };
    });
    // 张开门槛：至少一只手达到阈值才生效。
    // 进入：首次 0.75 严格防误触发，掉出后重进 0.5；保持中 0.35。
    // 保持中也必须检查：双手都收起（握拳）时，即使指尖检测误差让
    // 4 点面积不为零，也要判定无框（收手=结束取景）；
    // 而一开一合时张开的那只手满足 0.35，三角形中间形态照常保留。
    const needed = this.frameActive ? 0.35 : (this.everActivated ? 0.5 : 0.75);
    if (!info.some((hd) => hd.openness >= needed)) return null;
    info.sort((a, b) => a.wristX - b.wristX);
    const [A, B] = info;
    const pts = [A.index, B.index, B.thumb, A.thumb];
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const hull = [...pts].sort(
      (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
    );
    const minArea = this.frameActive ? 0.0005 : (this.everActivated ? 0.0015 : 0.005);
    if (this.polygonArea(hull) < this.rawCanvas.width * this.rawCanvas.height * minArea) return null;
    return pts;
  }

  polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a / 2);
  }

  quadPath(c, q) {
    c.beginPath();
    c.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) c.lineTo(q[i].x, q[i].y);
    c.closePath();
  }

  // 角点平滑（One Euro 风格 + 丢帧保持 + 瞬移确认）
  smoothQuad(targetQuad) {
    if (targetQuad) {
      if (!this.corners) {
        this.lostFrames = 0;
        this.frameActive = true;
        this.everActivated = true;
        this.jumpFrames = 0;
        this.corners = targetQuad;
        this.presence = Math.min(1, this.presence + 0.12);
      } else {
        const matched = targetQuad;
        const moved = matched.reduce((s, p, i) => s + Recorder.dist(p, this.corners[i]), 0) / 4;
        if (moved > this.rawCanvas.width * 0.3 && ++this.jumpFrames < this.JUMP_CONFIRM_FRAMES) {
          if (++this.lostFrames > this.MAX_LOST_FRAMES) this.presence = Math.max(0, this.presence - 0.3);
        } else {
          this.lostFrames = 0;
          this.frameActive = true;
          this.jumpFrames = 0;
          const alpha = Math.min(0.85, Math.max(0.35, moved / (this.rawCanvas.width * 0.05)));
          this.corners = this.corners.map((c, i) => Recorder.lerpPt(c, matched[i], alpha));
          this.presence = Math.min(1, this.presence + 0.2);
        }
      }
    } else if (this.corners && ++this.lostFrames <= this.MAX_LOST_FRAMES) {
      // 短暂丢帧保持（防闪烁），但不提升 presence
    } else {
      this.presence = Math.max(0, this.presence - 0.3);
      if (this.presence === 0) {
        this.corners = null;
        this.frameActive = false;
        this.jumpFrames = 0;
      }
    }
    this.smoothedQuad = this.corners && this.presence > 0.01 ? this.corners : null;
  }

  drawFrameOutline(c, q) {
    const t = performance.now() / 1000;
    c.save();
    c.globalAlpha = this.presence;
    this.quadPath(c, q);
    c.setLineDash([10, 8]);
    c.lineDashOffset = -t * 40;
    c.lineWidth = 2;
    c.strokeStyle = "rgba(255,255,255,0.95)";
    c.shadowColor = "rgba(0,0,0,0.5)";
    c.shadowBlur = 6;
    c.stroke();
    c.setLineDash([]);
    c.lineDashOffset = 0;
    c.shadowBlur = 0;
    q.forEach((p, i) => {
      const r = 7 + Math.sin(t * 3 + i * 1.5) * 1.5;
      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fillStyle = "#fff";
      c.fill();
    });
    c.restore();
  }

  // 记录当前帧的精确 quad 到 maskTrack（编辑器用它还原与录制时完全一致的虚线框）
  _recordMaskTrack(t) {
    this.maskTrack.push({
      t,
      quad: this.smoothedQuad ? this.smoothedQuad.map((p) => ({ ...p })) : null,
    });
  }

  // ---- 渲染循环 ----
  loop() {
    if (!this.running) return;
    const w = this.rawCanvas.width, h = this.rawCanvas.height;

    // 原始版：仅摄像头画面（录制用，干净无框）
    this.drawMirrored(this.rawCtx, w, h);
    // 绿幕版：摄像头画面 + 框内填绿（录制用，无框）
    this.drawMirrored(this.greenCtx, w, h);

    // 手势检测（仅在新视频帧时运行检测和平滑）
    let detectionUpdated = false;
    if (this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      this.lastResults = this.landmarker.detectForVideo(this.video, performance.now());
      detectionUpdated = true;
    }
    if (detectionUpdated) {
      let targetQuad = null;
      const lms = this.lastResults?.landmarks;
      if (lms?.length === 2) {
        targetQuad = this.computeQuad(lms);
      }
      // 单手张开判定：框无效但恰好只有一只手在画面且张开，提示用户需要双手
      this.singleHandOpen = false;
      this.handsAllTight = false;
      if (!targetQuad && lms?.length >= 1) {
        const openHands = lms.filter((lm) => {
          const scale = Recorder.dist(this.toPixel(lm[WRIST]), this.toPixel(lm[MIDDLE_MCP])) + 1;
          return Recorder.dist(this.toPixel(lm[THUMB_TIP]), this.toPixel(lm[INDEX_TIP])) >= scale * 0.35;
        }).length;
        this.singleHandOpen = lms.length === 1 && openHands === 1;
        this.handsAllTight = lms.length === 2 && openHands === 0;
      }
      this.smoothQuad(targetQuad);
      // 录制中：记录精确 quad 时间线（编辑器虚线框/遮罩/扫描的数据源）
      if (this.recording) {
        this._recordMaskTrack((performance.now() - this.recStart) / 1000);
      }
    }

    if (this.corners && this.presence > 0.01) {
      // 绿幕版：框内填绿
      this.greenCtx.save();
      this.quadPath(this.greenCtx, this.corners);
      this.greenCtx.globalAlpha = this.presence;
      this.greenCtx.fillStyle = GREEN_FILL;
      this.greenCtx.fill();
      this.greenCtx.restore();
    }

    // 显示版：复用原始画面 + 虚线框（给用户看，不录制）
    this.displayCtx.clearRect(0, 0, w, h);
    this.displayCtx.drawImage(this.rawCanvas, 0, 0);
    if (this.corners && this.presence > 0.01) {
      this.drawFrameOutline(this.displayCtx, this.corners);
    }

    if (this.hintEl) {
      this.hintEl.classList.toggle("hidden", this.presence > 0.5);
      // 无框时给出具体引导，避免用户以为检测失效（一开一合时框已出现，无需提示）
      let msg = "伸出双手，拇指与食指构成取景框";
      if (this.singleHandOpen) msg = "检测到 1 只手张开 · 另一只手入镜即可构成取景框";
      else if (this.handsAllTight) msg = "张开拇指与食指开始检测";
      if (this.hintEl.textContent !== msg) this.hintEl.textContent = msg;
    }
    requestAnimationFrame(() => this.loop());
  }

  // ---- 背景音管理 ----
  // 设置当前背景音 audio 元素（切换时调用）。传 null 清除。
  setBgAudio(audioEl) {
    // 断开当前
    if (this.currentSource) {
      this.currentSource.disconnect();
      this.currentSource = null;
    }
    if (this.bgAudioEl) this.bgAudioEl.pause();
    if (!audioEl) { this.bgAudioEl = null; return; }

    if (!this.audioCtx) this.audioCtx = new AudioContext();
    // 每个元素只能 createMediaElementSource 一次，缓存复用
    if (!this.sourceMap.has(audioEl)) {
      this.sourceMap.set(audioEl, this.audioCtx.createMediaElementSource(audioEl));
    }
    this.currentSource = this.sourceMap.get(audioEl);
    if (!this.audioDest) this.audioDest = this.audioCtx.createMediaStreamDestination();
    this.currentSource.connect(this.audioDest);
    this.currentSource.connect(this.audioCtx.destination); // 扬声器让用户听到
    this.bgAudioEl = audioEl;
  }

  // ---- 录制 ----
  startRecording() {
    if (this.recording) return;
    this.rawChunks = [];
    this.greenChunks = [];
    this.maskTrack = [];

    const rawStream = this.rawCanvas.captureStream(30);
    const greenStream = this.greenCanvas.captureStream(30);

    // 混入背景音
    if (this.audioDest) {
      const audioTrack = this.audioDest.stream.getAudioTracks()[0];
      if (audioTrack) {
        rawStream.addTrack(audioTrack);
        greenStream.addTrack(audioTrack);
      }
    }
    if (this.bgAudioEl) {
      this.audioCtx?.resume();
      this.bgAudioEl.currentTime = 0;
      this.bgAudioEl.play().catch(() => {});
    }

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9" : "video/webm";
    this.rawRecorder = new MediaRecorder(rawStream, { mimeType: mime });
    this.greenRecorder = new MediaRecorder(greenStream, { mimeType: mime });

    this.rawRecorder.ondataavailable = (e) => { if (e.data.size) this.rawChunks.push(e.data); };
    this.greenRecorder.ondataavailable = (e) => { if (e.data.size) this.greenChunks.push(e.data); };

    this.rawRecorder.start();
    this.greenRecorder.start();
    this.recording = true;
    this.recStart = performance.now();
  }

  async stopRecording() {
    if (!this.recording) return null;
    this.recording = false;
    if (this.bgAudioEl) this.bgAudioEl.pause();

    const stop = (rec, chunks) =>
      new Promise((res) => {
        rec.onstop = () => res(new Blob(chunks, { type: "video/webm" }));
        rec.stop();
      });

    const [rawBlob, greenBlob] = await Promise.all([
      stop(this.rawRecorder, this.rawChunks),
      stop(this.greenRecorder, this.greenChunks),
    ]);
    const duration = (performance.now() - this.recStart) / 1000;
    return { rawBlob, greenBlob, duration, width: this.rawCanvas.width, height: this.rawCanvas.height, maskTrack: this.maskTrack };
  }

  // ---- 处理上传视频：实时播放 + 手势检测，生成绿幕遮罩 ----
  async processUploadedVideo(file, onProgress) {
    if (!this.landmarker) throw new Error("手势模型未加载");

    // 暂停实时循环
    const wasRunning = this.running;
    this.running = false;

    // 保存状态
    const sv = {
      corners: this.corners, presence: this.presence, mirrored: this.mirrored,
      frameActive: this.frameActive, everActivated: this.everActivated,
      lostFrames: this.lostFrames, jumpFrames: this.jumpFrames,
      lastVideoTime: this.lastVideoTime, rawW: this.rawCanvas.width, rawH: this.rawCanvas.height,
    };

    // 加载上传视频
    const video = document.createElement("video");
    video.src = URL.createObjectURL(file);
    video.muted = true; video.playsInline = true;
    await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = rej; });
    if (video.readyState < 2) {
      await new Promise((res) => { video.onloadeddata = res; });
    }

    // 降低分辨率上限，加速 drawImage 和 detectForVideo
    const maxDim = 1280;
    let w = video.videoWidth || 1280, h = video.videoHeight || 720;
    if (w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
    const duration = video.duration;
    console.log(`[upload] 视频: ${video.videoWidth}x${video.videoHeight} → 处理 ${w}x${h}, 时长 ${duration}s`);

    // 临时设置处理状态
    this.mirrored = false;
    this.corners = null; this.presence = 0; this.frameActive = false; this.everActivated = false;
    this.lostFrames = 0; this.jumpFrames = 0; this.lastVideoTime = -1;
    this.rawCanvas.width = w; this.rawCanvas.height = h;
    this.maskTrack = [];

    // 绿幕 canvas
    const gc = document.createElement("canvas");
    gc.width = w; gc.height = h;
    const gctx = gc.getContext("2d");
    let hasMask = false;

    // WebM 录制（duration 问题在编辑器端处理，不依赖服务器转码）
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const stream = gc.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    return new Promise((resolve, reject) => {
      rec.onstop = () => {
        this.corners = sv.corners; this.presence = sv.presence; this.mirrored = sv.mirrored;
        this.frameActive = sv.frameActive; this.everActivated = sv.everActivated;
        this.lostFrames = sv.lostFrames; this.jumpFrames = sv.jumpFrames;
        this.lastVideoTime = sv.lastVideoTime;
        this.rawCanvas.width = sv.rawW; this.rawCanvas.height = sv.rawH;
        this.running = wasRunning;
        if (wasRunning) this.loop();
        URL.revokeObjectURL(video.src);
        resolve({
          greenBlob: new Blob(chunks, { type: mime }),
          hasMask, w, h, duration,
          handsCount,
          maskTrack: this.maskTrack,
        });
      };
      rec.onerror = (e) => reject(e.error || new Error("绿幕生成失败"));

      rec.start(100);
      video.play().catch((e) => console.warn("[upload] video.play 失败:", e));
      let detectCount = 0, handsCount = 0, quadCount = 0;

      const processFrame = () => {
        if (video.ended) {
          console.log(`[upload] 完成: 检测${detectCount}帧, 检测到手势${handsCount}帧, 生成quad${quadCount}帧, hasMask=${hasMask}`);
          setTimeout(() => rec.stop(), 300);
          return;
        }

        // 绘制视频帧（不镜像，降低分辨率）
        gctx.drawImage(video, 0, 0, w, h);

        // 手势检测（用 video 元素，播放模式下 GPU texture 已更新）
        let updated = false;
        if (video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = video.currentTime;
          this.lastResults = this.landmarker.detectForVideo(video, performance.now());
          updated = true;
          detectCount++;
          const nHands = this.lastResults?.landmarks?.length || 0;
          if (nHands > 0) handsCount++;
        }
        if (updated) {
          let targetQuad = null;
          const nHands = this.lastResults?.landmarks?.length || 0;
          if (nHands === 2) {
            targetQuad = this.computeQuad(this.lastResults.landmarks);
            if (targetQuad) { hasMask = true; quadCount++; }
          }
          this.smoothQuad(targetQuad);
          this._recordMaskTrack(video.currentTime);
        }

        // 绘制绿幕遮罩
        if (this.corners && this.presence > 0.01) {
          gctx.save();
          this.quadPath(gctx, this.corners);
          gctx.globalAlpha = this.presence;
          gctx.fillStyle = GREEN_FILL;
          gctx.fill();
          gctx.restore();
        }

        onProgress?.(video.currentTime / duration);
        requestAnimationFrame(processFrame);
      };
      requestAnimationFrame(processFrame);
    });
  }

  stop() {
    this.running = false;
    const stream = this.video.srcObject;
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }
}
