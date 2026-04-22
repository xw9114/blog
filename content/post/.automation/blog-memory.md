# 技术博客自动化记忆

## 用途

- 这份文件保存“每日技术博客”自动化的详细业务记忆。
- 默认入口文件仍是 `C:/Users/19890/.codex/automations/automation/memory.md`。
- 每次运行时，先读取入口文件，再读取本文件；完成写作后优先更新本文件，再回写入口文件的同步摘要。

## 已用主题

- 2026-04-21: MPU6050 姿态解算与零偏校准 -> `D:/blog/content/post/14/mpu6050.md`
- 2026-04-21: STM32 硬件定时器与中断机制 -> `D:/blog/content/post/16/timer.md`
- 2026-04-22: OpenCV 基础图像处理与颜色识别 -> `D:/blog/content/post/17/opencv-color.md`

## 运行记录

- 2026-04-21 20:10:52 +08:00
  - 输出文章: `D:/blog/content/post/14/mpu6050.md`
  - 决策说明: 避开仓库中已有的 I2C 与 H 桥相关主题，选择未重复的 MPU6050 主题。
  - 风格约束: 使用 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构。
  - 实现约束: 代码采用 STM32 HAL 风格，包含 Doxygen 注释、公式说明与边界限幅处理。

- 2026-04-21 20:22:00 +08:00
  - 结构调整: 将详细记忆迁移到仓库内，便于和博客内容一起管理。
  - 兼容策略: 默认入口记忆文件仅保留索引、外部记忆路径与最近一次同步摘要。

- 2026-04-21 21:24:46 +08:00
  - 输出文章: `D:/blog/content/post/16/timer.md`
  - 决策说明: 避开仓库中已存在的 I2C、UART 与 MPU6050 相关主题，选择未重复的 STM32 定时器主题。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构。
  - 实现约束: 代码采用 STM32 HAL 风格，覆盖 PSC/ARR 计算、更新中断转发、边界限幅与公式注释。

- 2026-04-21 21:30:00 +08:00
  - 提交状态: 已调用 `D:/blog/content/post/.automation/push-blog-auto.bat`，但自动提交失败。
  - 失败原因: `git add` 无法创建 `D:/blog/.git/index.lock`，返回 `Permission denied`。

- 2026-04-22 10:00:31 +08:00
  - 输出文章: `D:/blog/content/post/17/opencv-color.md`
  - 决策说明: 按主题池排除已使用的 MPU6050 与 STM32 定时器主题后，随机选中 OpenCV 方向，并继续避开仓库内已较充分展开的 I2C/UART 与 H 桥主线。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从物理到数字映射”的叙述风格。
  - 实现约束: 代码采用 OpenCV C++ 风格，覆盖 HSV 阈值、色相回绕、形态学净化、轮廓质心提取、像素到控制坐标的线性映射与边界限幅处理。
  - 提交状态: 已调用 `D:/blog/content/post/.automation/push-blog-auto.bat`，但自动提交失败。
  - 失败原因: `git add` 无法创建 `D:/blog/.git/index.lock`，且当前不存在残留 `index.lock` 文件，属于 `.git` 目录写入权限受限。
