# 指尖转场（Finger Frame Effects）

手势取景框视频特效工具：伸出双手拇指+食指构成“取景框”，摄像头实时识别手势，手指框住的区域自动生成特效遮罩；一开一合时取景框退化为三角形（转场中间形态），支持四边形↔三角形↔消失连续变形；录制后在编辑器里为手势出现的时间段叠加滤镜特效或 AI 风格转绘，导出成片。

## 功能

- **录制**：MediaPipe 手部关键点实时检测（双手构成取景框），同时录制原片与绿幕遮罩双流；也支持上传已有视频做手势检测
- **编辑**：自动扫描手势出现区间生成特效段，支持 10 种滤镜（像素化/模糊/反色/黑白/故障/卡通/梵高等）、正反模式（框内/框外）、时间轴拖拽调整
- **AI 转绘**：两步工作流（风格图生成 → 风格视频生成），RunningHub 应用
- **导出**：特效合成视频 / 带绿幕视频 / AI 转绘视频

## 页面（单一 SPA，两个视图切换）

- 录制页（`#record-view`）：摄像头预览 + 手势检测虚线框 + 录制/上传 + 片段管理
- 编辑器页（`#editor-view`）：时间轴 + 特效段列表 + AI 转绘面板 + 预览播放器 + 导出

## 数据结构

无服务端持久化、无数据库依赖，所有视频数据（Blob）在浏览器内存中处理。如后续需要保存历史，可使用平台内置 PocketBase（当前未使用，无需建表）。

## AI 能力（待平台接入）

两步工作流均为 RunningHub 上的 AI 应用：

| 步骤 | 能力 | webappId |
|---|---|---|
| 步骤 1 | 图生图（关键帧 → 风格图，22 种风格） | `2090078594642046978` |
| 步骤 2 | 图生视频（风格图 + 原视频 → 转绘视频） | `2090439773851840514` |

前端已按「提交生成（run）+ 轮询结果（poll）」双接口契约预留适配层：**`src/ai-api.js`**。平台接入后仅需按实际契约修改该文件中的 URL 与请求/响应字段（文件内有 `★ 平台接入 TODO` 标注）。

双模式说明：AI 转绘面板中填写 RunningHub API Key 时走本地 `serve.py` 代理直连（本地开发用）；不填时调用平台接口（服务端鉴权，前端不持有密钥）。

## 运行

```bash
npm install
npm run dev        # Vite dev server，监听 8000 端口（平台部署方式）
npm run build      # 构建产物输出到 dist/
npm run preview    # 本地预览构建产物（8000 端口）
```

本地开发可选：`python3 serve.py` → http://localhost:8123（提供 WebM→MP4 转码与 RH API 代理，**仅本地辅助使用，平台部署不依赖**；无转码服务时导出自动回退 WebM 格式）。

## 外部依赖

- **MediaPipe Hand Landmarker**：`public/vendor/hand_landmarker.task`（约 7.5MB，随仓库分发，无需 CDN）
- **RunningHub AI 应用**：图生图 + 图生视频工作流（见上表）
- **浏览器 API**：getUserMedia（摄像头，需 HTTPS 或 localhost）、MediaRecorder、WebAssembly

## 目录结构

```
index.html          # SPA 入口
src/                # 前端源码（原生 ES modules，零框架）
  app.js            #   主应用：视图切换 + 状态管理
  recorder.js       #   录制：摄像头 + MediaPipe 手势检测 + 双流录制
  editor.js         #   编辑器：时间轴 + 特效段 + 转绘流程 + 导出
  compositor.js     #   特效合成：遮罩提取 + 虚线框 + 滤镜应用
  effects.js        #   滤镜渲染引擎（Canvas 2D）
  restyle.js        #   AI 转绘（本地直连模式）
  ai-api.js         #   AI 接口适配层（平台模式，待平台接入）
  style.css
public/
  vendor/           # MediaPipe 模型与 wasm（约 26MB）
  assets/           # 背景音乐
serve.py            # 本地开发辅助服务器（平台部署不使用）
```
