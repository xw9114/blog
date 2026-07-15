---
title: "技能档案：RS-485 半双工的占线合同，从 DE 方向切换、帧间静默到总线回声消除"
slug: "skill-rs485-half-duplex-de-turnaround-idle-gap-and-echo-suppression"
date: 2026-06-12T10:22:04+08:00
draft: false
description: "从差分线对占用权、DE/RE 翻转边界、TC 完帧时刻到 3.5 字符静默窗，系统拆解 RS-485 为什么常死在方向切换与回声污染，而不是 UART API。"
tags: ["RS-485", "UART", "STM32", "半双工", "Modbus", "DMA", "嵌入式"]
categories: ["技能档案", "工业通信"]
image: ""
---

## 技能概述

RS-485 常出现在变频器、BMS、电表、伺服驱动器、云台控制板和楼宇总线里。表面看，它只是把 UART 挂到一对差分线上；真正困难的部分却从来不是 `HAL_UART_Transmit()` 会不会返回成功，而是**谁在什么时候取得总线占用权、最后一个停止位何时真正离开移位寄存器、帧与帧之间要留多大的静默窗、以及本机发出去的字节会不会从接收链路反咬自己一口**。这个主题要解决的核心痛点，不是再背一遍 RS-485 的电平标准，而是把 **DE 方向控制**、**TC 完帧边界**、**字符时间静默窗** 和 **回声过滤策略** 串成一份可以落到 STM32 HAL 代码里的时域合同。

## 核心底层概念解析

- **RS-485 不是“串口协议”，而是一种差分物理层占线机制**：UART 只定义字节如何按位出去，RS-485 定义的是 A/B 双绞线如何承载这些位。接收器关心的是 `Vab = VA - VB` 的极性，而不是某根线对地是多少伏，因此它对共模干扰更宽容，也更适合长线和多节点。
- **半双工的本质不是“不能同时收发”，而是同一时刻只能有一个驱动器改写这对线的电场状态**：DE 引脚拉高，等于本节点开始主动驱动总线；DE 拉低，等于把线权交还给偏置网络和其他节点。软件里的“发送”其实是在申请一段共享介质的独占时隙。
- **终端电阻与偏置电阻决定的不是波形好不好看，而是空闲态是否有定义**：120 欧终端负责匹配电缆特性阻抗，降低反射；上拉/下拉偏置负责在所有驱动器释放总线后，把线路稳定拉回一个可判定的 Mark 态。没有 fail-safe 偏置时，空闲总线会在噪声里漂，接收端就可能把毛刺误认成起始位。
- **DMA 发送完成不等于最后一个停止位已经离开芯片**：DMA 完成只说明内存里的最后一个字节写进了 `TDR`，但移位寄存器可能还在把最后几位推出去。真正可以撤销 DE 的边界是 `TC`，因为它表示发送数据寄存器和移位寄存器都空了，总线才真正到了可释放时刻。
- **DE 断言与释放是数字控制和模拟器件传播延迟之间的合同**：收发器从 `DE=1` 到驱动器完全导通，需要 `t_en`；从 `DE=0` 到真正三态释放，需要 `t_dis`。如果方向切得太早，会截断停止位；切得太晚，则会吃掉下一个节点的响应前导。
- **帧间静默不是“协议客气一下”，而是半双工总线的重新定界点**：以 Modbus RTU 为典型，字符时间可写成  
  `t_char = (1 + N_data + N_parity + N_stop) / baud`，  
  而帧间静默下限常取  
  `t_silent_min = 3.5 * t_char`。  
  这不是经验玄学，而是在共享链路上重新声明“上一帧已经结束、下一帧可以重新争取线权”。
- **总线空闲不能只靠读到高电平判断，而要看“距离上一字节已经过去多久”**：带偏置的 RS-485 在线路释放后本来就会回到稳定空闲态，所以“看到高电平”不说明总线没人在说话。更可靠的工程判据是时间戳: 只有在 `now - last_rx_byte_ts >= t_silent_min` 后，软件才把它视为真正可发送的空窗。
- **本机回声不是灵异事件，而是接收机在你发送时仍在工作**：很多板卡把 `/RE` 常年拉低，或者收发器内部允许本机回读；于是节点在发自己的字节时，也会从 RX 口收到同样的数据。如果不在 TX 窗口和 `DE` 释放后的短暂保护窗里丢弃这些回声，解析器就会把“自己说的话”错当成“别人回复的话”。
- **回声保护窗的长度也可以用字符时间来预算**：若本地环回、收发器释放延迟和电缆单程传播延迟叠加，保护窗可按  
  `t_echo_guard >= t_dis + t_cable + k * t_char`  
  估算，其中 `k` 常取 `1.0 ~ 1.5` 个字符时间。它的作用不是绝对正确地预测物理延迟，而是在协议边界前主动给接收状态机一个“闭嘴窗口”。
- **DMA 环形缓冲的深度本质上是在买调度裕量**：若最高接收速率为 `baud / bits_per_char` 字节每秒，而你的业务线程最长可能 `T_block` 秒不处理数据，那么最小缓冲深度应满足  
  `N_buf >= ceil((baud / bits_per_char) * T_block)`。  
  缓冲区不是为了省 CPU，而是为了吸收中断、任务切换和上层解析的抖动。
- **错误恢复要把“坏字节”与“坏时间边界”一起清掉**：`FE/NE/ORE` 不只是一个计数器，它往往意味着当前这段帧的时间轴已经不可信。更稳妥的做法通常不是硬着头皮继续拼包，而是在清标志位后丢弃残帧、重置解析游标，等下一个静默窗再重新对齐。
- **技术哲学上，RS-485 的稳定性来自对共享物理世界的敬畏**：在半双工链路里，发送并不是“把数组交给 HAL”，而是短暂接管一对线的解释权。什么时候发、什么时候闭嘴、什么时候承认边界丢了，都比“这几个字节是否已经进入 DMA”更接近系统真相。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 RS-485 半双工封装。示例假设:

- `USART3` 挂在一颗常见的 MAX3485/SP3485 类收发器上，`DE` 与 `/RE` 通过同一 GPIO 控制，`GPIO=1` 表示发送、`GPIO=0` 表示接收。
- `TIM6` 以 `1 MHz` 自由运行，作为微秒级时间基。
- DMA RX 采用**循环模式**，IDLE 中断只负责“告诉软件现在可以结算一段连续字节流”，而真正的主题是 **DE 申请线权 -> DMA 发送 -> TC 完帧释放 -> 回声保护 -> 静默窗定界** 这一整条时域链路。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define RS485_RX_DMA_SIZE                 256U
#define RS485_TX_BUFFER_SIZE              128U
#define RS485_FRAME_BUFFER_SIZE           256U
#define RS485_MIN_BAUD                   1200U
#define RS485_MAX_BAUD                3000000U
#define RS485_MIN_SILENT_CHARS           1.0f
#define RS485_MAX_SILENT_CHARS          10.0f
#define RS485_MIN_ECHO_GUARD_CHARS       0.0f
#define RS485_MAX_ECHO_GUARD_CHARS       4.0f

typedef enum
{
    RS485_TX_STATE_RX = 0,
    RS485_TX_STATE_DMA_ACTIVE,
    RS485_TX_STATE_WAIT_TC,
    RS485_TX_STATE_ECHO_GUARD
} Rs485TxState_t;

typedef struct
{
    UART_HandleTypeDef *huart;
    TIM_HandleTypeDef *htim_us;
    GPIO_TypeDef *de_port;
    uint16_t de_pin;
    uint32_t baud;
    uint8_t data_bits;
    uint8_t parity_bits;
    uint8_t stop_bits_x2; /* 1 stop bit -> 2, 2 stop bits -> 4 */
    float silent_chars;
    float echo_guard_chars;
    uint16_t de_assert_us;
    uint16_t de_release_us;

    uint8_t rx_dma_buffer[RS485_RX_DMA_SIZE];
    uint8_t tx_buffer[RS485_TX_BUFFER_SIZE];
    uint8_t frame_buffer[RS485_FRAME_BUFFER_SIZE];

    volatile uint16_t rx_read_index;
    volatile uint16_t frame_length;
    volatile uint32_t last_rx_byte_us;
    volatile uint32_t echo_guard_until_us;
    volatile uint32_t line_error_count;
    volatile uint32_t frame_overrun_count;
    volatile bool frame_ready;
    volatile Rs485TxState_t tx_state;
} Rs485Port_t;

extern UART_HandleTypeDef huart3;
extern TIM_HandleTypeDef htim6;

static Rs485Port_t g_rs485 =
{
    .huart = &huart3,
    .htim_us = &htim6,
    .de_port = GPIOB,
    .de_pin = GPIO_PIN_1,
    .baud = 115200U,
    .data_bits = 8U,
    .parity_bits = 0U,
    .stop_bits_x2 = 2U,
    .silent_chars = 3.5f,
    .echo_guard_chars = 1.2f,
    .de_assert_us = 2U,
    .de_release_us = 2U
};

static uint32_t Rs485_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static float Rs485_ClampFloat(float value, float min_value, float max_value)
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

static uint32_t Rs485_ReadNowUs(const Rs485Port_t *port)
{
    return __HAL_TIM_GET_COUNTER(port->htim_us);
}

static bool Rs485_TimeReached(uint32_t now_us, uint32_t deadline_us)
{
    return ((int32_t)(now_us - deadline_us) >= 0);
}

static void Rs485_DelayUs(const Rs485Port_t *port, uint32_t delay_us)
{
    const uint32_t start_us = Rs485_ReadNowUs(port);

    while (!Rs485_TimeReached(Rs485_ReadNowUs(port), start_us + delay_us))
    {
        /* DE 建立/保持时间通常只有几微秒，短忙等比切换另一个定时器更直接。 */
    }
}

static float Rs485_GetBitsPerChar(const Rs485Port_t *port)
{
    return (1.0f + (float)port->data_bits + (float)port->parity_bits + ((float)port->stop_bits_x2 * 0.5f));
}

static uint32_t Rs485_GetCharTimeUs(const Rs485Port_t *port)
{
    /*
     * 字符时间:
     * t_char = (1 + N_data + N_parity + N_stop) / baud
     *
     * 乘以 1e6 后得到微秒单位。使用向上取整，避免静默窗被算短。
     */
    const float char_time_us = (1000000.0f * Rs485_GetBitsPerChar(port)) / (float)port->baud;
    return (uint32_t)(char_time_us + 0.999f);
}

static uint32_t Rs485_GetSilentGapUs(const Rs485Port_t *port)
{
    return (uint32_t)((port->silent_chars * (float)Rs485_GetCharTimeUs(port)) + 0.999f);
}

static uint32_t Rs485_GetEchoGuardUs(const Rs485Port_t *port)
{
    return (uint32_t)((port->echo_guard_chars * (float)Rs485_GetCharTimeUs(port)) + 0.999f);
}

static void Rs485_SetTransmitDirection(const Rs485Port_t *port)
{
    HAL_GPIO_WritePin(port->de_port, port->de_pin, GPIO_PIN_SET);
}

static void Rs485_SetReceiveDirection(const Rs485Port_t *port)
{
    HAL_GPIO_WritePin(port->de_port, port->de_pin, GPIO_PIN_RESET);
}

static uint16_t Rs485_GetRxWriteIndex(const Rs485Port_t *port)
{
    DMA_HandleTypeDef *hdma_rx = port->huart->hdmarx;

    if (hdma_rx == NULL)
    {
        return 0U;
    }

    return (uint16_t)(RS485_RX_DMA_SIZE - __HAL_DMA_GET_COUNTER(hdma_rx));
}

static void Rs485_ResetFrameAssembler(Rs485Port_t *port)
{
    port->frame_length = 0U;
    port->frame_ready = false;
}

static void Rs485_ResetToCurrentDmaTail(Rs485Port_t *port)
{
    port->rx_read_index = Rs485_GetRxWriteIndex(port);
    Rs485_ResetFrameAssembler(port);
}

static bool Rs485_IsEchoWindowActive(Rs485Port_t *port, uint32_t now_us)
{
    if ((port->tx_state == RS485_TX_STATE_DMA_ACTIVE) ||
        (port->tx_state == RS485_TX_STATE_WAIT_TC))
    {
        return true;
    }

    if (port->tx_state == RS485_TX_STATE_ECHO_GUARD)
    {
        if (Rs485_TimeReached(now_us, port->echo_guard_until_us))
        {
            port->tx_state = RS485_TX_STATE_RX;
            return false;
        }

        return true;
    }

    return false;
}

static void Rs485_DrainRxDma(Rs485Port_t *port)
{
    const uint16_t write_index = Rs485_GetRxWriteIndex(port);

    while (port->rx_read_index != write_index)
    {
        const uint8_t byte = port->rx_dma_buffer[port->rx_read_index];
        const uint32_t now_us = Rs485_ReadNowUs(port);
        const bool drop_echo = Rs485_IsEchoWindowActive(port, now_us);

        port->rx_read_index = (uint16_t)((port->rx_read_index + 1U) % RS485_RX_DMA_SIZE);
        port->last_rx_byte_us = now_us;

        if (drop_echo)
        {
            continue;
        }

        /*
         * 若上一帧已经就绪但应用层还没取走，这里选择丢弃旧帧并以新字节重新起帧。
         * 这是典型的实时系统取舍: 保证边界重新对齐，代价是慢消费者要为丢包负责。
         */
        if (port->frame_ready)
        {
            port->frame_overrun_count++;
            port->frame_ready = false;
            port->frame_length = 0U;
        }

        if (port->frame_length < RS485_FRAME_BUFFER_SIZE)
        {
            port->frame_buffer[port->frame_length++] = byte;
        }
        else
        {
            port->frame_overrun_count++;
            Rs485_ResetFrameAssembler(port);
        }
    }
}

/**
 * @brief 启动 RS-485 端口的循环 DMA 接收与线路边界检测。
 * @param port RS-485 端口对象。
 * @retval HAL_OK 启动成功，HAL_ERROR 表示配置非法或 DMA 未挂接。
 *
 * @note 本示例假设 RX DMA 已在 CubeMX 中配置为 Circular 模式。
 *       硬件只是持续搬运字节，本函数额外打开 IDLE / ERR / TC 中断，
 *       把“接收字节流”提升成“带边界的总线事务”。
 */
HAL_StatusTypeDef Rs485_Start(Rs485Port_t *port)
{
    if ((port == NULL) ||
        (port->huart == NULL) ||
        (port->huart->hdmarx == NULL) ||
        (port->htim_us == NULL))
    {
        return HAL_ERROR;
    }

    port->baud = Rs485_ClampU32(port->baud, RS485_MIN_BAUD, RS485_MAX_BAUD);
    port->silent_chars = Rs485_ClampFloat(port->silent_chars, RS485_MIN_SILENT_CHARS, RS485_MAX_SILENT_CHARS);
    port->echo_guard_chars = Rs485_ClampFloat(port->echo_guard_chars,
                                              RS485_MIN_ECHO_GUARD_CHARS,
                                              RS485_MAX_ECHO_GUARD_CHARS);
    port->tx_state = RS485_TX_STATE_RX;
    port->last_rx_byte_us = 0U;
    port->echo_guard_until_us = 0U;
    Rs485_ResetFrameAssembler(port);
    Rs485_SetReceiveDirection(port);

    if (HAL_UART_Receive_DMA(port->huart, port->rx_dma_buffer, RS485_RX_DMA_SIZE) != HAL_OK)
    {
        return HAL_ERROR;
    }

    /* 环形缓存不需要半传输中断，避免无意义的频繁唤醒。 */
    __HAL_DMA_DISABLE_IT(port->huart->hdmarx, DMA_IT_HT);
    __HAL_UART_ENABLE_IT(port->huart, UART_IT_IDLE);
    __HAL_UART_ENABLE_IT(port->huart, UART_IT_ERR);

    return HAL_OK;
}

/**
 * @brief 发起一帧 RS-485 半双工发送。
 * @param port RS-485 端口对象。
 * @param payload 待发送数据。
 * @param length 待发送长度，单位字节。
 * @retval HAL_OK 成功开始发送，HAL_BUSY 表示总线或端口仍忙，HAL_ERROR 表示参数非法。
 *
 * @note 发送前必须先满足静默窗:
 *       now - last_rx_byte_ts >= t_silent_min
 *       这样做不是“礼貌”，而是为了避免在别人的响应尾巴上抢占总线。
 */
HAL_StatusTypeDef Rs485_TransmitFrame(Rs485Port_t *port, const uint8_t *payload, uint16_t length)
{
    uint32_t now_us;

    if ((port == NULL) || (payload == NULL) || (length == 0U))
    {
        return HAL_ERROR;
    }

    if ((port->tx_state != RS485_TX_STATE_RX) || (length > RS485_TX_BUFFER_SIZE))
    {
        return HAL_BUSY;
    }

    now_us = Rs485_ReadNowUs(port);

    if ((port->last_rx_byte_us != 0U) &&
        !Rs485_TimeReached(now_us, port->last_rx_byte_us + Rs485_GetSilentGapUs(port)))
    {
        return HAL_BUSY;
    }

    memcpy(port->tx_buffer, payload, length);
    Rs485_SetTransmitDirection(port);
    Rs485_DelayUs(port, port->de_assert_us);

    /* 先清旧 TC，再开始 DMA，确保本轮结束边界一定来自当前帧。 */
    __HAL_UART_CLEAR_FLAG(port->huart, UART_CLEAR_TCF);
    port->tx_state = RS485_TX_STATE_DMA_ACTIVE;

    if (HAL_UART_Transmit_DMA(port->huart, port->tx_buffer, length) != HAL_OK)
    {
        port->tx_state = RS485_TX_STATE_RX;
        Rs485_SetReceiveDirection(port);
        return HAL_ERROR;
    }

    return HAL_OK;
}

/**
 * @brief 处理 UART 中断中的 RS-485 专有时序逻辑。
 * @param port RS-485 端口对象。
 *
 * @note 这里主动处理三类边界:
 *       1) IDLE: 一段连续字节流告一段落，可尝试结算帧边界。
 *       2) ERR : 当前时间轴可能已损坏，直接丢弃残帧并重同步。
 *       3) TC  : 最后一个停止位已经真正离开总线，此时才允许撤销 DE。
 */
void Rs485_OnUartIrq(Rs485Port_t *port)
{
    uint32_t now_us;

    if ((port == NULL) || (port->huart == NULL))
    {
        return;
    }

    if (__HAL_UART_GET_FLAG(port->huart, UART_FLAG_IDLE) != RESET)
    {
        __HAL_UART_CLEAR_IDLEFLAG(port->huart);
        Rs485_DrainRxDma(port);
    }

    if (__HAL_UART_GET_FLAG(port->huart, UART_FLAG_ORE) != RESET)
    {
        __HAL_UART_CLEAR_OREFLAG(port->huart);
        port->line_error_count++;
        Rs485_ResetToCurrentDmaTail(port);
    }

    if (__HAL_UART_GET_FLAG(port->huart, UART_FLAG_FE) != RESET)
    {
        __HAL_UART_CLEAR_FEFLAG(port->huart);
        port->line_error_count++;
        Rs485_ResetToCurrentDmaTail(port);
    }

    if (__HAL_UART_GET_FLAG(port->huart, UART_FLAG_NE) != RESET)
    {
        __HAL_UART_CLEAR_NEFLAG(port->huart);
        port->line_error_count++;
        Rs485_ResetToCurrentDmaTail(port);
    }

    if ((__HAL_UART_GET_IT_SOURCE(port->huart, UART_IT_TC) != RESET) &&
        (__HAL_UART_GET_FLAG(port->huart, UART_FLAG_TC) != RESET) &&
        (port->tx_state == RS485_TX_STATE_WAIT_TC))
    {
        __HAL_UART_DISABLE_IT(port->huart, UART_IT_TC);
        __HAL_UART_CLEAR_FLAG(port->huart, UART_CLEAR_TCF);

        Rs485_DelayUs(port, port->de_release_us);
        Rs485_SetReceiveDirection(port);

        now_us = Rs485_ReadNowUs(port);
        port->echo_guard_until_us = now_us + Rs485_GetEchoGuardUs(port);
        port->tx_state = RS485_TX_STATE_ECHO_GUARD;
    }
}

/**
 * @brief 周期轮询 RS-485 接收状态机，结算静默窗并生成完整帧。
 * @param port RS-485 端口对象。
 *
 * @note `IDLE` 只能说明线路至少空了 1 个字符时间；
 *       对 Modbus RTU 等依赖 3.5 字符静默窗的协议，仍要在软件层继续等满。
 */
void Rs485_Poll(Rs485Port_t *port)
{
    const uint32_t now_us = Rs485_ReadNowUs(port);

    if (port == NULL)
    {
        return;
    }

    Rs485_DrainRxDma(port);
    (void)Rs485_IsEchoWindowActive(port, now_us);

    if ((!port->frame_ready) &&
        (port->frame_length > 0U) &&
        Rs485_TimeReached(now_us, port->last_rx_byte_us + Rs485_GetSilentGapUs(port)))
    {
        port->frame_ready = true;
    }
}

/**
 * @brief 取走一帧已经闭合完成的 RS-485 报文。
 * @param port RS-485 端口对象。
 * @param out 输出缓存。
 * @param out_size 输出缓存大小。
 * @param out_length 返回的实际帧长。
 * @retval true 取帧成功，false 表示当前没有完整帧或输出缓存不足。
 */
bool Rs485_FetchFrame(Rs485Port_t *port, uint8_t *out, uint16_t out_size, uint16_t *out_length)
{
    if ((port == NULL) || (out == NULL) || (out_length == NULL))
    {
        return false;
    }

    if ((!port->frame_ready) || (port->frame_length == 0U) || (port->frame_length > out_size))
    {
        return false;
    }

    memcpy(out, port->frame_buffer, port->frame_length);
    *out_length = port->frame_length;
    Rs485_ResetFrameAssembler(port);

    return true;
}

void HAL_UART_TxCpltCallback(UART_HandleTypeDef *huart)
{
    if (huart == g_rs485.huart)
    {
        /*
         * DMA 完成仅表示最后一个字节已写入 TDR，
         * 此时停止位可能还在移位寄存器里，所以这里只切到 WAIT_TC。
         */
        g_rs485.tx_state = RS485_TX_STATE_WAIT_TC;
        __HAL_UART_ENABLE_IT(huart, UART_IT_TC);
    }
}

void USART3_IRQHandler(void)
{
    Rs485_OnUartIrq(&g_rs485);
    HAL_UART_IRQHandler(&huart3);
}
```

这段实现里最关键的，不是某个 HAL API 本身，而是几个边界判断背后的物理含义:

- `HAL_UART_TxCpltCallback()` 只说明 DMA 搬运结束，不允许在这里直接拉低 `DE`。
- `TC` 才是“最后一个停止位真正离线”的边界，因此释放总线必须绑在 `TC` 上。
- 帧间静默使用 `t_silent_min = silent_chars * t_char` 计算，软件拿时间戳判定空闲，而不是盯着线路电平猜。
- RX DMA 环形缓冲在 TX 窗口与 `echo_guard` 窗口内主动丢弃本机回声，避免“自己发的字节”污染协议状态机。
- `FE/NE/ORE` 出现后直接丢弃残帧并把读指针追到 DMA 写尾，等价于承认这段时间轴已经失真，必须等下一次静默窗重新开始。
