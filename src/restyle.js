// restyle.js — AI 转绘：通过 RunningHub API 两步完成视频风格转绘
// 步骤1: generateStyleImage — 提取关键帧 → 上传 → 生成风格化图片
// 步骤2: generateRestyleVideo — 风格化图片 + 原视频 → 上传 → 生成转绘视频
// 双模式：有 apiKey 走本地 RH 直连；无 apiKey 走平台 AI 接口（见 ai-api.js）

import { platformGenerateStyleImage, platformGenerateRestyleVideo } from "./ai-api.js";

// ---- 配置（本地直连模式） ----

const IMAGE_WORKFLOW_ID = "2090078594642046978";
let IMAGE_NODE_IMAGE = "";    // 图片输入节点（自动发现）
let IMAGE_NODE_STYLE = "";    // 风格输入节点（自动发现）

const VIDEO_WORKFLOW_ID = "2090439773851840514";
let VIDEO_NODE_IMAGE = "";   // 风格图片输入节点（自动发现）
let VIDEO_NODE_VIDEO = "";   // 原视频输入节点（自动发现）

// 风格列表
export const RESTYLE_STYLES = [
  { id: "1",  label: "3D Chibi（3D风格）" },
  { id: "2",  label: "American Cartoon（美国卡通）" },
  { id: "3",  label: "Chinese Ink（中国水墨）" },
  { id: "4",  label: "Clay Toy（粘土玩具）" },
  { id: "5",  label: "Fabric（面料）" },
  { id: "6",  label: "Ghibli（吉卜力）" },
  { id: "7",  label: "Irasutoya（日本剪贴画）" },
  { id: "8",  label: "Jojo（JOJO）" },
  { id: "9",  label: "LEGO（乐高）" },
  { id: "10", label: "Line（线条）" },
  { id: "11", label: "Macaron（马卡龙）" },
  { id: "12", label: "Oil Painting（油画）" },
  { id: "13", label: "Paper Cutting（剪纸）" },
  { id: "14", label: "Picasso（毕加索）" },
  { id: "15", label: "Pixel（像素）" },
  { id: "16", label: "Poly（多边形）" },
  { id: "17", label: "Pop Art（波普艺术）" },
  { id: "18", label: "Rick Morty（瑞克和莫蒂）" },
  { id: "19", label: "Snoopy（史努比）" },
  { id: "20", label: "Vector（矢量）" },
  { id: "21", label: "Van Gogh（梵高）" },
  { id: "22", label: "Origami（折纸）" },
];

// ---- 工具函数 ----

// 从 apiCallDemo 响应中解析节点 ID
async function discoverNodes(workflowId, apiKey) {
  const resp = await fetch("/api/rh/nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-RH-Key": apiKey },
    body: JSON.stringify({ workflowId }),
  });
  if (!resp.ok) throw new Error(`查询节点失败: ${resp.status}`);
  const result = await resp.json();
  console.log(`[restyle] apiCallDemo 响应:`, JSON.stringify(result).slice(0, 500));

  // 尝试多种方式解析 nodeInfoList
  let nodes = [];
  // 策略1: data.curl 字段里嵌着 --data-raw '...' JSON
  const curlStr = result?.data?.curl || "";
  const curlMatch = curlStr.match(/--data-raw\s+'(.+?)'\s*$/s) ||
                     curlStr.match(/--data-raw\s+"(.+?)"\s*$/s) ||
                     curlStr.match(/--data-raw\s+'(.+)'/s);
  if (curlMatch) {
    try {
      const payload = JSON.parse(curlMatch[1]);
      nodes = payload.nodeInfoList || [];
    } catch (e) { console.warn("[restyle] curl JSON 解析失败:", e.message); }
  }
  // 策略2: data.nodeInfoList 直接是数组
  if (!nodes.length && result?.data?.nodeInfoList) {
    nodes = result.data.nodeInfoList;
  }
  // 策略3: 在整个响应文本中搜索 nodeInfoList
  if (!nodes.length) {
    const fullStr = JSON.stringify(result);
    const idx = fullStr.indexOf("nodeInfoList");
    if (idx !== -1) {
      // 尝试从该位置开始解析 JSON 数组
      const arrStart = fullStr.indexOf("[", idx);
      if (arrStart !== -1) {
        let depth = 0, end = arrStart;
        for (let i = arrStart; i < fullStr.length; i++) {
          if (fullStr[i] === "[") depth++;
          if (fullStr[i] === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        try { nodes = JSON.parse(fullStr.slice(arrStart, end)); } catch (e) {}
      }
    }
  }
  if (!nodes.length) throw new Error("无法从 apiCallDemo 解析节点信息");

  const found = {};
  for (const n of nodes) {
    if (!n) continue;
    if (n.fieldName === "image") found.image = n.nodeId;
    if (n.fieldName === "value") found.style = n.nodeId;
    if (n.fieldName === "video") found.video = n.nodeId;
  }
  console.log(`[restyle] 发现节点 (${workflowId}):`, found);
  return found;
}

// 从视频中提取关键帧
// framePosition: "current" 使用 videoEl 当前帧, "middle" 使用视频中间帧
async function extractFrame(videoBlob, frameTime = 0, videoEl = null) {
  let video;
  let shouldCleanup = false;
  if (videoEl) {
    video = videoEl;
  } else {
    video = document.createElement("video");
    video.muted = true;
    video.src = URL.createObjectURL(videoBlob);
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
    });
    shouldCleanup = true;
  }
  const seekTo = Math.min(frameTime, video.duration || 0);
  await new Promise((resolve) => {
    video.currentTime = seekTo;
    video.onseeked = resolve;
  });
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);
  if (shouldCleanup) URL.revokeObjectURL(video.src);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

async function uploadToRH(blob, apiKey, filename = "frame.png", segStart = null, segEnd = null, onProgress = null) {
  const formData = new FormData();
  formData.append("file", blob, filename);
  let url = "/api/rh/upload";
  if (segStart !== null && segEnd !== null) {
    url += `?start=${segStart}&end=${segEnd}`;
  }
  // 使用 XMLHttpRequest 以获取上传进度
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("X-RH-Key", apiKey);
    xhr.timeout = 180000; // 3分钟超时
    if (onProgress && blob.size > 100000) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.code !== 0 && data.data?.download_url === undefined) {
            reject(new Error(`上传失败: ${data.message || JSON.stringify(data)}`));
          } else {
            resolve(data.data?.download_url || data.data?.fileName);
          }
        } catch (e) {
          reject(new Error(`上传失败: 解析响应失败`));
        }
      } else {
        try {
          const e = JSON.parse(xhr.responseText);
          reject(new Error(`上传失败: ${e.error || xhr.status}`));
        } catch {
          reject(new Error(`上传失败: ${xhr.status}`));
        }
      }
    };
    xhr.onerror = () => reject(new Error("上传失败: 网络错误"));
    xhr.ontimeout = () => reject(new Error("上传失败: 超时"));
    xhr.send(formData);
  });
}

async function runWorkflow(workflowId, nodeInfoList, apiKey) {
  const resp = await fetch("/api/rh/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-RH-Key": apiKey },
    body: JSON.stringify({ workflowId, nodeInfoList }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(`提交任务失败: ${e.error || resp.status}`);
  }
  const data = await resp.json();
  if (!data.taskId) {
    throw new Error(`提交任务失败: ${data.errorMessage || JSON.stringify(data)}`);
  }
  return data.taskId;
}

async function pollTask(taskId, apiKey, onProgress, progressBase, progressRange) {
  const interval = 3000;
  const maxAttempts = 400; // 400 × 3s = 20 分钟超时
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch("/api/rh/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-RH-Key": apiKey },
      body: JSON.stringify({ taskId }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(`查询失败: ${e.error || resp.status}`);
    }
    const data = await resp.json();
    if (data.status === "SUCCESS") return data.results || [];
    if (data.status === "FAILED") {
      throw new Error(`任务失败: ${data.errorMessage || "未知错误"}`);
    }
    const p = progressBase + Math.floor((i / maxAttempts) * progressRange);
    onProgress?.(p);
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("任务超时");
}

async function downloadResult(url) {
  const resp = await fetch(`/api/rh/download?url=${encodeURIComponent(url)}`);
  if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
  return await resp.blob();
}

// ---- 步骤1: 生成风格图片 ----

/**
 * @param {Blob} rawBlob - 原始视频
 * @param {string} apiKey - RunningHub API Key；留空则走平台模式（ai-api.js，服务端鉴权）
 * @param {string} styleId - 风格编号 (1-22)
 * @param {number} frameTime - 提取关键帧的时间点（秒），通常为选中特效段的首帧
 * @param {HTMLVideoElement} videoEl - 当前播放的视频元素
 * @param {(text: string, progress: number) => void} onProgress
 * @returns {Promise<{styleImageUrl: string, styleImageBlob: Blob}>}
 */
export async function generateStyleImage(rawBlob, apiKey, styleId, frameTime, videoEl, onProgress) {
  const p = (text, val) => onProgress?.(text, val);

  p("提取关键帧...", 5);
  const frameBlob = await extractFrame(rawBlob, frameTime, videoEl);

  // 平台模式：无 Key，走平台 AI 接口（鉴权在服务端）
  if (!apiKey) {
    return platformGenerateStyleImage(frameBlob, styleId, onProgress);
  }

  // 本地模式：直连 RH OpenAPI（serve.py 代理）
  // 自动发现图片工作流节点 ID
  if (!IMAGE_NODE_IMAGE || !IMAGE_NODE_STYLE) {
    p("查询工作流节点...", 6);
    const found = await discoverNodes(IMAGE_WORKFLOW_ID, apiKey);
    IMAGE_NODE_IMAGE = found.image || "";
    IMAGE_NODE_STYLE = found.style || "";
    if (!IMAGE_NODE_IMAGE || !IMAGE_NODE_STYLE) {
      throw new Error("无法自动发现图片工作流节点 ID");
    }
  }

  p("上传关键帧...", 10);
  const frameUrl = await uploadToRH(frameBlob, apiKey, "frame.png");

  p("提交图片风格化任务...", 15);
  const taskId = await runWorkflow(IMAGE_WORKFLOW_ID, [
    { nodeId: IMAGE_NODE_IMAGE, fieldName: "image", fieldValue: frameUrl, description: "image" },
    { nodeId: IMAGE_NODE_STYLE, fieldName: "value", fieldValue: styleId, description: "value" },
  ], apiKey);

  p("生成风格图片中...", 20);
  const results = await pollTask(taskId, apiKey, (val) => p("生成风格图片中...", val), 20, 75);
  if (!results.length) throw new Error("未获得风格图片结果");

  const imageResult = results.find((r) =>
    r.outputType === "png" || r.outputType === "jpg" || r.outputType === "jpeg"
  ) || results[0];

  p("下载风格图片...", 95);
  const styleImageBlob = await downloadResult(imageResult.url);
  p("完成", 100);

  return { styleImageUrl: imageResult.url, styleImageBlob };
}

// ---- 步骤2: 生成转绘视频 ----

/**
 * @param {Blob} styleImageBlob - 风格图片 Blob（步骤1已生成）
 * @param {Blob} rawBlob - 原始视频
 * @param {string} apiKey - RunningHub API Key；留空则走平台模式（ai-api.js，服务端鉴权）
 * @param {number} segStart - 特效段起始时间（秒）
 * @param {number} segEnd - 特效段结束时间（秒）
 * @param {(text: string, progress: number) => void} onProgress
 * @returns {Promise<Blob>} 转绘视频 Blob
 */
export async function generateRestyleVideo(styleImageBlob, rawBlob, apiKey, segStart, segEnd, onProgress) {
  const p = (text, val) => onProgress?.(text, val);

  // 平台模式：无 Key，走平台 AI 接口（鉴权在服务端）
  if (!apiKey) {
    return platformGenerateRestyleVideo(styleImageBlob, rawBlob, segStart, segEnd, onProgress);
  }

  // 本地模式：直连 RH OpenAPI（serve.py 代理）
  if (!VIDEO_WORKFLOW_ID) {
    throw new Error("视频转绘工作流未配置");
  }

  // 自动发现视频工作流节点 ID
  if (!VIDEO_NODE_IMAGE || !VIDEO_NODE_VIDEO) {
    p("查询视频工作流节点...", 2);
    const found = await discoverNodes(VIDEO_WORKFLOW_ID, apiKey);
    VIDEO_NODE_IMAGE = found.image || "";
    VIDEO_NODE_VIDEO = found.video || "";
    if (!VIDEO_NODE_IMAGE || !VIDEO_NODE_VIDEO) {
      throw new Error("无法自动发现视频工作流节点 ID");
    }
  }

  // 上传风格图片（直接用内存中的 Blob，无需下载）
  p("上传风格图片...", 5);
  const styleImageField = await uploadToRH(styleImageBlob, apiKey, "style.png");

  p("上传特效段视频...", 15);
  const videoUrl = await uploadToRH(rawBlob, apiKey, "input.webm", segStart, segEnd, (pct) => {
    // 上传进度映射到 15%-19% 区间
    p("上传特效段视频...", 15 + Math.floor(pct * 0.04));
  });

  p("提交视频转绘任务...", 20);
  const taskId = await runWorkflow(VIDEO_WORKFLOW_ID, [
    { nodeId: VIDEO_NODE_IMAGE, fieldName: "image", fieldValue: styleImageField, description: "image" },
    { nodeId: VIDEO_NODE_VIDEO, fieldName: "video", fieldValue: videoUrl, description: "video" },
  ], apiKey);

  p("生成转绘视频中...", 25);
  const results = await pollTask(taskId, apiKey, (val) => p("生成转绘视频中...", val), 25, 70);
  if (!results.length) throw new Error("未获得转绘视频结果");

  const videoResult = results.find((r) =>
    r.outputType === "mp4" || r.outputType === "webm"
  ) || results[0];

  p("下载转绘视频...", 95);
  const videoBlob = await downloadResult(videoResult.url);
  p("完成", 100);

  return videoBlob;
}
