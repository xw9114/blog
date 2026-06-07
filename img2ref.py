#!/usr/bin/env python3
"""
img2ref.py — 上传图片，自动生成 Hugo 速查卡片

用法:
  python img2ref.py <图片路径>
  python img2ref.py <图片路径> <目标md文件>   # 直接指定写入文件
  ANTHROPIC_API_KEY=sk-... python img2ref.py xxx.png
"""

import sys
import os
import base64
import json
import requests

BLOG_ROOT = os.path.dirname(os.path.abspath(__file__))
REF_DIR = os.path.join(BLOG_ROOT, "content", "reference")

SYSTEM_PROMPT = """你是一个 Hugo 博客速查内容生成器。
将图片内容（代码、表格、列表等）转换为 Hugo shortcode 格式的 Markdown。

格式规则：
- 每个独立知识点用一个 ref-card，filename 属性填写简短中文标题
- 多个 ref-card 放在 ref-cols 内
- 代码块标注正确语言（cpp, python, java, javascript, bash 等）
- 注释保留并翻译成中文
- 多个主题用 ## 二级标题分组，每组一个 ref-cols

输出示例：
## 基础语法

{{< ref-cols >}}

{{< ref-card filename="变量声明" >}}
```python
x = 10        # 整数
name = "Alice" # 字符串
```
{{< /ref-card >}}

{{< ref-card filename="常用函数" >}}
| 函数 | 说明 |
|------|------|
| `len(x)` | 获取长度 |
| `print(x)` | 打印输出 |
{{< /ref-card >}}

{{< /ref-cols >}}

只输出 Markdown，不要任何额外说明。"""


def encode_image(path):
    with open(path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode()


def media_type(path):
    ext = os.path.splitext(path)[1].lower()
    return {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".webp": "image/webp",
            ".gif": "image/gif"}.get(ext, "image/png")


def call_claude(image_path, api_key, base_url="https://api.anthropic.com"):
    print("正在识别图片内容...")
    resp = requests.post(
        f"{base_url.rstrip('/')}/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-sonnet-4-6",
            "max_tokens": 4096,
            "system": SYSTEM_PROMPT,
            "messages": [{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type(image_path),
                            "data": encode_image(image_path),
                        },
                    },
                    {"type": "text", "text": "请将图片中的内容转换为速查卡片格式。"},
                ],
            }],
        },
        timeout=90,
    )
    if resp.status_code != 200:
        print(f"API 错误 {resp.status_code}: {resp.text}")
        sys.exit(1)
    return resp.json()["content"][0]["text"]


def list_ref_files():
    files = []
    for root, _, filenames in os.walk(REF_DIR):
        for f in filenames:
            if f == "index.md":
                path = os.path.join(root, f)
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


def pick_target():
    files = list_ref_files()
    print("\n写入到哪个速查文件？")
    for i, (title, _) in enumerate(files, 1):
        print(f"  {i}. {title}")
    print(f"  {len(files)+1}. 新建速查文件")

    while True:
        raw = input("\n序号: ").strip()
        try:
            n = int(raw)
            if 1 <= n <= len(files):
                return files[n-1][1]
            if n == len(files) + 1:
                return new_ref_file()
        except ValueError:
            pass
        print("请输入有效序号")


def new_ref_file():
    slug  = input("文件夹名（英文，如 python）: ").strip()
    title = input("速查标题（如 Python 备忘清单）: ").strip()
    icon  = input("图标文字（如 Py）: ").strip()
    desc  = input("简短描述: ").strip()
    color = input("主题色（如 #3776AB，回车跳过）: ").strip() or "#17c48a"

    dir_path = os.path.join(REF_DIR, slug)
    os.makedirs(dir_path, exist_ok=True)
    file_path = os.path.join(dir_path, "index.md")
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(f'---\ntitle: "{title}"\ndescription: "{desc}"\n'
                f'type: reference\nicon: "{icon}"\ncolor: "{color}"\n'
                f'toc: false\ndate: 2026-06-07\n---\n\n')
    print(f"✓ 已创建 {file_path}")
    return file_path


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

    image_path = sys.argv[1]
    if not os.path.isfile(image_path):
        print(f"文件不存在: {image_path}")
        sys.exit(1)

    api_key = os.environ.get("ANTHROPIC_API_KEY") or input("ANTHROPIC_API_KEY: ").strip()
    if not api_key:
        print("需要 API Key")
        sys.exit(1)

    base_url = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")

    content = call_claude(image_path, api_key, base_url)

    print("\n" + "─" * 60)
    print(content)
    print("─" * 60)

    confirm = input("\n确认写入？[y/N] ").strip().lower()
    if confirm != "y":
        print("已取消。")
        sys.exit(0)

    target = sys.argv[2] if len(sys.argv) >= 3 else pick_target()

    with open(target, "a", encoding="utf-8") as f:
        f.write("\n" + content.strip() + "\n")

    print(f"\n✓ 已追加到 {target}")
    print("  重新运行 hugo server 即可预览。")


if __name__ == "__main__":
    main()
