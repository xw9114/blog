---
title: "技能档案：SPI DMA 连续事务的帧边界，从片选保持到回读错位恢复"
slug: "skill-spi-dma-chip-select-hold-and-readback-phase-recovery"
date: 2026-05-16T10:04:10+08:00
draft: false
description: "从命令相位、Dummy Clock、DMA 搬运节拍、CS 保持时间到一字节回读错位恢复，系统拆解 SPI 连续事务为什么本质上是一份帧边界与采样相位合同。"
tags: ["SPI", "STM32", "DMA", "时序", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

SPI 一旦进入高速连续读写场景，真正困难的地方就不再是 `HAL_SPI_TransmitReceive_DMA()` 能不能返回 `HAL_OK`，而是命令相位、地址相位、Dummy Clock 和有效数据相位能否在一次不被打断的片选窗口里保持对齐。外部 Flash 连续读、IMU FIFO 突发拉取、高速 ADC 帧采样和显示控制器行缓存刷新都属于这一类问题。核心痛点不是“有没有 DMA”，而是当 `CS` 被过早释放、RX 队列残留旧字节、DMA 完成早于总线空闲、首字节需要额外等待半拍或者从设备需要一个 Dummy Byte 才开始回数据时，系统还能不能证明当前拿到的数据仍然属于同一帧，而不是一份已经错相位的数字幻觉。

## 核心底层概念解析

- **SPI 连续事务首先是帧问题，不是字节问题**：很多传感器和 Flash 并不是“给一个时钟就回一个独立字节”，而是先消化命令与地址，再经过一个或多个 **Dummy Cycle** 才进入有效数据相位。只要 `CS` 在这个过程中抖一下，从设备内部状态机就可能回到命令等待态，后续所有字节即便位宽正确，也已经不再属于原来的语义帧。
- **`CPOL/CPHA` 只定义了边沿采样规则，不替你维护相位连续性**：模式 0 到模式 3 解决的是“哪条边沿采样、哪条边沿更新”，但 DMA 连续读写里更棘手的问题是命令相位到数据相位之间有没有发生一字节偏移。换句话说，`CPHA` 管的是单个 bit 的采样时刻，**帧边界** 管的是一串 byte 从哪里开始才算有效。
- **Dummy Byte 不是填充物，而是换取从机输出时间的时域预算**：主机若想读数据，必须继续送时钟。若命令长度为 `N_cmd`，Dummy 字节数为 `N_dummy`，有效载荷长度为 `N_data`，那么一次完整读事务的总比特数是 `8 * (N_cmd + N_dummy + N_data)`。DMA 看到的是一段连续内存搬运，而物理总线看到的是你在用前 `N_cmd + N_dummy` 个字节给从机准备“吐数据”的时间。
- **RX 缓冲天然比“业务有效数据”更早到达**：SPI 全双工意味着每发出一个字节就会同时收到一个字节，因此 `rx[0]` 往往对应命令阶段的无效回波，`rx[N_cmd]` 也可能只是状态字或流水线残留。真正有效数据通常满足 `payload[i] = rx[N_cmd + N_dummy + i]`。如果这个线性映射没在代码里被显式表达，后面出现的所谓“首字节丢失”本质上只是数组索引错了。
- **DMA 完成不等于事务完成**：TX DMA 传完最后一个字节，只能说明数据已经写入 SPI 数据寄存器或 FIFO；最后一位是否真的从 SCK/MOSI 线上移出，还要看 **TXE**、**RXNE** 和 **BSY** 的收尾时序。若在 `BSY` 还没清零前就释放 `CS`，从设备看到的是一帧被硬截断的事务，而不是一次正常结束的读写。
- **`CS` 保持时间本质上是在保护从机状态机提交最后一拍**：很多器件要求 `t_CSH`、`t_SHSL` 或者最后一拍后的 `CS hold`，原因不是礼仪，而是最后一位采样后到内部状态提交之间仍有亚微秒级传播与锁存延迟。若 `CS` 提前抬高，逻辑分析仪上看 SCK 也许已经停了，但器件内部并不一定完成了帧收尾。
- **一字节回读错位往往来自三类源头**：其一，`N_dummy` 配少了，导致你把状态字当成数据字；其二，上一帧的 **RXNE/OVR** 没清，当前首字节被陈旧数据顶掉；其三，命令相位与数据相位之间被错误地拆成两次 DMA，`CS` 中间跳高后从机状态机重置。它们表面都像“数据整体右移一字节”，但修复点完全不同。
- **DMA 是资源调度器，不是正确性担保器**：它擅长把 CPU 从逐字节搬运里解放出来，却不会替你检查这次搬运是不是按设备手册要求的相位长度发生。真正的约束仍然来自从机 `t_ACC`、`t_DO`、`t_DIS`、主控 `f_SCK`、DMA 完成中断延迟和 `CS` 控制路径抖动。
- **连续事务的吞吐预算可以直接量化**：若 SPI 时钟为 `f_sck`，总字节数为 `N_total`，则线级理论持续时间近似 `t_bus ~= 8 * N_total / f_sck`。在此基础上，再叠加 `t_css`、`t_csh`、DMA 启动抖动和中断调度，就能得到软件侧最小超时预算。没有这层预算，所谓“偶发超时”常常只是时钟、帧长和调度抖动之间的算术后果。
- **相位恢复本质上是在验证“这份回读是否仍落在预期窗口”**：最常见的做法不是盲目重读，而是找一个 **同步标记**，例如 WHO_AM_I 常量字节、固定状态位、CRC 或帧头。若期望值落在 `rx[k]` 而不是 `rx[k-1]`，系统就能判断这不是随机噪声，而是明确的一字节错位。
- **总线恢复要回到物理空闲态，而不是只重跑 API**：当怀疑相位已经失真时，正确动作通常是清 RX、清 OVR、等待 **BSY=0**、拉高 `CS` 让从机回到空闲态，再按完整帧重试。直接在“半帧残骸”上继续发字节，只会把错位数据搬得更快。
- **SPI 的技术哲学是把数字流重新绑定到物理帧边界**：只要帧边界失守，后面的 DMA 吞吐、FIFO 深度和缓存优化都会变成对错误数据的高效运输。真正值得守住的，不是 API 返回值，而是“本次收到的每个字节，是否仍然可以追溯到同一次 `CS` 有效窗口”。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 SPI DMA 连续事务封装。代码重点不是初始化模板，而是四条更容易把工程写错的链路：**命令/地址/Dummy/数据相位的一次性拼帧**、**DMA 完成后对 `TXE/RXNE/BSY` 的收尾确认**、**一字节回读错位检测与恢复**、**超时预算与 `CS` 保持时间的显式量化**。示例以“读固定 ID 寄存器 + 突发读寄存器”为背景，但实现方式可以迁移到 Flash、IMU、ADC 等绝大多数 SPI 外设。

```c
#include "stm32f4xx_hal.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define SPI_DMA_MAX_FRAME_BYTES            64U
#define SPI_DMA_READ_BIT                   0x80U
#define SPI_DMA_DUMMY_BYTE                 0xFFU
#define SPI_DMA_PHASE_MAX_RETRY            2U
#define SPI_DMA_TIMEOUT_MARGIN_US          20U
#define SPI_DMA_MIN_TIMEOUT_US             50U

typedef struct
{
    SPI_HandleTypeDef *hspi;
    GPIO_TypeDef *cs_port;
    uint16_t cs_pin;
    uint32_t spi_kernel_hz;
    uint32_t actual_sck_hz;
    uint32_t cs_setup_ns;
    uint32_t cs_hold_ns;
    uint8_t rx_dummy_bytes;         /* 命令之后、有效数据之前需要丢弃的回读字节数。 */
    uint8_t sync_value;             /* 例如 WHO_AM_I 的固定值，用于一字节错位检测。 */
    uint8_t sync_reg;
    volatile uint8_t dma_done;
    volatile uint8_t dma_error;
} SpiDmaBus_t;

typedef struct
{
    uint8_t payload[SPI_DMA_MAX_FRAME_BYTES];
    uint16_t payload_len;
    uint8_t phase_shift_bytes;      /* 0 表示正常；1 表示检测到一字节错位并完成恢复。 */
    uint8_t retried;
} SpiDmaReadResult_t;

static void SpiDma_CsLow(const SpiDmaBus_t *bus)
{
    HAL_GPIO_WritePin(bus->cs_port, bus->cs_pin, GPIO_PIN_RESET);
}

static void SpiDma_CsHigh(const SpiDmaBus_t *bus)
{
    HAL_GPIO_WritePin(bus->cs_port, bus->cs_pin, GPIO_PIN_SET);
}

static void SpiDma_DelayCycles(uint32_t cycles)
{
    while (cycles-- > 0U)
    {
        __NOP();
    }
}

static void SpiDma_DelayNs(uint32_t core_clock_hz, uint32_t delay_ns)
{
    uint64_t cycles;

    if ((core_clock_hz == 0U) || (delay_ns == 0U))
    {
        return;
    }

    /*
     * 纳秒到 CPU 周期数的线性映射：
     * cycles = ceil(delay_ns * f_cpu / 1e9)
     * 这里必须向上取整，因为 CS 建立/保持时间一旦被低估，
     * 从设备状态机看到的就是被截断的帧边界，而不是“差一点”的安全时序。
     */
    cycles = ((uint64_t)delay_ns * (uint64_t)core_clock_hz + 1000000000ULL - 1ULL) / 1000000000ULL;
    SpiDma_DelayCycles((uint32_t)cycles);
}

static void SpiDma_ClearRxAndOvr(SPI_HandleTypeDef *hspi)
{
    __IO uint8_t discard8;
    __IO uint32_t discard32;

    while (__HAL_SPI_GET_FLAG(hspi, SPI_FLAG_RXNE) != RESET)
    {
        discard8 = *(__IO uint8_t *)&hspi->Instance->DR;
        (void)discard8;
    }

    if (__HAL_SPI_GET_FLAG(hspi, SPI_FLAG_OVR) != RESET)
    {
        discard8 = *(__IO uint8_t *)&hspi->Instance->DR;
        discard32 = hspi->Instance->SR;
        (void)discard8;
        (void)discard32;
    }
}

static bool SpiDma_WaitFlagState(SPI_HandleTypeDef *hspi,
                                 uint32_t flag,
                                 FlagStatus expected,
                                 uint32_t timeout_us)
{
    const uint32_t start_tick = HAL_GetTick();

    while ((__HAL_SPI_GET_FLAG(hspi, flag) == expected) == false)
    {
        if (((HAL_GetTick() - start_tick) * 1000U) >= timeout_us)
        {
            return false;
        }
    }

    return true;
}

/**
 * @brief 根据 SPI 时钟与帧长估算连续事务超时。
 * @param actual_sck_hz SPI 实际串行时钟。
 * @param total_bytes 命令、Dummy 与有效载荷合计字节数。
 * @return 建议的超时预算，单位 us。
 *
 * @note 线级时间可近似写成：
 *       t_bus ~= 8 * N_total / f_sck
 *       再加上少量软件与总线收尾裕量：
 *       t_timeout = ceil(8 * N_total * 1e6 / f_sck) + margin
 */
static uint32_t SpiDma_ComputeTimeoutUs(uint32_t actual_sck_hz, uint16_t total_bytes)
{
    uint64_t t_bus_us;

    if ((actual_sck_hz == 0U) || (total_bytes == 0U))
    {
        return SPI_DMA_MIN_TIMEOUT_US;
    }

    t_bus_us = (8ULL * (uint64_t)total_bytes * 1000000ULL + (uint64_t)actual_sck_hz - 1ULL) /
               (uint64_t)actual_sck_hz;
    t_bus_us += SPI_DMA_TIMEOUT_MARGIN_US;

    if (t_bus_us < SPI_DMA_MIN_TIMEOUT_US)
    {
        t_bus_us = SPI_DMA_MIN_TIMEOUT_US;
    }

    return (uint32_t)t_bus_us;
}

/**
 * @brief 组装一帧连续读事务。
 * @param tx_frame DMA 发送帧缓冲。
 * @param frame_len 输出总长度。
 * @param reg_addr 起始寄存器地址。
 * @param payload_len 希望读取的有效载荷长度。
 * @param rx_dummy_bytes 命令之后需要额外送出的 Dummy 字节数。
 * @retval true 组帧成功。
 * @retval false 参数越界。
 *
 * @note 一次连续读事务在线上表现为：
 *       [READ | reg][Dummy x N_dummy][Dummy x N_data]
 *       其中前 N_dummy 个 Dummy 不是“无意义发送”，
 *       而是在给从设备的输出流水线补齐相位。
 */
static bool SpiDma_BuildReadFrame(uint8_t *tx_frame,
                                  uint16_t *frame_len,
                                  uint8_t reg_addr,
                                  uint16_t payload_len,
                                  uint8_t rx_dummy_bytes)
{
    uint16_t total_len;

    if ((tx_frame == NULL) || (frame_len == NULL))
    {
        return false;
    }

    total_len = (uint16_t)(1U + rx_dummy_bytes + payload_len);
    if (total_len > SPI_DMA_MAX_FRAME_BYTES)
    {
        return false;
    }

    tx_frame[0] = (uint8_t)(reg_addr | SPI_DMA_READ_BIT);
    memset(&tx_frame[1], SPI_DMA_DUMMY_BYTE, (size_t)(total_len - 1U));

    *frame_len = total_len;
    return true;
}

/**
 * @brief 从接收帧中提取有效载荷。
 * @param rx_frame 原始接收缓冲区。
 * @param out 输出结果。
 * @param payload_len 有效载荷长度。
 * @param rx_dummy_bytes 命令之后需要丢弃的字节数。
 *
 * @note 有效数据索引满足：
 *       payload[i] = rx_frame[1 + N_dummy + i]
 *       这里的 `1` 是命令字本身在 RX 侧占掉的回波槽位。
 */
static void SpiDma_ExtractPayload(const uint8_t *rx_frame,
                                  SpiDmaReadResult_t *out,
                                  uint16_t payload_len,
                                  uint8_t rx_dummy_bytes)
{
    uint16_t i;
    const uint16_t base = (uint16_t)(1U + rx_dummy_bytes);

    out->payload_len = payload_len;

    for (i = 0U; i < payload_len; ++i)
    {
        out->payload[i] = rx_frame[base + i];
    }
}

/**
 * @brief 通过固定同步字节判断是否出现一字节回读错位。
 * @param rx_frame 原始接收帧。
 * @param rx_dummy_bytes 当前配置的 Dummy 字节数。
 * @param expected_sync 预期同步字节，例如 WHO_AM_I。
 * @retval 0 表示无错位。
 * @retval 1 表示检测到整体晚一字节到达。
 * @retval 0xFF 表示当前帧无法判定。
 *
 * @note 若预期同步字节不在 `rx[1 + N_dummy]`，却出现在 `rx[2 + N_dummy]`，
 *       往往说明：
 *       1. Dummy 字节数少配了 1；或
 *       2. 上一帧残留数据没有被清干净；或
 *       3. 从设备首字节需要更长的数据推出时间。
 */
static uint8_t SpiDma_DetectPhaseShift(const uint8_t *rx_frame,
                                       uint8_t rx_dummy_bytes,
                                       uint8_t expected_sync)
{
    const uint16_t index0 = (uint16_t)(1U + rx_dummy_bytes);
    const uint16_t index1 = (uint16_t)(2U + rx_dummy_bytes);

    if (rx_frame[index0] == expected_sync)
    {
        return 0U;
    }

    if (rx_frame[index1] == expected_sync)
    {
        return 1U;
    }

    return 0xFFU;
}

/**
 * @brief 执行一次连续 SPI DMA 读事务。
 * @param bus SPI DMA 总线对象。
 * @param reg_addr 起始寄存器地址。
 * @param out 输出结果。
 * @retval true 事务成功且输出有效。
 * @retval false 参数非法、DMA 失败或恢复后仍错位。
 *
 * @note 这里故意把“清残留 -> 拉低 CS -> 建立时间 -> 一次 DMA 全帧传输 ->
 *       等待 DMA 完成 -> 等待 TXE/RXNE/BSY 收尾 -> CS 保持 -> 提取载荷”写成
 *       严格顺序，因为 DMA 事务里最危险的问题从来不是单个 API，而是步骤次序被打乱。
 */
bool SpiDma_ReadBurst(SpiDmaBus_t *bus,
                      uint8_t reg_addr,
                      SpiDmaReadResult_t *out)
{
    uint8_t tx_frame[SPI_DMA_MAX_FRAME_BYTES];
    uint8_t rx_frame[SPI_DMA_MAX_FRAME_BYTES];
    uint16_t frame_len;
    uint32_t timeout_us;
    uint8_t attempt;

    if ((bus == NULL) || (out == NULL) || (bus->hspi == NULL))
    {
        return false;
    }

    memset(out, 0, sizeof(*out));

    for (attempt = 0U; attempt < SPI_DMA_PHASE_MAX_RETRY; ++attempt)
    {
        const uint8_t effective_dummy = (uint8_t)(bus->rx_dummy_bytes + attempt);
        uint8_t phase_shift;

        if (!SpiDma_BuildReadFrame(tx_frame,
                                   &frame_len,
                                   reg_addr,
                                   1U,
                                   effective_dummy))
        {
            return false;
        }

        memset(rx_frame, 0, sizeof(rx_frame));
        SpiDma_ClearRxAndOvr(bus->hspi);

        bus->dma_done = 0U;
        bus->dma_error = 0U;

        SpiDma_CsLow(bus);
        SpiDma_DelayNs(SystemCoreClock, bus->cs_setup_ns);

        if (HAL_SPI_TransmitReceive_DMA(bus->hspi, tx_frame, rx_frame, frame_len) != HAL_OK)
        {
            SpiDma_CsHigh(bus);
            return false;
        }

        timeout_us = SpiDma_ComputeTimeoutUs(bus->actual_sck_hz, frame_len);

        while ((bus->dma_done == 0U) && (bus->dma_error == 0U))
        {
            if (timeout_us-- == 0U)
            {
                (void)HAL_SPI_DMAStop(bus->hspi);
                SpiDma_CsHigh(bus);
                return false;
            }
        }

        if (bus->dma_error != 0U)
        {
            SpiDma_CsHigh(bus);
            return false;
        }

        /*
         * DMA 完成只代表最后一个字节进入了外设数据路径，
         * 不能代表最后一位已经从线缆上送完。
         * 因此这里继续等待：
         * 1. TXE = 1，发送数据寄存器已空；
         * 2. RXNE = 1 或最后一个回读已被 DMA 搬走；
         * 3. BSY = 0，总线真正回到空闲。
         */
        if (!SpiDma_WaitFlagState(bus->hspi, SPI_FLAG_TXE, SET, SPI_DMA_MIN_TIMEOUT_US) ||
            !SpiDma_WaitFlagState(bus->hspi, SPI_FLAG_BSY, RESET, SPI_DMA_MIN_TIMEOUT_US))
        {
            SpiDma_CsHigh(bus);
            return false;
        }

        SpiDma_DelayNs(SystemCoreClock, bus->cs_hold_ns);
        SpiDma_CsHigh(bus);

        phase_shift = SpiDma_DetectPhaseShift(rx_frame, effective_dummy, bus->sync_value);
        if (phase_shift == 0xFFU)
        {
            /* 无法用同步字节证明当前帧正确，先强制回空闲态再重试。 */
            SpiDma_ClearRxAndOvr(bus->hspi);
            continue;
        }

        if (phase_shift == 1U)
        {
            out->phase_shift_bytes = 1U;
            out->retried = 1U;
        }

        SpiDma_ExtractPayload(rx_frame, out, 1U, effective_dummy + phase_shift);
        return true;
    }

    return false;
}

/**
 * @brief 校验固定 ID 寄存器是否在正确相位返回。
 * @param bus SPI DMA 总线对象。
 * @retval true 校验成功。
 * @retval false 读回错位或器件未按预期响应。
 *
 * @note 这类同步校验非常适合作为总线恢复入口，因为它把“当前相位是否可信”
 *       收束成一个单字节判定，而不是等到整包业务数据都错了才发现问题。
 */
bool SpiDma_ProbeSync(SpiDmaBus_t *bus)
{
    SpiDmaReadResult_t result;

    if (!SpiDma_ReadBurst(bus, bus->sync_reg, &result))
    {
        return false;
    }

    return (result.payload_len == 1U) && (result.payload[0] == bus->sync_value);
}

/**
 * @brief DMA 发送接收完成回调。
 * @param hspi HAL SPI 句柄。
 *
 * @note 回调只做状态标记，不在中断上下文里拉高 CS，也不在这里解释相位，
 *       因为真正的事务完成语义必须等到任务上下文确认 BSY 清零后才成立。
 */
void HAL_SPI_TxRxCpltCallback(SPI_HandleTypeDef *hspi)
{
    extern SpiDmaBus_t g_imu_spi_dma_bus;

    if (hspi == g_imu_spi_dma_bus.hspi)
    {
        g_imu_spi_dma_bus.dma_done = 1U;
    }
}

void HAL_SPI_ErrorCallback(SPI_HandleTypeDef *hspi)
{
    extern SpiDmaBus_t g_imu_spi_dma_bus;

    if (hspi == g_imu_spi_dma_bus.hspi)
    {
        g_imu_spi_dma_bus.dma_error = 1U;
    }
}

SpiDmaBus_t g_imu_spi_dma_bus =
{
    .hspi = &hspi1,
    .cs_port = IMU_CS_GPIO_Port,
    .cs_pin = IMU_CS_Pin,
    .spi_kernel_hz = 84000000U,
    .actual_sck_hz = 10500000U, /* 84 MHz / 8 */
    .cs_setup_ns = 80U,
    .cs_hold_ns = 80U,
    .rx_dummy_bytes = 0U,
    .sync_value = 0x68U,
    .sync_reg = 0x75U
};

void App_ImuService(void)
{
    if (!SpiDma_ProbeSync(&g_imu_spi_dma_bus))
    {
        /*
         * 典型恢复动作：
         * 1. 停止 DMA，清理 RXNE / OVR；
         * 2. 拉高 CS，给从设备一个明确的空闲边界；
         * 3. 必要时降低一档 SPI 分频，再重新探测同步字节。
         */
        (void)HAL_SPI_DMAStop(g_imu_spi_dma_bus.hspi);
        SpiDma_CsHigh(&g_imu_spi_dma_bus);
        SpiDma_ClearRxAndOvr(g_imu_spi_dma_bus.hspi);
        SensorBus_RequestRecover();
    }
}
```

这段实现真正想守住的，不是“DMA 把一包数据搬完了”，而是“这包数据从命令相位到有效载荷相位始终处在同一次 `CS` 有效窗口里”。`payload[i] = rx[1 + N_dummy + i]` 这类索引映射把协议相位显式写进了代码；`t_timeout ~= 8 * N_total / f_sck + margin` 把帧长、时钟和软件调度重新拉回同一张预算表；`BSY=0` 之后再释放 `CS` 则是在保护从设备的最后一拍提交。DMA 可以减少 CPU 参与，但它从不会自动保证帧边界正确。只有把帧边界、相位长度、收尾时序和恢复路径一起写成合同，SPI 连续事务才配得上“高速可靠”这四个字。
