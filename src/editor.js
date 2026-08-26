// editor.js — 剪映式编辑器：时间轴 + 分段特效 + 实时预览
import { EFFECTS } from "./effects.js";
import { Compositor } from "./compositor.js";
import { generateStyleImage, generateRestyleVideo, RESTYLE_STYLES } from "./restyle.js";

export class Editor {
  constructor({ clips, el, onBack }) {
    this.clips = clips;
    this.el = el;
    this.onBack = onBack;
    this.selectedIndex = 0;
    this.playing = false;
    this.rafId = 0;
    this._segIdCounter = 0;
    this._scanToken = 0;

    // 每片段状态：持久化到 clip._editState（返回录制后重新进入，编辑结果不丢失）
    this._syncStates();

    // 隐藏的转绘视频元素（用于 compositor 绘制）
    this.restyleVideoEl = document.createElement("video");
    this.restyleVideoEl.muted = true;
    this.restyleVideoEl.playsInline = true;

    this.compositor = new Compositor({
      rawVideo: el.rawVideo,
      greenVideo: el.greenVideo,
      outputCanvas: el.previewCanvas,
    });

    this._buildPanel();
    this._bind();
    this._renderTimeline();
    if (clips.length > 0) this.selectClip(0);
    document.addEventListener("keydown", (e) => this._onKeydown(e));
  }

  // 同步 states：新 clip 建默认状态，已编辑过的 clip 复用其 _editState
  _syncStates() {
    this.states = this.clips.map((clip) => {
      if (!clip._editState) {
        clip._editState = {
          segments: [],          // [{ id, start, end, effectId, mode }]
          selectedSegId: null,
          maskRanges: [],         // 虚线框存在的时间段 [{ start, end }]
          // AI 转绘三步状态
          restyleImageUrl: null,   // 步骤1 结果 URL
          restyleImageBlob: null,  // 步骤1 结果 Blob（用于放大查看）
          restyleVideoBlob: null,  // 步骤2 结果 Blob
          restyleSegStart: 0,      // AI 视频对应的特效段起始时间（用于时间偏移）
          restyleStyleId: null,    // 当前生效的转绘风格 id（用于特效段名称显示）
          imgHistory: [],          // 步骤1 历史记录 [{ url, blob, styleId }]
          vidHistory: [],          // 步骤2 历史记录 [{ blob, styleImageBlob, styleId }]
          restyleApplied: false,   // 步骤3 是否已应用
          imgProcessing: false,
          vidProcessing: false,
          scanned: false,          // 是否已完成自动扫描（重进编辑器不重置用户编辑）
        };
      }
      return clip._editState;
    });
  }

  // 重新进入编辑器（实例复用）：同步 clips 增删，恢复上次的编辑状态
  show() {
    this.pausePreview();
    this._syncStates();
    this._renderTimeline();
    if (this.selectedIndex >= this.clips.length) {
      this.selectedIndex = Math.max(0, this.clips.length - 1);
    }
    if (this.clips.length > 0) this.selectClip(this.selectedIndex);
  }

  _bind() {
    this.el.backBtn.addEventListener("click", () => { this.pausePreview(); this.onBack?.(); });
    this.el.previewCanvas.addEventListener("click", () => this._togglePlay());
    this.el.restyleGenImage.addEventListener("click", () => this._handleGenStyleImage());
    this.el.restyleGenVideo.addEventListener("click", () => this._handleGenRestyleVideo());
    this.el.restyleApply.addEventListener("click", () => this._handleApplyRestyle());
    this.el.exportClipBtn.addEventListener("click", () => this._toggleExportMenu());
    this.el.exportOptions?.forEach((opt) => {
      opt.addEventListener("click", () => {
        this.el.exportMenu?.classList.add("hidden");
        this._exportClip(opt.dataset.type);
      });
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".export-dropdown")) this.el.exportMenu?.classList.add("hidden");
    });
    this.el.addSegmentBtn.addEventListener("click", () => this._addSegment());
    this.el.delSegmentBtn.addEventListener("click", () => this._deleteSegment());
    this.el.playPauseBtn.addEventListener("click", () => this._togglePlay());
    // 播放进度条：点击跳转 + 拖拽跳转
    let dragging = false;
    const seek = (clientX) => {
      const rect = this.el.playbackBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const t = ratio * this.clips[this.selectedIndex].duration;
      this.pausePreview();
      this.el.rawVideo.currentTime = t;
      this.el.greenVideo.currentTime = t;
      if (this.restyleVideoEl.src) {
        const segOffset = this.states[this.selectedIndex].restyleSegStart || 0;
        this.restyleVideoEl.currentTime = Math.max(0, t - segOffset);
      }
      this._updatePlaybackUI(t);
    };
    this.el.playbackBar.addEventListener("mousedown", (e) => {
      dragging = true;
      seek(e.clientX);
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => { if (dragging) seek(e.clientX); });
    document.addEventListener("mouseup", () => {
      if (dragging) { dragging = false; this._renderAfterSeek(); }
    });
  }

  _buildPanel() {
    // 滤镜按钮
    const grid = this.el.effectGrid;
    grid.innerHTML = "";
    EFFECTS.forEach((e) => {
      const btn = document.createElement("button");
      btn.className = "effect-btn";
      btn.textContent = e.label;
      btn.dataset.effect = e.id;
      btn.addEventListener("click", () => this.setEffect(e.id));
      grid.appendChild(btn);
    });
    // 风格下拉
    const styleSel = this.el.restyleStyle;
    styleSel.innerHTML = "";
    RESTYLE_STYLES.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.label;
      styleSel.appendChild(opt);
    });
    // 从 localStorage 恢复 API Key
    const savedKey = localStorage.getItem("rh_api_key");
    if (savedKey) this.el.rhApiKey.value = savedKey;
    // API Key 变化时保存
    this.el.rhApiKey.addEventListener("change", () => {
      localStorage.setItem("rh_api_key", this.el.rhApiKey.value);
    });
    // 灯箱：点击预览图/视频放大
    this.el.restylePreview.addEventListener("click", () => {
      if (this.el.restylePreview.src) this._openLightbox("img", this.el.restylePreview.src);
    });
    this.el.restyleVideoPreview.addEventListener("click", () => {
      if (this.el.restyleVideoPreview.src) this._openLightbox("video", this.el.restyleVideoPreview.src);
    });
    this.el.lightbox.querySelector(".lightbox-backdrop").addEventListener("click", () => this._closeLightbox());
    this.el.lightbox.querySelector(".lightbox-close").addEventListener("click", () => this._closeLightbox());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this._closeLightbox(); });
    // 特效类型三选一 tab
    this.el.segmentEdit.querySelectorAll(".effect-type-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => this._setEffectType(btn.dataset.type));
    });
    // 模式切换
    this.el.modeToggle.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => this.setMode(btn.dataset.mode));
    });
    // 时间范围输入
    this.el.segStart.addEventListener("change", () => this._updateSegTime("start"));
    this.el.segEnd.addEventListener("change", () => this._updateSegTime("end"));
  }

  // 特效类型切换：无特效 / 滤镜特效 / AI转绘
  _setEffectType(type) {
    const seg = this._getSelectedSeg();
    if (!seg) return;
    if (type === "none") {
      this.setEffect(null);
    } else if (type === "filter") {
      // 当前不是滤镜 → 切到默认滤镜
      const isFilter = EFFECTS.some((e) => e.id === seg.effectId);
      if (!isFilter) this.setEffect("pixelate");
    } else if (type === "restyle") {
      this.setEffect("restyle");
    }
  }

  // ---- 时间轴 ----
  _renderTimeline() {
    const track = this.el.timelineTrack;
    track.innerHTML = "";
    this.clips.forEach((clip, i) => {
      const div = document.createElement("div");
      div.className = "timeline-clip";
      const video = document.createElement("video");
      video.src = URL.createObjectURL(clip.rawBlob);
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      div.appendChild(video);
      const label = document.createElement("div");
      label.className = "tl-label";
      label.textContent = `片段 ${i + 1}`;
      div.appendChild(label);
      const badge = document.createElement("div");
      badge.className = "tl-badge hidden";
      div.appendChild(badge);
      div.addEventListener("click", () => this.selectClip(i));
      track.appendChild(div);
    });
  }

  selectClip(index) {
    this.pausePreview();
    this.selectedIndex = index;
    const scanToken = ++this._scanToken;
    this.el.timelineTrack.querySelectorAll(".timeline-clip").forEach((c, i) => {
      c.classList.toggle("selected", i === index);
    });
    const clip = this.clips[index];
    const state = this.states[index];
    // rawVideo 始终用原始视频（转绘视频作为框内特效源，不替换 rawVideo）
    this.el.rawVideo.src = URL.createObjectURL(clip.rawBlob);
    this.el.rawVideo.muted = false;   // 播放录制的背景音
    this.el.greenVideo.src = URL.createObjectURL(clip.greenBlob);
    this.el.greenVideo.muted = true;  // greenVideo 与 rawVideo 音轨相同，静音避免重复
    // 恢复转绘视频状态
    if (state.restyleVideoBlob) {
      this.restyleVideoEl.src = URL.createObjectURL(state.restyleVideoBlob);
      this.compositor.setRestyleVideo(this.restyleVideoEl);
    } else {
      this.restyleVideoEl.removeAttribute("src");
      this.compositor.setRestyleVideo(null);
    }
    // 恢复预览图/视频
    if (state.restyleImageBlob) {
      this.el.restylePreview.src = URL.createObjectURL(state.restyleImageBlob);
      this.el.restylePreview.classList.remove("hidden");
    } else {
      this.el.restylePreview.classList.add("hidden");
    }
    if (state.restyleVideoBlob) {
      this.el.restyleVideoPreview.src = URL.createObjectURL(state.restyleVideoBlob);
      this.el.restyleVideoPreview.classList.remove("hidden");
    } else {
      this.el.restyleVideoPreview.classList.add("hidden");
    }
    this.compositor.setMaskTrack(clip.maskTrack || null);
    this.compositor.setSize(clip.width, clip.height);
    this.el.playbackDuration.textContent = this._formatTime(clip.duration);
    this._renderSegmentList();
    this._renderSegmentTrack();
    this._updatePanel();
    this._renderImgHistory();
    this._renderVidHistory();
    this._updateClipBadge();

    // 等待 greenVideo 加载后自动扫描 mask 片段（已扫描过的片段直接恢复编辑状态）
    const onLoaded = async () => {
      this.el.greenVideo.removeEventListener("loadeddata", onLoaded);
      if (scanToken !== this._scanToken) return;
      if (!state.scanned) {
        this._showScanOverlay("扫描特效区域…");
        await this._autoScanSegments(clip, index);
        if (scanToken !== this._scanToken) return;
        state.scanned = true;
      }
      this._renderSegmentList();
      this._renderSegmentTrack();
      this._updatePanel();
      this._updateClipBadge();
      this.playPreview();
    };
    if (this.el.greenVideo.readyState >= 2) {
      onLoaded();
    } else {
      this.el.greenVideo.addEventListener("loadeddata", onLoaded);
      // WebM 可能不触发 loadeddata，用 play+pause 强制解码第一帧
      setTimeout(async () => {
        if (this.el.greenVideo.readyState < 2 && scanToken === this._scanToken) {
          this.el.greenVideo.removeEventListener("loadeddata", onLoaded);
          try {
            this.el.greenVideo.muted = true;
            await this.el.greenVideo.play();
            this.el.greenVideo.pause();
          } catch (e) { /* 忽略 autoplay 限制 */ }
          onLoaded();
        }
      }, 800);
    }
  }

  // ---- 分段特效 ----
  _getSelectedSeg() {
    const state = this.states[this.selectedIndex];
    return state.segments.find((s) => s.id === state.selectedSegId);
  }

  _getActiveSegment(t) {
    const state = this.states[this.selectedIndex];
    for (let i = state.segments.length - 1; i >= 0; i--) {
      const seg = state.segments[i];
      if (t >= seg.start && t < seg.end) return seg;
    }
    return null;
  }

  _addSegment() {
    const state = this.states[this.selectedIndex];
    const clip = this.clips[this.selectedIndex];
    const t = this.el.rawVideo.currentTime;
    // 默认结束位置：下一个特效段 start 或下一个虚线框标记边界（start/end）
    // 取两者中较早到达者
    let end = clip.duration;
    for (const seg of state.segments) {
      if (seg.start > t + 0.1 && seg.start < end) end = seg.start;
    }
    for (const r of (state.maskRanges || [])) {
      if (r.start > t + 0.1 && r.start < end) end = r.start;
      if (r.end > t + 0.1 && r.end < end) end = r.end;
    }
    if (end <= t + 0.3) end = Math.min(t + 1, clip.duration);
    // 空间不足（如视频结尾）→ 不添加
    if (end <= t + 0.1) return;
    const ns = parseFloat(t.toFixed(1));
    const ne = parseFloat(end.toFixed(1));
    // 裁剪/删除与新区间 [ns, ne] 重叠的已有段
    const newSegs = [];
    for (const seg of state.segments) {
      if (seg.end <= ns + 0.01 || seg.start >= ne - 0.01) {
        // 不重叠 → 保留
        newSegs.push(seg);
      } else if (seg.start < ns - 0.01 && seg.end > ne + 0.01) {
        // 新段在已有段中间 → 拆分
        newSegs.push({ ...seg, end: ns });
        newSegs.push({
          id: ++this._segIdCounter,
          start: ne, end: seg.end,
          effectId: seg.effectId, mode: seg.mode,
        });
      } else if (seg.start < ns - 0.01) {
        // 新段覆盖已有段右部 → 缩短 end
        newSegs.push({ ...seg, end: ns });
      } else if (seg.end > ne + 0.01) {
        // 新段覆盖已有段左部 → 缩短 start
        newSegs.push({ ...seg, start: ne });
      }
      // 完全被覆盖 → 删除（不加入）
    }
    const newSeg = {
      id: ++this._segIdCounter,
      start: ns, end: ne,
      effectId: "vangogh", mode: "normal",
    };
    newSegs.push(newSeg);
    state.segments = newSegs;
    state.selectedSegId = newSeg.id;
    this._renderSegmentList();
    this._renderSegmentTrack();
    this._updatePanel();
    this._updateClipBadge();
    this._renderCurrentFrame();
  }

  _deleteSegment() {
    const state = this.states[this.selectedIndex];
    state.segments = state.segments.filter((s) => s.id !== state.selectedSegId);
    state.selectedSegId = null;
    this._renderSegmentList();
    this._renderSegmentTrack();
    this._updatePanel();
    this._updateClipBadge();
    this._renderCurrentFrame();
  }

  _selectSegment(id) {
    const state = this.states[this.selectedIndex];
    state.selectedSegId = id;
    const seg = this._getSelectedSeg();
    if (seg) {
      this.pausePreview();
      this.el.rawVideo.currentTime = seg.start;
      this.el.greenVideo.currentTime = seg.start;
      if (this.restyleVideoEl.src) {
        const segOffset = state.restyleSegStart || 0;
        this.restyleVideoEl.currentTime = Math.max(0, seg.start - segOffset);
      }
    }
    // 先 seek + 更新进度条，再重建轨道（确保 playhead 不会被重建覆盖）
    this._renderSegmentList();
    this._renderSegmentTrack();
    this._updatePanel();
    if (seg) {
      this._updatePlaybackUI(seg.start);
    }
    this._renderAfterSeek(seg ? seg.start : undefined);
  }

  setEffect(effectId) {
    const seg = this._getSelectedSeg();
    if (!seg) return;
    seg.effectId = effectId;
    this._updatePanel();
    this._renderSegmentList();
    this._renderSegmentTrack();
    this._updateClipBadge();
    this._renderCurrentFrame();
  }

  setMode(mode) {
    const seg = this._getSelectedSeg();
    if (!seg) return;
    seg.mode = mode;
    this._updatePanel();
    this._renderSegmentList();
    this._renderSegmentTrack();
    this._updateClipBadge();
    this._renderCurrentFrame();
  }

  // 立即重渲当前帧（不 seek，保持当前进度）
  _renderCurrentFrame() {
    const t = this.el.rawVideo.currentTime;
    const seg = this._getActiveSegment(t);
    this.compositor.render(seg?.effectId ?? null, seg?.mode ?? "normal", 1, t);
    this._updatePlaybackUI(t);  // 同步进度条 + playhead 位置（轨道重建后 playhead 会重置）
  }

  _updateSegTime(which) {
    const seg = this._getSelectedSeg();
    if (!seg) return;
    const clip = this.clips[this.selectedIndex];
    const state = this.states[this.selectedIndex];
    const sorted = [...state.segments].sort((a, b) => a.start - b.start);
    const idx = sorted.findIndex((s) => s.id === seg.id);
    const prevSeg = idx > 0 ? sorted[idx - 1] : null;
    const nextSeg = idx < sorted.length - 1 ? sorted[idx + 1] : null;
    if (which === "start") {
      const v = parseFloat(this.el.segStart.value);
      const minStart = prevSeg ? prevSeg.end : 0;
      if (!isNaN(v) && v >= minStart && v < seg.end) seg.start = parseFloat(v.toFixed(1));
      this.el.segStart.value = seg.start.toFixed(1);
    } else {
      const v = parseFloat(this.el.segEnd.value);
      const maxEnd = nextSeg ? nextSeg.start : clip.duration;
      if (!isNaN(v) && v > seg.start && v <= maxEnd) seg.end = parseFloat(v.toFixed(1));
      this.el.segEnd.value = seg.end.toFixed(1);
    }
    this._renderSegmentList();
    this._renderSegmentTrack();
    this._updateClipBadge();
  }

  // ---- UI 渲染 ----
  // 特效段显示名称：AI 转绘用风格名称（如“转绘·梵高”），滤镜用 EFFECTS label
  _segLabel(seg) {
    if (seg.effectId === "restyle") {
      const state = this.states[this.selectedIndex];
      const style = RESTYLE_STYLES.find((s) => s.id === state.restyleStyleId);
      return "转绘·" + (style ? style.label : "风格转绘");
    }
    const eff = EFFECTS.find((e) => e.id === seg.effectId);
    return eff?.label || "无特效";
  }

  _renderSegmentList() {
    const state = this.states[this.selectedIndex];
    const list = this.el.segmentList;
    list.innerHTML = "";
    if (state.segments.length === 0) {
      list.innerHTML = '<div class="seg-empty">暂无特效段</div>';
      return;
    }
    const sorted = [...state.segments].sort((a, b) => a.start - b.start);
    for (const seg of sorted) {
      const item = document.createElement("div");
      item.className = "seg-item" + (state.selectedSegId === seg.id ? " selected" : "");
      const name = document.createElement("span");
      name.className = "seg-name";
      name.textContent = this._segLabel(seg) + (seg.mode === "inverted" ? " ·反" : "");
      const time = document.createElement("span");
      time.className = "seg-time";
      time.textContent = `${seg.start.toFixed(1)}s–${seg.end.toFixed(1)}s`;
      item.appendChild(name);
      item.appendChild(time);
      item.addEventListener("click", () => this._selectSegment(seg.id));
      list.appendChild(item);
    }
  }

  _renderSegmentTrack() {
    const state = this.states[this.selectedIndex];
    const clip = this.clips[this.selectedIndex];
    const bar = this.el.segmentTrackBar;
    bar.innerHTML = "";
    for (const seg of state.segments) {
      const block = document.createElement("div");
      block.className = "seg-block" + (state.selectedSegId === seg.id ? " selected" : "");
      block.dataset.segId = seg.id;
      block.style.left = `${(seg.start / clip.duration) * 100}%`;
      block.style.width = `${((seg.end - seg.start) / clip.duration) * 100}%`;
      const eff = EFFECTS.find((e) => e.id === seg.effectId);
      block.textContent = seg.effectId === "restyle" ? "转绘" : (eff?.label || "");
      block.title = `${seg.start.toFixed(1)}s–${seg.end.toFixed(1)}s`;
      block.addEventListener("click", (e) => { e.stopPropagation(); this._selectSegment(seg.id); });
      this._setupBlockDrag(block, seg);
      bar.appendChild(block);
    }
    const playhead = document.createElement("div");
    playhead.className = "seg-playhead";
    // 创建时立即定位到当前播放位置（避免重建后 playhead 丢失）
    if (clip && clip.duration > 0) {
      const t = this.el.rawVideo.currentTime;
      playhead.style.left = `${(t / clip.duration) * 100}%`;
    }
    bar.appendChild(playhead);
    this._renderPlaybackSegMarkers();
  }

  // 在播放进度条上标记虚线框区域
  _renderPlaybackSegMarkers() {
    const state = this.states[this.selectedIndex];
    const clip = this.clips[this.selectedIndex];
    const bar = this.el.playbackBar;
    bar.querySelectorAll(".playback-seg-marker").forEach((m) => m.remove());
    for (const r of (state.maskRanges || [])) {
      const marker = document.createElement("div");
      marker.className = "playback-seg-marker";
      marker.style.left = `${(r.start / clip.duration) * 100}%`;
      marker.style.width = `${((r.end - r.start) / clip.duration) * 100}%`;
      bar.appendChild(marker);
    }
  }

  // 实时更新某个段的 block 位置（不重建 DOM）
  _updateBlockPos(seg) {
    const clip = this.clips[this.selectedIndex];
    const block = this.el.segmentTrackBar.querySelector(`[data-seg-id="${seg.id}"]`);
    if (block) {
      block.style.left = `${(seg.start / clip.duration) * 100}%`;
      block.style.width = `${((seg.end - seg.start) / clip.duration) * 100}%`;
    }
  }

  _setupBlockDrag(block, seg) {
    const EDGE = 12; // 边缘拖拽区域宽度（像素）
    // 鼠标移到边缘时动态改变 cursor 和视觉提示
    block.addEventListener("mousemove", (e) => {
      const rect = block.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < EDGE) { block.style.cursor = "ew-resize"; block.dataset.edge = "left"; }
      else if (x > rect.width - EDGE) { block.style.cursor = "ew-resize"; block.dataset.edge = "right"; }
      else { block.style.cursor = "grab"; delete block.dataset.edge; }
    });
    block.addEventListener("mouseleave", () => { block.style.cursor = "grab"; delete block.dataset.edge; });
    block.addEventListener("mousedown", (e) => {
      const rect = block.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      let mode = null;
      if (offsetX < EDGE) mode = "left";
      else if (offsetX > rect.width - EDGE) mode = "right";
      else mode = "move"; // 中间区域：移动整个段

      e.preventDefault();
      e.stopPropagation();
      block.style.cursor = mode === "move" ? "grabbing" : "ew-resize";

      // 选中该段（不重建 track，避免 block 引用失效）
      const state = this.states[this.selectedIndex];
      if (state.selectedSegId !== seg.id) {
        state.selectedSegId = seg.id;
        this.el.segmentTrackBar.querySelectorAll(".seg-block").forEach((b) =>
          b.classList.toggle("selected", b === block));
        this._renderSegmentList();
        this._updatePanel();
      }

      const clip = this.clips[this.selectedIndex];
      const barRect = this.el.segmentTrackBar.getBoundingClientRect();
      const startX = e.clientX;
      const origStart = seg.start, origEnd = seg.end;
      let dragged = false; // 是否发生实际拖拽（区分点击与拖拽）

      // 找相邻段（用于限制不重叠）
      const sorted = [...state.segments].sort((a, b) => a.start - b.start);
      const idx = sorted.findIndex((s) => s.id === seg.id);
      const prevSeg = idx > 0 ? sorted[idx - 1] : null;
      const nextSeg = idx < sorted.length - 1 ? sorted[idx + 1] : null;

      const onMove = (ev) => {
        if (Math.abs(ev.clientX - startX) <= 2) return; // 抖动阈值内视为点击，不移动段
        dragged = true;
        const dt = ((ev.clientX - startX) / barRect.width) * clip.duration;
        if (mode === "left") {
          let newStart = Math.max(0, Math.min(seg.end - 0.3, origStart + dt));
          // 超过前一段 end → 缩短前一段
          if (prevSeg && newStart < prevSeg.end) {
            prevSeg.end = Math.max(prevSeg.start + 0.3, newStart);
            this._updateBlockPos(prevSeg);
          }
          seg.start = newStart;
        } else if (mode === "right") {
          let newEnd = Math.max(seg.start + 0.3, Math.min(clip.duration, origEnd + dt));
          // 超过后一段 start → 缩短后一段
          if (nextSeg && newEnd > nextSeg.start) {
            nextSeg.start = Math.min(nextSeg.end - 0.3, newEnd);
            this._updateBlockPos(nextSeg);
          }
          seg.end = newEnd;
        } else { // move：整体平移
          const len = origEnd - origStart;
          const minStart = prevSeg ? prevSeg.end : 0;
          const maxStart = (nextSeg ? nextSeg.start : clip.duration) - len;
          const newStart = Math.max(minStart, Math.min(maxStart, origStart + dt));
          seg.start = newStart;
          seg.end = newStart + len;
        }
        // 实时更新 block 位置（不重建 DOM）
        block.style.left = `${(seg.start / clip.duration) * 100}%`;
        block.style.width = `${((seg.end - seg.start) / clip.duration) * 100}%`;
        this.el.segStart.value = seg.start.toFixed(1);
        this.el.segEnd.value = seg.end.toFixed(1);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        block.style.cursor = "grab";
        if (!dragged) {
          // 纯点击（无拖拽）：onUp 重建 DOM 会吞掉原生 click 事件，
          // 手动调用 _selectSegment，与右侧特效段列表行为一致（跳转到该段首帧）
          this._selectSegment(seg.id);
          return;
        }
        seg.start = parseFloat(seg.start.toFixed(1));
        seg.end = parseFloat(seg.end.toFixed(1));
        this._renderSegmentList();
        this._renderSegmentTrack();
        this._updatePanel();
        this._updateClipBadge();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  _updatePanel() {
    const state = this.states[this.selectedIndex];
    const seg = this._getSelectedSeg();
    const hasSeg = !!seg;
    this.el.segmentEdit.classList.toggle("hidden", !hasSeg);
    this.el.segmentMode.classList.toggle("hidden", !hasSeg);
    this.el.segmentTime.classList.toggle("hidden", !hasSeg);
    if (hasSeg) {
      // 确定特效类型
      let effectType = "none";
      if (seg.effectId === "restyle") effectType = "restyle";
      else if (seg.effectId) effectType = "filter";
      // 更新 tab 选中状态
      this.el.segmentEdit.querySelectorAll(".effect-type-tabs button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.type === effectType);
      });
      // 显示/隐藏子面板
      this.el.effectGrid.classList.toggle("hidden", effectType !== "filter");
      const restyleSection = this.el.segmentEdit.querySelector("#restyle-section");
      if (restyleSection) restyleSection.classList.toggle("hidden", effectType !== "restyle");
      // 更新滤镜按钮选中状态
      this.el.effectGrid.querySelectorAll(".effect-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.effect === seg.effectId);
      });
      this.el.modeToggle.querySelectorAll("button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === seg.mode);
      });
      this.el.segStart.value = seg.start.toFixed(1);
      this.el.segEnd.value = seg.end.toFixed(1);
    }
    // 转绘三步状态
    const st = this.states[this.selectedIndex];
    // 步骤1
    this.el.restyleGenImage.classList.toggle("processing", st.imgProcessing);
    this.el.restyleGenImage.disabled = st.imgProcessing;
    this.el.restyleGenImage.textContent = st.imgProcessing ? "生成中…" : (st.restyleImageUrl ? "重新生成" : "生成风格图片");
    // 步骤2（依赖步骤1完成）
    this.el.restyleGenVideo.classList.toggle("processing", st.vidProcessing);
    this.el.restyleGenVideo.disabled = st.vidProcessing || !st.restyleImageUrl;
    this.el.restyleGenVideo.textContent = st.vidProcessing ? "生成中…" : (st.restyleVideoBlob ? "重新生成" : "生成转绘视频");
    // 步骤3（依赖步骤2完成）
    this.el.restyleApply.disabled = !st.restyleVideoBlob || st.restyleApplied;
    this.el.restyleApply.textContent = st.restyleApplied ? "✓ 已应用" : "应用到特效段";
  }

  _updateClipBadge() {
    const state = this.states[this.selectedIndex];
    const clips = this.el.timelineTrack.querySelectorAll(".timeline-clip");
    const clip = clips[this.selectedIndex];
    if (!clip) return;
    const badge = clip.querySelector(".tl-badge");
    let text = "";
    if (state.restyleApplied) text = "转绘特效";
    else if (state.segments.length > 0) text = `${state.segments.length}段特效`;
    if (text) { badge.textContent = text; badge.classList.remove("hidden"); }
    else badge.classList.add("hidden");
  }

  // ---- 导出 ----
  _toggleExportMenu() {
    const menu = this.el.exportMenu;
    if (!menu) return;
    // 根据是否有 AI 视频设置按钮状态
    const state = this.states[this.selectedIndex];
    const aiBtn = menu.querySelector('[data-type="ai"]');
    if (aiBtn) aiBtn.disabled = !state?.restyleVideoBlob;
    menu.classList.toggle("hidden");
  }

  async _exportClip(type = "green") {
    const btn = this.el.exportClipBtn;
    const idx = this.selectedIndex + 1;
    const clip = this.clips[this.selectedIndex];
    const state = this.states[this.selectedIndex];
    const orig = btn.textContent;
    btn.disabled = true;
    try {
      if (type === "green") {
        btn.textContent = "导出中...";
        await this._convertToMp4(clip.greenBlob, `clip${idx}_green.mp4`);
      } else if (type === "ai") {
        if (!state.restyleVideoBlob) { alert("请先生成 AI 转绘视频"); return; }
        btn.textContent = "导出中...";
        await this._convertToMp4(state.restyleVideoBlob, `clip${idx}_ai.mp4`);
      } else if (type === "composite") {
        btn.textContent = "渲染中...";
        await this._exportComposite(idx);
      }
    } catch (e) {
      console.error("导出失败:", e);
      alert("导出失败: " + e.message);
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  }

  // 导出特效合成视频：逐帧渲染 compositor 输出
  async _exportComposite(idx) {
    const clip = this.clips[this.selectedIndex];
    const state = this.states[this.selectedIndex];
    const raw = this.el.rawVideo;
    const green = this.el.greenVideo;
    const canvas = this.compositor.outputCanvas;
    const w = canvas.width, h = canvas.height;

    // 暂停预览
    const wasPlaying = this.playing;
    this.pausePreview();

    // 重置到开头
    raw.currentTime = 0;
    green.currentTime = 0;
    await new Promise((r) => { raw.onseeked = r; });
    await new Promise((r) => { green.onseeked = r; });

    // 设置 recorder
    const stream = canvas.captureStream(30);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const btn = this.el.exportClipBtn;
    const dur = clip.duration;

    return new Promise((resolve, reject) => {
      recorder.onstop = async () => {
        try {
          btn.textContent = "导出中...";
          const webmBlob = new Blob(chunks, { type: "video/webm" });
          await this._convertToMp4(webmBlob, `clip${idx}_composite.mp4`);
          // 恢复播放状态
          if (wasPlaying) this.playPreview();
          resolve();
        } catch (e) { reject(e); }
      };
      recorder.onerror = (e) => reject(e.error || new Error("录制失败"));

      recorder.start(100);
      raw.play().catch(() => {});
      green.play().catch(() => {});

      const renderFrame = () => {
        if (raw.ended) {
          recorder.stop();
          return;
        }
        const t = raw.currentTime;
        if (Math.abs(green.currentTime - t) > 0.05) green.currentTime = t;
        // 同步 AI 视频
        if (this.restyleVideoEl.src) {
          const segOffset = state.restyleSegStart || 0;
          const relT = Math.max(0, t - segOffset);
          if (Math.abs(this.restyleVideoEl.currentTime - relT) > 0.05)
            this.restyleVideoEl.currentTime = relT;
        }
        const seg = this._getActiveSegment(t);
        this.compositor.render(seg?.effectId ?? null, seg?.mode ?? "normal", 1, t);
        btn.textContent = `渲染中... ${Math.floor((t / dur) * 100)}%`;
        requestAnimationFrame(renderFrame);
      };
      requestAnimationFrame(renderFrame);
    });
  }
  // 导出下载：优先服务端转码 MP4（本地 serve.py 提供）；
  // 平台环境无转码服务时自动回退 WebM 直出
  async _convertToMp4(blob, filename) {
    try {
      const resp = await fetch("/convert", {
        method: "POST",
        headers: { "X-Format": "mp4", "Content-Type": "video/webm" },
        body: blob,
      });
      if (resp.ok) {
        const mp4Blob = await resp.blob();
        this._downloadBlob(mp4Blob, filename);
        return;
      }
      console.warn(`[export] 服务端转码不可用 (HTTP ${resp.status})，回退 WebM 导出`);
    } catch (e) {
      console.warn("[export] 服务端转码请求失败，回退 WebM 导出:", e);
    }
    this._downloadBlob(blob, filename.replace(/\.mp4$/, ".webm"));
  }
  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- 转绘三步流程 ----

  // 步骤1: 生成风格图片
  async _handleGenStyleImage() {
    const state = this.states[this.selectedIndex];
    if (state.imgProcessing) return;
    // API Key 留空 = 平台模式（服务端鉴权）；填写 = 本地直连模式
    const apiKey = this.el.rhApiKey.value.trim();
    const styleId = this.el.restyleStyle.value;
    const seg = this._getSelectedSeg();
    if (!seg) { alert("请先选择一个特效段"); return; }
    const frameTime = seg.start;

    state.imgProcessing = true;
    state.restyleImageUrl = null;
    state.restyleImageBlob = null;
    state.restyleVideoBlob = null;  // 重置步骤2
    state.restyleApplied = false;
    this._setProgress("img", true, "准备中...", 0);
    this.el.restylePreview.classList.add("hidden");
    this.el.restyleVideoPreview.classList.add("hidden");
    this._updatePanel();

    try {
      const { styleImageUrl, styleImageBlob } = await generateStyleImage(
        this.clips[this.selectedIndex].rawBlob, apiKey, styleId,
        frameTime, this.el.rawVideo,
        (text, p) => this._setProgress("img", true, text, p)
      );
      state.restyleImageUrl = styleImageUrl;
      state.restyleImageBlob = styleImageBlob;
      state.restyleStyleId = styleId;
      state.imgHistory.push({ url: styleImageUrl, blob: styleImageBlob, styleId });
      // 显示预览（用 Blob URL 避免再次请求）
      const url = URL.createObjectURL(styleImageBlob);
      this.el.restylePreview.src = url;
      this.el.restylePreview.classList.remove("hidden");
      this._renderImgHistory();
      this._setProgress("img", false, "", 0);
    } catch (e) {
      console.error("风格图片生成失败:", e);
      alert("生成失败: " + e.message);
      this._setProgress("img", false, "", 0);
    }
    state.imgProcessing = false;
    this._updatePanel();
    this._updateClipBadge();
  }

  // 步骤2: 生成转绘视频
  async _handleGenRestyleVideo() {
    const state = this.states[this.selectedIndex];
    if (state.vidProcessing) return;
    if (!state.restyleImageUrl) { alert("请先生成风格图片"); return; }
    const apiKey = this.el.rhApiKey.value.trim();
    const seg = this._getSelectedSeg();
    if (!seg) { alert("请先选择一个特效段"); return; }

    state.vidProcessing = true;
    state.restyleVideoBlob = null;
    state.restyleApplied = false;
    this._setProgress("vid", true, "准备中...", 0);
    this.el.restyleVideoPreview.classList.add("hidden");
    this._updatePanel();

    try {
      const videoBlob = await generateRestyleVideo(
        state.restyleImageBlob,
        this.clips[this.selectedIndex].rawBlob, apiKey,
        seg.start, seg.end,
        (text, p) => this._setProgress("vid", true, text, p)
      );
      state.restyleVideoBlob = videoBlob;
      state.restyleSegStart = seg.start;
      state.vidHistory.push({ blob: videoBlob, styleImageBlob: state.restyleImageBlob, segStart: seg.start, styleId: state.restyleStyleId });
      const url = URL.createObjectURL(videoBlob);
      this.el.restyleVideoPreview.src = url;
      this.el.restyleVideoPreview.classList.remove("hidden");
      this._renderVidHistory();
      this._setProgress("vid", false, "", 0);
    } catch (e) {
      console.error("转绘视频生成失败:", e);
      alert("生成失败: " + e.message);
      this._setProgress("vid", false, "", 0);
    }
    state.vidProcessing = false;
    this._updatePanel();
    this._updateClipBadge();
  }

  // 步骤3: 应用为特效
  _handleApplyRestyle() {
    const state = this.states[this.selectedIndex];
    if (!state.restyleVideoBlob) { alert("请先生成转绘视频"); return; }

    // 设置转绘视频源
    this.restyleVideoEl.src = URL.createObjectURL(state.restyleVideoBlob);
    const segOffset = state.restyleSegStart || 0;
    this.restyleVideoEl.currentTime = Math.max(0, this.el.rawVideo.currentTime - segOffset);
    this.compositor.setRestyleVideo(this.restyleVideoEl);
    state.restyleApplied = true;

    // 仅将当前选中的特效段设为 "restyle"
    const seg = this._getSelectedSeg();
    if (seg) {
      seg.effectId = "restyle";
      seg.mode = "normal";
    }

    this.pausePreview();
    this._renderSegmentList();
    this._renderSegmentTrack();
    this._updatePanel();
    this._updateClipBadge();
    this._renderCurrentFrame();
  }

  // 进度条控制（type: "img" | "vid"）
  _setProgress(type, show, text, percent) {
    const isImg = type === "img";
    const progEl = isImg ? this.el.restyleImgProgress : this.el.restyleVidProgress;
    const fillEl = isImg ? this.el.restyleImgFill : this.el.restyleVidFill;
    const textEl = isImg ? this.el.restyleImgText : this.el.restyleVidText;
    progEl.classList.toggle("hidden", !show);
    if (show) {
      fillEl.style.width = `${percent}%`;
      textEl.textContent = text;
    }
  }

  // ---- 历史缩略图 ----
  _renderImgHistory() {
    const state = this.states[this.selectedIndex];
    const container = this.el.restyleImgHistory;
    container.innerHTML = "";
    if (state.imgHistory.length <= 1) {
      container.classList.add("hidden");
      return;
    }
    container.classList.remove("hidden");
    state.imgHistory.forEach((item, i) => {
      const isCurrent = (item.url === state.restyleImageUrl);
      const div = document.createElement("div");
      div.className = "restyle-history-item" + (isCurrent ? " active" : "");
      div.title = `风格 ${item.styleId} · 第${i + 1}张`;
      const img = document.createElement("img");
      img.src = URL.createObjectURL(item.blob);
      const num = document.createElement("span");
      num.className = "history-num";
      num.textContent = i + 1;
      div.appendChild(img);
      div.appendChild(num);
      div.addEventListener("click", () => this._selectImgHistory(i));
      container.appendChild(div);
    });
  }

  _selectImgHistory(index) {
    const state = this.states[this.selectedIndex];
    const item = state.imgHistory[index];
    if (!item) return;
    state.restyleImageUrl = item.url;
    state.restyleImageBlob = item.blob;
    state.restyleStyleId = item.styleId || null;
    this.el.restylePreview.src = URL.createObjectURL(item.blob);
    this.el.restylePreview.classList.remove("hidden");
    // 切换图片后重置步骤2/3
    state.restyleVideoBlob = null;
    state.restyleApplied = false;
    this.el.restyleVideoPreview.classList.add("hidden");
    this._renderImgHistory();
    this._renderVidHistory();
    this._updatePanel();
    this._updateClipBadge();
  }

  _renderVidHistory() {
    const state = this.states[this.selectedIndex];
    const container = this.el.restyleVidHistory;
    container.innerHTML = "";
    if (state.vidHistory.length <= 1) {
      container.classList.add("hidden");
      return;
    }
    container.classList.remove("hidden");
    state.vidHistory.forEach((item, i) => {
      const isCurrent = (item.blob === state.restyleVideoBlob);
      const div = document.createElement("div");
      div.className = "restyle-history-item" + (isCurrent ? " active" : "");
      div.title = `第${i + 1}个视频`;
      const video = document.createElement("video");
      video.src = URL.createObjectURL(item.blob);
      video.muted = true;
      const num = document.createElement("span");
      num.className = "history-num";
      num.textContent = i + 1;
      div.appendChild(video);
      div.appendChild(num);
      div.addEventListener("click", () => this._selectVidHistory(i));
      container.appendChild(div);
    });
  }

  _selectVidHistory(index) {
    const state = this.states[this.selectedIndex];
    const item = state.vidHistory[index];
    if (!item) return;
    state.restyleVideoBlob = item.blob;
    state.restyleImageBlob = item.styleImageBlob;
    state.restyleSegStart = item.segStart || 0;
    state.restyleStyleId = item.styleId || null;
    state.restyleApplied = false;
    this.el.restyleVideoPreview.src = URL.createObjectURL(item.blob);
    this.el.restyleVideoPreview.classList.remove("hidden");
    this._renderVidHistory();
    this._updatePanel();
    this._updateClipBadge();
  }

  // ---- 灯箱 ----
  _openLightbox(type, src) {
    const content = this.el.lightboxContent;
    content.innerHTML = "";
    if (type === "img") {
      const img = document.createElement("img");
      img.src = src;
      content.appendChild(img);
    } else {
      const video = document.createElement("video");
      video.src = src;
      video.controls = true;
      video.autoplay = true;
      content.appendChild(video);
    }
    this.el.lightbox.classList.remove("hidden");
  }
  _closeLightbox() {
    this.el.lightbox.classList.add("hidden");
    this.el.lightboxContent.innerHTML = "";
  }

  // ---- 预览播放 ----
  playPreview() {
    this.el.rawVideo.play().catch(() => {});
    this.el.greenVideo.play().catch(() => {});
    // 同步转绘视频（如果已加载）
    if (this.restyleVideoEl.src) {
      const segOffset = this.states[this.selectedIndex].restyleSegStart || 0;
      this.restyleVideoEl.currentTime = Math.max(0, this.el.rawVideo.currentTime - segOffset);
      this.restyleVideoEl.play().catch(() => {});
    }
    this.playing = true;
    this.el.playPauseBtn.innerHTML = '<span class="icon-pause"></span>';
    this._renderLoop();
  }

  pausePreview() {
    this.playing = false;
    cancelAnimationFrame(this.rafId);
    this.el.rawVideo.pause();
    this.el.greenVideo.pause();
    if (this.restyleVideoEl.src) this.restyleVideoEl.pause();
    this.el.playPauseBtn.innerHTML = '<span class="icon-play"></span>';
  }

  _togglePlay() {
    if (this.playing) this.pausePreview();
    else this.playPreview();
  }

  _renderLoop() {
    if (!this.playing) return;
    const t = this.el.rawVideo.currentTime;
    if (Math.abs(this.el.greenVideo.currentTime - t) > 0.05) {
      this.el.greenVideo.currentTime = t;
    }
    // 同步转绘视频（AI 视频时间线从 0 开始，需减去特效段起始时间偏移）
    if (this.restyleVideoEl.src) {
      const segOffset = this.states[this.selectedIndex].restyleSegStart || 0;
      const relT = Math.max(0, t - segOffset);
      if (Math.abs(this.restyleVideoEl.currentTime - relT) > 0.05) {
        this.restyleVideoEl.currentTime = relT;
      }
    }
    const seg = this._getActiveSegment(t);
    this.compositor.render(seg?.effectId ?? null, seg?.mode ?? "normal", 1, t);
    // 更新进度条 + 播放头
    this._updatePlaybackUI(t);
    // 视频结束 → 暂停在第一个特效段的开始帧
    // 注意：必须 pausePreview 停止渲染循环并暂停双视频。
    // 否则 greenVideo（时长比 rawVideo 稍长）seek 后会继续播放，
    // 又被同步逻辑反复拉回，currentTime 在段首帧附近锯齿抖动；
    // 而段首帧恰是 quad 从无到有的边界 → 虚线框反复出现/消失即闪烁。
    if (this.el.rawVideo.ended) {
      const state = this.states[this.selectedIndex];
      const firstSeg = state.segments[0];
      const seekT = firstSeg ? firstSeg.start : 0;
      this.pausePreview();
      this.el.rawVideo.currentTime = seekT;
      this.el.greenVideo.currentTime = seekT;
      if (this.restyleVideoEl.src) {
        const segOffset = state.restyleSegStart || 0;
        this.restyleVideoEl.currentTime = Math.max(0, seekT - segOffset);
      }
      this._updatePlaybackUI(seekT);
      // 等 seek 完成后渲染该帧，虚线框稳定显示
      this._renderAfterSeek(seekT);
      return;
    }
    this.rafId = requestAnimationFrame(() => this._renderLoop());
  }

  // 更新进度条 + 播放头 + 时间显示
  _updatePlaybackUI(t) {
    const clip = this.clips[this.selectedIndex];
    if (clip.duration > 0) {
      const pct = (t / clip.duration) * 100;
      this.el.playbackFill.style.width = `${pct}%`;
      this.el.playbackTime.textContent = this._formatTime(t);
      const playhead = this.el.segmentTrackBar.querySelector(".seg-playhead");
      if (playhead) playhead.style.left = `${pct}%`;
    }
  }

  // 格式化时间 0:00.0
  _formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return `${m}:${sec.padStart(4, "0")}`;
  }

  // 逐帧移动（dir = +1 前进 / -1 后退）
  _stepFrame(dir) {
    this.pausePreview();
    const frameTime = 1 / 30;
    const dur = this.clips[this.selectedIndex].duration;
    let t = this.el.rawVideo.currentTime + dir * frameTime;
    t = Math.max(0, Math.min(dur, t));
    this.el.rawVideo.currentTime = t;
    this.el.greenVideo.currentTime = t;
    if (this.restyleVideoEl.src) {
      const segOffset = this.states[this.selectedIndex].restyleSegStart || 0;
      this.restyleVideoEl.currentTime = Math.max(0, t - segOffset);
    }
    this._updatePlaybackUI(t);
    this._renderAfterSeek();
  }

  // 键盘事件：←→逐帧，空格播放/暂停
  _onKeydown(e) {
    const ev = document.getElementById("editor-view");
    if (!ev || ev.classList.contains("hidden")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); this._stepFrame(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); this._stepFrame(1); }
    else if (e.key === " ") { e.preventDefault(); this._togglePlay(); }
  }

  // seek 完成后渲染一帧（等 greenVideo 同步）
  // expectedTime: 可选，指定期望显示的时间（避免 seek 延迟导致进度条跳动）
  _renderAfterSeek(expectedTime) {
    setTimeout(() => {
      const t = expectedTime ?? this.el.rawVideo.currentTime;
      if (Math.abs(this.el.greenVideo.currentTime - t) > 0.05) {
        this.el.greenVideo.currentTime = t;
      }
      if (this.restyleVideoEl.src) {
        const segOffset = this.states[this.selectedIndex].restyleSegStart || 0;
        const relT = Math.max(0, t - segOffset);
        if (Math.abs(this.restyleVideoEl.currentTime - relT) > 0.05) {
          this.restyleVideoEl.currentTime = relT;
        }
      }
      const seg = this._getActiveSegment(t);
      this.compositor.render(seg?.effectId ?? null, seg?.mode ?? "normal", 1, t);
      this._updatePlaybackUI(t);
    }, 80);
  }

  // ---- 自动扫描 mask 片段 ----
  // 遍历视频时间轴，检测绿幕 mask 存在的时间段，自动创建特效段
  async _autoScanSegments(clip, index) {
    const duration = clip.duration;
    if (!duration || !isFinite(duration)) return;
    // 固定 state 引用和扫描令牌：扫描期间用户切换片段时，旧扫描不得写入新片段的 state
    const state = this.states[index];
    const token = this._scanToken;
    const ranges = [];
    if (clip.maskTrack && clip.maskTrack.length > 0) {
      // 优先：直接用录制时记录的精确 quad 时间线（形状/时间与录制时完全一致，
      // 且不受 WebM seek 不可靠影响，不会漏检）
      let segStart = null;
      for (const item of clip.maskTrack) {
        if (item.quad && segStart === null) {
          segStart = item.t;
        } else if (!item.quad && segStart !== null) {
          ranges.push({ start: segStart, end: item.t });
          segStart = null;
        }
      }
      if (segStart !== null) ranges.push({ start: segStart, end: duration });
      console.log(`[scan] clip${index} 使用录制 maskTrack: ${ranges.length} 个原始区间`);
    } else {
      // 回退：无 maskTrack（旧片段/上传无手势视频），绿幕视频逐点色键扫描
      // 预热：快速播放一遍修正 WebM duration 元数据（Infinity → 实际时长）。
      // 否则结尾附近 seek 不触发 seeked 事件，导致结尾 mask 段漏检
      await this._warmGreenVideo(duration, token);
      if (token !== this._scanToken) return;
      const step = 0.15;
      let segStart = null;
      let seekFails = 0;
      for (let t = 0; t < duration; t += step) {
        let ok = await this._seekGreenTo(t);
        if (!ok) ok = await this._seekGreenTo(t); // 重试一次（首次失败多为解码慢）
        if (token !== this._scanToken) return; // 扫描已被新扫描取代，放弃
        if (!ok) { seekFails++; continue; } // seek 失败的点帧不确定，跳过不参与判断
        const bbox = this.compositor.extractMask();
        if (bbox && segStart === null) {
          segStart = t;
        } else if (!bbox && segStart !== null) {
          ranges.push({ start: segStart, end: t });
          segStart = null;
        }
      }
      if (segStart !== null) {
        ranges.push({ start: segStart, end: duration });
      }
      if (seekFails > 0) console.warn(`[scan] clip${index} 有 ${seekFails} 个采样点 seek 失败被跳过`);
    }
    // 合并短间隙（< 0.15s，单采样点毛刺；绿幕残留会吃掉真实间隙，不能设宽）
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start - last.end < 0.15) {
        last.end = r.end;
      } else {
        merged.push({ ...r });
      }
    }
    // 过滤过短的段（< 0.2s）
    const filtered = merged.filter(r => r.end - r.start >= 0.2);
    console.log(`[scan] clip${index} 原始段: ${ranges.map(r => `${r.start.toFixed(2)}-${r.end.toFixed(2)}`).join(", ") || "无"}; 合并后: ${merged.length}段; 过滤后: ${filtered.length}段`);
    // 保存虚线框区域 + 创建特效段
    state.maskRanges = filtered;
    state.segments = [];
    for (const r of filtered) {
      state.segments.push({
        id: ++this._segIdCounter,
        start: parseFloat(r.start.toFixed(2)),
        end: parseFloat(r.end.toFixed(2)),
        effectId: "vangogh",
        mode: "normal",
      });
    }
    if (state.segments.length > 0) {
      state.selectedSegId = state.segments[0].id;
    }
  }

  // seek greenVideo 到指定时间。返回 true=seeked 事件触发（帧可靠）；false=超时（帧不可信）
  _seekGreenTo(t) {
    return new Promise((resolve) => {
      const video = this.el.greenVideo;
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        resolve(ok);
      };
      const onSeeked = () => finish(true);
      const timer = setTimeout(() => finish(false), 600);
      video.addEventListener("seeked", onSeeked);
      video.currentTime = t;
    });
  }

  // 快速播放 greenVideo 一遍（16x 静音），让浏览器建立完整帧索引并修正 duration 元数据
  _warmGreenVideo(duration, token) {
    return new Promise((resolve) => {
      const video = this.el.greenVideo;
      video.muted = true;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearInterval(check);
        clearTimeout(overall);
        video.removeEventListener("ended", done);
        video.pause();
        video.playbackRate = 1;
        resolve();
      };
      // 总超时：正常 16x 播完需 duration/16，加倍余量
      const timeoutMs = Math.max(2000, (duration / 16) * 2 * 1000 + 1500);
      const overall = setTimeout(done, timeoutMs);
      // 扫描被新扫描取代时提前退出
      const check = setInterval(() => {
        if (token !== this._scanToken) done();
      }, 200);
      video.addEventListener("ended", done);
      video.currentTime = 0; // 从头播放，预热完整时间轴
      video.playbackRate = 16;
      video.play().catch(() => done());
    });
  }

  // 在预览画布上显示扫描提示
  _showScanOverlay(msg) {
    const cv = this.el.previewCanvas;
    const ctx = cv.getContext("2d");
    if (!cv.width || !cv.height) return;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#fff";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(msg, cv.width / 2, cv.height / 2);
    ctx.restore();
  }
}
