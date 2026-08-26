#!/usr/bin/env python3
"""开发服务器：静态文件 + webm→mp4 转码 + RunningHub API 代理。"""
import http.server
import socketserver
import os
import json
import subprocess
import tempfile
import shutil
import urllib.request
import urllib.error
import uuid
import time
import ssl

PORT = 8123
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
FFMPEG = shutil.which("ffmpeg") or ""

if not FFMPEG:
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        FFMPEG = get_ffmpeg_exe()
    except Exception:
        FFMPEG = "ffmpeg"

# 检测可用的硬件编码器
def _detect_hw_encoder():
    try:
        r = subprocess.run(
            [FFMPEG, "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL,
        )
        if "h264_videotoolbox" in r.stdout:
            return "h264_videotoolbox"
    except Exception:
        pass
    return None

HW_ENCODER = _detect_hw_encoder()

RH_BASE = "https://www.runninghub.cn/openapi/v2"
# 服务端预设 API Key（可为空，由前端运行时传入）
RH_API_KEY = os.environ.get("RH_API_KEY", "")
# macOS Python 默认不信任系统证书，跳过 SSL 验证（本地开发环境）
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/convert":
            self._handle_convert()
        elif path == "/fix-meta":
            self._handle_fix_meta()
        elif path == "/api/rh/upload":
            self._rh_upload()
        elif path == "/api/rh/run":
            self._rh_run()
        elif path == "/api/rh/query":
            self._rh_query()
        elif path == "/api/rh/nodes":
            self._rh_nodes()
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path.startswith("/api/rh/download?"):
            self._rh_download()
            return
        # Vite 目录结构兼容：静态资源在根目录找不到时回退到 public/ 前缀
        # （vendor/wasm、vendor/*.task、assets/ 等运行时 fetch 的资源已移入 public/）
        rel = self.path.split("?", 1)[0].lstrip("/")
        if rel and not os.path.exists(os.path.join(DIRECTORY, rel)):
            if os.path.exists(os.path.join(DIRECTORY, "public", rel)):
                self.path = "/public" + self.path
        super().do_GET()

    # ---- RunningHub API 代理 ----

    def _rh_key(self):
        """获取 API Key：优先请求头，其次环境变量"""
        return self.headers.get("X-RH-Key", "") or RH_API_KEY

    def _rh_api(self, path, payload, key):
        """调用 RH JSON API"""
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{RH_BASE}/{path}",
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120, context=SSL_CTX) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace")
            return {"error": f"RH API {e.code}", "detail": err}
        except Exception as e:
            return {"error": str(e)}

    def _rh_upload(self):
        key = self._rh_key()
        if not key:
            self._send_json(400, {"error": "缺少 API Key"})
            return
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            self._send_json(400, {"error": "需要 multipart/form-data"})
            return
        # 解析 multipart
        boundary = ctype.split("boundary=")[1].strip()
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        parts = body.split(f"--{boundary}".encode())
        file_data = None
        filename = "upload.bin"
        for part in parts:
            if b"filename=" not in part:
                continue
            header_end = part.find(b"\r\n\r\n")
            if header_end < 0:
                continue
            header = part[:header_end].decode("utf-8", errors="replace")
            file_data = part[header_end + 4:]
            if file_data.endswith(b"\r\n"):
                file_data = file_data[:-2]
            for line in header.split("\r\n"):
                if "filename=" in line:
                    fn = line.split('filename="')[1].split('"')[0] if 'filename="' in line else "upload.bin"
                    filename = fn or "upload.bin"
            break
        if not file_data:
            self._send_json(400, {"error": "未找到文件"})
            return
        # 如果是视频文件，裁剪片段 + 添加静音音轨
        if filename.lower().endswith((".webm", ".mp4")):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            seg_start = qs.get("start", [None])[0]
            seg_end = qs.get("end", [None])[0]
            print(f"[upload] 收到视频: {filename}, size={len(file_data)}, start={seg_start}, end={seg_end}", flush=True)
            if seg_start is not None and seg_end is not None:
                file_data = self._cut_and_add_audio(file_data, filename, float(seg_start), float(seg_end))
            else:
                file_data = self._add_silent_audio(file_data, filename)
            print(f"[upload] 处理后 size={len(file_data)}, 开始上传到RH...", flush=True)
            # 视频已转为 MP4，更新文件名
            if filename.lower().endswith(".webm"):
                filename = filename[:-5] + ".mp4"
        # 转发到 RH
        boundary_rh = f"----WebKitFormBoundary{uuid.uuid4().hex[:16]}"
        body_rh = (
            f"--{boundary_rh}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + file_data + f"\r\n--{boundary_rh}--\r\n".encode()
        req = urllib.request.Request(
            f"{RH_BASE}/media/upload/binary",
            data=body_rh,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": f"multipart/form-data; boundary={boundary_rh}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120, context=SSL_CTX) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                print(f"[upload] RH响应: {json.dumps(result, ensure_ascii=False)[:200]}", flush=True)
                self._send_json(200, result)
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace")
            print(f"[upload] RH上传失败: {e.code} {err[:200]}", flush=True)
            self._send_json(e.code, {"error": f"RH upload {e.code}", "detail": err})
        except Exception as e:
            print(f"[upload] 异常: {e}", flush=True)
            self._send_json(500, {"error": str(e)})

    def _rh_run(self):
        key = self._rh_key()
        if not key:
            self._send_json(400, {"error": "缺少 API Key"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except Exception:
            self._send_json(400, {"error": "无效的 JSON"})
            return
        workflow_id = payload.get("workflowId", "")
        node_info = payload.get("nodeInfoList", [])
        if not workflow_id:
            self._send_json(400, {"error": "缺少 workflowId"})
            return
        result = self._rh_api(
            f"run/ai-app/{workflow_id}",
            {"nodeInfoList": node_info, "instanceType": "default"},
            key,
        )
        print(f"[RH run] 响应: {json.dumps(result, ensure_ascii=False)[:500]}", flush=True)
        # 兼容 RH OpenAPI v2 嵌套格式: {"code":0, "data":{"taskId":"xxx"}}
        if not result.get("taskId") and isinstance(result.get("data"), dict):
            if result["data"].get("taskId"):
                result["taskId"] = result["data"]["taskId"]
        self._send_json(200, result)

    def _rh_query(self):
        key = self._rh_key()
        if not key:
            self._send_json(400, {"error": "缺少 API Key"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except Exception:
            self._send_json(400, {"error": "无效的 JSON"})
            return
        task_id = payload.get("taskId", "")
        if not task_id:
            self._send_json(400, {"error": "缺少 taskId"})
            return
        result = self._rh_api("query", {"taskId": task_id}, key)
        print(f"[RH query] 响应: {json.dumps(result, ensure_ascii=False)[:500]}", flush=True)
        # 兼容 RH OpenAPI v2 嵌套格式: {"code":0, "data":{"taskStatus":"SUCCESS", "outputs":[...]}}
        if not result.get("status") and isinstance(result.get("data"), dict):
            d = result["data"]
            if d.get("taskStatus"):
                result["status"] = d["taskStatus"]
            if d.get("outputs") and not result.get("results"):
                result["results"] = d["outputs"]
            if d.get("errorMessage") and not result.get("errorMessage"):
                result["errorMessage"] = d["errorMessage"]
        self._send_json(200, result)

    def _rh_nodes(self):
        """获取工作流的节点信息列表"""
        key = self._rh_key()
        if not key:
            self._send_json(400, {"error": "缺少 API Key"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except Exception:
            self._send_json(400, {"error": "无效的 JSON"})
            return
        workflow_id = payload.get("workflowId", "")
        if not workflow_id:
            self._send_json(400, {"error": "缺少 workflowId"})
            return
        # AI 应用专用 API: GET /api/webapp/apiCallDemo
        req = urllib.request.Request(
            f"https://www.runninghub.cn/api/webapp/apiCallDemo?apiKey={urllib.parse.quote(key)}&webappId={urllib.parse.quote(workflow_id)}",
            headers={},
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                print(f"[RH nodes] 响应: {json.dumps(result, ensure_ascii=False)[:1000]}", flush=True)
                self._send_json(200, result)
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace")
            self._send_json(e.code, {"error": f"RH API {e.code}", "detail": err})
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _ffprobe_info(self, file_path, label=""):
        """用 ffprobe 检查视频元数据，用于调试"""
        import subprocess
        try:
            cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file_path]
            result = subprocess.run(cmd, capture_output=True, timeout=10, stdin=subprocess.DEVNULL)
            if result.returncode == 0:
                import json
                info = json.loads(result.stdout.decode("utf-8", errors="replace"))
                fmt = info.get("format", {})
                duration = fmt.get("duration", "?")
                streams = info.get("streams", [])
                parts = []
                for s in streams:
                    ct = s.get("codec_type", "?")
                    codec = s.get("codec_name", "?")
                    dur = s.get("duration", "?")
                    start = s.get("start_time", "?")
                    nbf = s.get("nb_frames", "?")
                    w = s.get("width", "")
                    h = s.get("height", "")
                    fps = s.get("r_frame_rate", "?")
                    wh = f" {w}x{h}" if w else ""
                    parts.append(f"{ct}({codec}{wh},dur={dur},start={start},nb_frames={nbf},fps={fps})")
                print(f"[ffprobe] {label}: format_duration={duration}s, streams=[{', '.join(parts)}]", flush=True)
            else:
                print(f"[ffprobe] {label}: ffprobe failed (rc={result.returncode})", flush=True)
        except Exception as e:
            print(f"[ffprobe] {label}: error: {e}", flush=True)

    def _add_silent_audio(self, file_data, filename):
        """用 ffmpeg 给视频添加静音音轨，避免 VHS_LoadVideo 报错
        统一输出 MP4 格式，因为 MP4 容器有完整的流级时长和帧数元数据。"""
        import tempfile, subprocess, os
        ext = os.path.splitext(filename)[1]
        with tempfile.TemporaryDirectory() as td:
            in_path = os.path.join(td, f"input{ext}")
            out_path = os.path.join(td, "output.mp4")
            with open(in_path, "wb") as f:
                f.write(file_data)
            cmd = [
                "ffmpeg", "-y", "-nostdin", "-i", in_path,
                "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                "-vf", "fps=30",
                "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                "-pix_fmt", "yuv420p", "-r", "30",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                "-shortest", out_path,
            ]
            try:
                subprocess.run(cmd, capture_output=True, timeout=60, check=True, stdin=subprocess.DEVNULL)
                self._ffprobe_info(out_path, "add_silent_audio 输出")
                with open(out_path, "rb") as f:
                    print(f"[upload] 已添加静音音轨(MP4): {filename}", flush=True)
                    return f.read()
            except subprocess.CalledProcessError as e:
                print(f"[upload] ffmpeg 添加音轨失败，使用原文件: {e.stderr.decode(errors='replace')[:200]}", flush=True)
                return file_data
            except Exception as e:
                print(f"[upload] ffmpeg 异常，使用原文件: {e}", flush=True)
                return file_data

    def _cut_and_add_audio(self, file_data, filename, start, end):
        """用 ffmpeg 裁剪视频片段并添加静音音轨
        统一输出 MP4 格式，因为 MP4 容器有完整的流级时长和帧数元数据。"""
        import tempfile, subprocess, os
        ext = os.path.splitext(filename)[1]
        duration = max(0, end - start)
        with tempfile.TemporaryDirectory() as td:
            in_path = os.path.join(td, f"input{ext}")
            out_path = os.path.join(td, "output.mp4")
            with open(in_path, "wb") as f:
                f.write(file_data)
            cmd = [
                "ffmpeg", "-y", "-nostdin",
                "-ss", f"{start}", "-i", in_path,
                "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                "-t", f"{duration}",
                "-vf", "fps=30",
                "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                "-pix_fmt", "yuv420p", "-r", "30",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                "-shortest", out_path,
            ]
            try:
                subprocess.run(cmd, capture_output=True, timeout=60, check=True, stdin=subprocess.DEVNULL)
                self._ffprobe_info(out_path, "cut_and_add_audio 输出")
                with open(out_path, "rb") as f:
                    result = f.read()
                    print(f"[upload] 已裁剪片段({start:.2f}-{end:.2f}s, 时长{duration:.2f}s)并添加音轨(MP4): {len(result)} bytes", flush=True)
                    return result
            except subprocess.CalledProcessError as e:
                print(f"[upload] ffmpeg 裁剪失败，尝试只添加音轨: {e.stderr.decode(errors='replace')[:200]}", flush=True)
                return self._add_silent_audio(file_data, filename)
            except Exception as e:
                print(f"[upload] ffmpeg 异常，尝试只添加音轨: {e}", flush=True)
                return self._add_silent_audio(file_data, filename)

    def _rh_download(self):
        # 从 query string 提取 url
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        url = qs.get("url", [""])[0]
        if not url:
            self._send_json(400, {"error": "缺少 url 参数"})
            return
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=120, context=SSL_CTX) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
            # ffprobe 检查下载结果
            import tempfile, os
            with tempfile.TemporaryDirectory() as td:
                dl_path = os.path.join(td, "downloaded" + os.path.splitext(url)[1])
                with open(dl_path, "wb") as f:
                    f.write(data)
                self._ffprobe_info(dl_path, "RH 下载结果")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _handle_convert(self):
        length = int(self.headers.get("Content-Length", 0))
        fmt = self.headers.get("X-Format", "mp4")
        if length == 0:
            self._send_json(400, {"error": "Empty body"})
            return

        body = self.rfile.read(length)
        ext_in = ".webm"
        ext_out = ".mp4" if fmt == "mp4" else ".webm"

        tmpdir = tempfile.mkdtemp()
        in_path = os.path.join(tmpdir, f"input{ext_in}")
        out_path = os.path.join(tmpdir, f"output{ext_out}")

        try:
            with open(in_path, "wb") as f:
                f.write(body)

            if fmt == "mp4":
                # 优先硬件编码（VideoToolbox），失败则回退软件编码
                cmds = []
                if HW_ENCODER == "h264_videotoolbox":
                    cmds.append([
                        FFMPEG, "-y", "-i", in_path,
                        "-c:v", "h264_videotoolbox", "-q:v", "50",
                        "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "192k",
                        "-movflags", "+faststart",
                        out_path,
                    ])
                # 软件回退（最快 preset）
                cmds.append([
                    FFMPEG, "-y", "-i", in_path,
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                    out_path,
                ])

                result = None
                for cmd in cmds:
                    result = subprocess.run(cmd, capture_output=True, timeout=300, stdin=subprocess.DEVNULL)
                    if result.returncode == 0:
                        break
                if result is None or result.returncode != 0:
                    err = (result.stderr.decode("utf-8", errors="replace")[-2000:]
                           if result else "no command")
                    self._send_json(500, {"error": "FFmpeg failed", "detail": err})
                    return
            else:
                # webm: 直接拷贝流
                cmd = [FFMPEG, "-y", "-i", in_path, "-c", "copy", out_path]
                result = subprocess.run(cmd, capture_output=True, timeout=30, stdin=subprocess.DEVNULL)
                if result.returncode != 0:
                    err = result.stderr.decode("utf-8", errors="replace")[-2000:]
                    self._send_json(500, {"error": "FFmpeg failed", "detail": err})
                    return

            with open(out_path, "rb") as f:
                data = f.read()

            self.send_response(200)
            self.send_header("Content-Type", "video/mp4" if fmt == "mp4" else "video/webm")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        except Exception as e:
            self._send_json(500, {"error": str(e)})
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def _handle_fix_meta(self):
        """重新封装 WebM 以修复缺失的 duration 元数据（不重编码，极快）"""
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self._send_json(400, {"error": "Empty body"})
            return
        body = self.rfile.read(length)
        tmpdir = tempfile.mkdtemp()
        in_path = os.path.join(tmpdir, "input.webm")
        out_path = os.path.join(tmpdir, "output.webm")
        try:
            with open(in_path, "wb") as f:
                f.write(body)
            # -c copy 不重编码，-fflags +genpts 生成时间戳修复 duration
            cmd = [FFMPEG, "-y", "-i", in_path, "-c", "copy", "-fflags", "+genpts", out_path]
            result = subprocess.run(cmd, capture_output=True, timeout=30, stdin=subprocess.DEVNULL)
            if result.returncode != 0:
                # 如果 webm 修复失败，转 mp4（一定有 duration）
                out_path = os.path.join(tmpdir, "output.mp4")
                cmd = [FFMPEG, "-y", "-i", in_path, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", out_path]
                result = subprocess.run(cmd, capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
                if result.returncode != 0:
                    err = result.stderr.decode("utf-8", errors="replace")[-1000:]
                    self._send_json(500, {"error": "FFmpeg failed", "detail": err})
                    return
            with open(out_path, "rb") as f:
                data = f.read()
            ctype = "video/webm" if out_path.endswith(".webm") else "video/mp4"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._send_json(500, {"error": str(e)})
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class ThreadingTCPServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with ThreadingTCPServer(("", PORT), Handler) as httpd:
        print(f"Serving {DIRECTORY} at http://localhost:{PORT} (no-cache)")
        print(f"FFmpeg: {FFMPEG}")
        print(f"HW Encoder: {HW_ENCODER or 'none (using software)'}")
        httpd.serve_forever()
