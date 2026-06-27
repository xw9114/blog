---
title: "技能档案：UART DMA 环形接收、IDLE 判帧与粘包错帧恢复"
slug: "skill-uart-dma-circular-idle-frame-resync-and-error-recovery"
date: 2026-06-27T14:59:56+08:00
draft: false
description: "从 UART 过采样、波特率误差、DMA 环形缓冲写指针到 IDLE 空闲线判帧与 ORE/FE 异常恢复，系统拆解异步串口在无帧时钟条件下如何维持边界与数据一致性。"
tags: ["UART", "DMA", "STM32", "IDLE", "环形缓冲", "串口通信", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

在电机驱动调参、上位机调试协议、传感器网关和工业从站里，`UART + DMA` 常被误解成“开了循环接收就不会丢包”，但真正的工程痛点从来不是字节能不能进内存，而是 **异步串口没有独立帧时钟时，系统靠什么在连续字节流中恢复帧边界、识别半包与粘包，并在 DMA 与 CPU 并发读写下维持一致性**。这个主题真正解决的是：如何把 UART 的起始位采样契约、`IDLE` 空闲线、环形 DMA 写指针快照和 `ORE/FE` 错误恢复串成一条可落地的实时接收链路，而不是停留在 `HAL_UARTEx_ReceiveToIdle_DMA()` 能跑起来这一层。

## 核心底层概念解析

- **UART 本质上是“无共享时钟的局部时间重建”**：发送端只给出一个起始位下降沿，接收端随后靠本地波特率时钟在每个比特中心采样。它不是同步总线，而是一次“发现边沿后在本地时间轴上做离散预测”的过程。

- **过采样是在为采样相位留容差，不是在浪费时钟**：典型 UART 采用 `16x` 或 `8x` 过采样。接收机先检测起始位，再按过采样计数走到位中心附近取样。过采样倍率越高，可用于检测边沿和抑制抖动的时间分辨率越细，但时钟误差预算也仍然有限。

- **波特率误差会沿整帧累计，而不是只影响一个比特**：若发送与接收的相对误差为 `epsilon`，一帧从起始位中心走到停止位中心的采样漂移近似为  
  `Delta t ~= epsilon * N_bits * T_bit`。  
  当 `|Delta t|` 接近半个比特时间，停止位就可能被采到边沿附近，进而触发 `FE`。这说明串口不是“差一点也行”，而是误差会跨整帧积分。

- **DMA 解决的是搬运吞吐，不自动解决边界语义**：UART 每收到一个字节就把它推进 `RDR`，DMA 再把 `RDR` 搬到内存。这个链路只保证“字节能进缓冲区”，并不保证 CPU 知道哪几个字节属于同一帧、何时一帧已经结束、以及自己读到的区间是否与 DMA 正在写的区间重叠。

- **环形缓冲的核心对象不是数组，而是单调推进的写指针**：对长度为 `N` 的 DMA 循环缓冲区，若 `NDTR` 表示剩余搬运量，则当前硬件写位置可写成  
  `write_pos = (N - NDTR) mod N`。  
  CPU 侧每次消费的不是“从头到尾再扫一遍数组”，而是读取上一次 `read_pos` 和当前 `write_pos` 之间的新弧段。

- **IDLE 不是消息协议字段，而是物理层的时间边界**：当 RX 线上持续一个字符时间以上没有新的起始位到来，USART 置位 `IDLE`。这不是“收到了结束符”，而是“线路在一个字符时间窗口内保持静默”。很多上位机协议把它当作帧结束判据，本质上是在借用物理层沉默去补异步链路缺失的帧时钟。

- **用 IDLE 判帧时，边界其实依赖“发送节拍是否允许中途停顿”**：如果发送端可能在同一业务帧中因为任务切换、FIFO 枯竭或半双工方向翻转而停顿超过 1 个字符时间，那么接收端的 `IDLE` 就会把一帧错误切成两帧。换句话说，`IDLE` 判帧成立的前提不是 HAL 支持，而是发送端时域行为满足这份契约。

- **粘包和半包不是异常，而是字节流协议的默认状态**：只要协议本身不是固定长度，接收端就必须接受“本次唤醒只拿到半帧”或“这次一口气拿到三帧”的现实。DMA 环形缓冲只是把这件事从中断一字节一处理，改成了区间批处理。

- **错帧恢复本质上是在随机字节流里重新找到同步锚点**：若前一帧长度字段损坏、起始标志误判或缓存溢出，解析器需要丢弃一段数据并重新搜索帧头。这一步不是“协议层补丁”，而是在没有共享时钟的链路里重新建立字节边界的最小代价。

- **`ORE`、`FE`、`NE` 这些错误位反映的是不同层面的契约断裂**：`ORE` 说明 `RDR` 旧字节还没被搬走，新字节已经到达，问题在于消费链路跟不上；`FE` 说明停止位采样失败，常见于波特率漂移、线噪声或错误起始位；`NE` 则是噪声污染导致采样值不稳定。恢复策略不能一刀切。

- **DMA 快照一致性在串口里同样重要**：若 CPU 一边读环形缓冲，一边让 DMA 继续往同一段区域落字节，而代码又没有先锁定 `write_pos` 快照，那么本次解析得到的“帧”可能前半段来自旧批次、后半段来自新批次。串口虽然不是控制环，但协议状态机同样怕这种撕裂输入。

- **从数学上看，环形缓冲消费是在做模空间上的弧段提取**：若 `read_pos = r`，硬件快照写指针为 `w`，则新数据长度为  
  `len = (w - r + N) mod N`。  
  当 `w < r` 时，新数据跨越了数组尾部，这不是异常，只是环形空间的正常拓扑。

- **技术哲学上，异步串口真正困难的地方，不是“收到字节”，而是“在没有共享时间基准的前提下重建消息边界”**：DMA 只是在帮你保住吞吐，`IDLE` 只是在提供一个物理静默提示，真正让系统稳定工作的，是你是否把边界、快照、错误与重同步写成一份完整契约。

## 代码能力展现

下面给出一段基于 STM32 HAL 风格的 UART DMA 环形接收实现。重点不放在某个现成 HAL 封装，而放在四件真正决定工程质量的事情上：

- 如何从 DMA `NDTR` 推导 **稳定写指针快照**。
- 如何把 `IDLE` 事件转成 **可消费的数据批次**。
- 如何在环形缓冲上处理 **粘包、半包与跨尾部连续区间**。
- 如何在 `ORE/FE/NE` 出现时做 **显式恢复与重新同步**。

```c
#include "main.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define UART_RX_DMA_BUFFER_SIZE             256U
#define UART_RX_FRAME_BUFFER_SIZE            96U
#define UART_RX_MIN_FRAME_SIZE                5U
#define UART_RX_MAX_FRAME_SIZE               64U
#define UART_RX_SYNC_BYTE_0                0xAAU
#define UART_RX_SYNC_BYTE_1                0x55U
typedef struct
{
    uint8_t payload[UART_RX_MAX_FRAME_SIZE];
    uint16_t length;
    uint32_t sequence_id;
    bool valid;
} UartFrame_t;

typedef struct
{
    UART_HandleTypeDef *huart;
    DMA_HandleTypeDef *hdma_rx;
    uint8_t dma_buffer[UART_RX_DMA_BUFFER_SIZE];
    uint8_t linear_buffer[UART_RX_FRAME_BUFFER_SIZE];
    uint16_t read_pos;
    uint16_t ready_write_pos;
    uint16_t pending_length;
    uint32_t idle_event_count;
    uint32_t dma_overrun_count;
    uint32_t frame_error_count;
    uint32_t noise_error_count;
    uint32_t parser_resync_count;
    uint32_t frame_sequence_id;
    bool batch_ready;
} UartRxContext_t;

static UartRxContext_t g_uart3_rx_ctx;

static uint16_t UartRingDistance(uint16_t from, uint16_t to, uint16_t size)
{
    return (uint16_t)((to + size - from) % size);
}

static uint16_t UartClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

/**
 * @brief 由 DMA 剩余计数推导当前环形缓冲写指针。
 * @param ctx UART 接收上下文。
 * @return 当前 DMA 写指针，范围 `[0, UART_RX_DMA_BUFFER_SIZE)`.
 *
 * @note 对长度为 N 的循环 DMA 缓冲区:
 *       write_pos = (N - NDTR) mod N
 *
 *       其中 NDTR 表示 DMA 还剩多少个元素未搬运。
 *       该公式的物理含义是：DMA 已经提交到内存的字节数。
 */
static uint16_t UartRxGetWritePos(const UartRxContext_t *ctx)
{
    uint32_t remaining = 0U;

    if ((ctx == NULL) || (ctx->hdma_rx == NULL))
    {
        return 0U;
    }

    remaining = __HAL_DMA_GET_COUNTER(ctx->hdma_rx);
    remaining %= UART_RX_DMA_BUFFER_SIZE;
    return (uint16_t)((UART_RX_DMA_BUFFER_SIZE - remaining) % UART_RX_DMA_BUFFER_SIZE);
}

/**
 * @brief 复制环形缓冲中 `[read_pos, write_pos)` 的新字节并追加到线性待解析缓冲。
 * @param ctx UART 接收上下文。
 * @param write_pos 已锁定的 DMA 写指针快照。
 * @return 实际追加到待解析缓冲中的字节数。
 *
 * @note 新字节长度公式:
 *       len = (write_pos - read_pos + N) mod N
 *
 *       若 write_pos < read_pos，说明新数据跨越了数组尾部，
 *       此时需要拆成两段复制，但逻辑上它仍是一条连续字节流。
 *
 *       这里不会在每个 IDLE 批次后立刻丢掉半包，而是把新字节追加到
 *       linear_buffer[pending_length...]，让解析器可以跨多个批次拼出完整帧。
 */
static uint16_t UartRxCopyNewBytes(UartRxContext_t *ctx, uint16_t write_pos)
{
    uint16_t new_len = 0U;
    uint16_t first_chunk = 0U;
    uint16_t second_chunk = 0U;
    uint16_t append_len = 0U;

    if (ctx == NULL)
    {
        return 0U;
    }

    new_len = UartRingDistance(ctx->read_pos, write_pos, UART_RX_DMA_BUFFER_SIZE);

    if (new_len == 0U)
    {
        return 0U;
    }

    /*
     * 若待解析缓冲剩余空间不足，说明上层协议长时间未完成同步或突发长度超预算。
     * 这里显式丢弃最旧的未解析内容并重新同步，而不是静默覆盖。
     */
    if ((uint32_t)ctx->pending_length + (uint32_t)new_len > UART_RX_FRAME_BUFFER_SIZE)
    {
        ctx->parser_resync_count++;
        ctx->pending_length = 0U;

        if (new_len > UART_RX_FRAME_BUFFER_SIZE)
        {
            ctx->read_pos = (uint16_t)((write_pos + UART_RX_DMA_BUFFER_SIZE - UART_RX_FRAME_BUFFER_SIZE) %
                                       UART_RX_DMA_BUFFER_SIZE);
            new_len = UART_RX_FRAME_BUFFER_SIZE;
        }
    }

    first_chunk = new_len;
    if ((uint32_t)ctx->read_pos + first_chunk > UART_RX_DMA_BUFFER_SIZE)
    {
        first_chunk = (uint16_t)(UART_RX_DMA_BUFFER_SIZE - ctx->read_pos);
    }

    second_chunk = (uint16_t)(new_len - first_chunk);
    append_len = ctx->pending_length;

    memcpy(&ctx->linear_buffer[append_len],
           &ctx->dma_buffer[ctx->read_pos],
           first_chunk);

    if (second_chunk > 0U)
    {
        memcpy(&ctx->linear_buffer[append_len + first_chunk],
               &ctx->dma_buffer[0],
               second_chunk);
    }

    ctx->read_pos = write_pos;
    ctx->pending_length = (uint16_t)(ctx->pending_length + new_len);
    return new_len;
}

/**
 * @brief 在批处理缓冲中搜索协议同步头。
 * @param data 线性字节流。
 * @param length 字节流长度。
 * @return 同步头起始索引；未找到时返回 -1。
 *
 * @note 这里用固定双字节帧头 `0xAA 0x55` 作为示例。
 *       实际工程可替换为 SOF、地址域或 CRC 可验证前缀。
 */
static int16_t UartFrameFindSync(const uint8_t *data, uint16_t length)
{
    uint16_t i;

    if ((data == NULL) || (length < 2U))
    {
        return -1;
    }

    for (i = 0U; i + 1U < length; ++i)
    {
        if ((data[i] == UART_RX_SYNC_BYTE_0) &&
            (data[i + 1U] == UART_RX_SYNC_BYTE_1))
        {
            return (int16_t)i;
        }
    }

    return -1;
}

/**
 * @brief 计算示例协议的逐字节异或校验。
 * @param data 输入数据。
 * @param length 数据长度。
 * @return 异或校验值。
 *
 * @note 此处只为突出“错帧后必须有可验证锚点”，
 *       工程中可替换为 CRC8/CRC16。
 */
static uint8_t UartFrameXorChecksum(const uint8_t *data, uint16_t length)
{
    uint8_t checksum = 0U;
    uint16_t i;

    for (i = 0U; i < length; ++i)
    {
        checksum ^= data[i];
    }

    return checksum;
}

/**
 * @brief 从线性待解析缓冲中提取一帧完整消息。
 * @param ctx UART 接收上下文。
 * @param frame_out 输出帧。
 * @retval true  成功解析到完整帧。
 * @retval false 当前待解析缓冲里无完整帧，或发生错帧需继续重同步。
 *
 * @note 示例帧格式:
 *       [0] SOF0 = 0xAA
 *       [1] SOF1 = 0x55
 *       [2] LEN  = payload_length
 *       [3..LEN+2] PAYLOAD
 *       [LEN+3] CHECKSUM = XOR(SOF0..PAYLOAD_END)
 *
 *       总帧长:
 *       frame_len = LEN + 4
 */
static bool UartFrameTryParse(UartRxContext_t *ctx,
                              UartFrame_t *frame_out)
{
    int16_t sync_index = -1;
    uint16_t frame_len = 0U;
    uint16_t remaining = 0U;
    uint8_t payload_len = 0U;
    uint8_t expected_checksum = 0U;
    uint8_t received_checksum = 0U;

    if ((ctx == NULL) || (frame_out == NULL))
    {
        return false;
    }

    frame_out->valid = false;

    while (ctx->pending_length >= 2U)
    {
        sync_index = UartFrameFindSync(ctx->linear_buffer, ctx->pending_length);
        if (sync_index < 0)
        {
            /*
             * 若最后一个字节刚好是同步头首字节，则保留它等待下个批次；
             * 这样 `0xAA` 与下一批次开头的 `0x55` 仍能拼成合法帧头。
             */
            if (ctx->linear_buffer[ctx->pending_length - 1U] == UART_RX_SYNC_BYTE_0)
            {
                ctx->linear_buffer[0] = UART_RX_SYNC_BYTE_0;
                ctx->pending_length = 1U;
            }
            else
            {
                ctx->pending_length = 0U;
            }

            ctx->parser_resync_count++;
            return false;
        }

        if (sync_index > 0)
        {
            remaining = (uint16_t)(ctx->pending_length - (uint16_t)sync_index);
            memmove(&ctx->linear_buffer[0],
                    &ctx->linear_buffer[sync_index],
                    remaining);
            ctx->pending_length = remaining;
            ctx->parser_resync_count++;
        }

        if (ctx->pending_length < UART_RX_MIN_FRAME_SIZE)
        {
            return false;
        }

        payload_len = ctx->linear_buffer[2];
        if ((payload_len == 0U) || (payload_len > UART_RX_MAX_FRAME_SIZE))
        {
            memmove(&ctx->linear_buffer[0],
                    &ctx->linear_buffer[1],
                    (size_t)(ctx->pending_length - 1U));
            ctx->pending_length--;
            ctx->parser_resync_count++;
            continue;
        }

        frame_len = (uint16_t)payload_len + 4U;
        if (ctx->pending_length < frame_len)
        {
            return false;
        }

        expected_checksum = UartFrameXorChecksum(&ctx->linear_buffer[0], (uint16_t)(frame_len - 1U));
        received_checksum = ctx->linear_buffer[frame_len - 1U];
        if (expected_checksum != received_checksum)
        {
            memmove(&ctx->linear_buffer[0],
                    &ctx->linear_buffer[1],
                    (size_t)(ctx->pending_length - 1U));
            ctx->pending_length--;
            ctx->parser_resync_count++;
            continue;
        }

        memcpy(frame_out->payload,
               &ctx->linear_buffer[3U],
               payload_len);
        frame_out->length = payload_len;
        frame_out->sequence_id = ++ctx->frame_sequence_id;
        frame_out->valid = true;

        remaining = (uint16_t)(ctx->pending_length - frame_len);
        if (remaining > 0U)
        {
            memmove(&ctx->linear_buffer[0],
                    &ctx->linear_buffer[frame_len],
                    remaining);
        }

        ctx->pending_length = remaining;
        return true;
    }

    return false;
}

/**
 * @brief 清除并恢复 USART 错误状态。
 * @param ctx UART 接收上下文。
 *
 * @note 错误恢复重点不是“清标志”本身，而是恢复接收状态机与 DMA 语义一致性。
 *       对常见错误:
 *       - ORE: 说明旧字节尚未被取走，新字节已覆盖到来，通常表示接收链路失速。
 *       - FE : 停止位采样失败，常见于波特率误差、噪声或断线。
 *       - NE : 采样噪声过大。
 *
 *       这里采用保守策略：发现错误后停止 DMA、清空状态、重新启动环形接收。
 */
static void UartRxRecoverFromError(UartRxContext_t *ctx)
{
    if ((ctx == NULL) || (ctx->huart == NULL))
    {
        return;
    }

    HAL_UART_DMAStop(ctx->huart);

    __HAL_UART_CLEAR_IDLEFLAG(ctx->huart);
    __HAL_UART_CLEAR_OREFLAG(ctx->huart);
    __HAL_UART_CLEAR_FEFLAG(ctx->huart);
    __HAL_UART_CLEAR_NEFLAG(ctx->huart);

    ctx->read_pos = 0U;
    ctx->ready_write_pos = 0U;
    ctx->pending_length = 0U;
    ctx->batch_ready = false;

    (void)HAL_UART_Receive_DMA(ctx->huart,
                               ctx->dma_buffer,
                               UART_RX_DMA_BUFFER_SIZE);

    /* 重新打开 IDLE 中断，恢复物理静默判帧。 */
    __HAL_UART_ENABLE_IT(ctx->huart, UART_IT_IDLE);
}

/**
 * @brief 初始化 UART DMA 环形接收。
 * @param ctx UART 接收上下文。
 * @param huart UART 句柄。
 * @param hdma_rx RX DMA 句柄。
 * @retval true 初始化成功。
 * @retval false 参数非法或 DMA 启动失败。
 */
static bool UartRxInit(UartRxContext_t *ctx,
                       UART_HandleTypeDef *huart,
                       DMA_HandleTypeDef *hdma_rx)
{
    if ((ctx == NULL) || (huart == NULL) || (hdma_rx == NULL))
    {
        return false;
    }

    memset(ctx, 0, sizeof(*ctx));
    ctx->huart = huart;
    ctx->hdma_rx = hdma_rx;

    if (HAL_UART_Receive_DMA(huart, ctx->dma_buffer, UART_RX_DMA_BUFFER_SIZE) != HAL_OK)
    {
        return false;
    }

    __HAL_UART_ENABLE_IT(huart, UART_IT_IDLE);
    return true;
}

/**
 * @brief UART 中断服务例程中的 IDLE 事件处理。
 * @param ctx UART 接收上下文。
 *
 * @note IDLE 到来时，说明 RX 线上至少一个字符时间没有新起始位。
 *       此时先清除 IDLE 标志，再抓取当前 write_pos 快照。
 *       这里的关键是“先锁定写指针，再通知任务层消费”，
 *       避免任务层读到 DMA 后续继续写入的撕裂数据。
 */
static void UartRxOnIdle(UartRxContext_t *ctx)
{
    uint16_t write_pos = 0U;

    if (ctx == NULL)
    {
        return;
    }

    __HAL_UART_CLEAR_IDLEFLAG(ctx->huart);
    write_pos = UartRxGetWritePos(ctx);

    if (UartRingDistance(ctx->read_pos, write_pos, UART_RX_DMA_BUFFER_SIZE) > 0U)
    {
        ctx->idle_event_count++;
        ctx->ready_write_pos = write_pos;
        ctx->batch_ready = true;
    }
}

/**
 * @brief 在任务上下文中消费一次 IDLE 批次并尝试解析协议帧。
 * @param ctx UART 接收上下文。
 * @param frame_out 输出帧。
 * @retval true  成功解析到完整帧。
 * @retval false 当前没有可消费批次或尚未形成完整帧。
 */
static bool UartRxPollFrame(UartRxContext_t *ctx, UartFrame_t *frame_out)
{
    uint16_t write_pos = 0U;
    uint16_t copied_len = 0U;

    if ((ctx == NULL) || (frame_out == NULL))
    {
        return false;
    }

    if (!ctx->batch_ready)
    {
        return false;
    }

    ctx->batch_ready = false;
    write_pos = ctx->ready_write_pos;
    copied_len = UartRxCopyNewBytes(ctx, write_pos);
    if (copied_len == 0U)
    {
        return UartFrameTryParse(ctx, frame_out);
    }

    return UartFrameTryParse(ctx, frame_out);
}

/**
 * @brief UART 错误回调。
 * @param huart UART 句柄。
 *
 * @note 这里把不同错误分开计数，便于后续区分：
 *       - 是消费链路过慢导致 ORE；
 *       - 还是物理层时序/噪声导致 FE/NE。
 */
void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
    if ((huart == NULL) || (huart != g_uart3_rx_ctx.huart))
    {
        return;
    }

    if ((huart->ErrorCode & HAL_UART_ERROR_ORE) != 0U)
    {
        g_uart3_rx_ctx.dma_overrun_count++;
    }

    if ((huart->ErrorCode & HAL_UART_ERROR_FE) != 0U)
    {
        g_uart3_rx_ctx.frame_error_count++;
    }

    if ((huart->ErrorCode & HAL_UART_ERROR_NE) != 0U)
    {
        g_uart3_rx_ctx.noise_error_count++;
    }

    UartRxRecoverFromError(&g_uart3_rx_ctx);
}

/**
 * @brief USART IRQ 中对 IDLE 中断的最小处理包装。
 * @param huart UART 句柄。
 *
 * @note 先判断 IDLE，再交给 HAL 走剩余通用处理，
 *       避免丢掉物理层静默边界。
 */
void App_UartIrqHandler(UART_HandleTypeDef *huart)
{
    if ((huart != NULL) &&
        (huart == g_uart3_rx_ctx.huart) &&
        (__HAL_UART_GET_FLAG(huart, UART_FLAG_IDLE) != RESET) &&
        (__HAL_UART_GET_IT_SOURCE(huart, UART_IT_IDLE) != RESET))
    {
        UartRxOnIdle(&g_uart3_rx_ctx);
    }

    HAL_UART_IRQHandler(huart);
}

extern UART_HandleTypeDef huart3;
extern DMA_HandleTypeDef hdma_usart3_rx;

void App_UartProtocolInit(void)
{
    (void)UartRxInit(&g_uart3_rx_ctx, &huart3, &hdma_usart3_rx);
}

void App_UartProtocolTask(void)
{
    UartFrame_t frame;

    memset(&frame, 0, sizeof(frame));

    if (UartRxPollFrame(&g_uart3_rx_ctx, &frame) && frame.valid)
    {
        /*
         * 到这里拿到的是一份基于 IDLE 边界和 write_pos 快照提取出的完整帧。
         * 后续可继续做命令分发、参数更新或状态回传。
         */
    }

    /*
     * 若错误计数持续增长，可进一步触发降级:
     * 1. 降低波特率或切换硬件流控；
     * 2. 提高任务优先级，减少 ORE；
     * 3. 连续 FE/NE 超过阈值后请求链路重握手。
     */
}
```

这段代码真正要表达的工程结论有四个：

- **UART DMA 的核心不是“自动搬运”，而是“把写指针变成可快照的时间边界”**。没有 `read_pos/write_pos` 这套语义，循环缓冲只是一圈没人说得清边界的字节。
- **`IDLE` 不是万能分包器，而是一条物理层静默契约**。只有发送端保证帧内不会停顿超过一个字符时间，接收端才能安全地把 `IDLE` 当作帧尾提示。
- **错帧恢复必须依赖可验证锚点**。无论是双字节帧头、长度字段还是 CRC，接收端都要有能力在字节流里重新找到同步点，而不是盲目相信“从这里开始就是对的”。
- **`ORE/FE/NE` 计数值得长期观测**。它们分别映射到吞吐失配、时序漂移和噪声污染，是链路健康度最直接的工程证据。

如果继续往工程深处走，下一步通常不是继续包更多 HAL 接口，而是回到三件更底层的事情上：发送端帧间静默是否可控、DMA 缓冲大小是否覆盖最坏突发长度、以及协议是否有足够强的自同步与 CRC 机制。只有这三件事同时成立，`UART + DMA + IDLE` 才不是“实验室里能收串口”，而是真正可进入长期运行系统的数据前端。
