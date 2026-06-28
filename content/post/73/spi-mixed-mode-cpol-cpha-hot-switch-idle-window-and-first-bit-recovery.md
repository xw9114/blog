---
title: "技能档案：SPI 混挂模式切换里的 CPOL/CPHA 重配置、SCK 静默窗与首位错采恢复"
slug: "skill-spi-mixed-mode-cpol-cpha-hot-switch-idle-window-and-first-bit-recovery"
date: 2026-06-28T09:40:13+08:00
draft: false
description: "从 CPOL/CPHA 动态切换、SCK 空闲电平回归、片选前后静默窗到首位错采重读恢复，系统拆解一条 SPI 总线混挂不同模式从设备时为何最容易死在第一位。"
tags: ["SPI", "STM32", "CPOL", "CPHA", "模式切换", "时序", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

当一颗 STM32 同时挂着 Mode 0 的外部 Flash、Mode 3 的 IMU、甚至还混着一颗对片选建立时间很敏感的 ADC 时，SPI 最容易出问题的地方往往不是持续传输阶段，而是两帧之间那段极短的“模式切换空档”。很多现场故障看起来像“偶发首字节错误”“只有第一位读歪了”“逻辑分析仪上四种模式都像是对的”，本质上却是 **CPOL/CPHA 重配置、SCK 空闲电平回归、片选建立时间和外设状态残留没有被当成一份完整的时域合同来处理**。这个主题真正解决的，不是 `HAL_SPI_TransmitReceive()` 怎么调用，而是一条共享 SPI 总线在跨设备切换时，怎样保证“上一份采样契约已经结束，下一份采样契约才开始”。

## 核心底层概念解析

- **CPOL/CPHA 不是模式编号，而是采样契约**：`CPOL` 定义的是时钟空闲时线路应该停在哪个电平，`CPHA` 定义的是首个有效采样发生在第几个边沿。它们不是枚举常量，而是主从双方对“哪一条边沿有语义”的共同约定。

- **混挂不同模式设备时，真正危险的是帧间切换，不是帧内移位**：同一颗从设备在一次连续事务里，只要模式匹配，后续位流通常很稳定；真正容易出错的是刚从 Mode 0 设备切到 Mode 3 设备，或者反过来切回来时，硬件总线还没完成“空闲态重建”，主机已经开始下一帧。

- **`CPOL` 切换会让 SCK 空闲电平本身发生一次物理跃迁**：如果前一设备要求 `SCK` 空闲低，后一设备要求 `SCK` 空闲高，那么在主机重写 SPI 控制寄存器、重新使能外设后，`SCK` 管脚会从低翻到高。若这时某个 `CS` 已经被拉低，这个“空闲回归边沿”在从设备眼里可能根本不是空闲，而是一记多余时钟。

- **`CPHA` 切换会改写首位的有效建立时间**：对首位来说，`CPHA = 0` 常意味着第一个采样边沿一来就要锁数，外设必须在 `CS` 建立之后立刻准备好 `MISO`；而 `CPHA = 1` 则通常把首个边沿留给数据推出，把真正采样推迟到下一个边沿。于是同样一个 `CS` 建立时间，对两种相位模式的首位预算并不相同。

- **首位预算必须显式写成公式，而不是靠“加一点 delay”**：若程序在 `CS` 拉低后等待 `t_css`，总线周期为 `T_sck`，则首位可用准备时间可近似写成  
  `T_first_budget = t_css + (CPHA == 0 ? 0 : T_sck / 2)`。  
  当从设备首位输出延迟、线路传播延迟与主控输入建立时间之和大于这笔预算时，最先错的往往不是整帧，而就是第一位。

- **混挂模式切换的核心时间窗是“静默窗”而不是“传输时长”**：从上一帧结束到下一帧片选拉低之前，至少要满足  
  `T_quiet >= t_bsy_clear + t_csh_prev + t_recfg + t_idle_settle + t_margin`。  
  这里 `t_bsy_clear` 是 SPI 内部移位链真正空闲的时间，`t_csh_prev` 是前一从设备要求的片选保持，`t_recfg` 是主机重写 `CPOL/CPHA/BR` 的配置时间，`t_idle_settle` 则是 `SCK` 回到新空闲电平并在线路上稳定下来的时间。

- **`BSY`、`RXNE`、`OVR` 这些标志位是模式切换前必须清的现场证据**：如果上一帧最后一个位还在移位器里，或者 `RXNE/OVR` 残留着旧事务的尾巴，你即便把 `CPOL/CPHA` 改对了，也可能在下一帧一开头就先吃到一口旧数据。

- **资源调度问题在混挂模式里更突出**：两个任务分别访问 Flash 和 IMU 时，问题不是“谁先调用 HAL”，而是谁拥有“下一次可以改 SPI 模式”的总线所有权。没有总线锁和最后一次事务时间戳，模式切换就会退化成不可重现的竞争条件。

- **首字节错、后续字节全对，是模式切换类故障的典型指纹**：这通常说明稳态位流时序本身没塌，只是首位在 `CS` 建立、`SCK` 空闲回归或相位切换那一瞬间被采歪了。它和整帧持续错误不是同一种问题，诊断方向也完全不同。

- **恢复动作要围绕“重新建立第一位的时域边界”展开**：最有效的恢复通常不是无限重试，而是先完整撤销片选、清状态、重新应用模式，再给首位多买半拍或一拍时间，例如增加一次额外 Dummy Byte，让真正有语义的数据后移一个槽位。

- **混挂 SPI 的本质不是共享三根线，而是共享一条时间轴**：同一条 `SCK/MOSI/MISO` 上的不同从设备，并不只是电气并联，更是在轮流租用“哪一个边沿属于自己”的解释权。模式切换做不好，本质上就是前一个合同还没结束，下一个合同已经抢着生效。

- **技术哲学上，SPI 的稳定从来不是“跑通一次”**：真正成熟的共享总线设计，会把空闲电平、首位预算、片选保持、状态残留和恢复路径都写成可以验证的约束，而不是靠示波器上看起来差不多、或者延时调到“刚好不报错”为止。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 的共享 SPI 总线管理代码。场景假设 `SPI1` 同时连接一颗 **Mode 0 外部 Flash** 和一颗 **Mode 3 IMU**。代码重点不放在普通收发模板，而放在四件真正决定混挂模式切换质量的事情上：

- 如何在切换前 **等总线真正空闲并清理残留状态**。
- 如何在切换时 **安全重写 `CPOL/CPHA/BR` 并等待 `SCK` 回到新空闲电平**。
- 如何在事务前后 **显式满足片选建立、保持与静默窗预算**。
- 如何对 **首位错采** 做一次有边界的重同步恢复，而不是盲目无限重试。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define SPI_MIXED_MAX_FRAME_BYTES              32U
#define SPI_MIXED_MIN_TIMEOUT_MS                1U
#define SPI_MIXED_MAX_TIMEOUT_MS               20U
#define SPI_MIXED_RETRY_LIMIT                   2U
#define SPI_MIXED_DUMMY_FILL                 0x00U
#define SPI_MIXED_NS_PER_SECOND       1000000000ULL

typedef struct
{
    GPIO_TypeDef *cs_port;
    uint16_t cs_pin;

    uint32_t clk_polarity;
    uint32_t clk_phase;
    uint32_t baud_prescaler;
    uint16_t prescaler_div;

    uint32_t cs_setup_ns;
    uint32_t cs_hold_ns;
    uint32_t deselect_quiet_ns;
    uint32_t mode_settle_ns;
} SpiMixedSlave_t;

typedef struct
{
    SPI_HandleTypeDef *hspi;
    uint32_t spi_kernel_hz;
    uint32_t core_clock_hz;
    uint32_t guard_margin_ns;

    bool mode_valid;
    uint32_t configured_clk_polarity;
    uint32_t configured_clk_phase;
    uint32_t configured_baud_prescaler;

    const SpiMixedSlave_t *last_slave;
    uint32_t last_frame_end_cycle;

    uint32_t mode_switch_count;
    uint32_t first_bit_retry_count;
    volatile uint8_t locked;
} SpiMixedBus_t;

typedef struct
{
    uint8_t payload[SPI_MIXED_MAX_FRAME_BYTES];
    uint16_t payload_len;
    uint8_t retry_count;
    bool recovered_by_extra_dummy;
} SpiMixedReadResult_t;

static uint32_t SpiMixed_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint32_t SpiMixed_CeilDivU64(uint64_t numerator, uint32_t denominator)
{
    if ((numerator == 0ULL) || (denominator == 0U))
    {
        return 0U;
    }

    return (uint32_t)((numerator + (uint64_t)denominator - 1ULL) / (uint64_t)denominator);
}

static uint32_t SpiMixed_ActualSckHz(const SpiMixedBus_t *bus, const SpiMixedSlave_t *slave)
{
    if ((bus == NULL) || (slave == NULL) || (slave->prescaler_div == 0U))
    {
        return 0U;
    }

    return bus->spi_kernel_hz / (uint32_t)slave->prescaler_div;
}

static uint32_t SpiMixed_HalfCycleNs(const SpiMixedBus_t *bus, const SpiMixedSlave_t *slave)
{
    const uint32_t sck_hz = SpiMixed_ActualSckHz(bus, slave);

    if (sck_hz == 0U)
    {
        return 0U;
    }

    /*
     * 半周期预算：
     * T_half = ceil(1e9 / (2 * f_sck))
     *
     * 在 CPHA/CPOL 切换问题里，半周期是一个很关键的物理量：
     * 1. CPHA 改变时，首位真正多出来或少掉的时间量级通常就是半个 SCK 周期。
     * 2. CPOL 改变时，SCK 线回到新空闲电平后，至少要给从设备看见一个稳定的
     *    空闲状态窗口，而不是边翻电平边立刻拉低 CS。
     */
    return SpiMixed_CeilDivU64(SPI_MIXED_NS_PER_SECOND, (uint32_t)(2U * sck_hz));
}

static bool SpiMixed_EnableCycleCounter(void)
{
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CYCCNT = 0U;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;

    return ((DWT->CTRL & DWT_CTRL_CYCCNTENA_Msk) != 0U);
}

static uint32_t SpiMixed_NsToCycles(uint32_t core_hz, uint32_t delay_ns)
{
    return SpiMixed_CeilDivU64((uint64_t)delay_ns * (uint64_t)core_hz,
                               (uint32_t)SPI_MIXED_NS_PER_SECOND);
}

static void SpiMixed_DelayCycles(uint32_t cycles)
{
    const uint32_t start_cycles = DWT->CYCCNT;

    while ((uint32_t)(DWT->CYCCNT - start_cycles) < cycles)
    {
        __NOP();
    }
}

static void SpiMixed_DelayNs(const SpiMixedBus_t *bus, uint32_t delay_ns)
{
    SpiMixed_DelayCycles(SpiMixed_NsToCycles(bus->core_clock_hz, delay_ns));
}

static bool SpiMixed_Lock(SpiMixedBus_t *bus)
{
    uint32_t primask;

    if (bus == NULL)
    {
        return false;
    }

    primask = __get_PRIMASK();
    __disable_irq();

    if (bus->locked != 0U)
    {
        if (primask == 0U)
        {
            __enable_irq();
        }
        return false;
    }

    bus->locked = 1U;

    if (primask == 0U)
    {
        __enable_irq();
    }

    return true;
}

static void SpiMixed_Unlock(SpiMixedBus_t *bus)
{
    uint32_t primask;

    if (bus == NULL)
    {
        return;
    }

    primask = __get_PRIMASK();
    __disable_irq();
    bus->locked = 0U;

    if (primask == 0U)
    {
        __enable_irq();
    }
}

static void SpiMixed_CsHigh(const SpiMixedSlave_t *slave)
{
    HAL_GPIO_WritePin(slave->cs_port, slave->cs_pin, GPIO_PIN_SET);
}

static void SpiMixed_CsLow(const SpiMixedSlave_t *slave)
{
    HAL_GPIO_WritePin(slave->cs_port, slave->cs_pin, GPIO_PIN_RESET);
}

static bool SpiMixed_WaitFlagState(SPI_HandleTypeDef *hspi,
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

static void SpiMixed_FlushRxState(SPI_HandleTypeDef *hspi)
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

/**
 * @brief 计算从上一帧结束到下一次事务开始前的最小静默时间。
 * @param bus 共享 SPI 总线对象。
 * @param next_slave 即将访问的目标从设备。
 * @return 需要满足的静默时间，单位 ns。
 *
 * @note 对混挂模式切换，保守的静默时间可写成：
 *       T_quiet >= t_csh_prev + t_recfg + t_idle_settle + t_margin
 *
 *       其中：
 *       1. t_csh_prev         来自上一从设备的片选保持与高电平静默要求；
 *       2. t_recfg            来自主机改写 CPOL/CPHA/BR 的模式切换动作；
 *       3. t_idle_settle      是 SCK 回到新空闲电平并稳定下来的时间；
 *       4. t_margin           用于吸收软件调度抖动与器件离散差异。
 *
 *       这里把 t_recfg 折进 `mode_settle_ns`，同时在 CPOL/CPHA 真发生切换时，
 *       再额外加一个或两个半周期做边界保护，确保首位不会贴着模式切换边沿开始。
 */
static uint32_t SpiMixed_ComputeQuietNs(const SpiMixedBus_t *bus,
                                        const SpiMixedSlave_t *next_slave)
{
    uint32_t quiet_ns = bus->guard_margin_ns;

    if (bus->last_slave != NULL)
    {
        quiet_ns += bus->last_slave->cs_hold_ns + bus->last_slave->deselect_quiet_ns;
    }

    if (bus->mode_valid)
    {
        const bool polarity_changed = (bus->configured_clk_polarity != next_slave->clk_polarity);
        const bool phase_changed = (bus->configured_clk_phase != next_slave->clk_phase);
        const uint32_t half_cycle_ns = SpiMixed_HalfCycleNs(bus, next_slave);

        quiet_ns += next_slave->mode_settle_ns;

        if (polarity_changed)
        {
            quiet_ns += half_cycle_ns;
        }

        if (phase_changed)
        {
            quiet_ns += half_cycle_ns;
        }
    }

    return quiet_ns;
}

static void SpiMixed_WaitQuietWindow(SpiMixedBus_t *bus, const SpiMixedSlave_t *next_slave)
{
    uint32_t elapsed_cycles;
    uint32_t quiet_cycles;

    if ((bus == NULL) || (next_slave == NULL) || (bus->last_slave == NULL))
    {
        return;
    }

    quiet_cycles = SpiMixed_NsToCycles(bus->core_clock_hz,
                                       SpiMixed_ComputeQuietNs(bus, next_slave));
    elapsed_cycles = DWT->CYCCNT - bus->last_frame_end_cycle;

    if (elapsed_cycles < quiet_cycles)
    {
        SpiMixed_DelayCycles(quiet_cycles - elapsed_cycles);
    }
}

/**
 * @brief 在总线空闲时安全切换到目标从设备所需的 SPI 模式。
 * @param bus 共享 SPI 总线对象。
 * @param slave 目标从设备。
 * @param timeout_ms 等待 SPI 真正空闲的超时预算。
 * @retval HAL_OK      模式已就绪。
 * @retval HAL_TIMEOUT 总线未能在限定时间内退出忙状态。
 *
 * @note 这一步必须满足两个原则：
 *       1. 改 CR1 前，必须确认 BSY=0，避免上一帧最后几位仍在移位时改模式；
 *       2. 改完模式后，必须给 SCK 一个显式稳定窗口，不能让新空闲电平和
 *          新一帧的片选拉低几乎同时发生。
 */
static HAL_StatusTypeDef SpiMixed_ApplyMode(SpiMixedBus_t *bus,
                                            const SpiMixedSlave_t *slave,
                                            uint32_t timeout_ms)
{
    uint32_t cr1_value = 0U;

    if ((bus == NULL) || (slave == NULL) || (bus->hspi == NULL))
    {
        return HAL_ERROR;
    }

    if (bus->mode_valid &&
        (bus->configured_clk_polarity == slave->clk_polarity) &&
        (bus->configured_clk_phase == slave->clk_phase) &&
        (bus->configured_baud_prescaler == slave->baud_prescaler))
    {
        return HAL_OK;
    }

    if (!SpiMixed_WaitFlagState(bus->hspi, SPI_FLAG_TXE, SET, timeout_ms) ||
        !SpiMixed_WaitFlagState(bus->hspi, SPI_FLAG_BSY, RESET, timeout_ms))
    {
        return HAL_TIMEOUT;
    }

    SpiMixed_FlushRxState(bus->hspi);
    __HAL_SPI_DISABLE(bus->hspi);

    cr1_value = slave->baud_prescaler;
    if (slave->clk_polarity == SPI_POLARITY_HIGH)
    {
        cr1_value |= SPI_CR1_CPOL;
    }

    if (slave->clk_phase == SPI_PHASE_2EDGE)
    {
        cr1_value |= SPI_CR1_CPHA;
    }

    MODIFY_REG(bus->hspi->Instance->CR1,
               SPI_CR1_CPOL | SPI_CR1_CPHA | SPI_CR1_BR,
               cr1_value);

    bus->hspi->Init.CLKPolarity = slave->clk_polarity;
    bus->hspi->Init.CLKPhase = slave->clk_phase;
    bus->hspi->Init.BaudRatePrescaler = slave->baud_prescaler;

    __HAL_SPI_ENABLE(bus->hspi);

    bus->configured_clk_polarity = slave->clk_polarity;
    bus->configured_clk_phase = slave->clk_phase;
    bus->configured_baud_prescaler = slave->baud_prescaler;
    bus->mode_valid = true;
    bus->mode_switch_count++;

    /*
     * 模式切换后的等待不是礼貌性 delay，而是给 SCK 新空闲电平和
     * 片上时序链一个明确的回稳窗口。若这里省掉，下一帧首位很可能贴着
     * 空闲回归边沿开始，导致只第一位采错。
     */
    SpiMixed_DelayNs(bus, slave->mode_settle_ns + SpiMixed_HalfCycleNs(bus, slave));
    return HAL_OK;
}

/**
 * @brief 计算一次 SPI 事务的阻塞超时。
 * @param bus 共享 SPI 总线对象。
 * @param slave 当前从设备。
 * @param frame_len 本次总线上真实传输的字节数。
 * @return 建议超时，单位 ms。
 *
 * @note 事务时间近似满足：
 *       t_frame ~= 8 * frame_len / f_sck
 *
 *       再叠加静默窗、片选建立与保持的保守开销，映射到软件阻塞超时：
 *       timeout_ms = ceil((t_quiet + t_css + t_frame + t_csh) / 1 ms)
 *
 *       这样 timeout 就是时域预算的线性映射，而不是拍脑袋常量。
 */
static uint32_t SpiMixed_ComputeTimeoutMs(const SpiMixedBus_t *bus,
                                          const SpiMixedSlave_t *slave,
                                          uint16_t frame_len)
{
    const uint32_t sck_hz = SpiMixed_ActualSckHz(bus, slave);
    const uint64_t transfer_ns =
        SpiMixed_CeilDivU64((uint64_t)8U * (uint64_t)frame_len * SPI_MIXED_NS_PER_SECOND,
                            sck_hz);
    const uint64_t total_ns =
        (uint64_t)SpiMixed_ComputeQuietNs(bus, slave) +
        (uint64_t)slave->cs_setup_ns +
        transfer_ns +
        (uint64_t)slave->cs_hold_ns;

    return SpiMixed_ClampU32((uint32_t)(total_ns / 1000000ULL) + 1U,
                             SPI_MIXED_MIN_TIMEOUT_MS,
                             SPI_MIXED_MAX_TIMEOUT_MS);
}

static HAL_StatusTypeDef SpiMixed_BeginTransaction(SpiMixedBus_t *bus,
                                                   const SpiMixedSlave_t *slave,
                                                   uint32_t timeout_ms)
{
    HAL_StatusTypeDef status;

    SpiMixed_WaitQuietWindow(bus, slave);

    status = SpiMixed_ApplyMode(bus, slave, timeout_ms);
    if (status != HAL_OK)
    {
        return status;
    }

    SpiMixed_FlushRxState(bus->hspi);
    SpiMixed_CsLow(slave);
    SpiMixed_DelayNs(bus, slave->cs_setup_ns);
    return HAL_OK;
}

static HAL_StatusTypeDef SpiMixed_EndTransaction(SpiMixedBus_t *bus,
                                                 const SpiMixedSlave_t *slave,
                                                 uint32_t timeout_ms)
{
    if (!SpiMixed_WaitFlagState(bus->hspi, SPI_FLAG_TXE, SET, timeout_ms) ||
        !SpiMixed_WaitFlagState(bus->hspi, SPI_FLAG_BSY, RESET, timeout_ms))
    {
        SpiMixed_CsHigh(slave);
        return HAL_TIMEOUT;
    }

    SpiMixed_DelayNs(bus, slave->cs_hold_ns);
    SpiMixed_CsHigh(slave);

    bus->last_slave = slave;
    bus->last_frame_end_cycle = DWT->CYCCNT;
    return HAL_OK;
}

/**
 * @brief 组装一帧寄存器读事务，并允许为首位恢复插入额外 Dummy Byte。
 * @param reg_addr 目标寄存器地址，函数内部会补上读位。
 * @param payload_len 希望读出的有效负载长度。
 * @param extra_dummy_bytes 额外补偿的 Dummy Byte 数。
 * @param tx_frame 输出发送帧。
 * @param frame_len 输出总帧长。
 * @param valid_offset 输出第一个有效返回字节在 RX 缓冲中的槽位。
 * @retval true  组帧成功。
 * @retval false 请求长度超界。
 *
 * @note 总线上真实时钟数满足：
 *       frame_len = 1 + extra_dummy_bytes + payload_len
 *
 *       其中：
 *       1. 第 0 个接收槽位对应命令发出期间的回读垃圾值；
 *       2. extra_dummy_bytes 若大于 0，等价于把真正有语义的数据整体后移，
 *          从而给首位额外买下一整字节时钟。
 */
static bool SpiMixed_BuildReadFrame(uint8_t reg_addr,
                                    uint16_t payload_len,
                                    uint8_t extra_dummy_bytes,
                                    uint8_t *tx_frame,
                                    uint16_t *frame_len,
                                    uint16_t *valid_offset)
{
    const uint16_t total_len = (uint16_t)(1U + extra_dummy_bytes + payload_len);

    if ((tx_frame == NULL) || (frame_len == NULL) || (valid_offset == NULL))
    {
        return false;
    }

    if ((payload_len == 0U) || (total_len > SPI_MIXED_MAX_FRAME_BYTES))
    {
        return false;
    }

    tx_frame[0] = (uint8_t)(reg_addr | 0x80U);
    memset(&tx_frame[1], SPI_MIXED_DUMMY_FILL, (size_t)(total_len - 1U));

    *frame_len = total_len;
    *valid_offset = (uint16_t)(1U + extra_dummy_bytes);
    return true;
}

/**
 * @brief 读取寄存器并对首个有效返回字节做校验，不通过时追加 Dummy 重试一次。
 * @param bus 共享 SPI 总线对象。
 * @param slave 目标从设备。
 * @param reg_addr 寄存器地址。
 * @param payload_len 读取长度。
 * @param first_byte_mask 首字节校验掩码，为 0 时表示不校验。
 * @param first_byte_expect 首字节期望值。
 * @param out 输出结果。
 * @retval true  读取成功，且首位校验通过。
 * @retval false 读取失败，或重试后仍不可信。
 *
 * @note 这条恢复路径的关键不是“再试一次”，而是“先完整退回空闲态，再以更保守
 *       的首位预算重发”：
 *       1. 第一次用正常帧长读取；
 *       2. 若首字节槽位不对，则重新撤销片选、等待静默窗，并插入 1 个 Dummy Byte；
 *       3. 真正的数据因此后移到 `valid_offset + 1`，相当于给首位多买了
 *          `8 / f_sck` 的完整时间窗口。
 */
static bool SpiMixed_ReadRegisterVerified(SpiMixedBus_t *bus,
                                          const SpiMixedSlave_t *slave,
                                          uint8_t reg_addr,
                                          uint16_t payload_len,
                                          uint8_t first_byte_mask,
                                          uint8_t first_byte_expect,
                                          SpiMixedReadResult_t *out)
{
    uint8_t tx_frame[SPI_MIXED_MAX_FRAME_BYTES];
    uint8_t rx_frame[SPI_MIXED_MAX_FRAME_BYTES];
    uint8_t attempt;

    if ((bus == NULL) || (slave == NULL) || (out == NULL) || (bus->hspi == NULL))
    {
        return false;
    }

    if (!SpiMixed_Lock(bus))
    {
        return false;
    }

    memset(out, 0, sizeof(*out));

    for (attempt = 0U; attempt < SPI_MIXED_RETRY_LIMIT; ++attempt)
    {
        uint16_t frame_len = 0U;
        uint16_t valid_offset = 0U;
        uint32_t timeout_ms = 0U;
        HAL_StatusTypeDef status;

        if (!SpiMixed_BuildReadFrame(reg_addr,
                                     payload_len,
                                     attempt,
                                     tx_frame,
                                     &frame_len,
                                     &valid_offset))
        {
            break;
        }

        memset(rx_frame, 0, sizeof(rx_frame));
        timeout_ms = SpiMixed_ComputeTimeoutMs(bus, slave, frame_len);

        status = SpiMixed_BeginTransaction(bus, slave, timeout_ms);
        if (status != HAL_OK)
        {
            break;
        }

        status = HAL_SPI_TransmitReceive(bus->hspi, tx_frame, rx_frame, frame_len, timeout_ms);
        if (SpiMixed_EndTransaction(bus, slave, timeout_ms) != HAL_OK)
        {
            status = HAL_TIMEOUT;
        }

        if (status != HAL_OK)
        {
            break;
        }

        if ((first_byte_mask != 0U) &&
            ((rx_frame[valid_offset] & first_byte_mask) != (first_byte_expect & first_byte_mask)))
        {
            /*
             * 首位校验失败，不立即认定整帧时序崩溃，而是先按“模式切换首位预算不足”
             * 处理：清外设残留，完整等待下一轮静默窗，再用多 1 个 Dummy Byte 重试。
             */
            SpiMixed_FlushRxState(bus->hspi);
            bus->first_bit_retry_count++;
            continue;
        }

        memcpy(out->payload, &rx_frame[valid_offset], payload_len);
        out->payload_len = payload_len;
        out->retry_count = attempt;
        out->recovered_by_extra_dummy = (attempt > 0U);

        SpiMixed_Unlock(bus);
        return true;
    }

    SpiMixed_Unlock(bus);
    return false;
}

extern SPI_HandleTypeDef hspi1;

static const SpiMixedSlave_t g_flash_mode0 =
{
    .cs_port = FLASH_CS_GPIO_Port,
    .cs_pin = FLASH_CS_Pin,
    .clk_polarity = SPI_POLARITY_LOW,
    .clk_phase = SPI_PHASE_1EDGE,
    .baud_prescaler = SPI_BAUDRATEPRESCALER_8,
    .prescaler_div = 8U,
    .cs_setup_ns = 40U,
    .cs_hold_ns = 40U,
    .deselect_quiet_ns = 80U,
    .mode_settle_ns = 60U
};

static const SpiMixedSlave_t g_imu_mode3 =
{
    .cs_port = IMU_CS_GPIO_Port,
    .cs_pin = IMU_CS_Pin,
    .clk_polarity = SPI_POLARITY_HIGH,
    .clk_phase = SPI_PHASE_2EDGE,
    .baud_prescaler = SPI_BAUDRATEPRESCALER_16,
    .prescaler_div = 16U,
    .cs_setup_ns = 120U,
    .cs_hold_ns = 120U,
    .deselect_quiet_ns = 200U,
    .mode_settle_ns = 100U
};

static SpiMixedBus_t g_spi1_bus =
{
    .hspi = &hspi1,
    .spi_kernel_hz = 84000000U,
    .core_clock_hz = 168000000U,
    .guard_margin_ns = 80U,
    .mode_valid = false,
    .configured_clk_polarity = 0U,
    .configured_clk_phase = 0U,
    .configured_baud_prescaler = 0U,
    .last_slave = NULL,
    .last_frame_end_cycle = 0U,
    .mode_switch_count = 0U,
    .first_bit_retry_count = 0U,
    .locked = 0U
};

void App_SpiMixedBusInit(void)
{
    SpiMixed_CsHigh(&g_flash_mode0);
    SpiMixed_CsHigh(&g_imu_mode3);
    (void)SpiMixed_EnableCycleCounter();
}

void App_SpiMixedModeProbe(void)
{
    SpiMixedReadResult_t imu_id = {0};

    /*
     * 示例背景：
     * 1. 系统可能刚刚访问过 Mode 0 的 Flash；
     * 2. 下一拍立刻切到 Mode 3 的 IMU 读取 WHO_AM_I；
     * 3. 若模式切换静默窗和首位预算不足，最先出错的通常就是这个固定 ID 字节。
     */
    if (SpiMixed_ReadRegisterVerified(&g_spi1_bus,
                                      &g_imu_mode3,
                                      0x75U,
                                      1U,
                                      0xFFU,
                                      0x68U,
                                      &imu_id))
    {
        ImuLink_UpdateWhoAmI(imu_id.payload[0], imu_id.recovered_by_extra_dummy);
    }
    else
    {
        /*
         * 若这里仍失败，说明问题通常已经超出“首位预算不够”的轻微范畴，
         * 应进一步检查：
         * 1. IMU 对 Mode 3 的 tCSS / tCSH 手册约束；
         * 2. SCK 在 CPOL 翻转后的板级回稳；
         * 3. 是否仍有 DMA / 中断上下文在并发抢占同一 SPI 实例。
         */
        ImuLink_ReportBusFault();
    }
}
```

这段代码真正强调的工程要点有四个：

- **模式切换前先清状态，再谈模式值**。`BSY/RXNE/OVR` 不清干净，`CPOL/CPHA` 再正确也可能把旧尾巴带进新事务。
- **静默窗必须显式预算**。`T_quiet >= t_bsy_clear + t_csh_prev + t_recfg + t_idle_settle + t_margin` 这类公式不写出来，问题就一定会在现场变成“偶发第一位错”。
- **首位错误要按“边界重建”来修，不要按“随机重试”来修**。多给一个 Dummy Byte，本质上是在给第一位重新购买一整字节时钟，而不是碰运气。
- **共享 SPI 需要总线所有权**。一旦多任务并发访问不同模式的从设备，没有锁、没有最后一帧时间戳、没有统一模式切换入口，所有时序预算都会被调度抖动吃掉。

如果继续往工程深处走，下一步应该做的通常不是再把延时调大，而是把这三件事量化出来：`CS` 到首边沿的真实时间、`SCK` 从旧空闲电平翻到新空闲电平的板级回稳时间，以及任务切换导致的最坏模式切换抖动。只有这些量被明确写进总线管理层，混挂不同 SPI 模式的系统才算真正可维护，而不是暂时没撞上那一次最坏边界。
