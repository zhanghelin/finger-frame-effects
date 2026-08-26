// ai-api.js — AI 生成接口适配层（平台模式）
// ─────────────────────────────────────────────────────────────────
// 双模式说明（与 restyle.js 配合）：
//   1. 平台模式（默认）：用户未填写 RunningHub API Key 时，
//      调用平台提供的两个相对路径接口「提交生成 run + 轮询结果 poll」，
//      鉴权由平台服务端处理（继承 RunningHub 主站登录态），前端不持有任何密钥。
//   2. 本地开发模式：填写 API Key 后走本地 serve.py 代理直连 RH OpenAPI
//      （实现见 restyle.js，与本文件无关）。
//
// ★★ 平台接入 TODO（平台提供接口契约后仅需修改本文件）：
//   1. PLATFORM_AI_URLS 填入实际路径；
//   2. submitTask 的请求字段（kind / image / video / styleId / segStart / segEnd）
//      按平台文档调整编码方式（当前用 FormData 传文件 + 文本字段）；
//   3. pollTaskToDone 的响应字段（status / progress / resultUrl）按平台文档对齐。
// ─────────────────────────────────────────────────────────────────

export const PLATFORM_AI_URLS = {
  run: "/api/ai/run",   // 提交生成任务（占位，待平台提供）
  poll: "/api/ai/poll", // 轮询任务结果（占位，待平台提供）
};

// 提交生成任务，返回 { taskId }
async function submitTask(kind, files, fields) {
  const fd = new FormData();
  fd.append("kind", kind);
  if (files.image) fd.append("image", files.image, "image.png");
  if (files.video) fd.append("video", files.video, "video.webm");
  for (const [k, v] of Object.entries(fields || {})) {
    if (v !== undefined && v !== null) fd.append(k, String(v));
  }
  const resp = await fetch(PLATFORM_AI_URLS.run, { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`AI 服务不可用 (HTTP ${resp.status})，请确认已部署到平台环境`);
  const data = await resp.json().catch(() => null);
  if (!data?.taskId) throw new Error("AI 服务返回异常：缺少 taskId");
  return data;
}

// 轮询任务直至完成，返回结果文件 URL
// onProgress(text, pct)：进度映射到 [base, base+range] 区间
async function pollTaskToDone(taskId, onProgress, base, range) {
  const p = (t, v) => onProgress?.(t, v);
  const POLL_INTERVAL = 3000;
  const TIMEOUT = 20 * 60 * 1000; // 20 分钟超时（长视频生成耗时较长）
  const start = performance.now();
  for (;;) {
    if (performance.now() - start > TIMEOUT) throw new Error("AI 生成超时（20 分钟）");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const resp = await fetch(`${PLATFORM_AI_URLS.poll}?taskId=${encodeURIComponent(taskId)}`);
    if (!resp.ok) throw new Error(`AI 轮询失败 (HTTP ${resp.status})`);
    const data = await resp.json().catch(() => null);
    if (!data) throw new Error("AI 轮询返回异常");
    if (data.status === "failed") throw new Error(data.error || "AI 生成失败");
    const pct = base + Math.floor((data.progress || 0) / 100 * range);
    p("生成中...", pct);
    if (data.status === "success" || data.status === "succeeded") {
      if (!data.resultUrl) throw new Error("AI 生成完成但未返回结果地址");
      return data.resultUrl;
    }
  }
}

async function fetchBlob(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载结果失败: HTTP ${resp.status}`);
  return resp.blob();
}

// 平台模式 · 步骤1：生成风格图片（图生图）
// @returns {Promise<{styleImageUrl: string, styleImageBlob: Blob}>}
export async function platformGenerateStyleImage(frameBlob, styleId, onProgress) {
  const p = (t, v) => onProgress?.(t, v);
  p("提交生成任务...", 10);
  const { taskId } = await submitTask("style-image", { image: frameBlob }, { styleId });
  const resultUrl = await pollTaskToDone(taskId, onProgress, 20, 70);
  p("下载结果...", 90);
  const styleImageBlob = await fetchBlob(resultUrl);
  p("完成", 100);
  return { styleImageUrl: resultUrl, styleImageBlob };
}

// 平台模式 · 步骤2：生成转绘视频（图生视频）
// @returns {Promise<Blob>} 转绘视频 Blob
export async function platformGenerateRestyleVideo(styleImageBlob, rawBlob, segStart, segEnd, onProgress) {
  const p = (t, v) => onProgress?.(t, v);
  p("提交生成任务...", 10);
  const { taskId } = await submitTask(
    "restyle-video",
    { image: styleImageBlob, video: rawBlob },
    { segStart, segEnd }
  );
  const resultUrl = await pollTaskToDone(taskId, onProgress, 20, 70);
  p("下载结果...", 90);
  const videoBlob = await fetchBlob(resultUrl);
  p("完成", 100);
  return videoBlob;
}
