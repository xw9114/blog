---
title: "技能档案：SPI 共享总线的 MISO 三态释放、片选撤销延迟与帧间污染恢复"
slug: "skill-spi-shared-bus-miso-tristate-release-chip-select-deassertion-and-interframe-contamination-recovery"
date: 2026-06-07T13:58:23+08:00
draft: false
description: "从 MISO 三态释放、片选撤销延迟、帧间保护时间到首字节污染恢复，系统拆解多从设备共享 SPI 为何本质上是一份总线所有权与时域交接合同。"
tags: ["SPI", "STM32", "MISO", "总线共享", "时序", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

当一颗 STM32 同时挂着 IMU、外部 Flash、ADC、LCD 或编码器时，SPI 最难的部分往往不再是 `CPOL/CPHA` 选哪种模式，而是多从设备共享一根 `MISO` 线之后，上一位主人是否已经真正放手，下一位主人又何时可以开始说话。片选抬高过早、从设备三态释放过慢、偏置网络恢复不及、上一帧 `RXNE/OVR` 未清理，这些问题最终都会落在“首字节偶发错误”“切换设备后第一帧脏掉”“逻辑分析仪看着没问题但程序读错”这种最难复现的症状上。这个主题要解决的核心痛点，不是再封装一层 `HAL_SPI_TransmitReceive()`，而是把 **总线所有权交接**、**MISO 三态释放尾延迟**、**片选撤销后的帧间保护时间** 和 **首字节污染后的恢复策略** 串成一条可验证的时域合同。

## 核心底层概念解析

- **共享 SPI 的本质不是多了几个 CS，而是多了一次所有权交接**：单从设备 SPI 里，主机只需要保证边沿采样正确；多从设备共享总线时，还必须证明上一帧结束后 `MISO` 已经回到可交接状态，否则下一帧即便 `SCK`、`CPHA` 完全正确，首字节也可能已经被污染。
- **`MISO` 的三态释放不是理想开关，而是带尾巴的模拟过程**：很多器件数据手册会给出 `tDIS(MISO)` 或 `tHZ`，表示 `CS` 拉高到输出真正高阻之间仍存在几十到几百纳秒的尾延迟。这个时间窗口里，线上并不是“没人驱动”，而是“上一位还没完全松手”。
- **当前从设备也不是 `CS` 一拉低就能立即驱动总线**：对应地，许多器件还给出 `tEN(MISO)`、`tV` 或 `tACC`，表示从 `CS` 拉低到首个有效输出位稳定之间需要一段建立时间。于是帧间保护不应靠经验值，而应从前一设备的释放时间和后一设备的使能时间联合预算。
- **帧间保护时间可以被显式写成公式**：若上一从设备为 `A`，下一从设备为 `B`，则安全交接至少满足 `T_guard >= max(tDIS_A, tEN_B) + t_flight + t_margin`。这里 `t_flight` 是 PCB 走线、隔离器或电平转换器带来的传播延迟，`t_margin` 则吸收温漂、批次差异和软件抖动。
- **片选抬高不等于上一帧已经完全结束**：即便 `HAL_SPI_TransmitReceive()` 返回成功，最后一位也未必已经离开移位寄存器，因此还要继续确认 `TXE=1` 且 `BSY=0`，再满足 `tCSH` 后才能真正撤销 `CS`。很多“切换设备后偶发首字节错”其实是因为上一帧被软件提前截断。
- **浮空总线并不会自动回到可信电平**：当上一从设备进入高阻而下一从设备尚未驱动时，`MISO` 可能短暂悬空，此时偏置电阻与总线电容会形成 `tau = R_bias * C_bus` 的恢复过程。若偏置过弱、线长过大或附近开关噪声强，首位采样就可能落在一个电平尚未稳定的灰区里。
- **首字节污染有两类来源，不能混为一谈**：一类来自物理交接不干净，例如 `MISO` 残留驱动或浮空；另一类来自主控侧状态没清干净，例如上一帧残留 `RXNE/OVR`，导致当前首字节其实是旧数据。两者症状都像“第一个字节脏了”，但修复点一个在总线时序，一个在外设状态机。
- **Dummy Byte 在共享总线里不仅是协议需要，也可以是污染吸收层**：如果首个有效字节最容易被帧间交接污染，那么有意识地加一个 `Dummy Byte`，相当于把最不稳定的那一拍分配给“可丢弃窗口”，把真正有语义的数据推到更稳定的位置。
- **共享总线必须有资源调度语义，而不是靠调用顺序碰运气**：若任务 A 正在给外部 Flash 连续读，任务 B 同时去轮询 IMU，问题不只是 `HAL_BUSY`，而是两个任务都在争抢“谁有权决定下一个 `CS` 应该给谁”。因此总线对象必须显式记录当前所有者、最近一次 `CS` 拉高时刻以及总线锁。
- **恢复动作的第一原则是先让总线回到空闲态**：发现首字节污染后，最糟糕的做法是在残留状态上继续送更多时钟。正确路径应是清 `RXNE/OVR`、等待 `BSY=0`、拉高 `CS`、满足高电平空闲时间，再重新发完整帧；必要时给一次额外 Dummy，让污染消耗在无效窗口里。
- **验证窗口要从“这包数据长得像不像”升级为“它是否出现在正确槽位”**：若预期同步字节本应出现在 `rx[k]`，却出现在 `rx[k+1]`，这说明不是随机噪声，而是明确的相位滞后或帧间污染。真正的系统设计，不会只比对值，还会比对值在帧中的位置。
- **技术哲学上，共享 SPI 不是字节流优化问题，而是所有权交接问题**：一帧数据只有在“上一位已经放手，下一位才开始说话”的前提下才有语义。只谈吞吐、不谈交接，就等于把错误数据更高效地搬进内存。

## 代码能力展现

下面给出一个基于 STM32 HAL 的共享 SPI 总线读事务示例。场景假设 `SPI1` 同时连接外部 Flash 和 IMU，两者共用 `SCK/MOSI/MISO`，各自拥有独立 `CS`。代码重点不是初始化模板，而是四条更容易被工程忽略的链路：**总线锁与所有权记录**、**`MISO` 交接保护时间预算**、**首字节槽位校验与额外 Dummy 恢复**、**`BSY/RXNE/OVR` 收尾清理**。示例默认已经在系统启动时打开 `DWT->CYCCNT`。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define SPI_SHARED_MAX_FRAME_BYTES             64U
#define SPI_SHARED_MAX_RECOVERY_RETRY          2U
#define SPI_SHARED_DUMMY_FILL                  0xFFU
#define SPI_SHARED_MIN_TIMEOUT_MS              1U
#define SPI_SHARED_MAX_TIMEOUT_MS              20U
#define SPI_SHARED_TIMEOUT_MARGIN_MS           1U

typedef struct
{
    GPIO_TypeDef *cs_port;
    uint16_t cs_pin;
    uint32_t cs_setup_ns;          /* CS 拉低到首个 SCK 的建立时间。 */
    uint32_t cs_hold_ns;           /* 最后一位移出后，CS 继续保持的时间。 */
    uint32_t cs_inactive_min_ns;   /* 同一从设备两帧之间要求的最小高电平时间。 */
    uint32_t miso_release_ns;      /* tDIS(MISO): CS 拉高后，MISO 进入高阻的最坏时间。 */
    uint32_t miso_enable_ns;       /* tEN(MISO): CS 拉低后，MISO 驱动有效的最坏时间。 */
    uint8_t dummy_prefix_bytes;    /* 设备协议要求的固定 Dummy Byte 数。 */
} SpiSharedSlave_t;

typedef struct
{
    SPI_HandleTypeDef *hspi;
    uint32_t actual_sck_hz;
    uint32_t trace_flight_ns;      /* 走线、隔离器、电平转换器传播延迟预算。 */
    uint32_t guard_margin_ns;      /* 温漂、批次差异与软件抖动裕量。 */
    const SpiSharedSlave_t *last_owner;
    uint32_t last_cs_rise_cycles;  /* 最近一次 CS 拉高时的 DWT 周期计数。 */
    volatile uint8_t busy;
} SpiSharedBus_t;

typedef struct
{
    uint8_t payload[SPI_SHARED_MAX_FRAME_BYTES];
    uint16_t payload_len;
    uint8_t retry_count;
    bool contamination_recovered;
} SpiSharedReadResult_t;

static uint32_t SpiShared_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint32_t SpiShared_MaxU32(uint32_t a, uint32_t b)
{
    return (a > b) ? a : b;
}

static uint32_t SpiShared_NsToCycles(uint32_t core_hz, uint32_t delay_ns)
{
    if ((core_hz == 0U) || (delay_ns == 0U))
    {
        return 0U;
    }

    /*
     * 纳秒到 CPU 周期数的线性映射:
     * cycles = ceil(delay_ns * f_cpu / 1e9)
     *
     * 这里必须向上取整，因为帧间保护时间一旦被低估，
     * 首字节采样就会直接落进上一从设备尚未释放完的灰区。
     */
    return (uint32_t)(((uint64_t)delay_ns * (uint64_t)core_hz + 1000000000ULL - 1ULL) / 1000000000ULL);
}

static void SpiShared_DelayCycles(uint32_t cycles)
{
    const uint32_t start_cycles = DWT->CYCCNT;

    while ((uint32_t)(DWT->CYCCNT - start_cycles) < cycles)
    {
        /* 用 DWT 做亚微秒级等待，避免 HAL_Delay 量化过粗。 */
    }
}

static void SpiShared_DelayNs(uint32_t delay_ns)
{
    SpiShared_DelayCycles(SpiShared_NsToCycles(SystemCoreClock, delay_ns));
}

static bool SpiShared_Lock(SpiSharedBus_t *bus)
{
    uint32_t primask;

    if (bus == NULL)
    {
        return false;
    }

    primask = __get_PRIMASK();
    __disable_irq();

    if (bus->busy != 0U)
    {
        if (primask == 0U)
        {
            __enable_irq();
        }
        return false;
    }

    bus->busy = 1U;

    if (primask == 0U)
    {
        __enable_irq();
    }

    return true;
}

static void SpiShared_Unlock(SpiSharedBus_t *bus)
{
    uint32_t primask;

    if (bus == NULL)
    {
        return;
    }

    primask = __get_PRIMASK();
    __disable_irq();
    bus->busy = 0U;

    if (primask == 0U)
    {
        __enable_irq();
    }
}

static void SpiShared_CsLow(const SpiSharedSlave_t *slave)
{
    HAL_GPIO_WritePin(slave->cs_port, slave->cs_pin, GPIO_PIN_RESET);
}

static void SpiShared_CsHigh(SpiSharedBus_t *bus, const SpiSharedSlave_t *slave)
{
    HAL_GPIO_WritePin(slave->cs_port, slave->cs_pin, GPIO_PIN_SET);
    bus->last_owner = slave;
    bus->last_cs_rise_cycles = DWT->CYCCNT;
}

static void SpiShared_ClearRxAndOvr(SPI_HandleTypeDef *hspi)
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

static bool SpiShared_WaitFlagState(SPI_HandleTypeDef *hspi,
                                    uint32_t flag,
                                    FlagStatus expected_state,
                                    uint32_t timeout_ms)
{
    const uint32_t start_tick = HAL_GetTick();

    while (((__HAL_SPI_GET_FLAG(hspi, flag) != RESET) ? SET : RESET) != expected_state)
    {
        if ((HAL_GetTick() - start_tick) > timeout_ms)
        {
            return false;
        }
    }

    return true;
}

/**
 * @brief 计算上一从设备撤销后到下一从设备起始前所需的最小交接时间。
 * @param bus SPI 共享总线对象。
 * @param previous 上一位总线所有者，可为空。
 * @param next 下一位要访问的从设备。
 * @return 需要满足的最小保护时间，单位 ns。
 *
 * @note 多从设备共享 MISO 时，安全交接时间满足:
 *       T_guard >= max(tDIS_prev, tEN_next) + t_flight + t_margin
 *
 *       同时还要满足下一从设备自己的最小 CS 高电平时间约束。
 */
static uint32_t SpiShared_ComputeGuardNs(const SpiSharedBus_t *bus,
                                         const SpiSharedSlave_t *previous,
                                         const SpiSharedSlave_t *next)
{
    uint32_t release_ns = 0U;
    uint32_t enable_ns = 0U;
    uint32_t turnaround_ns = 0U;

    if ((bus == NULL) || (next == NULL))
    {
        return 0U;
    }

    if (previous != NULL)
    {
        release_ns = previous->miso_release_ns;
    }

    enable_ns = next->miso_enable_ns;
    turnaround_ns = SpiShared_MaxU32(release_ns, enable_ns) +
                    bus->trace_flight_ns +
                    bus->guard_margin_ns;

    return SpiShared_MaxU32(turnaround_ns, next->cs_inactive_min_ns);
}

/**
 * @brief 等待总线完成所有权交接。
 * @param bus SPI 共享总线对象。
 * @param next 下一位要访问的从设备。
 *
 * @note 使用最近一次 CS 拉高时刻与当前 DWT 计数做差，
 *       避免简单地“每次固定 sleep 一段时间”，从而把空等时间压到刚好足够。
 */
static void SpiShared_WaitTurnaround(SpiSharedBus_t *bus, const SpiSharedSlave_t *next)
{
    uint32_t guard_cycles;
    uint32_t elapsed_cycles;
    const uint32_t guard_ns = SpiShared_ComputeGuardNs(bus, bus->last_owner, next);

    if ((bus == NULL) || (next == NULL) || (bus->last_owner == NULL))
    {
        return;
    }

    guard_cycles = SpiShared_NsToCycles(SystemCoreClock, guard_ns);
    elapsed_cycles = DWT->CYCCNT - bus->last_cs_rise_cycles;

    if (elapsed_cycles < guard_cycles)
    {
        SpiShared_DelayCycles(guard_cycles - elapsed_cycles);
    }
}

/**
 * @brief 根据帧长和 SPI 时钟估算阻塞式事务超时。
 * @param bus SPI 共享总线对象。
 * @param slave 目标从设备。
 * @param total_bytes 本次总线上真实传输的总字节数。
 * @return 建议的超时，单位 ms。
 *
 * @note 线级事务时间近似满足:
 *       t_frame ~= 8 * N_total / f_sck + t_css + t_csh + t_guard
 *
 *       其中 `N_total = 1 + N_dummy + N_payload`。
 *       再加 1 ms 软件裕量后做边界限幅，避免异常参数导致过短超时。
 */
static uint32_t SpiShared_ComputeTimeoutMs(const SpiSharedBus_t *bus,
                                           const SpiSharedSlave_t *slave,
                                           uint16_t total_bytes)
{
    uint64_t frame_ns;
    uint64_t total_ns;

    if ((bus == NULL) || (slave == NULL) || (bus->actual_sck_hz == 0U))
    {
        return SPI_SHARED_MIN_TIMEOUT_MS;
    }

    frame_ns = ((uint64_t)8U * (uint64_t)total_bytes * 1000000000ULL +
                (uint64_t)bus->actual_sck_hz - 1ULL) /
               (uint64_t)bus->actual_sck_hz;

    total_ns = frame_ns +
               (uint64_t)slave->cs_setup_ns +
               (uint64_t)slave->cs_hold_ns +
               (uint64_t)SpiShared_ComputeGuardNs(bus, bus->last_owner, slave);

    total_ns = total_ns / 1000000ULL + SPI_SHARED_TIMEOUT_MARGIN_MS;
    return SpiShared_ClampU32((uint32_t)total_ns, SPI_SHARED_MIN_TIMEOUT_MS, SPI_SHARED_MAX_TIMEOUT_MS);
}

/**
 * @brief 组装一次 SPI 读帧。
 * @param tx_frame 发送缓冲区。
 * @param total_len 输出总长度。
 * @param valid_offset 输出首个有效返回字节所在槽位。
 * @param command 读命令，调用者需自行包含读位和起始地址。
 * @param payload_len 希望读取的有效载荷长度。
 * @param fixed_dummy_bytes 设备协议要求的固定 Dummy 数。
 * @param extra_dummy_bytes 为恢复帧间污染而附加的 Dummy 数。
 * @retval true 组帧成功。
 * @retval false 帧长越界。
 *
 * @note 首个有效字节槽位满足:
 *       valid_offset = 1 + fixed_dummy_bytes + extra_dummy_bytes
 *
 *       其中索引 `0` 始终被命令回波占用，因此不能把 `rx[0]`
 *       误当成真正的业务首字节。
 */
static bool SpiShared_BuildReadFrame(uint8_t *tx_frame,
                                     uint16_t *total_len,
                                     uint16_t *valid_offset,
                                     uint8_t command,
                                     uint16_t payload_len,
                                     uint8_t fixed_dummy_bytes,
                                     uint8_t extra_dummy_bytes)
{
    const uint16_t total = (uint16_t)(1U + fixed_dummy_bytes + extra_dummy_bytes + payload_len);

    if ((tx_frame == NULL) || (total_len == NULL) || (valid_offset == NULL))
    {
        return false;
    }

    if ((payload_len == 0U) || (total > SPI_SHARED_MAX_FRAME_BYTES))
    {
        return false;
    }

    tx_frame[0] = command;
    memset(&tx_frame[1], SPI_SHARED_DUMMY_FILL, (size_t)(total - 1U));

    *total_len = total;
    *valid_offset = (uint16_t)(1U + fixed_dummy_bytes + extra_dummy_bytes);
    return true;
}

static bool SpiShared_IsFirstByteValid(const uint8_t *rx_frame,
                                       uint16_t valid_offset,
                                       uint8_t sync_mask,
                                       uint8_t sync_expect)
{
    if (sync_mask == 0U)
    {
        return true;
    }

    return ((rx_frame[valid_offset] & sync_mask) == (sync_expect & sync_mask));
}

/**
 * @brief 在共享 SPI 总线上读取一帧，并对首字节槽位做校验与恢复。
 * @param bus SPI 共享总线对象。
 * @param slave 目标从设备。
 * @param command 读命令，调用者需自行拼好读位和寄存器地址。
 * @param payload_len 希望读取的有效载荷长度。
 * @param sync_mask 首字节校验掩码；为 0 表示不做校验。
 * @param sync_expect 首字节期望值。
 * @param out 输出结果。
 * @retval true 读取成功且结果可信。
 * @retval false 参数非法、总线忙、外设错误或恢复后仍污染。
 *
 * @note 该函数的恢复策略很明确:
 *       1. 第一次按设备协议要求的 Dummy 数发起读事务。
 *       2. 若首字节槽位校验失败，则强制回空闲态并追加 1 个 Dummy 重试。
 *
 *       额外 Dummy 的含义不是“蒙一个字节”，而是把最易受帧间污染的时间窗
 *       显式分配给一个可以丢弃的槽位。
 */
bool SpiShared_ReadVerified(SpiSharedBus_t *bus,
                            const SpiSharedSlave_t *slave,
                            uint8_t command,
                            uint16_t payload_len,
                            uint8_t sync_mask,
                            uint8_t sync_expect,
                            SpiSharedReadResult_t *out)
{
    uint8_t tx_frame[SPI_SHARED_MAX_FRAME_BYTES];
    uint8_t rx_frame[SPI_SHARED_MAX_FRAME_BYTES];
    bool success = false;
    uint8_t attempt;

    if ((bus == NULL) || (slave == NULL) || (out == NULL) || (bus->hspi == NULL))
    {
        return false;
    }

    if (!SpiShared_Lock(bus))
    {
        return false;
    }

    memset(out, 0, sizeof(*out));

    for (attempt = 0U; attempt < SPI_SHARED_MAX_RECOVERY_RETRY; ++attempt)
    {
        HAL_StatusTypeDef hal_status;
        uint16_t total_len;
        uint16_t valid_offset;
        uint32_t timeout_ms;

        if (!SpiShared_BuildReadFrame(tx_frame,
                                      &total_len,
                                      &valid_offset,
                                      command,
                                      payload_len,
                                      slave->dummy_prefix_bytes,
                                      attempt))
        {
            break;
        }

        /*
         * 先做总线交接等待，再清理 RXNE / OVR。
         * 这样既保证上一位所有者已经放手，也避免把旧帧残留错当成本帧首字节。
         */
        SpiShared_WaitTurnaround(bus, slave);
        SpiShared_ClearRxAndOvr(bus->hspi);
        memset(rx_frame, 0, sizeof(rx_frame));

        SpiShared_CsLow(slave);
        SpiShared_DelayNs(slave->cs_setup_ns);

        timeout_ms = SpiShared_ComputeTimeoutMs(bus, slave, total_len);
        hal_status = HAL_SPI_TransmitReceive(bus->hspi, tx_frame, rx_frame, total_len, timeout_ms);

        /*
         * HAL 返回成功并不自动等于帧边界已安全提交。
         * 必须确认 TXE=1 且 BSY=0，再满足 tCSH 后才能抬高 CS。
         */
        if ((hal_status != HAL_OK) ||
            !SpiShared_WaitFlagState(bus->hspi, SPI_FLAG_TXE, SET, timeout_ms) ||
            !SpiShared_WaitFlagState(bus->hspi, SPI_FLAG_BSY, RESET, timeout_ms))
        {
            SpiShared_DelayNs(slave->cs_hold_ns);
            SpiShared_CsHigh(bus, slave);
            SpiShared_ClearRxAndOvr(bus->hspi);
            break;
        }

        SpiShared_DelayNs(slave->cs_hold_ns);
        SpiShared_CsHigh(bus, slave);

        if (!SpiShared_IsFirstByteValid(rx_frame, valid_offset, sync_mask, sync_expect))
        {
            /*
             * 首字节校验失败，优先按“帧间污染或前置槽位不足”处理。
             * 清空接收侧状态后，再用多 1 个 Dummy 的版本重发完整帧。
             */
            SpiShared_ClearRxAndOvr(bus->hspi);
            continue;
        }

        memcpy(out->payload, &rx_frame[valid_offset], payload_len);
        out->payload_len = payload_len;
        out->retry_count = attempt;
        out->contamination_recovered = (attempt > 0U);
        success = true;
        break;
    }

    SpiShared_Unlock(bus);
    return success;
}

static const SpiSharedSlave_t g_spi1_flash =
{
    .cs_port = FLASH_CS_GPIO_Port,
    .cs_pin = FLASH_CS_Pin,
    .cs_setup_ns = 20U,
    .cs_hold_ns = 20U,
    .cs_inactive_min_ns = 50U,
    .miso_release_ns = 60U,
    .miso_enable_ns = 30U,
    .dummy_prefix_bytes = 1U
};

static const SpiSharedSlave_t g_spi1_imu =
{
    .cs_port = IMU_CS_GPIO_Port,
    .cs_pin = IMU_CS_Pin,
    .cs_setup_ns = 80U,
    .cs_hold_ns = 80U,
    .cs_inactive_min_ns = 120U,
    .miso_release_ns = 50U,
    .miso_enable_ns = 90U,
    .dummy_prefix_bytes = 0U
};

static SpiSharedBus_t g_spi1_bus =
{
    .hspi = &hspi1,
    .actual_sck_hz = 18000000U,
    .trace_flight_ns = 25U,
    .guard_margin_ns = 40U,
    .last_owner = NULL,
    .last_cs_rise_cycles = 0U,
    .busy = 0U
};

void App_ImuProbeWhoAmI(void)
{
    SpiSharedReadResult_t result;

    /*
     * WHO_AM_I 读回值固定为 0x68，可用于验证:
     * 1. 首字节是否出现在正确槽位；
     * 2. 从 Flash 切到 IMU 后，MISO 交接是否干净。
     */
    if (SpiShared_ReadVerified(&g_spi1_bus,
                               &g_spi1_imu,
                               (uint8_t)(0x75U | 0x80U),
                               1U,
                               0xFFU,
                               0x68U,
                               &result))
    {
        ImuLink_UpdateState(result.payload[0], result.contamination_recovered);
    }
    else
    {
        /*
         * 失败后的正确动作不是立刻切下一个设备，而是交给上层做进一步恢复:
         * 1. 降一档 SPI 分频；
         * 2. 增大 guard_margin_ns；
         * 3. 检查 MISO 偏置与器件 tDIS/tEN 数据手册预算。
         */
        ImuLink_ReportFault();
    }
}
```

这段代码真正建立的，不是“共享一条 SPI 也能读到数据”的侥幸，而是一份总线交接合同。`T_guard >= max(tDIS_prev, tEN_next) + t_flight + t_margin` 把两颗从设备之间的物理释放与建立时间拉回同一条时间轴；`valid_offset = 1 + N_dummy` 把“第几个字节才真正有语义”显式写进了代码；额外 Dummy 重试则承认首字节是共享总线里最脆弱的一拍，并为它预留了一个可丢弃窗口。对多从设备 SPI 来说，真正决定系统稳定性的，往往不是时钟还能不能再快一点，而是上一位设备有没有在你开始下一帧之前，真正把 `MISO` 让出来。
