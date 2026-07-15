---
title: "技能档案：CAN LEC 错误指纹、时间戳直方图与物理层根因回推"
slug: "skill-can-lec-fingerprint-timestamp-histogram-and-root-cause-traceback"
date: 2026-07-15T09:07:24+08:00
draft: false
description: "从 bxCAN ESR 的 LEC 最后错误码、ACK/Stuff/Form/Bit/CRC 的位级语义，到时间戳错误直方图、周期干扰识别与根因域映射，系统拆解 CAN 调试为什么要先回答“哪一位在何时错了”，再谈重发或恢复。"
tags: ["CAN", "STM32", "bxCAN", "LEC", "错误调试", "工业总线"]
categories: ["技能档案", "工业通信"]
image: ""
---

## 技能概述

很多 CAN 故障最后都会在 `HAL_CAN_ErrorCallback()` 里收敛成一句模糊的“总线错误”，但真正让系统停摆的，往往不是回调有没有进来，而是你无法回答三个更底层的问题：**错的是哪一类位、错误是随机散点还是周期性重现、它更像发送驱动不足、接收采样漂移，还是某个功率开关把共模噪声打进了差分链路**。`LEC` 的价值从来不是再给你一个枚举，而是把总线异常重新压回 **显性/隐性电平、固定字段、边沿密度、时间戳模式和故障域隔离** 这几条可审计链路。这个主题要解决的核心痛点，是把 `bxCAN` 的 `ESR.LEC`、`TEC/REC`、错误时间戳与发送上下文串成一份“错误指纹”，让工程调试从“重启试试”升级成“先重建出错的物理语义，再决定该查布线、位时序、收发器还是对端缺席”。

## 核心底层概念解析

- **`LEC` 不是判决书，而是“最近一次偏离链路合同的位级标签”**：`bxCAN` 的 `ESR.LEC` 只锁存最近一类链路层错误。它告诉你“最近一次坏在哪里”，却不会自动保留完整历史，所以一旦不在错误回调里第一时间抓取时间戳、`TEC/REC` 和上下文，后面看到的往往只剩一句失真的摘要。

- **Bit Recessive 与 Bit Dominant 的差别，来自“线与”电路上的读回现实，而不是名字好不好记**：若节点发送**隐性位**却读回**显性位**，可抽象为 **Bit Recessive Error**，这意味着总线上有外部 dominant 把你的 recessive 压住；若节点发送**显性位**却读回**隐性位**，则更像 **Bit Dominant Error**，优先怀疑收发器驱动不足、开路、共模越界或隔离电源掉压。这里的关键不是术语，而是**发送意图与物理读回之间的差值**。

- **ACK Error 首先是“可达性共识失败”，不是先验噪声结论**：ACK 槽里发送端本来输出 recessive，至少一个正确接收的节点要把它覆写成 dominant。若 `LEC=ACK`，最先该问的是“有没有任何节点愿意承认收到”，而不是直接把锅甩给 EMI。单节点上电、静默模式、过滤器全拒收、对端掉电、波特率不一致，都会表现成 ACK Error。

- **Stuff / Form / CRC 三类错误，对应三条完全不同的物理怀疑链**：**Stuff Error** 常指边沿密度合同被破坏，可能是振铃、采样点漂移或时序裕量不够；**Form Error** 常落在 CRC delimiter、ACK delimiter、EOF 这类固定格式字段，说明“本该绝对干净的固定区间被污染了”；**CRC Error** 则更像有效载荷比特在传输途中被翻转，或者接收端采样到的位流与发送端实际位流已不一致。

- **Error Active / Error Passive 改写的不只是扰动能力，也会改写你在波形上看到的戏剧性**：同样一类根因，在 Error Active 下会用 dominant error flag 明显“砸断”总线；到了 Error Passive，同类问题可能只留下更隐蔽的错误计数爬升与局部定界异常。也就是说，**可见症状的强弱不完全等于根因的强弱**，还取决于节点当前错误状态。

- **`TEC/REC` 是“谁在为错误买单”的信任账本**：工程上可以先用一个粗粒度指标感知故障更偏发送侧还是接收侧：  
  `r_trouble ≈ ΔTEC / (ΔREC + 1)`。  
  若 `r_trouble >> 1`，说明发送路径在更快失去总线信任；若 `ΔREC` 持续高于 `ΔTEC`，则更像本节点主要在“看错别人的帧”。它不是标准定义式，而是一种把错误演化方向压缩成可读趋势的工程化近似。

- **错误直方图不是 Excel 审美，而是从孤例走向统计证据的第一步**：若某类错误计数为 `N_i`，总错误数为 `N_sum`，则可以定义  
  `ρ_i = N_i / N_sum`。  
  只有当你知道 **ACK 占 70%** 还是 **Stuff 占 70%**，后续调试路径才会分叉：前者先查网络存在性，后者先查边沿与时序，后两步完全不是一回事。

- **时间戳序列比单次波形更容易抓住周期性干扰**：记连续错误时间戳为 `t_err[n]`，则间隔为  
  `Δt_err[n] = t_err[n] - t_err[n-1]`。  
  若错误由周期性源注入，则可疑干扰频率可近似估成  
  `f_suspect ≈ 1 / median(Δt_err)`。  
  这里故意用 `median` 而不是 `mean`，是为了降低偶发丢样本、连续重发和任务抢占带来的离群值污染。

- **把时间模式映射回电机 PWM、DC/DC 开关频率和周期任务，往往比盯平均总线负载更快**：如果 `Δt_err` 的中位数稳定落在 `50 us` 左右，你该先想到 `20 kHz` PWM；如果落在 `1000 us` 左右，可能是 `1 kHz` 控制任务、同步采样或周期广播边界。很多所谓“CAN 随机错误”，本质上是**另一个周期系统在总线侧留下了时域指纹**。

- **真正高效的调试顺序不是“换板子试试”，而是“错误指纹 -> 故障域 -> 验证试验”**：先通过 `LEC + TEC/REC + 时间戳` 判断它更像 ACK 缺失、dominant 注入、驱动不足还是边沿污染；再做针对性实验——拔掉其余节点、改变采样点、降低 PWM 边沿速度、切换终端、局部屏蔽地回流。只有这样，CAN 调试才会从经验玄学变成一条能复现、能收敛的工程闭环。

## 代码能力展现

下面给出一段基于 **STM32 HAL `bxCAN`** 风格的错误指纹监视骨架。代码刻意把重点放在四件真正能把错误从“日志字符串”压回“物理因果链”的事情上：

- 在 `HAL_CAN_ErrorCallback()` 里第一时间锁存 `ESR.LEC / TEC / REC`；
- 用 `TIM2` 的 **1 MHz 自由运行时间戳** 记录每次错误的到达时刻；
- 用发送包装函数给错误事件补上**发送上下文**；
- 从 **错误直方图 + 时间间隔分布** 里构造一个可落地的根因域推断。

这段代码假设：

- `TIM2` 已被配置成 32-bit、`1 MHz` 自由运行计数器；
- `hcan1` 工作在经典 `bxCAN` 模式；
- 你愿意把真正的发送入口收口到一个包装函数，而不是让每个业务任务直接裸调 `HAL_CAN_AddTxMessage()`；
- 根因分类是**工程启发式**，不是标准强判决，它的目标是收敛排查方向，而不是替代示波器。

```c
#include "main.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define CAN_DIAG_EVENT_DEPTH                 32U
#define CAN_DIAG_INTERVAL_DEPTH              31U
#define CAN_DIAG_DEFAULT_TIM_HZ              1000000U
#define CAN_DIAG_MIN_BITRATE_HZ              10000U
#define CAN_DIAG_MAX_DLC                     8U
#define CAN_DIAG_MIN_TX_CONTEXT_US           300U
#define CAN_DIAG_MAX_PERIOD_SCORE            1.0f
#define CAN_DIAG_MIN_PERIOD_SCORE            0.0f
#define CAN_DIAG_EPSILON_F                   1.0e-6f

/* bxCAN ESR 寄存器字段位置：
 * [6:4]  LEC  最后错误码
 * [23:16] TEC 发送错误计数
 * [31:24] REC 接收错误计数
 */
#define CAN_DIAG_ESR_LEC_POS                 4U
#define CAN_DIAG_ESR_LEC_MASK                (0x7UL << CAN_DIAG_ESR_LEC_POS)
#define CAN_DIAG_ESR_TEC_POS                 16U
#define CAN_DIAG_ESR_REC_POS                 24U

typedef enum
{
    CAN_DIAG_LEC_NONE = 0U,
    CAN_DIAG_LEC_STUFF = 1U,
    CAN_DIAG_LEC_FORM = 2U,
    CAN_DIAG_LEC_ACK = 3U,
    CAN_DIAG_LEC_BIT_RECESSIVE = 4U,
    CAN_DIAG_LEC_BIT_DOMINANT = 5U,
    CAN_DIAG_LEC_CRC = 6U,
    CAN_DIAG_LEC_OTHER = 7U
} CanDiagLec_t;

typedef enum
{
    CAN_DIAG_DOMAIN_NONE = 0U,
    CAN_DIAG_DOMAIN_REACHABILITY,
    CAN_DIAG_DOMAIN_EXTERNAL_DOMINANT_INJECTION,
    CAN_DIAG_DOMAIN_TX_DRIVE_WEAKNESS,
    CAN_DIAG_DOMAIN_TIMING_OR_EMI,
    CAN_DIAG_DOMAIN_DATA_INTEGRITY,
    CAN_DIAG_DOMAIN_MIXED
} CanDiagFaultDomain_t;

typedef struct
{
    uint32_t timestamp_us;
    uint32_t esr_snapshot;
    uint16_t std_id_hint;
    uint8_t tec;
    uint8_t rec;
    uint8_t tx_context;
    CanDiagLec_t lec;
} CanDiagEvent_t;

typedef struct
{
    CanDiagLec_t dominant_lec;
    CanDiagFaultDomain_t domain;
    float dominant_ratio;
    float ack_ratio_vs_tx;
    float periodicity_score;
    float suspect_frequency_hz;
    uint8_t tec;
    uint8_t rec;
} CanDiagSummary_t;

typedef struct
{
    CAN_HandleTypeDef *hcan;
    TIM_HandleTypeDef *htim;

    uint32_t timer_hz;
    uint32_t nominal_bitrate_hz;
    uint32_t tx_context_window_us;

    volatile uint32_t tx_request_count;
    volatile uint32_t total_error_count;
    volatile uint32_t lec_hist[8];

    volatile uint32_t last_tx_request_us;
    volatile uint16_t last_tx_std_id;
    volatile uint8_t has_tx_context;

    volatile uint32_t last_error_us;
    volatile uint8_t has_last_error;

    volatile uint8_t event_head;
    volatile uint8_t event_count;
    CanDiagEvent_t events[CAN_DIAG_EVENT_DEPTH];

    volatile uint8_t interval_head;
    volatile uint8_t interval_count;
    uint32_t intervals_us[CAN_DIAG_INTERVAL_DEPTH];
} CanDiagMonitor_t;

extern CAN_HandleTypeDef hcan1;
extern TIM_HandleTypeDef htim2;

static CanDiagMonitor_t g_can1_diag;

static float CanDiag_ClampF(float value, float min_value, float max_value)
{
    if (value < min_value)
    {
        return min_value;
    }

    if (value > max_value)
    {
        return max_value;
    }

    return value;
}

static uint32_t CanDiag_GetNowUs(const CanDiagMonitor_t *diag)
{
    /* 假设 TIM2 已配置成 1 MHz 自由运行计数器，因此 CNT 直接就是 us。 */
    return __HAL_TIM_GET_COUNTER(diag->htim);
}

static uint32_t CanDiag_ElapsedUs(uint32_t now_us, uint32_t then_us)
{
    /* 32-bit 递增计数器上，unsigned 减法天然支持回绕。 */
    return (uint32_t)(now_us - then_us);
}

static uint8_t CanDiag_GetTec(uint32_t esr)
{
    return (uint8_t)((esr >> CAN_DIAG_ESR_TEC_POS) & 0xFFU);
}

static uint8_t CanDiag_GetRec(uint32_t esr)
{
    return (uint8_t)((esr >> CAN_DIAG_ESR_REC_POS) & 0xFFU);
}

/**
 * @brief 从 bxCAN ESR 快照中解析最后错误码 LEC。
 * @param esr bxCAN ESR 寄存器快照。
 * @return 解码后的 LEC 枚举。
 *
 * @note 这里故意只把 1~6 当成有效链路层标签：
 *       1 = Stuff Error
 *       2 = Form Error
 *       3 = Acknowledgment Error
 *       4 = Bit Recessive Error（发 recessive 却读到 dominant）
 *       5 = Bit Dominant Error（发 dominant 却读到 recessive）
 *       6 = CRC Error
 *
 *       0 表示当前没有新的已锁存错误；7 统一并入 OTHER，
 *       让上层把它视为“无法直接用于根因指纹”的杂项状态。
 */
static CanDiagLec_t CanDiag_DecodeLec(uint32_t esr)
{
    const uint32_t code = (esr & CAN_DIAG_ESR_LEC_MASK) >> CAN_DIAG_ESR_LEC_POS;

    switch (code)
    {
        case 1U: return CAN_DIAG_LEC_STUFF;
        case 2U: return CAN_DIAG_LEC_FORM;
        case 3U: return CAN_DIAG_LEC_ACK;
        case 4U: return CAN_DIAG_LEC_BIT_RECESSIVE;
        case 5U: return CAN_DIAG_LEC_BIT_DOMINANT;
        case 6U: return CAN_DIAG_LEC_CRC;
        case 0U: return CAN_DIAG_LEC_NONE;
        default: return CAN_DIAG_LEC_OTHER;
    }
}

static void CanDiag_PushInterval(CanDiagMonitor_t *diag, uint32_t delta_us)
{
    diag->intervals_us[diag->interval_head] = delta_us;
    diag->interval_head = (uint8_t)((diag->interval_head + 1U) % CAN_DIAG_INTERVAL_DEPTH);

    if (diag->interval_count < CAN_DIAG_INTERVAL_DEPTH)
    {
        diag->interval_count++;
    }
}

static void CanDiag_PushEvent(CanDiagMonitor_t *diag, const CanDiagEvent_t *event)
{
    diag->events[diag->event_head] = *event;
    diag->event_head = (uint8_t)((diag->event_head + 1U) % CAN_DIAG_EVENT_DEPTH);

    if (diag->event_count < CAN_DIAG_EVENT_DEPTH)
    {
        diag->event_count++;
    }
}

/**
 * @brief 初始化 CAN 错误指纹监视器。
 * @param diag 监视器对象。
 * @param hcan 绑定的 bxCAN 句柄。
 * @param htim 提供 1 MHz 时间戳的定时器句柄。
 * @param nominal_bitrate_hz 总线标称波特率。
 *
 * @note 发送上下文窗口使用保守近似：
 *       T_ctx ≈ 3 * N_frame,worst / bitrate
 *
 *       其中 N_frame,worst 对 11-bit ID + DLC8 的经典帧按 150 bit 级别保守估算。
 *       乘 3 的目的不是追求数学精确，而是覆盖：
 *       1. 一次发送尝试；
 *       2. 错误帧定界；
 *       3. 一次短暂重发等待。
 */
static void CanDiag_Init(CanDiagMonitor_t *diag,
                         CAN_HandleTypeDef *hcan,
                         TIM_HandleTypeDef *htim,
                         uint32_t nominal_bitrate_hz)
{
    uint32_t context_window_us;

    if ((diag == NULL) || (hcan == NULL) || (htim == NULL))
    {
        return;
    }

    memset(diag, 0, sizeof(*diag));

    diag->hcan = hcan;
    diag->htim = htim;
    diag->timer_hz = CAN_DIAG_DEFAULT_TIM_HZ;
    diag->nominal_bitrate_hz = (nominal_bitrate_hz < CAN_DIAG_MIN_BITRATE_HZ)
                                ? CAN_DIAG_MIN_BITRATE_HZ
                                : nominal_bitrate_hz;

    context_window_us = (3U * 150U * 1000000U) / diag->nominal_bitrate_hz;
    if (context_window_us < CAN_DIAG_MIN_TX_CONTEXT_US)
    {
        context_window_us = CAN_DIAG_MIN_TX_CONTEXT_US;
    }
    diag->tx_context_window_us = context_window_us;
}

/**
 * @brief 在真正发报文前登记发送上下文。
 * @param diag 监视器对象。
 * @param std_id 即将发送的标准帧 ID。
 *
 * @note 这里并不试图证明“哪一位一定由这次发送引起”，
 *       而是用一段有限时间窗把错误事件粗分成“更像发送路径”或“更像纯接收路径”。
 */
static void CanDiag_NotifyTxRequest(CanDiagMonitor_t *diag, uint16_t std_id)
{
    uint32_t now_us;

    if ((diag == NULL) || (diag->htim == NULL))
    {
        return;
    }

    now_us = CanDiag_GetNowUs(diag);

    diag->last_tx_request_us = now_us;
    diag->last_tx_std_id = (uint16_t)(std_id & 0x7FFU);
    diag->has_tx_context = 1U;
    diag->tx_request_count++;
}

/**
 * @brief 在 HAL 错误回调中锁存一条错误事件。
 * @param diag 监视器对象。
 * @param esr bxCAN ESR 快照。
 *
 * @note 连续错误时间戳序列 t[n] 可导出：
 *       Δt[n] = t[n] - t[n-1]
 *       f_suspect ≈ 10^6 / median(Δt_us)
 *
 *       这让代码不只知道“错了多少次”，还知道“它像不像某个固定频率在敲总线”。
 */
static void CanDiag_RecordErrorFromIsr(CanDiagMonitor_t *diag, uint32_t esr)
{
    CanDiagEvent_t event;
    uint32_t now_us;
    CanDiagLec_t lec;

    if ((diag == NULL) || (diag->htim == NULL))
    {
        return;
    }

    now_us = CanDiag_GetNowUs(diag);
    lec = CanDiag_DecodeLec(esr);
    if (lec == CAN_DIAG_LEC_NONE)
    {
        return;
    }

    event.timestamp_us = now_us;
    event.esr_snapshot = esr;
    event.lec = lec;
    event.tec = CanDiag_GetTec(esr);
    event.rec = CanDiag_GetRec(esr);
    event.std_id_hint = diag->last_tx_std_id;
    event.tx_context = 0U;

    if ((diag->has_tx_context != 0U) &&
        (CanDiag_ElapsedUs(now_us, diag->last_tx_request_us) <= diag->tx_context_window_us))
    {
        event.tx_context = 1U;
    }

    if (diag->has_last_error != 0U)
    {
        CanDiag_PushInterval(diag, CanDiag_ElapsedUs(now_us, diag->last_error_us));
    }

    diag->has_last_error = 1U;
    diag->last_error_us = now_us;
    diag->total_error_count++;
    diag->lec_hist[(uint32_t)lec]++;

    CanDiag_PushEvent(diag, &event);
}

static uint8_t CanDiag_GetDominantLecIndex(const CanDiagMonitor_t *diag)
{
    uint8_t best_index = (uint8_t)CAN_DIAG_LEC_NONE;
    uint32_t best_count = 0U;
    uint32_t i;

    for (i = 1U; i <= 6U; ++i)
    {
        if (diag->lec_hist[i] > best_count)
        {
            best_count = diag->lec_hist[i];
            best_index = (uint8_t)i;
        }
    }

    return best_index;
}

/**
 * @brief 计算最近错误间隔的中位数。
 * @param diag 监视器对象。
 * @return 中位数间隔，单位 us；无数据时返回 0。
 *
 * @note 使用 median 而非 mean，是因为错误事件常含离群值：
 *       - 某一次连续重发把间隔拉得极短；
 *       - 某一次长时间空闲又把间隔拉得极长。
 *       对“它像不像固定频率源”这个问题，中位数更稳。
 */
static uint32_t CanDiag_GetMedianIntervalUs(const CanDiagMonitor_t *diag)
{
    uint32_t scratch[CAN_DIAG_INTERVAL_DEPTH];
    uint32_t i;
    uint32_t j;
    const uint32_t count = diag->interval_count;

    if (count == 0U)
    {
        return 0U;
    }

    for (i = 0U; i < count; ++i)
    {
        scratch[i] = diag->intervals_us[i];
    }

    /* 小样本窗口下，插入排序足够直接且稳定。 */
    for (i = 1U; i < count; ++i)
    {
        const uint32_t key = scratch[i];
        j = i;

        while ((j > 0U) && (scratch[j - 1U] > key))
        {
            scratch[j] = scratch[j - 1U];
            j--;
        }

        scratch[j] = key;
    }

    return scratch[count / 2U];
}

/**
 * @brief 计算错误间隔的“周期性评分”。
 * @param diag 监视器对象。
 * @return 0.0 ~ 1.0，越接近 1 表示间隔越像稳定周期源。
 *
 * @note 定义：
 *       μ = mean(Δt)
 *       σ = std(Δt)
 *       score = clamp(1 - σ / (μ + ε), 0, 1)
 *
 *       它不是统计学上的严格周期检验，而是一个足够工程化的启发式：
 *       当 Δt 抖动远小于均值时，score 会明显抬高。
 */
static float CanDiag_GetPeriodicityScore(const CanDiagMonitor_t *diag)
{
    float mean_us = 0.0f;
    float variance = 0.0f;
    uint32_t i;
    const uint32_t count = diag->interval_count;

    if (count < 3U)
    {
        return 0.0f;
    }

    for (i = 0U; i < count; ++i)
    {
        mean_us += (float)diag->intervals_us[i];
    }
    mean_us /= (float)count;

    for (i = 0U; i < count; ++i)
    {
        const float delta = (float)diag->intervals_us[i] - mean_us;
        variance += delta * delta;
    }
    variance /= (float)(count - 1U);

    return CanDiag_ClampF(1.0f - sqrtf(variance) / (mean_us + CAN_DIAG_EPSILON_F),
                          CAN_DIAG_MIN_PERIOD_SCORE,
                          CAN_DIAG_MAX_PERIOD_SCORE);
}

/**
 * @brief 根据统计结果把错误收敛到一个优先排查的故障域。
 * @param summary 已构建好的错误摘要。
 * @return 根因域枚举。
 *
 * @note 这里使用的是工程启发式，而不是标准强判定：
 *       - ACK 占优：先查网络存在性、过滤器、静默模式、对端掉电；
 *       - Bit Recessive 占优：先查外部 dominant 注入、短路到地、强噪声；
 *       - Bit Dominant 占优：先查收发器驱动、开路、隔离供电与共模范围；
 *       - Stuff/Form 且周期性高：先查位时序边界、振铃、PWM 共模注入；
 *       - CRC 占优：先查数据完整性、采样稳定性与收发器信号质量。
 */
static CanDiagFaultDomain_t CanDiag_ClassifyDomain(const CanDiagSummary_t *summary)
{
    if (summary->dominant_ratio <= 0.0f)
    {
        return CAN_DIAG_DOMAIN_NONE;
    }

    if ((summary->dominant_lec == CAN_DIAG_LEC_ACK) && (summary->ack_ratio_vs_tx >= 0.25f))
    {
        return CAN_DIAG_DOMAIN_REACHABILITY;
    }

    if ((summary->dominant_lec == CAN_DIAG_LEC_BIT_RECESSIVE) && (summary->dominant_ratio >= 0.40f))
    {
        return CAN_DIAG_DOMAIN_EXTERNAL_DOMINANT_INJECTION;
    }

    if ((summary->dominant_lec == CAN_DIAG_LEC_BIT_DOMINANT) && (summary->dominant_ratio >= 0.40f))
    {
        return CAN_DIAG_DOMAIN_TX_DRIVE_WEAKNESS;
    }

    if (((summary->dominant_lec == CAN_DIAG_LEC_STUFF) ||
         (summary->dominant_lec == CAN_DIAG_LEC_FORM)) &&
        (summary->periodicity_score >= 0.65f))
    {
        return CAN_DIAG_DOMAIN_TIMING_OR_EMI;
    }

    if ((summary->dominant_lec == CAN_DIAG_LEC_CRC) &&
        ((summary->rec >= summary->tec) || (summary->periodicity_score >= 0.50f)))
    {
        return CAN_DIAG_DOMAIN_DATA_INTEGRITY;
    }

    return CAN_DIAG_DOMAIN_MIXED;
}

/**
 * @brief 基于累计直方图和最近时间序列构建一份错误摘要。
 * @param diag 监视器对象。
 * @param summary_out 输出摘要。
 *
 * @note 关键量包括：
 *       1. dominant_ratio = N_dom / N_total
 *       2. ack_ratio_vs_tx = N_ack / N_tx_request
 *       3. suspect_freq_hz ≈ 10^6 / median(Δt_us)
 *
 *       它们分别对应：
 *       - 哪类错误最占主导；
 *       - 发送可达性是否显著失真；
 *       - 错误是否带有稳定时域指纹。
 */
static void CanDiag_BuildSummary(const CanDiagMonitor_t *diag, CanDiagSummary_t *summary_out)
{
    uint8_t dominant_index;
    uint32_t dominant_count;
    uint32_t median_interval_us;

    if ((diag == NULL) || (summary_out == NULL))
    {
        return;
    }

    memset(summary_out, 0, sizeof(*summary_out));

    dominant_index = CanDiag_GetDominantLecIndex(diag);
    dominant_count = diag->lec_hist[dominant_index];
    median_interval_us = CanDiag_GetMedianIntervalUs(diag);

    summary_out->dominant_lec = (CanDiagLec_t)dominant_index;
    summary_out->tec = (diag->event_count == 0U)
                       ? 0U
                       : diag->events[(diag->event_head + CAN_DIAG_EVENT_DEPTH - 1U) % CAN_DIAG_EVENT_DEPTH].tec;
    summary_out->rec = (diag->event_count == 0U)
                       ? 0U
                       : diag->events[(diag->event_head + CAN_DIAG_EVENT_DEPTH - 1U) % CAN_DIAG_EVENT_DEPTH].rec;

    if (diag->total_error_count > 0U)
    {
        summary_out->dominant_ratio = (float)dominant_count / (float)diag->total_error_count;
    }

    if (diag->tx_request_count > 0U)
    {
        summary_out->ack_ratio_vs_tx =
            (float)diag->lec_hist[CAN_DIAG_LEC_ACK] / (float)diag->tx_request_count;
    }

    summary_out->periodicity_score = CanDiag_GetPeriodicityScore(diag);
    summary_out->suspect_frequency_hz = (median_interval_us == 0U)
                                        ? 0.0f
                                        : (1000000.0f / (float)median_interval_us);
    summary_out->domain = CanDiag_ClassifyDomain(summary_out);
}

/**
 * @brief 发送一帧标准 CAN 数据，并给错误诊断链登记发送上下文。
 * @param hcan bxCAN 句柄。
 * @param std_id 11-bit 标准帧 ID。
 * @param payload 数据指针；DLC=0 时可为 NULL。
 * @param dlc 数据长度，0~8。
 * @return HAL 状态码。
 */
HAL_StatusTypeDef CanBus_SendStdWithDiag(CAN_HandleTypeDef *hcan,
                                         uint16_t std_id,
                                         const uint8_t *payload,
                                         uint8_t dlc)
{
    CAN_TxHeaderTypeDef tx_header;
    uint32_t mailbox = 0U;

    if ((hcan == NULL) || (dlc > CAN_DIAG_MAX_DLC) || ((payload == NULL) && (dlc > 0U)))
    {
        return HAL_ERROR;
    }

    memset(&tx_header, 0, sizeof(tx_header));
    tx_header.StdId = (uint32_t)(std_id & 0x7FFU);
    tx_header.IDE = CAN_ID_STD;
    tx_header.RTR = CAN_RTR_DATA;
    tx_header.DLC = dlc;
    tx_header.TransmitGlobalTime = DISABLE;

    /* 先登记“我要发了”，再真正入邮箱。这样即使稍后马上出现 ACK/Bit Error，
     * 错误回调也能拿到相对可信的发送上下文窗口。 */
    CanDiag_NotifyTxRequest(&g_can1_diag, std_id);

    return HAL_CAN_AddTxMessage(hcan, &tx_header, (uint8_t *)payload, &mailbox);
}

void CanDiag_AppInit(void)
{
    CanDiag_Init(&g_can1_diag, &hcan1, &htim2, 500000U);
}

void HAL_CAN_ErrorCallback(CAN_HandleTypeDef *hcan)
{
    if ((hcan == NULL) || (hcan != g_can1_diag.hcan))
    {
        return;
    }

    /* 在错误回调第一时间抓 ESR，避免后续任务上下文再读时，
     * “最近一次错误”已经被新的错误或其他状态覆盖。 */
    CanDiag_RecordErrorFromIsr(&g_can1_diag, hcan->Instance->ESR);
}

/**
 * @brief 周期任务中读取错误摘要，并据此决定接下来的排查动作。
 * @param summary_out 输出摘要。
 * @return true 表示已经拿到至少一条错误历史；false 表示暂时没有诊断样本。
 */
bool CanDiag_GetLatestSummary(CanDiagSummary_t *summary_out)
{
    if ((summary_out == NULL) || (g_can1_diag.total_error_count == 0U))
    {
        return false;
    }

    CanDiag_BuildSummary(&g_can1_diag, summary_out);
    return true;
}
```

这段实现真正想表达的，不是“怎么把 `LEC` 打印出来”，而是三条更底层的工程约束：

- `HAL_CAN_ErrorCallback()` 里的第一拍，不是做复杂恢复，而是**锁存证据**；
- `LEC` 只有和 `TEC/REC`、发送上下文、时间戳间隔绑在一起，才会从枚举值变成**故障指纹**；
- 调试动作应该围绕 `CanDiagSummary_t` 给出的**故障域**去设计验证试验，而不是把 ACK、Stuff、Bit Error 一股脑都归类成“CAN 不稳定”。

如果你愿意继续往下做，这套骨架下一步最值得补的通常不是更多日志，而是两类“闭环验证”：第一类是把 `suspect_frequency_hz` 去和 PWM、DC/DC、同步采样、周期报文做交叉比对；第二类是把 `domain` 结果直接映射成实验菜单，例如 **ACK 主导 -> 断开其他节点看是否变单节点 ACK 缺失；Bit Recessive 主导 -> 查短路到地和 dominant 注入；Stuff/Form + 高周期性 -> 改采样点、减缓开关沿、加共模回流约束**。做到这一步，`LEC` 才真正从一个寄存器字段变成总线调试里的物理显微镜。
