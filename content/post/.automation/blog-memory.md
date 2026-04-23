# 技术博客自动化记忆

## 用途

- 这份文件保存“每日技术博客”自动化的详细业务记忆。
- 默认入口文件仍是 `C:/Users/19890/.codex/automations/automation/memory.md`。
- 每次运行时，先读取入口文件，再读取本文件；完成写作后优先更新本文件，再回写入口文件的同步摘要。

## 已用主题

- 2026-04-23
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: CAN 总线仲裁的底层逻辑：从“线与”电路到非破坏性竞争
  - 二级技术切面: 无
  - 文章路径: `D:/blog/content/post/20/can-arbitration.md`
- 2026-04-21
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: MPU6050 姿态解算与零偏校准
  - 二级技术切面: 无
  - 文章路径: `D:/blog/content/post/14/mpu6050.md`
- 2026-04-21
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 硬件定时器与中断机制
  - 二级技术切面: 无
  - 文章路径: `D:/blog/content/post/16/timer.md`
- 2026-04-22
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: OpenCV 基础图像处理与颜色识别
  - 二级技术切面: 无
  - 文章路径: `D:/blog/content/post/17/opencv-color.md`
- 2026-04-22
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: 电机驱动 (TB6612FNG) 与死区控制
  - 二级技术切面: 无
  - 文章路径: `D:/blog/content/post/18/tb6612-deadzone.md`
- 2026-04-23
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 DMA 与多通道 ADC 的内存搬运哲学
  - 二级技术切面: 无
  - 文章路径: `D:/blog/content/post/19/stm32-adc-dma.md`

## 运行记录

- 2026-04-23 19:04:40 +08:00
  - 输出文章: `D:/blog/content/post/20/can-arbitration.md`
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: CAN 总线仲裁的底层逻辑：从“线与”电路到非破坏性竞争
  - 二级技术切面: 无
  - 决策说明: 最近几篇已覆盖 MCU 架构、视觉与电机控制维度，因此优先切换到尚未使用的工业总线方向；在剩余未用一级主题中选择 CAN 仲裁，重点放在线与电路、位时序、采样点、错误封闭与优先级映射，而不是停留在 HAL API 调用层。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从物理线路到时域契约”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，覆盖标准 ID 位域设计、位时序搜索公式、采样点约束、发送邮箱限流与 Bus-Off 最小恢复逻辑。
  - 提交动作: 完成文章与记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/20/can-arbitration.md" "auto(blog): skill-can-bus-arbitration-wired-and-non-destructive-contention"`。
  - 提交状态: 自动提交失败。
  - 失败原因: `fatal: Unable to create 'D:/blog/.git/index.lock': Permission denied`
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

- 2026-04-22 10:08:50 +08:00
  - 修复动作: 在允许写入 `.git` 后重试提交链路，确认问题仅为沙箱权限限制，而非 Git 锁文件残留。
  - 验证结果: 沙箱外执行 `git add` 正常，随后重新调用 `D:/blog/content/post/.automation/push-blog-auto.bat` 成功。
  - 最近提交: `b772c4052cd90fdcbf788dbe75fd5630133e7543`
  - 提交说明: `auto(blog): skill-opencv-image-processing-color-recognition`

- 2026-04-22 10:12:27 +08:00
  - 状态判断: 文章生成链路与提交脚本本身均已验证可用。
  - 自动化前提: 下次是否可无人值守成功，取决于自动化运行环境是否持续拥有 `.git` 写权限，或已持久放行 `D:/blog/content/post/.automation/push-blog-auto.bat` 这条提交前缀。
  - 风险提示: 若权限仍回到受限沙箱，失败点仍会落在 `git add` 创建 `D:/blog/.git/index.lock`。

- 2026-04-22 10:21:42 +08:00
  - 输出文章: `D:/blog/content/post/18/tb6612-deadzone.md`
  - 决策说明: 在剩余未重复主题 I2C/UART、PID、TB6612FNG 三项中随机选中 TB6612FNG 方向，继续保证与此前自动生成主题不重复。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从数字控制到物理执行链路”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，覆盖 H 桥方向控制、启动死区补偿、换向死区保护、PWM 映射公式、短刹车与边界限幅处理。
  - 提交动作: 完成文章与仓库记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat`。
  - 提交状态: 已调用 `D:/blog/content/post/.automation/push-blog-auto.bat`，但自动提交失败。
  - 失败原因: `fatal: Unable to create 'D:/blog/.git/index.lock': Permission denied`

- 2026-04-23 09:03:50 +08:00
  - 输出文章: `D:/blog/content/post/19/stm32-adc-dma.md`
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 DMA 与多通道 ADC 的内存搬运哲学
  - 二级技术切面: 无
  - 决策说明: 避开已使用的 MPU6050、定时器、OpenCV 颜色识别与 TB6612FNG 后，优先切回最近几篇未覆盖的 MCU 架构维度，选择未重复的 ADC + DMA 主题，并把重点放在采样保持、通道时序、环形 DMA 窗口和物理量映射。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从模拟量进入数字内存”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，覆盖定时触发、交错缓冲区索引公式、半缓冲处理、分压还原、电流映射、死区限幅与快照一致性控制。
  - 提交动作: 完成文章与记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/19/stm32-adc-dma.md" "auto(blog): skill-stm32-dma-multi-channel-adc-memory-transport"`。
  - 提交状态: 自动提交失败。
  - 失败原因: `fatal: Unable to create 'D:/blog/.git/index.lock': Permission denied`
