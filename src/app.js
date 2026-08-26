// app.js — 主应用：录制 ↔ 编辑器视图切换 + 状态管理
import { Recorder } from "./recorder.js";
import { Editor } from "./editor.js";

// 预设背景音
const BG_MUSIC_LIST = [
  { id: "", label: "无背景音" },
  { id: "assets/audio/xhs_bgm.mp3", label: "BGM1" },
];

class App {
  constructor() {
    this.clips = [];
    this.recorder = null;
    this.editor = null;
    this.bgAudioEls = {};

    this._cacheElements();
    this._setupBgMusic();
    this._bindRecordControls();
    this._start();
  }

  _cacheElements() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      // 状态遮罩
      statusOverlay: $("status-overlay"),
      statusText: $("status-text"),
      statusSub: $("status-sub"),
      progressWrap: $("progress-wrap"),
      progressFill: $("progress-fill"),
      progressPct: $("progress-pct"),
      // 录制页
      recordView: $("record-view"),
      camVideo: $("cam-video"),
      displayCanvas: $("display-canvas"),
      rawCanvas: $("raw-canvas"),
      greenCanvas: $("green-canvas"),
      recordHint: $("record-hint"),
      countdownOverlay: $("countdown-overlay"),
      countdownNum: $("countdown-num"),
      recordBtn: $("record-btn"),
      recDot: $("rec-dot"),
      editBtn: $("edit-btn"),
      uploadBtn: $("upload-btn"),
      uploadInput: $("upload-input"),
      bgMusicSelect: $("bg-music-select"),
      clipsStrip: $("clips-strip"),
      // 编辑器页
      editorView: $("editor-view"),
      backBtn: $("back-btn"),
      timelineTrack: $("timeline-track"),
      segmentList: $("segment-list"),
      addSegmentBtn: $("add-segment-btn"),
      segmentEdit: $("segment-edit"),
      effectGrid: $("effect-grid"),
      segmentMode: $("segment-mode"),
      modeToggle: $("mode-toggle"),
      segmentTime: $("segment-time"),
      segStart: $("seg-start"),
      segEnd: $("seg-end"),
      delSegmentBtn: $("del-segment-btn"),
      playPauseBtn: $("play-pause-btn"),
      playbackBar: $("playback-bar"),
      playbackFill: $("playback-fill"),
      playbackTime: $("playback-time"),
      playbackDuration: $("playback-duration"),
      segmentTrackBar: $("segment-track-bar"),
      // 转绘 - 三步式
      rhApiKey: $("rh-api-key"),
      restyleStyle: $("restyle-style"),
      restyleGenImage: $("restyle-gen-image"),
      restyleImgProgress: $("restyle-img-progress"),
      restyleImgFill: $("restyle-img-fill"),
      restyleImgText: $("restyle-img-text"),
      restylePreview: $("restyle-preview"),
      restyleImgHistory: $("restyle-img-history"),
      restyleGenVideo: $("restyle-gen-video"),
      restyleVidProgress: $("restyle-vid-progress"),
      restyleVidFill: $("restyle-vid-fill"),
      restyleVidText: $("restyle-vid-text"),
      restyleVideoPreview: $("restyle-video-preview"),
      restyleVidHistory: $("restyle-vid-history"),
      restyleApply: $("restyle-apply"),
      // 灯箱
      lightbox: $("lightbox"),
      lightboxContent: $("lightbox-content"),
      exportClipBtn: $("export-clip-btn"),
      exportMenu: $("export-menu"),
      exportOptions: document.querySelectorAll(".export-option"),
      previewCanvas: $("preview-canvas"),
      previewRawVideo: $("preview-raw-video"),
      previewGreenVideo: $("preview-green-video"),
    };
  }

  async _start() {
    this.el.statusOverlay.classList.remove("hidden");
    this.el.statusOverlay.style.opacity = "1";
    this.el.progressWrap.style.display = "flex";
    this.el.statusText.textContent = "正在初始化…";
    this.el.statusSub.textContent = "首次加载需下载手势模型（约7.8MB），后续访问秒开";

    this.recorder = new Recorder({
      video: this.el.camVideo,
      displayCanvas: this.el.displayCanvas,
      rawCanvas: this.el.rawCanvas,
      greenCanvas: this.el.greenCanvas,
      hintEl: this.el.recordHint,
      onStatus: (msg) => { this.el.statusText.textContent = msg; },
      onProgress: (p) => {
        const pct = Math.round(p * 100);
        this.el.progressFill.style.width = pct + "%";
        this.el.progressPct.textContent = pct + "%";
      },
    });

    try {
      await this.recorder.init();
    } catch (e) {
      this.el.statusText.textContent = "初始化失败";
      this.el.statusSub.textContent = e.message;
      this.el.progressWrap.style.display = "none";
      return;
    }

    this.el.progressWrap.style.display = "none";
    this.el.statusOverlay.style.opacity = "0";
    setTimeout(() => this.el.statusOverlay.classList.add("hidden"), 500);
  }

  _bindRecordControls() {
    this.el.recordBtn.addEventListener("click", () => this._toggleRecord());
    this.el.editBtn.addEventListener("click", () => this._enterEditor());
    this.el.uploadBtn.addEventListener("click", () => this.el.uploadInput.click());
    this.el.uploadInput.addEventListener("change", (e) => this._handleUpload(e));
  }

  _toggleRecord() {
    if (this.recorder.recording) {
      this.recorder.stopRecording().then((clip) => {
        if (clip) {
          this.clips.push(clip);
          this._renderClipsStrip();
          this.el.editBtn.classList.toggle("hidden", this.clips.length === 0);
        }
      });
      this.el.recordBtn.textContent = "开始录制";
      this.el.recDot.classList.remove("active");
    } else {
      this.el.recordBtn.disabled = true;
      this._startCountdown(() => {
        this.recorder.startRecording();
        this.el.recordBtn.textContent = "停止录制";
        this.el.recordBtn.disabled = false;
        this.el.recDot.classList.add("active");
      });
    }
  }

  _startCountdown(onDone) {
    const overlay = this.el.countdownOverlay;
    const num = this.el.countdownNum;
    let count = 3;
    overlay.classList.remove("hidden");
    const tick = () => {
      if (count > 0) {
        num.textContent = count;
        // 重置动画
        num.style.animation = "none";
        num.offsetHeight; // reflow
        num.style.animation = "";
        count--;
        setTimeout(tick, 1000);
      } else {
        num.textContent = "开始!";
        num.style.animation = "none";
        num.offsetHeight;
        num.style.animation = "";
        setTimeout(() => {
          overlay.classList.add("hidden");
          onDone();
        }, 500);
      }
    };
    tick();
  }

  // ---- 上传视频 ----
  async _handleUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选择同一文件
    if (!file) return;
    this.el.uploadBtn.textContent = "处理中...";
    this.el.uploadBtn.disabled = true;
    try {
      let greenBlob, duration, w, h, maskTrack = null;

      // 尝试用逐帧手势检测生成绿幕遮罩
      if (this.recorder?.landmarker) {
        const result = await this.recorder.processUploadedVideo(file, (p) => {
          this.el.uploadBtn.textContent = `手势检测中... ${Math.floor(p * 100)}%`;
        });
        greenBlob = result.greenBlob;
        duration = result.duration;
        w = result.w; h = result.h;
        maskTrack = result.maskTrack || null;

        // 如果没检测到手势，回退到全屏绿幕（无手势轨迹），并明确告知用户原因
        if (!result.hasMask) {
          greenBlob = await this._generateGreenVideo(w, h, Math.min(duration, 2));
          maskTrack = null;
          if (result.handsCount > 0) {
            alert("检测到手部，但未识别到双手取景框手势（需双手拇指+食指构成框且张开足够大），已应用全屏特效区域");
          } else {
            alert("未在视频中检测到手势，已应用全屏特效区域（可重新上传含双手取景框手势的视频）");
          }
        }
      } else {
        // 模型未加载，直接用全屏绿幕
        const video = document.createElement("video");
        video.preload = "metadata";
        video.src = URL.createObjectURL(file);
        await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = rej; });
        duration = video.duration;
        w = video.videoWidth || 1280; h = video.videoHeight || 720;
        URL.revokeObjectURL(video.src);
        greenBlob = await this._generateGreenVideo(w, h, Math.min(duration, 2));
        alert("手势模型未加载完成（刚返回录制页时需要几秒重新加载），已应用全屏特效区域");
      }

      this.clips.push({ rawBlob: file, greenBlob, duration, width: w, height: h, maskTrack });
      this._renderClipsStrip();
      this.el.editBtn.classList.toggle("hidden", this.clips.length === 0);
    } catch (err) {
      console.error("上传失败:", err);
      alert("上传失败: " + err.message);
    } finally {
      this.el.uploadBtn.textContent = "上传视频";
      this.el.uploadBtn.disabled = false;
    }
  }

  // 生成全屏绿幕视频（短片段，编辑器会复用最后一帧）
  _generateGreenVideo(w, h, duration) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "rgb(0, 177, 64)";
      ctx.fillRect(0, 0, w, h);
      const stream = canvas.captureStream(30);
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9" : "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
      rec.onerror = (e) => reject(e.error || new Error("绿幕生成失败"));
      rec.start(100);
      setTimeout(() => rec.stop(), Math.max(500, duration * 1000));
    });
  }

  _renderClipsStrip() {
    const strip = this.el.clipsStrip;
    strip.innerHTML = "";
    this.clips.forEach((clip, i) => {
      const div = document.createElement("div");
      div.className = "clip-thumb";
      const video = document.createElement("video");
      video.src = URL.createObjectURL(clip.rawBlob);
      video.muted = true;
      div.appendChild(video);
      const num = document.createElement("div");
      num.className = "clip-num";
      num.textContent = i + 1;
      div.appendChild(num);
      const del = document.createElement("button");
      del.className = "clip-del";
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.clips.splice(i, 1);
        this._renderClipsStrip();
        this.el.editBtn.classList.toggle("hidden", this.clips.length === 0);
      });
      div.appendChild(del);
      strip.appendChild(div);
    });
  }

  _setupBgMusic() {
    const select = this.el.bgMusicSelect;
    BG_MUSIC_LIST.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => this._selectBgMusic(select.value));
  }

  _selectBgMusic(id) {
    if (!id) {
      this.recorder?.setBgAudio(null);
      return;
    }
    if (!this.bgAudioEls[id]) {
      const audio = new Audio(id);
      audio.loop = true;
      audio.preload = "auto";
      this.bgAudioEls[id] = audio;
    }
    this.recorder?.setBgAudio(this.bgAudioEls[id]);
  }

  _enterEditor() {
    if (this.clips.length === 0) return;
    this.recorder.stop();
    this.el.recordView.classList.add("hidden");
    this.el.editorView.classList.remove("hidden");
    if (!this.editor) {
      this.editor = new Editor({
      clips: this.clips,
      el: {
        timelineTrack: this.el.timelineTrack,
        backBtn: this.el.backBtn,
        previewCanvas: this.el.previewCanvas,
        rawVideo: this.el.previewRawVideo,
        greenVideo: this.el.previewGreenVideo,
        segmentList: this.el.segmentList,
        addSegmentBtn: this.el.addSegmentBtn,
        segmentEdit: this.el.segmentEdit,
        effectGrid: this.el.effectGrid,
        segmentMode: this.el.segmentMode,
        modeToggle: this.el.modeToggle,
        segmentTime: this.el.segmentTime,
        segStart: this.el.segStart,
        segEnd: this.el.segEnd,
        delSegmentBtn: this.el.delSegmentBtn,
        playPauseBtn: this.el.playPauseBtn,
        playbackBar: this.el.playbackBar,
        playbackFill: this.el.playbackFill,
        playbackTime: this.el.playbackTime,
        playbackDuration: this.el.playbackDuration,
        segmentTrackBar: this.el.segmentTrackBar,
        rhApiKey: this.el.rhApiKey,
        restyleStyle: this.el.restyleStyle,
        restyleGenImage: this.el.restyleGenImage,
        restyleImgProgress: this.el.restyleImgProgress,
        restyleImgFill: this.el.restyleImgFill,
        restyleImgText: this.el.restyleImgText,
        restylePreview: this.el.restylePreview,
        restyleImgHistory: this.el.restyleImgHistory,
        restyleGenVideo: this.el.restyleGenVideo,
        restyleVidProgress: this.el.restyleVidProgress,
        restyleVidFill: this.el.restyleVidFill,
        restyleVidText: this.el.restyleVidText,
        restyleVideoPreview: this.el.restyleVideoPreview,
        restyleVidHistory: this.el.restyleVidHistory,
        restyleApply: this.el.restyleApply,
        lightbox: this.el.lightbox,
        lightboxContent: this.el.lightboxContent,
        exportClipBtn: this.el.exportClipBtn,
        exportMenu: this.el.exportMenu,
        exportOptions: this.el.exportOptions,
      },
      onBack: () => this._backToRecord(),
      });
    } else {
      // 复用编辑器实例：编辑状态（特效段/转绘结果）保留，返回后重进不丢失
      this.editor.show();
    }
  }

  _backToRecord() {
    this.el.editorView.classList.add("hidden");
    this.el.recordView.classList.remove("hidden");
    // 保留 editor 实例（事件监听与编辑状态），重新进入时复用
    this._start();
  }
}

window.app = new App();
