# 技术博客自动化记忆

## 用途

- 这份文件保存“每日技术博客”自动化的详细业务记忆。
- 默认入口文件仍是 `C:/Users/19890/.codex/automations/automation/memory.md`。
- 每次运行时，先读取入口文件，再读取本文件；完成写作后优先更新本文件，再回写入口文件的同步摘要。

## 已用主题

- 2026-07-06
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: 硬件中断的边界：触发沿逻辑与信号消抖的博弈
  - 二级技术切面: EXTI 双沿触发、静默窗消抖与边沿可信度预算
  - 文章路径: `D:/blog/content/post/82/exti-dual-edge-quiet-window-debounce-and-edge-confidence-budget.md`

- 2026-07-05
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: PCB 高频布局与混合信号干扰抑制
  - 二级技术切面: 共阻抗耦合、VREF 回注与电流采样运放恢复时间
  - 文章路径: `D:/blog/content/post/81/pcb-common-impedance-vref-injection-current-sense-recovery.md`

- 2026-07-04
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: FOC 磁场定向控制的核心：Clark 与 Park 变换的降维打击
  - 二级技术切面: 电角度时间戳对齐、采样执行延迟与 Park 相位前馈补偿
  - 文章路径: `D:/blog/content/post/80/foc-electrical-angle-timestamp-alignment-sampling-execution-delay-and-park-phase-lead.md`

- 2026-07-03
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 DMA 与多通道 ADC 的内存搬运哲学
  - 二级技术切面: 注入组抢占、DMA 常规组背压与过流保护时延预算
  - 文章路径: `D:/blog/content/post/79/stm32-adc-injected-preemption-regular-dma-backpressure-and-overcurrent-latency-budget.md`

- 2026-07-02
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: SPI 协议 CPOL/CPHA 深度解析：数字采样的时域契约
  - 二级技术切面: 时钟占空比塌缩、建立保持时间与亚稳态容限
  - 文章路径: `D:/blog/content/post/78/spi-duty-cycle-distortion-setup-hold-and-metastability-margin.md`

- 2026-07-01
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: OpenCV 相机标定与物理世界的三维重建
  - 二级技术切面: 镜头温漂、对焦呼吸与在线重投影守卫
  - 文章路径: `D:/blog/content/post/76/camera-calibration-lens-thermal-drift-focus-breathing-and-online-reprojection-guard.md`

- 2026-06-30
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 硬件定时器与中断机制
  - 二级技术切面: 编码器模式四倍频计数、环形差分溢出扩展与低速速度观测
  - 文章路径: `D:/blog/content/post/77/stm32-timer-encoder-mode-quadrature-overflow-low-speed-observer.md`

- 2026-06-30
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: 电机驱动 (TB6612FNG) 与死区控制
  - 二级技术切面: 续流路径、快慢衰减与换向回灌保护
  - 文章路径: `D:/blog/content/post/75/tb6612-current-decay-recirculation-and-regenerative-clamp.md`

- 2026-06-29
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: PID 算法在平衡车中的应用
  - 二级技术切面: 位置式 PID 与增量式 PID 的离散实现差异、执行器饱和记忆与采样抖动
  - 文章路径: `D:/blog/content/post/74/balance-car-position-vs-incremental-pid-saturation-memory-and-dt-jitter.md`

- 2026-06-28
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: SPI 协议 CPOL/CPHA 深度解析：数字采样的时域契约
  - 二级技术切面: 多从设备混挂时的 CPOL/CPHA 动态切换、SCK 空闲回归与首位错采恢复
  - 文章路径: `D:/blog/content/post/73/spi-mixed-mode-cpol-cpha-hot-switch-idle-window-and-first-bit-recovery.md`

- 2026-06-27
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: I2C/UART 通信协议底层逻辑
  - 二级技术切面: UART DMA 环形接收、IDLE 判帧与粘包错帧恢复
  - 文章路径: `D:/blog/content/post/72/uart-dma-circular-idle-frame-resync-and-error-recovery.md`

- 2026-06-26
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: MPU6050 姿态解算与零偏校准
  - 二级技术切面: 六面体静态标定、交叉轴失准与 3x3 补偿矩阵
  - 文章路径: `D:/blog/content/post/71/mpu6050-six-position-calibration-cross-axis-misalignment-and-3x3-compensation.md`

- 2026-06-23
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: OpenCV 基础图像处理与颜色识别
  - 二级技术切面: LED 频闪、滚动快门条纹与时域颜色稳定化
  - 文章路径: `D:/blog/content/post/69/opencv-color-led-flicker-rolling-shutter-temporal-stabilization.md`

- 2026-06-22
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: FOC 磁场定向控制的核心：Clark 与 Park 变换的降维打击
  - 二级技术切面: 电压圆限幅、SVPWM 零序注入与母线利用率边界
  - 文章路径: `D:/blog/content/post/68/foc-voltage-circle-limiting-svpwm-zero-sequence-and-dc-bus-utilization.md`

- 2026-06-21
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: CAN 总线仲裁的底层逻辑：从“线与”电路到非破坏性竞争
  - 二级技术切面: 位填充帧长抖动、优先级阻塞与最坏响应时间
  - 文章路径: `D:/blog/content/post/67/can-bit-stuffing-frame-jitter-priority-blocking-and-worst-case-response-time.md`

- 2026-06-20
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: MPU6050 姿态解算与零偏校准
  - 二级技术切面: Allan 方差、零偏随机游走与静止冻结校准
  - 文章路径: `D:/blog/content/post/66/mpu6050-allan-variance-bias-random-walk-and-stationary-bias-freeze.md`

- 2026-06-19
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: 步进电机 S 型加减速算法：抑制机械谐振的微积分应用
  - 二级技术切面: 共振带避让、jerk 限幅与失步保护窗口
  - 文章路径: `D:/blog/content/post/65/stepper-s-curve-jerk-limit-resonance-band-crossing-and-stall-guard-window.md`

- 2026-06-18
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: ESP32 双核调度与 RTOS 任务间的通信机制
  - 二级技术切面: portMUX 自旋锁、双 bank 共享快照与 ISR 唤醒尾延迟预算
  - 文章路径: `D:/blog/content/post/64/esp32-portmux-shared-snapshot-isr-wake-tail-latency.md`

- 2026-06-17
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: YOLO 边缘端部署：AI 模型的轻量化与量化裁剪
  - 二级技术切面: Letterbox 坐标逆映射、Stride 栅格量化与小目标框漂移补偿
  - 文章路径: `D:/blog/content/post/62/yolo-letterbox-stride-quantization-small-object-drift.md`

- 2026-06-16
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: SPI 协议 CPOL/CPHA 深度解析：数字采样的时域契约
  - 二级技术切面: 高速 SPI 采样窗、板级传播延迟与 Dummy Cycle 预算
  - 文章路径: `D:/blog/content/post/61/spi-sampling-window-board-delay-dummy-cycle-budget.md`

- 2026-06-15
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 硬件定时器与中断机制
  - 二级技术切面: 主从同步、TRGO 触发链与 ADC/PWM 相位锁定
  - 文章路径: `D:/blog/content/post/60/stm32-timer-master-slave-trgo-adc-pwm-phase-lock.md`

- 2026-06-14
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: 卡尔曼滤波 (Kalman Filter) 的数学推演与先验信任
  - 二级技术切面: 测量延迟、离序观测与固定滞后回放
  - 文章路径: `D:/blog/content/post/59/kalman-delayed-measurement-fixed-lag-replay.md`

- 2026-06-13
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: FOC 磁场定向控制的核心：Clark 与 Park 变换的降维打击
  - 二级技术切面: 电流环离散化、交叉耦合解耦与反电动势前馈
  - 文章路径: `D:/blog/content/post/58/foc-current-loop-discretization-decoupling-back-emf-feedforward.md`

- 2026-06-12
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: CAN 总线仲裁的底层逻辑：从“线与”电路到非破坏性竞争
  - 二级技术切面: 重同步、SJW 与长线时钟漂移容限
  - 文章路径: `D:/blog/content/post/57/can-resynchronization-sjw-clock-drift-budget.md`

- 2026-06-12
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: I2C/UART 通信协议底层逻辑
  - 二级技术切面: RS-485 半双工方向切换、帧间静默与总线回声消除
  - 文章路径: `D:/blog/content/post/56/rs485-half-duplex-de-turnaround-idle-gap-echo-suppression.md`

- 2026-06-11
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: 卡尔曼滤波 (Kalman Filter) 的数学推演与先验信任
  - 二级技术切面: 连续噪声离散化、Q/R 量纲统一与采样周期抖动
  - 文章路径: `D:/blog/content/post/55/kalman-continuous-noise-discretization-qr-dt-jitter.md`

- 2026-06-11
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 硬件定时器与中断机制
  - 二级技术切面: 影子寄存器、更新事件、重复计数器与中心对齐 PWM 的无毛刺更新
  - 文章路径: `D:/blog/content/post/54/stm32-timer-preload-update-center-aligned-pwm.md`

- 2026-06-07
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: SPI 协议 CPOL/CPHA 深度解析：数字采样的时域契约
  - 二级技术切面: 多从设备共享 MISO、片选撤销延迟与帧间污染恢复
  - 文章路径: `D:/blog/content/post/53/spi-shared-bus-miso-tristate-release-contamination-recovery.md`

- 2026-06-07
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: 步进电机 S 型加减速算法：抑制机械谐振的微积分应用
  - 二级技术切面: 短行程段退化、定时器量化与末端残差消除
  - 文章路径: `D:/blog/content/post/52/stepper-short-move-s-curve-quantization-residual.md`

- 2026-05-31
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: OpenCV 相机标定与物理世界的三维重建
  - 二级技术切面: 单目 PnP 的共面退化、条件数与姿态翻转判据
  - 文章路径: `D:/blog/content/post/51/opencv-planar-pnp-degeneracy-condition-number-pose-flip.md`

- 2026-05-30
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: 多传感器融合：视觉坐标系与 MPU6050 姿态的对齐
  - 二级技术切面: 曝光中点时间戳、滚动快门行延迟与姿态外推补偿
  - 文章路径: `D:/blog/content/post/50/vision-imu-exposure-midpoint-rolling-shutter.md`

- 2026-05-29
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 DMA 与多通道 ADC 的内存搬运哲学
  - 二级技术切面: 采样时间、源阻抗与通道串扰误差预算
  - 文章路径: `D:/blog/content/post/49/stm32-adc-source-impedance-crosstalk-budget.md`

- 2026-05-28
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: FOC 磁场定向控制的核心：Clark 与 Park 变换的降维打击
  - 二级技术切面: 编码器零电角标定、极对数识别与 d/q 轴错位误差
  - 文章路径: `D:/blog/content/post/48/foc-encoder-electrical-zero-pole-pair-calibration.md`

- 2026-05-27
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: MPU6050 姿态解算与零偏校准
  - 二级技术切面: DLPF 截止频率、采样分频与互补滤波相位裕量预算
  - 文章路径: `D:/blog/content/post/47/mpu6050-dlpf-sample-divider-phase-margin.md`

- 2026-05-26
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: OpenCV 基础图像处理与颜色识别
  - 二级技术切面: 自动曝光、白平衡、伽马与 HSV 阈值回标定
  - 文章路径: `D:/blog/content/post/46/opencv-hsv-recalibration-ae-awb-gamma.md`

- 2026-05-25
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: CAN 总线仲裁的底层逻辑：从“线与”电路到非破坏性竞争
  - 二级技术切面: ACK 缺失、自动重发与发送截止期预算
  - 文章路径: `D:/blog/content/post/45/can-ack-retry-deadline-budget.md`

- 2026-05-23
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: I2C/UART 通信协议底层逻辑
  - 二级技术切面: UART 过采样、波特率误差与空闲帧重同步
  - 文章路径: `D:/blog/content/post/44/uart-oversampling-baud-error-resync.md`

- 2026-05-20
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: 卡尔曼滤波 (Kalman Filter) 的数学推演与先验信任
  - 二级技术切面: 归一化创新平方 NIS、异常观测门控与协方差恢复
  - 文章路径: `D:/blog/content/post/43/kalman-nis-gating.md`

- 2026-05-17
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: 电机驱动 (TB6612FNG) 与死区控制
  - 二级技术切面: PWM 频率选择、反电动势与刹车模式
  - 文章路径: `D:/blog/content/post/42/tb6612-pwm-frequency-back-emf-brake-mode.md`

- 2026-05-16
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: SPI 协议 CPOL/CPHA 深度解析：数字采样的时域契约
  - 二级技术切面: DMA 连续事务、片选保持与回读错位恢复
  - 文章路径: `D:/blog/content/post/41/skill-spi-dma-chip-select-hold-and-readback-phase-recovery.md`

- 2026-05-15
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 硬件定时器与中断机制
  - 二级技术切面: 输入捕获溢出扩展、边沿时间戳与低速测速误差预算
  - 文章路径: `D:/blog/content/post/40/stm32-input-capture-overflow-rpm.md`

- 2026-05-13
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: OpenCV 相机标定与物理世界的三维重建
  - 二级技术切面: 双目标定的基线误差、视差量化与深度误差传播
  - 文章路径: `D:/blog/content/post/39/opencv-stereo-disparity-depth-error.md`

- 2026-05-13
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: MPU6050 姿态解算与零偏校准
  - 二级技术切面: 温漂零偏、静止窗口与零角速度约束
  - 文章路径: `D:/blog/content/post/38/mpu6050-temp-bias-zero-rate.md`

- 2026-05-12
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: FOC 磁场定向控制的核心：Clark 与 Park 变换的降维打击
  - 二级技术切面: 单电阻母线采样窗口、死区补偿与低速电流重构误差
  - 文章路径: `D:/blog/content/post/37/foc-single-shunt-reconstruction.md`

- 2026-05-11
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: CAN 总线仲裁的底层逻辑：从“线与”电路到非破坏性竞争
  - 二级技术切面: 位时序容差、错误计数与 Bus-Off 恢复策略
  - 文章路径: `D:/blog/content/post/36/can-bit-timing-bus-off-recovery.md`

- 2026-05-11
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: ESP32 双核调度与 RTOS 任务间的通信机制
  - 二级技术切面: 跨核任务通知、队列背压与中断到任务唤醒延迟预算
  - 文章路径: `D:/blog/content/post/35/esp32-cross-core-notify-backpressure.md`
- 2026-05-07
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: PCB 高频布局与混合信号干扰抑制
  - 二级技术切面: 回流路径、开关节点 dV/dt 与 ADC 采样静默窗预算
  - 文章路径: `D:/blog/content/post/34/pcb-return-path-adc-quiet-window.md`
- 2026-05-06
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: YOLO 边缘端部署：AI 模型的轻量化与量化裁剪
  - 二级技术切面: INT8 量化映射、结构化通道剪枝与 NMS 尾延迟预算
  - 文章路径: `D:/blog/content/post/33/yolo-edge-int8-pruning-nms.md`
- 2026-05-05
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: PID 算法在平衡车中的应用
  - 二级技术切面: 姿态环位置式 PD、速度环增量式 PI、采样周期抖动与抗积分饱和
  - 文章路径: `D:/blog/content/post/32/balance-car-pid-discrete-cascade.md`
- 2026-05-04
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: 硬件中断的边界：触发沿逻辑与信号消抖的博弈
  - 二级技术切面: EXTI 双沿触发、定时器确认窗与积分式数字消抖
  - 文章路径: `D:/blog/content/post/31/exti-edge-debounce-window.md`
- 2026-04-30
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: OpenMV 动态目标追踪与空域滤波算法
  - 二级技术切面: ROI 门控、3x3 空域滤波与 alpha-beta 质心预测
  - 文章路径: `D:/blog/content/post/30/openmv-target-tracking.md`
- 2026-04-29
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: 步进电机 S 型加减速算法：抑制机械谐振的微积分应用
  - 二级技术切面: jerk 受限轨迹、短行程峰值约束与定时器脉冲映射
  - 文章路径: `D:/blog/content/post/29/stepper-s-curve.md`
- 2026-04-27
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: 多传感器融合：视觉坐标系与 MPU6050 姿态的对齐
  - 二级技术切面: 相机外参、时间同步与像素射线的地平面姿态补偿
  - 文章路径: `D:/blog/content/post/27/vision-imu-alignment.md`
- 2026-04-28
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: SPI 协议 CPOL/CPHA 深度解析：数字采样的时域契约
  - 二级技术切面: 空闲时钟、首边沿与次边沿、片选建立时间预算
  - 文章路径: `D:/blog/content/post/28/spi-cpol-cpha-timing.md`
- 2026-04-26
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: I2C/UART 通信协议底层逻辑
  - 二级技术切面: I2C 开漏仲裁、时钟拉伸与总线恢复
  - 文章路径: `D:/blog/content/post/25/i2c-bus-recovery.md`
- 2026-04-25
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: FOC 磁场定向控制的核心：Clark 与 Park 变换的降维打击
  - 二级技术切面: 三相电流到 d/q 电流闭环的坐标变换与电压矢量限幅
  - 文章路径: `D:/blog/content/post/24/foc-clarke-park.md`
- 2026-04-24
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: OpenCV 相机标定与物理世界的三维重建
  - 二级技术切面: 无
  - 文章路径: `D:/blog/content/post/22/opencv-calibration.md`
- 2026-04-23
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: 卡尔曼滤波 (Kalman Filter) 的数学推演与先验信任
  - 二级技术切面: 无
  - 文章路径: `D:/blog/content/post/21/kalman-filter.md`
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

- 2026-07-04 09:15:22 +08:00
  - 输出文章: `D:/blog/content/post/80/foc-electrical-angle-timestamp-alignment-sampling-execution-delay-and-park-phase-lead.md`
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: FOC 磁场定向控制的核心：Clark 与 Park 变换的降维打击
  - 二级技术切面: 电角度时间戳对齐、采样执行延迟与 Park 相位前馈补偿
  - 决策说明: 一级主题池已全部覆盖，因此继续按兜底策略从已用一级主题中派生新的二级技术切面；最近几篇文章依次覆盖了 `Vision`、`Industrial Bus` 与 `MCU`，而高阶电机维度自 `2026-06-30` 以来未再展开，具备较好的技术跨度；在高阶电机主线中，`FOC` 已写过坐标变换、电流环解耦、编码器零电角和电压圆限幅，但尚未单独拆解“同一拍采样的电流、角度与 PWM 何时真正属于同一个电角时刻”这一时域问题，因此本轮刻意避开旧文已经覆盖的几何和调制边界，转而聚焦 `ADC` 采样时刻、编码器共时快照、PWM 预装载生效窗口、错过更新事件时的一整拍延迟惩罚，以及 `Delta_theta_e = omega_e * Tdelay + 0.5 * alpha_e * Tdelay^2` 如何把时间误差直接映射成 d/q 轴串扰，确保标题、slug、核心公式、代码结构和工程问题都与历史文章明显区分。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从旋转坐标系公式回到定时器与 ADC 时间合同”的叙述方式。
  - 实现约束: 代码采用 STM32 HAL 风格，围绕 `Tdelay = Tsample_to_latch + Tzoh + Nmiss * Tcarrier`、`Delta_theta_e = omega_e * Tdelay + 0.5 * alpha_e * Tdelay^2`、`id_meas ~= iq * sin(Delta_theta_e)`、`vq_real ~= vq_ref * cos(Delta_theta_e)` 与 `sqrt(vd^2 + vq^2) <= k_util * Vdc / sqrt(3)` 展开，同时实现采样时刻角度下的 Park、电压执行时刻角度下的 inverse Park、编码器扩展计数差分测速、加速度限幅、错过 PWM 更新事件检测与三相 CCR 写回。
  - 提交动作: 完成文章与记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/80/foc-electrical-angle-timestamp-alignment-sampling-execution-delay-and-park-phase-lead.md" "auto(blog): skill-foc-electrical-angle-timestamp-alignment-sampling-execution-delay-and-park-phase-lead"`

- 2026-07-03 09:45:54 +08:00
  - 输出文章: `D:/blog/content/post/79/stm32-adc-injected-preemption-regular-dma-backpressure-and-overcurrent-latency-budget.md`
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 DMA 与多通道 ADC 的内存搬运哲学
  - 二级技术切面: 注入组抢占、DMA 常规组背压与过流保护时延预算
  - 决策说明: 一级主题池已全部覆盖，因此继续按兜底策略从已用一级主题中派生新的二级技术切面；考虑最近几篇文章已依次覆盖工业总线、视觉、MCU、高阶电机与控制，而上一轮刚完成工业总线切面，本轮刻意不连续重复该维度，回到 `MCU` 体系中的 `STM32 DMA 与多通道 ADC` 主线；在这一主线下，仓库中已经写过“采样时间、源阻抗与通道串扰误差预算”以及“双缓冲 DMA、控制快照一致性与过载退化”两个旧切口，因此本轮明确避开模拟误差预算与 DMA 页面一致性老题，转而把重心收敛到“一颗 ADC 如何在常规组后台扫描、PWM 同步注入采样与过流保护之间分配优先级、转换时间和关断时延”这条更底层的实时调度链路上，确保标题、slug、公式、代码结构和工程问题都与历史文章明显区分。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从 ADC 外设回到实时调度器”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，围绕 `t_conv = (t_sample + 12.5) / f_adc`、`rho_reg = f_reg_frame * N_reg * t_conv_reg`、`rho_inj = f_inj * N_inj * t_conv_inj`、`margin = 1 - rho_reg - rho_inj - rho_cpu`、`Iphase = (Vadc - Vbias) / (Rshunt * Gamp)` 与 `t_trip = t_conv + t_irq + t_gate_off` 展开，同时实现常规组半缓冲快照、注入组 JDR 快路径、模拟看门狗闩锁、软件过流兜底与启动期 `service_margin` 边界检查。
  - 提交动作: 完成文章与记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/79/stm32-adc-injected-preemption-regular-dma-backpressure-and-overcurrent-latency-budget.md" "auto(blog): skill-stm32-adc-injected-preemption-regular-dma-backpressure-and-overcurrent-latency-budget"`

- 2026-07-02 14:27:51 +08:00
  - 输出文章: `D:/blog/content/post/78/spi-duty-cycle-distortion-setup-hold-and-metastability-margin.md`
  - 技术维度: 工业级总线与时序的物理契约 (Industrial Bus & Timing)
  - 一级主题: SPI 协议 CPOL/CPHA 深度解析：数字采样的时域契约
  - 二级技术切面: 时钟占空比塌缩、建立保持时间与亚稳态容限
  - 决策说明: 一级主题池已全部覆盖，因此继续按兜底策略从已用一级主题中派生新的二级技术切面；考虑最近几篇文章依次覆盖了控制、高阶电机、MCU 与视觉，而工业总线维度自 `2026-06-28` 以来未再展开，本轮优先回补技术跨度；在工业总线主题中，`SPI` 已经写过“首边沿/次边沿与片选建立”“DMA 连续事务与回读错位恢复”“共享 MISO 污染”“板级传播延迟与 Dummy Cycle 预算”“多从混挂动态切换”等切口，因此刻意避开这些已用题材，把重心收敛到“CPOL/CPHA 之外，真正决定链路上限的是哪一个半周期在承担建立时间、保持时间、板级飞行时间和同步器亚稳态收敛成本”这条更底层的时域合同上，确保标题、slug、公式和代码结构都与历史文章明显区分。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从模式编号回到采样窗口预算”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，围绕 `Tclk = 1 / f_sck`、`Thigh = D * Tclk`、`Tlow = (1 - D) * Tclk`、`Msetup = Tpre - (tpath + tjitter + tmeta) - tSU` 与 `Mhold = Tpost - tjitter - tH` 展开，同时实现模式到前后窗映射、MOSI/MISO 双向裕量评估、最快安全预分频选择与 CS 保护窗延迟。
  - 提交动作: 完成文章与记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/78/spi-duty-cycle-distortion-setup-hold-and-metastability-margin.md" "auto(blog): skill-spi-duty-cycle-distortion-setup-hold-and-metastability-margin"`

- 2026-07-01 09:06:03 +08:00
  - 输出文章: `D:/blog/content/post/76/camera-calibration-lens-thermal-drift-focus-breathing-and-online-reprojection-guard.md`
  - 技术维度: 机器视觉与边缘计算 (Vision & Edge AI)
  - 一级主题: OpenCV 相机标定与物理世界的三维重建
  - 二级技术切面: 镜头温漂、对焦呼吸与在线重投影守卫
  - 决策说明: 一级主题池已全部覆盖，因此继续按兜底策略从已用一级主题中派生新的二级技术切面；考虑最近几篇文章依次覆盖了高阶电机、控制、工业总线与 MCU，而视觉维度自 `2026-06-23` 以来未再展开，本轮优先回补视觉跨度；在视觉主题中，`OpenCV 相机标定` 自 `2026-05-31` 的平面 PnP 退化文章后未再深挖，因此刻意避开已写过的“平面双解退化”和“双目标定深度误差”旧切口，把重心收敛到“标定并不会随着 YAML 文件落盘而冻结，镜头温漂、对焦呼吸和装配漂移如何通过焦距缩放、主点挪动与边缘重投影残差重新改写像素到毫米映射”这条更底层的光学几何链路上，确保标题、slug、公式、代码结构与历史文章明显区分。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从一次性标定结果回到持续可信度审计”的叙述风格。
  - 实现约束: 代码采用 OpenCV C++ 风格，围绕 `u = f_x * X / Z + c_x`、`v = f_y * Y / Z + c_y`、`f_x(T) = f_x0 * (1 + alpha_x * Delta T)`、`Z = f * L / l_px` 与 `Delta Z / Z ~= Delta f / f - Delta l_px / l_px` 展开，并实现一阶温漂补偿、对焦呼吸尺度最小二乘估计、分区重投影残差统计、边缘/中心误差比监测与在线标定退化守卫。
  - 提交动作: 待执行 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/76/camera-calibration-lens-thermal-drift-focus-breathing-and-online-reprojection-guard.md" "auto(blog): skill-camera-calibration-thermal-drift-focus-breathing-online-reprojection-guard"`

- 2026-06-30 23:42:00 +08:00
  - 输出文章: `D:/blog/content/post/77/stm32-timer-encoder-mode-quadrature-overflow-low-speed-observer.md`
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: STM32 硬件定时器与中断机制
  - 二级技术切面: 编码器模式四倍频计数、环形差分溢出扩展与低速速度观测
  - 决策说明: 仓库中已存在一篇 `2026-06-30` 的高阶电机文章，本次按用户指定日期补写新的编号文章，因此只复用日期、不复用主题；一级主题池已全部覆盖，继续按兜底策略从已用一级主题派生新的二级技术切面。考虑最新几篇依次覆盖 MCU、工业总线、控制、高阶电机与视觉，且 `STM32 硬件定时器` 最近已写过输入捕获溢出、中心对齐 PWM、TRGO 相位锁定等切面，本轮回到 MCU 维度但避开这些旧切口，把重点收敛到“定时器编码器模式如何把正交 A/B 相四倍频边沿、有限位宽 CNT 回绕、固定周期差分和低速速度台阶组织成一份可信运动观测”这条更底层的测量链路上，确保标题、slug、公式和代码结构都与历史文章明显区分。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从能读 CNT 回到连续机械状态观测契约”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，围绕 `counts_per_rev = 4 * N_line * gear_ratio`、`position[k] = position[k-1] + wrap_delta(CNT[k], CNT[k-1])`、`rpm = 60 * delta_counts / (counts_per_rev * dt)` 与 `|delta| < 32768` 展开，并实现 16 位环形差分、连续位置累加、速度一阶滤波、异常跳变拒绝、低速抖动死区与零速确认状态。
  - 提交动作: 完成文章与记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/77/stm32-timer-encoder-mode-quadrature-overflow-low-speed-observer.md" "auto(blog): skill-stm32-timer-encoder-mode-quadrature-overflow-low-speed-observer"`。

- 2026-06-30 10:59:32 +08:00
  - 输出文章: `D:/blog/content/post/75/tb6612-current-decay-recirculation-and-regenerative-clamp.md`
  - 技术维度: 高阶电机与运动控制算法 (Advanced Motion Control)
  - 一级主题: 电机驱动 (TB6612FNG) 与死区控制
  - 二级技术切面: 续流路径、快慢衰减与换向回灌保护
  - 决策说明: 一级主题池已全部覆盖，因此继续按兜底策略从已用一级主题中派生新的二级技术切面；考虑最近几篇已依次覆盖控制、工业总线与 MCU，而视觉主题若要满足本轮“优先用 STM32 HAL 展示底层控制代码”的约束会天然更受表达形式限制，本轮切回自 `2026-06-22` 以来未再展开的高阶电机维度，并刻意避开 `tb6612-pwm-frequency-back-emf-brake-mode.md` 已写过的“PWM 频率、反电动势与刹车模式”旧切口，把重心收敛到“同一颗 TB6612FNG 在不同关断相状态下究竟给电感电流提供什么退路、快慢衰减为何会把能量分别留在绕组和母线里、以及软件换向为什么必须同时尊重电流释放与母线回灌边界”这条更底层的能量链路上，确保标题、slug、公式、状态机和工程问题都与历史文章明显区分。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从桥臂导通路径回到能量退路契约”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，围绕 `V_ab = L * di/dt + R * i + K_e * omega`、慢衰减近似 `di/dt ~= -(R * i + K_e * omega) / L`、快衰减近似 `di/dt ~= -(V_m + R * i + K_e * omega) / L`、储能 `E_L = 0.5 * L * i^2` 与母线抬升近似 `Delta V ~= E_L / (C_bus * V_bus)` 展开，同时实现 `AIN1/AIN2` 周期内相位切换、快慢衰减选择、母线过压迟滞钳位、换向释放窗口与平均电压到占空比的边界限幅。
  - 提交动作: 完成文章与记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/75/tb6612-current-decay-recirculation-and-regenerative-clamp.md" "auto(blog): skill-tb6612-current-decay-recirculation-and-regenerative-clamp"`。

- 2026-06-29 11:53:58 +08:00
  - 输出文章: `D:/blog/content/post/74/balance-car-position-vs-incremental-pid-saturation-memory-and-dt-jitter.md`
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: PID 算法在平衡车中的应用
  - 二级技术切面: 位置式 PID 与增量式 PID 的离散实现差异、执行器饱和记忆与采样抖动
  - 决策说明: 一级主题池已全部覆盖，因此继续按兜底策略从已用一级主题里派生新的二级技术切面；考虑最近几篇已依次覆盖控制、MCU 与工业总线，而 `PID` 方向自 `2026-05-05` 的 `balance-car-pid-discrete-cascade.md` 之后尚未再展开，本轮切回平衡车控制维度，但刻意避开“姿态环位置式 PD + 速度环增量式 PI 的串级总览”旧切口，把重心收敛到“同一倒立摆、同一组离散参数下，位置式 PID 与增量式 PID 为什么会因状态记忆位置、执行器饱和和采样抖动投影不同而表现出不同闭环手感”这条更底层的数字控制链路上，确保标题、slug、公式与工程问题都与历史文章明显区分。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从离散状态记账回到倒立摆相位裕量”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，覆盖 `P + I - D_meas` 的两种离散状态表示、`dt` 限幅、back-calculation 抗饱和、增量限幅、H 桥电压映射与同时间戳快照输入约束。

- 2026-07-05 11:42:18 +08:00
  - 输出文章: `D:/blog/content/post/81/pcb-common-impedance-vref-injection-current-sense-recovery.md`
  - 技术维度: 控制理论与多维传感 (Control & Fusion)
  - 一级主题: PCB 高频布局与混合信号干扰抑制
  - 二级技术切面: 共阻抗耦合、VREF 回注与电流采样运放恢复时间
  - 决策说明: 一级主题池已全部覆盖，因此继续按兜底策略从已用一级主题中派生新的二级技术切面；考虑最近几篇文章依次覆盖了高阶电机、MCU、工业总线与视觉，而控制维度自 `2026-06-29` 以来未再展开，本轮优先回补技术跨度；在控制维度中，`PCB 高频布局与混合信号干扰抑制` 曾于 `2026-05-07` 写过“回流路径、开关节点 dV/dt 与 ADC 采样静默窗预算”这一基础切口，因此本轮刻意避开旧文已覆盖的宏观铺陈，转而收敛到“同一块板上为什么会因为共阻抗地弹、VREF 回注和电流采样运放恢复期而把真实相电流读成伪瞬态”这条更具体的误差链，确保标题、slug、公式主线、代码结构和工程问题都与历史文章明显区分。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从 ADC 码值回到可信物理映射契约”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，围绕 `V_err_shared = I_return * R_shared + L_shared * di/dt`、`Code = Vin / Vdda * (2^N - 1)`、`VDDA_now ~= Vcal * Code_cal / Code_now`、`Iphase = (Code / 4095 * VDDA - bias * VDDA) / (Rshunt * Gain)`、`|Delta I|max <= (Vbus / L) * Delta t` 与 `T_blank = T_dead + T_rr + T_opamp_recover + T_settle + T_aperture / 2` 展开，并实现占空比相关的注入触发重定位、VREFINT 参考补偿、物理斜率门控、静默窗失效冻结与可信样本保持。
  - 提交动作: 完成文章与记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/81/pcb-common-impedance-vref-injection-current-sense-recovery.md" "auto(blog): skill-pcb-common-impedance-vref-injection-current-sense-recovery"`

- 2026-07-06 09:05:11 +08:00
  - 输出文章: `D:/blog/content/post/82/exti-dual-edge-quiet-window-debounce-and-edge-confidence-budget.md`
  - 技术维度: 嵌入式底层与系统架构 (MCU & Architecture)
  - 一级主题: 硬件中断的边界：触发沿逻辑与信号消抖的博弈
  - 二级技术切面: EXTI 双沿触发、静默窗消抖与边沿可信度预算
  - 决策说明: 读取仓库记忆后确认增强主题池尚未完全耗尽，其中 `硬件中断的边界：触发沿逻辑与信号消抖的博弈` 仍是从未写过的一级主题；虽然 `OpenMV 动态目标追踪与空域滤波算法` 也未使用，但本轮任务明确要求优先下探物理约束、时序边界和 STM32 HAL 风格代码展示，因此优先选择更适合把“阈值穿越抖动、EXTI 挂起位折叠、定时器静默窗确认与 CPU 负载预算”串成同一条实时链路的中断主题，确保与 `2026-07-03` 的 ADC/DMA 调度文章在问题域、公式、代码结构和工程失效模式上明显区分。
  - 风格约束: 延续 Hugo YAML Front Matter、技能概述、核心底层概念解析、代码能力展现四段结构，并保持“从模拟边沿回到数字事件契约”的叙述风格。
  - 实现约束: 代码采用 STM32 HAL 风格，围绕 `Delta t_jitter ~= DeltaV_noise / |dV/dt|`、`Tquiet >= Tbounce_max + Tsync + Tmargin`、`rho_raw = f_raw * t_exti_isr`、`Tpulse_min_trust > Tquiet + Tirq_block + Tsample_quantization` 展开，同时实现 EXTI 双沿原始记账、TIM6 一次性静默窗重装、稳定边沿队列化与 raw/stable 双时间戳分层。
  - 提交动作: 完成文章与记忆写入后，按约定调用 `D:/blog/content/post/.automation/push-blog-auto.bat "content/post/82/exti-dual-edge-quiet-window-debounce-and-edge-confidence-budget.md" "auto(blog): skill-exti-dual-edge-quiet-window-debounce-and-edge-confidence-budget"`
