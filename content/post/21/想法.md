---
title: "头脑风暴：AI 驱动的自动化间隔重复（SRS）学习系统构建"
slug: "skill-ai-srs-system"
date: 2026-04-23T10:00:00+08:00
draft: false
description: "融合大语言模型语义理解能力与艾宾浩斯遗忘曲线，将碎片化 Markdown 笔记转化为动态交互式考核系统的全栈工程实践。"
tags: ["Python", "LLM API", "自动化工作流"]
categories: ["头脑风暴"]
image: ""
---

## 技能概述

该技能展现了将**被动知识存储**向**主动反馈系统**转化的全栈工程能力。核心价值在于利用大语言模型（LLM）的语义理解特性，打破了传统间隔重复工具（如 Anki）仅能进行简单卡片复习的局限。通过构建自动化调度引擎，实现从本地 Markdown 知识库自动提取上下文、生成场景化考题、并基于 WebSocket 协议在即时通讯终端（如 QQ 机器人）进行异步交互，构建了一套高度个性化的知识内化闭环。

## 核心能力矩阵

* **结构化知识解析与建模**：利用 Python 针对包含 **YAML Frontmatter** 的 Markdown 文件进行深度解析。通过提取 `tags`、`date` 等元数据维度，建立基于时间权重与知识领域的动态抽样模型。
* **启发式提示词工程 (Prompt Engineering)**：设计高阶提示词驱动 LLM 扮演“苏格拉底式导师”。系统不再复读定义，而是基于笔记内容构建**反事实场景**、**逻辑推演**或**代码重构挑战**，强制进行深度认知参与。
* **分布式部署与进程守护**：具备在 Linux/VPS 环境下部署长连接应用的能力。熟练运用 **PM2**、**tmux** 或 **systemd** 进行进程保活，确保机器人服务与调度脚本 24/7 在线，实现无感化的自动化触发。
* **异步通信与协议集成**：通过 **WebSocket** 实现 Python 后端与 **NapCatQQ/OneBot** 协议栈的无缝对接。处理跨平台的异步消息流转，将复杂的 AI 逻辑封装为简洁的即时通讯交互界面。

## 代码能力展现

以下代码片段展示了该系统的核心引擎：如何从结构化笔记中提取内容并驱动 LLM 生成“理解性”考核题目。

```python
import yaml
import requests
from datetime import datetime

class SRSBrain:
    """自动化间隔重复系统的核心逻辑引擎"""
    def __init__(self, api_config, note_path):
        self.api_url = api_config['url']
        self.api_key = api_config['key']
        self.note_path = note_path

    def parse_knowledge_point(self, file_content):
        """解析 Markdown 笔记，分离元数据与核心知识点"""
        try:
            _, frontmatter, body = file_content.split('---', 2)
            meta = yaml.safe_load(frontmatter)
            return meta, body.strip()
        except ValueError:
            return None, file_content

    def generate_scenario_challenge(self, body):
        """驱动 AI 生成非死记硬背的应用场景题"""
        headers = {"Authorization": f"Bearer {self.api_key}"}
        prompt = {
            "role": "system",
            "content": (
                "你是一个技术导师。请基于提供的笔记内容，设计一个实际应用场景题。"
                "严禁询问定义，必须要求用户写出逻辑伪代码或解决具体故障。"
            )
        }
        user_input = {"role": "user", "content": f"笔记内容：\n{body}"}
        
        response = requests.post(
            self.api_url, 
            json={"messages": [prompt, user_input], "model": "gpt-4-turbo"},
            headers=headers
        )
        return response.json()['choices'][0]['message']['content']

# 逻辑流示例：
# 1. 定时任务触发获取本地文件 -> 2. parse_knowledge_point 提取 -> 3. 生成题目并通过 WebSocket 推送