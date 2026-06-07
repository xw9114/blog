#!/usr/bin/env python3
"""img2ref GUI — 拖入图片，自动生成 Hugo 速查卡片"""

import os
import sys
import base64
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from PIL import Image, ImageTk
import requests

BLOG_ROOT = os.path.dirname(os.path.abspath(__file__))
REF_DIR   = os.path.join(BLOG_ROOT, "content", "reference")

SYSTEM_PROMPT = """你是一个 Hugo 博客速查内容生成器。
将图片内容（代码、表格、列表等）转换为 Hugo shortcode 格式的 Markdown。

格式规则：
- 每个独立知识点用一个 ref-card，filename 属性填写简短中文标题
- 多个 ref-card 放在 ref-cols 内
- 代码块标注正确语言（cpp, python, java, javascript, bash 等）
- 注释保留并翻译成中文
- 多个主题用 ## 二级标题分组，每组一个 ref-cols

只输出 Markdown，不要任何额外说明。"""


def encode_image(path):
    with open(path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode()

def media_type(path):
    return {".jpg":"image/jpeg",".jpeg":"image/jpeg",
            ".png":"image/png",".webp":"image/webp",
            ".gif":"image/gif"}.get(os.path.splitext(path)[1].lower(), "image/png")

def list_ref_files():
    files = []
    for root, _, fnames in os.walk(REF_DIR):
        if "index.md" in fnames:
            path = os.path.join(root, "index.md")
            title = os.path.relpath(path, BLOG_ROOT)
            try:
                with open(path, encoding="utf-8") as fp:
                    for line in fp:
                        if line.startswith("title:"):
                            title = line.split(":", 1)[1].strip().strip('"')
                            break
            except Exception:
                pass
            files.append((title, path))
    return files

def call_claude(image_path, api_key, base_url):
    # 兼容用户填了 /v1 或没填的情况
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    resp = requests.post(
        f"{base}/v1/messages",
        headers={"x-api-key": api_key,
                 "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={
            "model": "claude-sonnet-4-6",
            "max_tokens": 4096,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {
                    "type": "base64",
                    "media_type": media_type(image_path),
                    "data": encode_image(image_path)}},
                {"type": "text", "text": "请将图片中的内容转换为速查卡片格式。"}
            ]}]
        },
        timeout=90,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"API 错误 {resp.status_code}: {resp.text}")
    return resp.json()["content"][0]["text"]


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("img2ref — 图片转速查卡片")
        self.geometry("920x680")
        self.configure(bg="#1e1e2e")
        self.resizable(True, True)

        self.image_path = tk.StringVar()
        self.api_key  = tk.StringVar(value=os.environ.get("ANTHROPIC_API_KEY", ""))
        self.base_url = tk.StringVar(value=os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com"))
        self.ref_files = list_ref_files()

        self._build()

    def _build(self):
        S = {"bg": "#1e1e2e", "fg": "#cdd6f4"}
        ES = {"bg": "#313244", "fg": "#cdd6f4", "insertbackground": "#cdd6f4",
              "relief": "flat", "bd": 0}
        BS = {"relief": "flat", "bd": 0, "cursor": "hand2", "padx": 12, "pady": 6}

        # ── 顶部 API 设置 ──────────────────────────────
        top = tk.Frame(self, bg="#181825", pady=8)
        top.pack(fill="x")

        tk.Label(top, text="API Key", **S, font=("Consolas", 9)).grid(
            row=0, column=0, padx=(16, 4), sticky="w")
        tk.Entry(top, textvariable=self.api_key, width=52, show="*",
                 font=("Consolas", 9), **ES).grid(
            row=0, column=1, padx=4, pady=4, ipady=4)

        tk.Label(top, text="Base URL", **S, font=("Consolas", 9)).grid(
            row=0, column=2, padx=(12, 4), sticky="w")
        tk.Entry(top, textvariable=self.base_url, width=30,
                 font=("Consolas", 9), **ES).grid(
            row=0, column=3, padx=(4, 16), pady=4, ipady=4)

        # ── 中部左右分栏 ───────────────────────────────
        mid = tk.Frame(self, bg="#1e1e2e")
        mid.pack(fill="both", expand=True, padx=16, pady=12)
        mid.columnconfigure(0, weight=1)
        mid.columnconfigure(1, weight=2)
        mid.rowconfigure(0, weight=1)

        # 左栏
        left = tk.Frame(mid, bg="#1e1e2e")
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 10))
        left.rowconfigure(1, weight=1)
        left.columnconfigure(0, weight=1)

        tk.Label(left, text="图片", **S, font=("微软雅黑", 10, "bold")).grid(
            row=0, column=0, sticky="w", pady=(0, 6))

        self.drop_zone = tk.Label(
            left, text="点击选择图片\n或截图后 Ctrl+V 粘贴",
            bg="#313244", fg="#6c7086",
            font=("微软雅黑", 11), relief="flat", cursor="hand2"
        )
        self.drop_zone.grid(row=1, column=0, sticky="nsew")
        self.drop_zone.bind("<Button-1>", self._pick_file)
        self.bind("<Control-v>", self._paste_image)
        self.bind("<Control-V>", self._paste_image)

        self.img_preview = tk.Label(left, bg="#313244")

        tk.Label(left, text="写入到", **S, font=("微软雅黑", 9)).grid(
            row=2, column=0, sticky="w", pady=(10, 4))

        ref_names = [t for t, _ in self.ref_files] + ["＋ 新建速查文件"]
        self.combo = ttk.Combobox(left, values=ref_names, state="readonly",
                                  font=("微软雅黑", 9))
        self.combo.grid(row=3, column=0, sticky="ew")
        if self.ref_files:
            self.combo.current(0)

        self.gen_btn = tk.Button(
            left, text="识别并生成 ▶",
            bg="#a6e3a1", fg="#1e1e2e", font=("微软雅黑", 10, "bold"),
            command=self._generate, **BS
        )
        self.gen_btn.grid(row=4, column=0, sticky="ew", pady=(12, 0))

        # 右栏
        right = tk.Frame(mid, bg="#1e1e2e")
        right.grid(row=0, column=1, sticky="nsew")
        right.rowconfigure(1, weight=1)
        right.columnconfigure(0, weight=1)

        tk.Label(right, text="生成内容（可编辑）", **S,
                 font=("微软雅黑", 10, "bold")).grid(
            row=0, column=0, sticky="w", pady=(0, 6))

        self.output = tk.Text(
            right, bg="#313244", fg="#cdd6f4",
            font=("Consolas", 10), relief="flat", bd=0,
            insertbackground="#cdd6f4", wrap="none", padx=12, pady=10
        )
        self.output.grid(row=1, column=0, sticky="nsew")

        sb_y = ttk.Scrollbar(right, orient="vertical",   command=self.output.yview)
        sb_x = ttk.Scrollbar(right, orient="horizontal", command=self.output.xview)
        self.output.configure(yscrollcommand=sb_y.set, xscrollcommand=sb_x.set)
        sb_y.grid(row=1, column=1, sticky="ns")
        sb_x.grid(row=2, column=0, sticky="ew")

        self.write_btn = tk.Button(
            right, text="写入文件 ✓",
            bg="#89b4fa", fg="#1e1e2e", font=("微软雅黑", 10, "bold"),
            command=self._write, state="disabled", **BS
        )
        self.write_btn.grid(row=3, column=0, sticky="ew", pady=(10, 0))

        # ── 状态栏 ────────────────────────────────────
        self.status = tk.Label(
            self, text="就绪 — 选择或拖入图片开始",
            bg="#181825", fg="#6c7086",
            font=("Consolas", 9), anchor="w", padx=12
        )
        self.status.pack(fill="x", side="bottom", pady=(4, 0))

    def _paste_image(self, _=None):
        try:
            from PIL import ImageGrab
            img = ImageGrab.grabclipboard()
            if img is None:
                self._set_status("剪贴板中没有图片，请先截图再 Ctrl+V")
                return
            import tempfile
            tmp = tempfile.mktemp(suffix=".png")
            img.save(tmp)
            self._load_image(tmp)
        except Exception as e:
            messagebox.showerror("粘贴失败", str(e))

    def _pick_file(self, _=None):
        path = filedialog.askopenfilename(
            filetypes=[("图片", "*.png *.jpg *.jpeg *.webp *.gif"), ("所有文件", "*.*")]
        )
        if path:
            self._load_image(path)

    def _load_image(self, path):
        self.image_path.set(path)
        self._set_status(f"已选择：{os.path.basename(path)}")
        try:
            img = Image.open(path)
            img.thumbnail((300, 260), Image.LANCZOS)
            self._tk_img = ImageTk.PhotoImage(img)
            self.drop_zone.grid_remove()
            self.img_preview.configure(image=self._tk_img, bg="#313244")
            self.img_preview.grid(row=1, column=0, sticky="nsew")
            self.img_preview.bind("<Button-1>", self._pick_file)
        except Exception as e:
            self._set_status(f"预览失败: {e}")

    def _generate(self):
        path     = self.image_path.get()
        api_key  = self.api_key.get().strip()
        base_url = self.base_url.get().strip()

        if not path:
            messagebox.showwarning("提示", "请先选择图片"); return
        if not api_key:
            messagebox.showwarning("提示", "请填写 API Key"); return

        self.gen_btn.config(state="disabled", text="识别中…")
        self.write_btn.config(state="disabled")
        self.output.delete("1.0", "end")
        self._set_status("正在调用 Claude API…")

        def worker():
            try:
                result = call_claude(path, api_key, base_url)
                self.after(0, lambda: self._on_result(result))
            except Exception as e:
                self.after(0, lambda: self._on_error(str(e)))

        threading.Thread(target=worker, daemon=True).start()

    def _on_result(self, text):
        self.output.insert("1.0", text)
        self.write_btn.config(state="normal")
        self.gen_btn.config(state="normal", text="识别并生成 ▶")
        self._set_status("生成完成，可编辑后点击「写入文件」")

    def _on_error(self, msg):
        self.gen_btn.config(state="normal", text="识别并生成 ▶")
        self._set_status(f"错误：{msg}")
        messagebox.showerror("API 错误", msg)

    def _write(self):
        content = self.output.get("1.0", "end").strip()
        if not content:
            messagebox.showwarning("提示", "生成内容为空"); return

        sel = self.combo.current()
        if sel < 0:
            messagebox.showwarning("提示", "请选择目标文件"); return

        target = self.ref_files[sel][1] if sel < len(self.ref_files) else self._new_ref_dialog()
        if not target:
            return

        try:
            with open(target, "a", encoding="utf-8") as f:
                f.write("\n" + content + "\n")
            self._set_status(f"✓ 已写入 {os.path.relpath(target, BLOG_ROOT)}")
            messagebox.showinfo("完成", f"已追加到\n{target}\n\n刷新 hugo server 即可预览。")
        except Exception as e:
            messagebox.showerror("写入失败", str(e))

    def _new_ref_dialog(self):
        dlg = tk.Toplevel(self)
        dlg.title("新建速查文件")
        dlg.geometry("360x290")
        dlg.configure(bg="#1e1e2e")
        dlg.grab_set()

        fields = {}
        rows = [("文件夹名（英文）", "slug"), ("速查标题", "title"),
                ("图标文字", "icon"), ("简短描述", "desc"), ("主题色", "color")]
        defaults = {"color": "#17c48a"}

        for i, (label, key) in enumerate(rows):
            tk.Label(dlg, text=label, bg="#1e1e2e", fg="#cdd6f4",
                     font=("微软雅黑", 9)).grid(row=i, column=0, padx=16, pady=4, sticky="w")
            var = tk.StringVar(value=defaults.get(key, ""))
            tk.Entry(dlg, textvariable=var, bg="#313244", fg="#cdd6f4",
                     insertbackground="#cdd6f4", relief="flat",
                     font=("Consolas", 9), width=24).grid(
                row=i, column=1, padx=8, pady=4, ipady=3)
            fields[key] = var

        result = [None]

        def confirm():
            slug  = fields["slug"].get().strip()
            title = fields["title"].get().strip()
            if not slug or not title:
                messagebox.showwarning("提示", "文件夹名和标题必填", parent=dlg); return
            dir_p = os.path.join(REF_DIR, slug)
            os.makedirs(dir_p, exist_ok=True)
            fp = os.path.join(dir_p, "index.md")
            with open(fp, "w", encoding="utf-8") as f:
                f.write(f'---\ntitle: "{title}"\ndescription: "{fields["desc"].get().strip()}"\n'
                        f'type: reference\nicon: "{fields["icon"].get().strip()}"\n'
                        f'color: "{fields["color"].get().strip()}"\ntoc: false\ndate: 2026-06-07\n---\n\n')
            self.ref_files = list_ref_files()
            names = [t for t, _ in self.ref_files] + ["＋ 新建速查文件"]
            self.combo["values"] = names
            self.combo.current(len(self.ref_files) - 1)
            result[0] = fp
            dlg.destroy()

        tk.Button(dlg, text="创建", bg="#a6e3a1", fg="#1e1e2e",
                  font=("微软雅黑", 10, "bold"), relief="flat",
                  command=confirm).grid(row=len(rows), column=0, columnspan=2,
                                        pady=14, ipadx=20, ipady=6)
        dlg.wait_window()
        return result[0]

    def _set_status(self, msg):
        self.status.config(text=msg)


def check_deps():
    try:
        from PIL import Image
    except ImportError:
        print("正在安装 Pillow…")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"])
        print("安装完成，请重新运行脚本。")
        sys.exit(0)


if __name__ == "__main__":
    check_deps()
    app = App()
    app.mainloop()
