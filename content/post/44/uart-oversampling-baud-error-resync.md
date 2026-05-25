---
title: "技能档案：UART 接收的隐性合同，从过采样、波特率误差到空闲帧重同步"
slug: "skill-uart-oversampling-baud-error-and-idle-resynchronization"
date: 2026-05-23T10:18:00+08:00
draft: false
description: "从起始位边沿、16 倍过采样、累计相位漂移到 IDLE 重同步，系统拆解 UART 为什么常死在时钟误差与帧边界恢复，而不是串口 API。"
tags: ["UART", "STM32", "过采样", "波特率", "重同步", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

UART 真正解决的，不是“单片机之间发几个字节”这么表面的接口问题，而是如何在**没有共享时钟线**的前提下，让两个独立振荡器驱动的系统在有限误差里完成逐位采样。它广泛存在于调试日志、GNSS 模块、蓝牙透传、视觉串口回传、工业控制器和 Bootloader 链路中，核心痛点从来不是 `HAL_UART_Transmit()` 会不会返回成功，而是当本地时钟和对端时钟并不完全一致、线路边沿有抖动、帧与帧之间没有固定间隔、DMA 长收包混进半帧垃圾时，接收端还能不能在正确的位中心把信息采到。UART 本质上不是“TX/RX 两根线”，而是一份关于**时间基误差、过采样投票和帧边界恢复**的隐性合同。

## 核心底层概念解析

- **UART 是异步通信，真正缺失的不是时钟引脚，而是每一位的共同时间原点**：SPI 和 I2C 都有显式时钟，接收端只需跟着采样；UART 没有外部时钟，接收端只能靠起始位边沿推断“现在是一帧的第 0 位”，然后用自己的本地时钟往后数。这意味着一旦起点找偏、或者后续位周期估错，误差会在整帧里持续累计。
- **起始位不是普通低电平，它是接收状态机重新锁定时间轴的触发器**：线路空闲时 UART 维持高电平，发送端把线从高拉低形成起始位，接收端检测到这个高到低边沿后，才开始启动位定时。也就是说，UART 真正拿来同步的不是电平值，而是一次边沿事件。
- **过采样的价值不是“采得更密”，而是给边沿抖动和频偏留投票余地**：STM32 常见 16 倍过采样或 8 倍过采样。以 16 倍为例，每个比特时间被切成 16 个子周期，接收器通常不会在第 0 个子周期立刻判决，而会在靠近位中心的位置采若干次再投票。这样即便起始位检测稍有抖动，或者线上边沿有一点毛刺，仍能靠中点附近的多数票守住判决。
- **位中心采样本质上是在对抗累计相位漂移**：如果理想位周期为 `T_bit`，发送端实际为 `T_tx`，接收端本地估计为 `T_rx`，那么到第 `k` 位采样中心时，累计时间偏差近似为 `Delta t_k ≈ k * (T_rx - T_tx)`。只要这个偏差在采样窗口内没越过相邻位边界，接收仍可能正确；一旦跨过边界，后面的位即使电平本身没错，也会被采到隔壁位去。
- **波特率误差真正危险的不是单拍误差，而是整帧误差积累到停止位**：UART 往往从起始位一路盲跑到数据位、校验位、停止位，中间没有新的强制重同步。因此总误差预算常按“到最后一个采样点仍落在合法位窗内”来算。对于常见的 `8N1` 帧，接收端至少要连续跨过 10 个 bit 时间，任何本振偏差、分频量化误差和线路抖动都会被一路积分到帧尾。
- **过采样倍数提升了抗抖动能力，但会压缩高波特率下的分频自由度**：16 倍过采样下，波特率生成器需要产生更高的内部采样时钟，优点是位中心定位更细，缺点是当外设时钟有限时，分频器可选整数和小数组合变少，某些目标波特率的量化误差反而更大。8 倍过采样则相反，采样分辨率更粗，但在高波特率下更容易凑出较小的分频误差。
- **波特率生成不是“填个 115200”那么简单，它本质上是时钟整数量化问题**：若 UART 外设时钟为 `f_ck`，过采样倍率为 `OSR`，则目标分频近似为 `USARTDIV = f_ck / (OSR * baud)`。寄存器无法表示连续实数，只能编码成有限精度的小数，因此实际波特率会变成 `baud_actual = f_ck / (OSR * USARTDIV_quantized)`。真正的风险不在公式本身，而在量化后的误差是否还落在整帧允许范围内。
- **线路噪声与毛刺最容易破坏的不是数据位，而是起始位判定**：数据位判错只会污染当前 bit；而如果一段毛刺被误认为起始位，接收端会在完全错误的时间基上采完整帧，最后往往表现为整字节乱值、帧错误或连续乱码。这也是为什么很多 UART 问题看起来像“偶发随机字节”，本质却是起始位误锁。
- **停止位的物理意义不是“多发一个 1”，而是为下一帧提供重新回到空闲态的缓冲区**：停止位要求线路维持高电平至少 1 bit 或更久，它既让接收端验证“这一帧是否正常结束”，也给下一次起始位的高到低边沿提供清晰的对比背景。没有足够的空闲高电平，帧与帧之间就容易粘连成难以重新锁定的长波形。
- **IDLE 检测的真正价值不是“收包结束回调”，而是把长字节流重新切回帧级语义**：在 DMA 环形接收场景里，硬件只是不断把字节搬进内存，并不知道业务报文何时结束。`IDLE` 中断本质上是在检测“线路经历了至少 1 帧时间的空闲”，于是接收端可以借此确认一段连续字节已经结束，并在应用层重新建立包边界与状态清理点。
- **重同步不是只有收到下一次起始位才发生，工程上往往要主动借空闲窗清理坏状态**：如果前一段数据因噪声、频偏或丢字节而半帧错位，继续沿用旧 DMA 写指针、旧状态机和旧报文解析上下文，问题只会扩散。利用 IDLE 事件在空闲窗重置解析游标、截断尾部残包，等价于在业务层补了一次“软重同步”。
- **UART 的技术哲学，不是确保每个字节都永不出错，而是让接收端知道自己何时仍在正确时间轴上、何时已经偏航并如何尽快回到边界清晰的空闲态**：真正可靠的串口链路，从来不是盲信数据，而是对时间误差保持敏感。

## 代码能力展现

下面给出一个基于 STM32 HAL 的稳健 UART 接收封装。代码重点不在基础初始化，而在三条更容易被忽略的链路上：**根据过采样倍率搜索更小波特率误差**、**显式估算整帧累计误差是否还在采样窗口预算内**、**利用 DMA + IDLE 把连续字节流切回报文边界并在空闲窗完成软重同步**。示例假设业务侧按“空闲即一包”消费串口数据，适用于 GNSS、视觉模块和自定义二进制帧等典型场景。

```c
#include "stm32f4xx_hal.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define UART_IDLE_DMA_BUFFER_SIZE                256U
#define UART_FRAME_BITS_8N1                      10U
#define UART_BAUD_ERROR_LIMIT_PERCENT            2.0f
#define UART_BAUD_ERROR_BEST_INIT_PERCENT        1000.0f
#define UART_OSR_8                               8U
#define UART_OSR_16                              16U
#define UART_WORD_LENGTH_BYTES                   1U
#define UART_PACKET_MAX_SIZE                     128U

typedef struct
{
    uint32_t baud;
    uint32_t oversampling;
    uint16_t brr;
    float actual_baud;
    float baud_error_percent;
    float end_of_frame_drift_percent;
} UartTimingChoice_t;

typedef struct
{
    UART_HandleTypeDef *huart;
    DMA_HandleTypeDef *hdma_rx;
    uint8_t dma_buffer[UART_IDLE_DMA_BUFFER_SIZE];
    uint8_t packet_buffer[UART_PACKET_MAX_SIZE];
    volatile uint16_t dma_last_pos;
    volatile uint16_t packet_size;
    volatile uint8_t packet_ready;
    volatile uint32_t idle_count;
    volatile uint32_t overrun_count;
    volatile uint32_t frame_error_count;
} UartIdleRx_t;

static float Uart_AbsFloat(float value)
{
    return (value >= 0.0f) ? value : -value;
}

static float Uart_ClampFloat(float value, float min_value, float max_value)
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

static uint16_t Uart_ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static uint16_t Uart_DmaGetWritePos(const UartIdleRx_t *rx)
{
    return (uint16_t)(UART_IDLE_DMA_BUFFER_SIZE - __HAL_DMA_GET_COUNTER(rx->hdma_rx));
}

/**
 * @brief 估算某组 UART 时序参数下的实际波特率与帧尾累计漂移。
 * @param periph_clk_hz UART 外设时钟，单位 Hz。
 * @param baud 目标波特率。
 * @param oversampling 过采样倍率，常见为 8 或 16。
 * @param out_choice 输出时序候选。
 * @retval true  该组合可被寄存器表示。
 * @retval false 参数非法或分频结果越界。
 *
 * @note 波特率生成近似关系：
 *       USARTDIV = f_ck / (OSR * baud_target)
 *       baud_actual = f_ck / (OSR * USARTDIV_quantized)
 *
 *       相对误差：
 *       err = (baud_actual - baud_target) / baud_target
 *
 *       由于异步链路在一帧内没有中间重同步，帧尾累计相位漂移可近似估计为：
 *       drift_eof ~= frame_bits * |err|
 *
 *       例如 8N1 为 10 bit，若总误差过大，则停止位采样点可能越过合法位窗。
 */
static bool Uart_ComputeTimingChoice(uint32_t periph_clk_hz,
                                     uint32_t baud,
                                     uint32_t oversampling,
                                     UartTimingChoice_t *out_choice)
{
    const uint32_t osr = (oversampling == UART_OSR_8) ? UART_OSR_8 : UART_OSR_16;
    const float usartdiv_real = (float)periph_clk_hz / ((float)osr * (float)baud);
    const uint32_t mantissa = (uint32_t)usartdiv_real;
    const float fraction_real = usartdiv_real - (float)mantissa;
    uint32_t fraction_scale;
    uint32_t fraction_quantized;
    float usartdiv_quantized;
    float actual_baud;
    float error_percent;

    if ((out_choice == NULL) || (periph_clk_hz == 0U) || (baud == 0U))
    {
        return false;
    }

    if (mantissa == 0U)
    {
        return false;
    }

    /*
     * STM32 USART BRR 的小数位宽随 OSR 变化：
     * - oversampling by 16: fraction 使用 4 bit，量化步距 1/16
     * - oversampling by 8 : fraction 使用 3 bit，量化步距 1/8
     */
    fraction_scale = (osr == UART_OSR_8) ? 8U : 16U;
    fraction_quantized = (uint32_t)lroundf(fraction_real * (float)fraction_scale);

    if (fraction_quantized >= fraction_scale)
    {
        fraction_quantized = 0U;
        if ((mantissa + 1U) > 0x0FFFU)
        {
            return false;
        }

        usartdiv_quantized = (float)(mantissa + 1U);
    }
    else
    {
        usartdiv_quantized = (float)mantissa + ((float)fraction_quantized / (float)fraction_scale);
    }

    if (usartdiv_quantized <= 0.0f)
    {
        return false;
    }

    actual_baud = (float)periph_clk_hz / ((float)osr * usartdiv_quantized);
    error_percent = ((actual_baud - (float)baud) / (float)baud) * 100.0f;

    out_choice->baud = baud;
    out_choice->oversampling = osr;
    out_choice->brr = (uint16_t)((mantissa << 4U) | (fraction_quantized & 0x0FU));
    out_choice->actual_baud = actual_baud;
    out_choice->baud_error_percent = error_percent;
    out_choice->end_of_frame_drift_percent = (float)UART_FRAME_BITS_8N1 * Uart_AbsFloat(error_percent);
    return true;
}

/**
 * @brief 在 8 倍与 16 倍过采样之间选择更稳妥的 UART 时序。
 * @param periph_clk_hz UART 外设时钟，单位 Hz。
 * @param baud 目标波特率。
 * @param out_choice 输出最终选择。
 * @retval true  找到可接受的配置。
 * @retval false 两种过采样模式都无法满足误差预算。
 *
 * @note 选择策略遵循两个层次：
 *       1. 优先比较波特率绝对误差更小的方案；
 *       2. 若误差相近，则优先 16 倍过采样，因为位中心采样粒度更细。
 *
 *       判据并不只看单点波特率误差，还要看帧尾累计漂移：
 *       eof_drift_percent = frame_bits * |baud_error_percent|
 */
bool Uart_SelectBestTiming(uint32_t periph_clk_hz,
                           uint32_t baud,
                           UartTimingChoice_t *out_choice)
{
    UartTimingChoice_t candidate_osr16;
    UartTimingChoice_t candidate_osr8;
    bool has_osr16;
    bool has_osr8;
    float best_error = UART_BAUD_ERROR_BEST_INIT_PERCENT;
    UartTimingChoice_t best_choice = {0};

    if (out_choice == NULL)
    {
        return false;
    }

    has_osr16 = Uart_ComputeTimingChoice(periph_clk_hz, baud, UART_OSR_16, &candidate_osr16);
    has_osr8 = Uart_ComputeTimingChoice(periph_clk_hz, baud, UART_OSR_8, &candidate_osr8);

    if (has_osr16)
    {
        const float abs_error = Uart_AbsFloat(candidate_osr16.baud_error_percent);

        if (abs_error < best_error)
        {
            best_choice = candidate_osr16;
            best_error = abs_error;
        }
    }

    if (has_osr8)
    {
        const float abs_error = Uart_AbsFloat(candidate_osr8.baud_error_percent);
        const bool better_error = (abs_error < best_error);
        const bool tie_but_prefer_osr16 = (fabsf(abs_error - best_error) < 0.05f) &&
                                          (best_choice.oversampling == UART_OSR_16);

        if (better_error || ((!tie_but_prefer_osr16) && (abs_error <= best_error)))
        {
            best_choice = candidate_osr8;
            best_error = abs_error;
        }
    }

    if (best_error > UART_BAUD_ERROR_LIMIT_PERCENT)
    {
        return false;
    }

    /*
     * 帧尾累计漂移不是标准条文里的唯一判据，但它能直观看出
     * “这一帧最后一个采样点已经偏离了多少 bit 百分比”。
     * 超过约 20%~25% 时，停止位安全裕量会明显下降。
     */
    if (best_choice.end_of_frame_drift_percent > 20.0f)
    {
        return false;
    }

    *out_choice = best_choice;
    return true;
}

/**
 * @brief 按计算结果重配 UART 的过采样与 BRR。
 * @param huart HAL UART 句柄。
 * @param choice 已选定的时序参数。
 * @retval true  配置成功。
 * @retval false 参数非法。
 */
bool Uart_ApplyTimingChoice(UART_HandleTypeDef *huart, const UartTimingChoice_t *choice)
{
    if ((huart == NULL) || (choice == NULL))
    {
        return false;
    }

    __HAL_UART_DISABLE(huart);

    if (choice->oversampling == UART_OSR_8)
    {
        huart->Instance->CR1 |= USART_CR1_OVER8;
    }
    else
    {
        huart->Instance->CR1 &= ~USART_CR1_OVER8;
    }

    huart->Instance->BRR = choice->brr;
    __HAL_UART_ENABLE(huart);
    return true;
}

/**
 * @brief 启动 UART DMA + IDLE 接收。
 * @param rx 接收上下文。
 * @retval true  启动成功。
 * @retval false 参数非法或 HAL 启动失败。
 *
 * @note IDLE 中断的意义不是“额外来一次通知”，而是把连续 DMA 字节流
 *       切回“这段数据之后出现了至少 1 帧时间的空闲”这一物理边界。
 */
bool UartIdleRx_Start(UartIdleRx_t *rx)
{
    if ((rx == NULL) || (rx->huart == NULL) || (rx->hdma_rx == NULL))
    {
        return false;
    }

    rx->dma_last_pos = 0U;
    rx->packet_size = 0U;
    rx->packet_ready = 0U;
    rx->idle_count = 0U;
    rx->overrun_count = 0U;
    rx->frame_error_count = 0U;
    memset(rx->dma_buffer, 0, sizeof(rx->dma_buffer));
    memset(rx->packet_buffer, 0, sizeof(rx->packet_buffer));

    __HAL_UART_CLEAR_IDLEFLAG(rx->huart);
    __HAL_UART_ENABLE_IT(rx->huart, UART_IT_IDLE);
    __HAL_UART_ENABLE_IT(rx->huart, UART_IT_ERR);

    return (HAL_UART_Receive_DMA(rx->huart, rx->dma_buffer, UART_IDLE_DMA_BUFFER_SIZE) == HAL_OK);
}

/**
 * @brief 将 DMA 环形缓存中新到达的字节收拢成一帧报文。
 * @param rx 接收上下文。
 * @param start_pos 本次处理的起始 DMA 位置。
 * @param end_pos 本次处理的结束 DMA 位置。
 *
 * @note 这里的“帧”是工程意义上的 IDLE 分段，而不是 UART 硬件字节帧。
 *       一旦检测到 IDLE，就把从 `dma_last_pos` 到当前写指针之间的内容
 *       当作一包完整数据，同时重置业务层游标，实现软重同步。
 */
static void UartIdleRx_CopyRange(UartIdleRx_t *rx, uint16_t start_pos, uint16_t end_pos)
{
    uint16_t packet_index = 0U;
    uint16_t pos = start_pos;

    while (pos != end_pos)
    {
        if (packet_index >= UART_PACKET_MAX_SIZE)
        {
            break;
        }

        rx->packet_buffer[packet_index++] = rx->dma_buffer[pos];
        pos = (uint16_t)((pos + UART_WORD_LENGTH_BYTES) % UART_IDLE_DMA_BUFFER_SIZE);
    }

    rx->packet_size = packet_index;
    rx->packet_ready = (packet_index > 0U) ? 1U : 0U;
}

/**
 * @brief 处理 UART IDLE 事件。
 * @param rx 接收上下文。
 *
 * @note 触发条件是线路经历了至少 1 帧时间的空闲高电平。
 *       这相当于告诉软件：“上一段连续字节已经结束，可以安全切包并清理坏状态。”
 */
void UartIdleRx_OnIdle(UartIdleRx_t *rx)
{
    uint16_t dma_pos;

    if (rx == NULL)
    {
        return;
    }

    __HAL_UART_CLEAR_IDLEFLAG(rx->huart);
    dma_pos = Uart_DmaGetWritePos(rx);

    UartIdleRx_CopyRange(rx, rx->dma_last_pos, dma_pos);
    rx->dma_last_pos = dma_pos;
    rx->idle_count++;
}

/**
 * @brief 处理 UART 错误事件并执行软重同步。
 * @param rx 接收上下文。
 *
 * @note 这里特别关注两类错误：
 *       - ORE: 旧字节未及时搬走，新字节又来了，说明接收链路节奏失配；
 *       - FE : 停止位采样失败，常见于频偏过大、线噪声或半帧错锁。
 *
 *       错误后的策略不是继续相信旧缓冲区，而是清空解析边界，等待下一次
 *       IDLE 或新起始位重新建立时间语义。
 */
void UartIdleRx_OnError(UartIdleRx_t *rx)
{
    if (rx == NULL)
    {
        return;
    }

    if (__HAL_UART_GET_FLAG(rx->huart, UART_FLAG_ORE) != RESET)
    {
        rx->overrun_count++;
    }

    if (__HAL_UART_GET_FLAG(rx->huart, UART_FLAG_FE) != RESET)
    {
        rx->frame_error_count++;
    }

    __HAL_UART_CLEAR_OREFLAG(rx->huart);
    __HAL_UART_CLEAR_FEFLAG(rx->huart);

    /*
     * 软重同步：
     * 1. 丢弃当前未封包残片，避免把半帧垃圾继续喂给上层解析器；
     * 2. 将软件读指针追到 DMA 当前写指针，等待下一次空闲或新数据边界。
     */
    rx->packet_size = 0U;
    rx->packet_ready = 0U;
    rx->dma_last_pos = Uart_DmaGetWritePos(rx);
}

/**
 * @brief 从 UART IDLE 接收器中取出一包数据。
 * @param rx 接收上下文。
 * @param out_buffer 输出缓冲区。
 * @param buffer_capacity 输出缓冲区容量。
 * @param out_size 输出实际字节数。
 * @retval true  取包成功。
 * @retval false 当前没有新包或参数非法。
 */
bool UartIdleRx_TakePacket(UartIdleRx_t *rx,
                           uint8_t *out_buffer,
                           uint16_t buffer_capacity,
                           uint16_t *out_size)
{
    uint16_t copy_size;

    if ((rx == NULL) || (out_buffer == NULL) || (out_size == NULL) || (rx->packet_ready == 0U))
    {
        return false;
    }

    copy_size = Uart_ClampU16(rx->packet_size, 0U, buffer_capacity);
    memcpy(out_buffer, rx->packet_buffer, copy_size);
    *out_size = copy_size;
    rx->packet_ready = 0U;
    rx->packet_size = 0U;
    return true;
}

extern UART_HandleTypeDef huart1;
extern DMA_HandleTypeDef hdma_usart1_rx;
extern uint32_t HAL_RCC_GetPCLK2Freq(void);

static UartIdleRx_t g_uart1_rx =
{
    .huart = &huart1,
    .hdma_rx = &hdma_usart1_rx
};

/**
 * @brief 应用层初始化示例：为 USART1 选择更稳妥的波特率时序并启动 DMA + IDLE。
 * @retval true 初始化成功。
 * @retval false 波特率误差预算不满足或接收启动失败。
 */
bool App_Uart1_InitRobustRx(void)
{
    UartTimingChoice_t timing_choice;
    const uint32_t pclk_hz = HAL_RCC_GetPCLK2Freq();

    if (!Uart_SelectBestTiming(pclk_hz, 115200U, &timing_choice))
    {
        return false;
    }

    if (!Uart_ApplyTimingChoice(&huart1, &timing_choice))
    {
        return false;
    }

    return UartIdleRx_Start(&g_uart1_rx);
}

void USART1_IRQHandler(void)
{
    if (__HAL_UART_GET_FLAG(&huart1, UART_FLAG_IDLE) != RESET)
    {
        UartIdleRx_OnIdle(&g_uart1_rx);
    }

    if ((__HAL_UART_GET_FLAG(&huart1, UART_FLAG_ORE) != RESET) ||
        (__HAL_UART_GET_FLAG(&huart1, UART_FLAG_FE) != RESET))
    {
        UartIdleRx_OnError(&g_uart1_rx);
    }

    HAL_UART_IRQHandler(&huart1);
}

bool App_Uart1_PollPacket(uint8_t *buffer, uint16_t capacity, uint16_t *size)
{
    return UartIdleRx_TakePacket(&g_uart1_rx, buffer, capacity, size);
}
```

这段实现真正想守住的，不是“串口能收字节”这么低层的能力，而是**当接收端没有共享时钟时，软件如何替硬件补齐时间语义**。`USARTDIV = f_ck / (OSR * baud)` 管的是本地位周期量化，`drift_eof ~= frame_bits * |err|` 管的是整帧累计相位漂移，`IDLE` 则负责把无边界字节流重新切回可解释的报文片段。把这些隐性合同写进接收层之后，UART 才不再只是“偶尔乱码的两根线”，而是一条能感知偏航、能在空闲窗重同步、能给上层稳定交付边界的异步链路。
