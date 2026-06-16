---
title: "技能档案：高速 SPI 读时序里的采样窗、板级传播延迟与 Dummy Cycle 预算"
slug: "skill-high-speed-spi-sampling-window-board-delay-and-dummy-cycle-budget"
date: 2026-06-16T08:31:15+08:00
draft: false
description: "从半周期采样窗、器件 tCO/tSU、板级传播延迟到首字节 Dummy Cycle 映射，系统拆解高速 SPI 读事务为什么常死在时域预算坍缩而不是模式编号。"
tags: ["SPI", "STM32", "Dummy Cycle", "时序", "高速接口", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

很多人把 SPI 提速，第一反应是去改 `BaudRatePrescaler`，第二反应是把 `CPOL/CPHA` 四种模式再试一遍；真正到了外部 Flash 高速读、ADC 连续采样、显示控制器大块搬运或者 IMU 突发寄存器读取时，系统暴露的问题却往往不是模式配错，而是 **采样窗已经被器件输出延迟、板级传播延迟和主控输入建立时间吃空了**。这类场景真正的痛点，不是“HAL 能不能收发成功”，而是 **每一位数据在被 STM32 锁存之前，到底有没有足够的物理稳定时间**，以及 **首字节还来不及吐出来时，Dummy Cycle 究竟该加多少**。这个主题要解决的核心问题，就是把高速 SPI 读事务从“经验降频”拉回到一份可计算、可验证、可映射到寄存器参数的时域预算。

## 核心底层概念解析

- **CPOL/CPHA 只定义边沿角色，不保证边沿那一刻数据已经有效**：模式 0 到模式 3 决定的是“谁在领先沿更新、谁在滞后沿采样”，但真正决定能不能读对的，是采样边沿之前究竟还剩多少有效建立时间。
- **高速 SPI 的稳定性首先受半周期预算约束**：若从设备在一个边沿推出下一位数据，主机在下一个相反边沿采样，则稳态读路径至少满足  
  `T_sck / 2 >= t_co_slave + t_flight + t_su_master + t_jitter + t_margin`。  
  这里的 `t_co_slave` 是从设备时钟到数据有效延迟，`t_flight` 是走线、电平转换器、隔离器和封装传播延迟，`t_su_master` 是 MCU 输入建立时间，`t_jitter` 和 `t_margin` 则吸收边沿抖动与温漂余量。
- **首字节和后续字节不是同一份合同**：稳态位流只需要关心每一位的 `t_co`，但读事务的首字节还要额外等待器件内部地址译码、阵列访问、页缓存装载或状态机切换，因此它往往满足另一条更苛刻的不等式。
- **Dummy Cycle 的本质不是“协议格式的一部分”，而是为首字节购买整周期时间**：若地址阶段结束后，从设备还需要 `t_first_valid` 才能把首位推到 MISO 上，那么首位采样至少应满足  
  `T_sck / 2 + N_dummy * T_sck >= t_first_valid + t_flight + t_su_master + t_jitter + t_margin`。  
  这里每增加 1 个 Dummy bit，本质上就是给首字节再多买 1 个完整 `T_sck`。
- **Dummy Cycle 只能修复首字节延迟，不能修复稳态采样窗坍缩**：如果 `T_sck / 2` 连 `t_co_slave + t_flight + t_su_master` 都装不下，那么后续每一位都没有稳定窗口。此时继续加 Dummy 只是让第一位晚点开始错，不能让整帧突然正确。
- **板级传播延迟是高速 SPI 最容易被软件忽略的隐形税**：10 cm 走线、电平转换器、共模扼流圈、串联阻尼电阻和探头负载都会改写有效边沿到达时间。数字协议看起来只是“0 和 1”，但高速下本质仍然是模拟边沿在铜线上奔跑。
- **GPIO 片选时序和首字节正确性直接相关**：当 `CPHA = 0` 时，首位往往在第一个采样沿就被锁存。如果 `CS` 拉低后没有满足器件的 `tCSS`，从设备甚至还没切进读状态，第一拍就已经被主机采走了。
- **SPI 主机的输入同步链也在吞噬预算**：不少 MCU 输入路径带有同步触发器、数字滤波或内部总线跨时钟域逻辑，它们虽然通常被折叠进手册参数，但工程上必须把这类建立时间显式记入预算，而不是假设管脚边沿到内核采样“零延迟”。
- **8 位数据帧下的 Dummy Cycle 经常只能按字节向上取整**：很多器件手册给的是 `6 bit`、`10 bit` 或 `14 bit` Dummy，而普通 SPI 外设若跑在 8 bit 数据帧模式，只能把 `N_dummy_bit` 映射成 `ceil(N_dummy_bit / 8)` 个 Dummy Byte。你买到的时间会略多，但不会更少。
- **逻辑分析仪“看起来对”不代表 MCU 真有建立时间**：分析仪往往挂在测试点，看到的是探头位置的波形；真正决定读错不读错的，是 MCU 封装管脚处、采样触发器前一级的时序。两者并不总是同一个世界。
- **降频并不是保守主义，而是在重建有效采样窗**：当 `f_sck` 降低时，`T_sck / 2` 线性变大；这意味着你不是“把总线调慢一点试试”，而是在给 `t_co + t_flight + t_su` 重新腾出时间。
- **数据手册里的 `max 50 MHz` 从来不是无条件承诺**：那个数字通常建立在指定电压、温度、负载电容、上升下降时间和特定 Dummy 配置上。脱离这些前提，只记住一个频率上限，等于只抄了合同标题，没有抄附加条款。
- **技术哲学上，高速 SPI 不只是“更快的移位寄存器”，而是一份边沿预算表**：你每提高一档时钟，本质上都在压缩 `t_co`、板级传播、输入建立、首字节周转和软件片选保持共同瓜分的时间池。真正成熟的设计，不会让这些开销躲在经验值后面，而是会把它们逐项记账。

## 代码能力展现

下面给出一个基于 **STM32 HAL** 的高速 SPI 读链路示例。场景假设 `SPI1` 连接一颗外部 Flash，使用 `0x0B` Fast Read 指令，地址阶段后需要 Dummy Cycle 才能开始稳定吐出首字节。代码重点不是重复 `HAL_SPI_Init()` 模板，而是把 **稳态采样窗预算**、**首字节 Dummy bit 预算**、**分频器选择**、**片选纳秒级建立/保持** 和 **阻塞超时映射** 串成一条完整链路。

```c
#include "main.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define SPI_FAST_READ_MAX_PAYLOAD_BYTES         256U
#define SPI_FAST_READ_MAX_HEADER_BYTES           16U
#define SPI_FAST_READ_TIMEOUT_MIN_MS              1U
#define SPI_FAST_READ_TIMEOUT_MAX_MS             50U
#define SPI_FAST_READ_DUMMY_FILL               0x00U
#define SPI_FAST_READ_NS_PER_SECOND      1000000000ULL

typedef struct
{
    uint16_t divisor;
    uint32_t hal_prescaler;
} SpiPrescalerEntry_t;

typedef struct
{
    bool idle_clock_high;
    bool sample_on_second_edge;

    uint8_t opcode;
    uint8_t address_bytes;
    uint16_t fixed_dummy_bits;

    uint32_t desired_sck_hz;
    uint32_t slave_max_sck_hz;

    uint32_t first_data_valid_ns;
    uint32_t per_bit_tco_ns;
    uint32_t board_delay_ns;
    uint32_t master_setup_ns;
    uint32_t edge_jitter_ns;
    uint32_t timing_margin_ns;

    uint32_t cs_setup_ns;
    uint32_t cs_hold_ns;
} SpiFastReadTiming_t;

typedef struct
{
    uint32_t actual_sck_hz;
    uint32_t sck_period_ns;
    uint32_t half_cycle_ns;

    uint16_t dummy_bits;
    uint16_t dummy_bytes;

    int32_t steady_state_slack_ns;
    int32_t first_bit_slack_ns;
} SpiFastReadPlan_t;

typedef struct
{
    SPI_HandleTypeDef *hspi;
    GPIO_TypeDef *cs_port;
    uint16_t cs_pin;
    uint32_t spi_kernel_hz;
    uint32_t core_clock_hz;

    SpiFastReadTiming_t timing;
    SpiFastReadPlan_t plan;
} SpiFastReadPort_t;

static const SpiPrescalerEntry_t k_spi_prescalers[] =
{
    {2U,   SPI_BAUDRATEPRESCALER_2},
    {4U,   SPI_BAUDRATEPRESCALER_4},
    {8U,   SPI_BAUDRATEPRESCALER_8},
    {16U,  SPI_BAUDRATEPRESCALER_16},
    {32U,  SPI_BAUDRATEPRESCALER_32},
    {64U,  SPI_BAUDRATEPRESCALER_64},
    {128U, SPI_BAUDRATEPRESCALER_128},
    {256U, SPI_BAUDRATEPRESCALER_256}
};

static uint32_t SpiFastRead_MinU32(uint32_t a, uint32_t b)
{
    return (a < b) ? a : b;
}

static uint32_t SpiFastRead_MaxU32(uint32_t a, uint32_t b)
{
    return (a > b) ? a : b;
}

static uint32_t SpiFastRead_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint32_t SpiFastRead_CeilDivU64(uint64_t numerator, uint32_t denominator)
{
    if ((numerator == 0ULL) || (denominator == 0U))
    {
        return 0U;
    }

    return (uint32_t)((numerator + (uint64_t)denominator - 1ULL) / (uint64_t)denominator);
}

static bool SpiFastRead_EnableCycleCounter(void)
{
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CYCCNT = 0U;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;

    return ((DWT->CTRL & DWT_CTRL_CYCCNTENA_Msk) != 0U);
}

static void SpiFastRead_DelayNs(uint32_t core_clock_hz, uint32_t delay_ns)
{
    const uint32_t start_cycles = DWT->CYCCNT;
    const uint32_t wait_cycles = SpiFastRead_CeilDivU64((uint64_t)delay_ns * (uint64_t)core_clock_hz,
                                                        (uint32_t)SPI_FAST_READ_NS_PER_SECOND);

    while ((uint32_t)(DWT->CYCCNT - start_cycles) < wait_cycles)
    {
        __NOP();
    }
}

static void SpiFastRead_CsAssert(const SpiFastReadPort_t *port)
{
    HAL_GPIO_WritePin(port->cs_port, port->cs_pin, GPIO_PIN_RESET);
}

static void SpiFastRead_CsDeassert(const SpiFastReadPort_t *port)
{
    HAL_GPIO_WritePin(port->cs_port, port->cs_pin, GPIO_PIN_SET);
}

static bool SpiFastRead_WaitFlag(SPI_HandleTypeDef *hspi,
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
 * @brief 由稳态每 bit 采样路径预算推导安全 SCK 上限。
 * @param timing 器件与板级时序约束。
 * @return 不超过稳态采样窗约束的最高理论时钟，单位 Hz。
 *
 * @note 稳态采样窗预算来自:
 *       T_sck / 2 >= t_co_slave + t_board + t_su_master + t_jitter + t_margin
 *
 *       因而有:
 *       f_sck <= 1 / (2 * path_ns)
 *
 *       这里故意把所有延迟项集中到 `path_ns`，便于后续排查时知道
 *       频率为什么不能再往上推，而不是只看到一个神秘的 prescaler。
 */
static uint32_t SpiFastRead_ComputeSteadySafeHz(const SpiFastReadTiming_t *timing)
{
    const uint32_t path_ns =
        timing->per_bit_tco_ns +
        timing->board_delay_ns +
        timing->master_setup_ns +
        timing->edge_jitter_ns +
        timing->timing_margin_ns;

    if (path_ns == 0U)
    {
        return 0U;
    }

    return (uint32_t)(SPI_FAST_READ_NS_PER_SECOND / (2ULL * (uint64_t)path_ns));
}

/**
 * @brief 在不违反稳态时序约束的前提下选择 STM32 SPI 分频器。
 * @param spi_kernel_hz SPI 外设内核时钟，单位 Hz。
 * @param timing 器件与板级时序约束。
 * @param out_actual_sck_hz 输出实际 SCK，单位 Hz。
 * @param out_hal_prescaler 输出 HAL 预分频枚举。
 * @retval true 已选出合法分频器。
 * @retval false 任何分频都无法满足当前约束。
 *
 * @note 目标频率同时受三类上限约束:
 *       1. 用户期望频率 `desired_sck_hz`
 *       2. 从设备手册上限 `slave_max_sck_hz`
 *       3. 由稳态半周期预算推导出的 `steady_safe_hz`
 *
 *       最终选择“不超过这三者最小值的最快档位”，既不过度保守，也不拿
 *       数据正确性去换表面吞吐。
 */
static bool SpiFastRead_SelectPrescaler(uint32_t spi_kernel_hz,
                                        const SpiFastReadTiming_t *timing,
                                        uint32_t *out_actual_sck_hz,
                                        uint32_t *out_hal_prescaler)
{
    uint32_t best_hz = 0U;
    uint32_t best_hal = 0U;
    const uint32_t steady_safe_hz = SpiFastRead_ComputeSteadySafeHz(timing);
    const uint32_t target_hz = SpiFastRead_MinU32(timing->desired_sck_hz,
                                                  SpiFastRead_MinU32(timing->slave_max_sck_hz, steady_safe_hz));

    if ((spi_kernel_hz == 0U) || (target_hz == 0U) || (out_actual_sck_hz == NULL) || (out_hal_prescaler == NULL))
    {
        return false;
    }

    for (uint32_t i = 0U; i < (sizeof(k_spi_prescalers) / sizeof(k_spi_prescalers[0])); ++i)
    {
        const uint32_t actual_hz = spi_kernel_hz / k_spi_prescalers[i].divisor;

        if ((actual_hz <= target_hz) && (actual_hz > best_hz))
        {
            best_hz = actual_hz;
            best_hal = k_spi_prescalers[i].hal_prescaler;
        }
    }

    if (best_hz == 0U)
    {
        return false;
    }

    *out_actual_sck_hz = best_hz;
    *out_hal_prescaler = best_hal;
    return true;
}

/**
 * @brief 依据首字节周转时间推导需要补偿的 Dummy bit 数。
 * @param timing 器件与板级时序约束。
 * @param actual_sck_hz 已选定的实际 SCK，单位 Hz。
 * @param plan 输出计划，其中会填充 dummy 位数和剩余裕量。
 * @retval true 计划构建成功。
 * @retval false 分频不可达或稳态窗口已经为负。
 *
 * @note 首字节采样预算满足:
 *       T_sck / 2 + N_dummy * T_sck
 *       >= t_first_valid + t_board + t_su_master + t_jitter + t_margin
 *
 *       推得:
 *       N_dummy >= ceil((path_first - T_sck / 2) / T_sck)
 *
 *       注意这只能修复“首字节来得太晚”的问题；若稳态 `T_sck / 2` 已经不足，
 *       那么无论 Dummy 加多少，后续位流都会继续出错。
 */
static bool SpiFastRead_BuildPlan(const SpiFastReadTiming_t *timing,
                                  uint32_t actual_sck_hz,
                                  SpiFastReadPlan_t *plan)
{
    uint32_t period_ns;
    uint32_t half_cycle_ns;
    int32_t steady_slack_ns;
    int32_t first_path_ns;
    uint32_t dynamic_dummy_bits = 0U;

    if ((timing == NULL) || (actual_sck_hz == 0U) || (plan == NULL))
    {
        return false;
    }

    memset(plan, 0, sizeof(*plan));

    period_ns = SpiFastRead_CeilDivU64(SPI_FAST_READ_NS_PER_SECOND, actual_sck_hz);
    half_cycle_ns = period_ns / 2U;

    steady_slack_ns =
        (int32_t)half_cycle_ns -
        (int32_t)(timing->per_bit_tco_ns +
                  timing->board_delay_ns +
                  timing->master_setup_ns +
                  timing->edge_jitter_ns +
                  timing->timing_margin_ns);
    if (steady_slack_ns < 0)
    {
        return false;
    }

    first_path_ns =
        (int32_t)(timing->first_data_valid_ns +
                  timing->board_delay_ns +
                  timing->master_setup_ns +
                  timing->edge_jitter_ns +
                  timing->timing_margin_ns);

    if (first_path_ns > (int32_t)half_cycle_ns)
    {
        dynamic_dummy_bits = SpiFastRead_CeilDivU64((uint64_t)(first_path_ns - (int32_t)half_cycle_ns),
                                                    period_ns);
    }

    plan->actual_sck_hz = actual_sck_hz;
    plan->sck_period_ns = period_ns;
    plan->half_cycle_ns = half_cycle_ns;
    plan->dummy_bits = (uint16_t)SpiFastRead_MaxU32(timing->fixed_dummy_bits, dynamic_dummy_bits);
    plan->dummy_bytes = (uint16_t)SpiFastRead_CeilDivU64(plan->dummy_bits, 8U);
    plan->steady_state_slack_ns = steady_slack_ns;
    plan->first_bit_slack_ns =
        (int32_t)(half_cycle_ns + ((uint32_t)plan->dummy_bits * period_ns)) - first_path_ns;

    return true;
}

/**
 * @brief 计算一次 Fast Read 阻塞式事务的合理超时。
 * @param plan 已生成的读时序计划。
 * @param timing 器件时序约束。
 * @param payload_len 数据负载长度，单位 byte。
 * @return 超时预算，单位 ms。
 *
 * @note 事务总时间近似满足:
 *       t_total ~= 8 * (N_header + N_payload) / f_sck + t_css + t_csh
 *
 *       其中:
 *       N_header = 1(opcode) + N_addr + N_dummy_byte
 *
 *       这让软件层的 timeout 不再拍脑袋，而是能跟总线位数和时钟频率对齐。
 */
static uint32_t SpiFastRead_ComputeTimeoutMs(const SpiFastReadPlan_t *plan,
                                             const SpiFastReadTiming_t *timing,
                                             uint16_t payload_len)
{
    const uint32_t header_bytes = 1U + (uint32_t)timing->address_bytes + (uint32_t)plan->dummy_bytes;
    const uint32_t total_bytes = header_bytes + payload_len;
    const uint64_t transfer_ns =
        SpiFastRead_CeilDivU64((uint64_t)8U * (uint64_t)total_bytes * SPI_FAST_READ_NS_PER_SECOND,
                               plan->actual_sck_hz);
    const uint64_t total_ns = transfer_ns + (uint64_t)timing->cs_setup_ns + (uint64_t)timing->cs_hold_ns;
    const uint32_t total_ms = (uint32_t)(total_ns / 1000000ULL) + 1U;

    return SpiFastRead_ClampU32(total_ms, SPI_FAST_READ_TIMEOUT_MIN_MS, SPI_FAST_READ_TIMEOUT_MAX_MS);
}

/**
 * @brief 初始化一条带自动 Dummy 预算的高速 SPI 读端口。
 * @param port 端口对象。
 * @param hspi HAL SPI 句柄。
 * @param cs_port 片选 GPIO 端口。
 * @param cs_pin 片选 GPIO 引脚。
 * @param spi_kernel_hz SPI 外设内核时钟，单位 Hz。
 * @param core_clock_hz 内核主频，单位 Hz。
 * @param timing 器件与板级时序约束。
 * @retval HAL_OK 初始化成功。
 * @retval HAL_ERROR 参数非法、分频不可达或 HAL 初始化失败。
 *
 * @note 这个函数做的不是“把 SPI 打开”，而是先把物理约束收敛成
 *       prescaler 与 dummy byte，再把结果映射到 HAL 初始化参数。
 */
HAL_StatusTypeDef SpiFastRead_Init(SpiFastReadPort_t *port,
                                   SPI_HandleTypeDef *hspi,
                                   GPIO_TypeDef *cs_port,
                                   uint16_t cs_pin,
                                   uint32_t spi_kernel_hz,
                                   uint32_t core_clock_hz,
                                   const SpiFastReadTiming_t *timing)
{
    uint32_t actual_sck_hz;
    uint32_t hal_prescaler;

    if ((port == NULL) || (hspi == NULL) || (cs_port == NULL) || (timing == NULL))
    {
        return HAL_ERROR;
    }

    if (!SpiFastRead_SelectPrescaler(spi_kernel_hz, timing, &actual_sck_hz, &hal_prescaler))
    {
        return HAL_ERROR;
    }

    if (!SpiFastRead_BuildPlan(timing, actual_sck_hz, &port->plan))
    {
        return HAL_ERROR;
    }

    memset(port, 0, sizeof(*port));
    port->hspi = hspi;
    port->cs_port = cs_port;
    port->cs_pin = cs_pin;
    port->spi_kernel_hz = spi_kernel_hz;
    port->core_clock_hz = core_clock_hz;
    port->timing = *timing;

    if (!SpiFastRead_BuildPlan(&port->timing, actual_sck_hz, &port->plan))
    {
        return HAL_ERROR;
    }

    hspi->Init.Mode = SPI_MODE_MASTER;
    hspi->Init.Direction = SPI_DIRECTION_2LINES;
    hspi->Init.DataSize = SPI_DATASIZE_8BIT;
    hspi->Init.CLKPolarity = port->timing.idle_clock_high ? SPI_POLARITY_HIGH : SPI_POLARITY_LOW;
    hspi->Init.CLKPhase = port->timing.sample_on_second_edge ? SPI_PHASE_2EDGE : SPI_PHASE_1EDGE;
    hspi->Init.NSS = SPI_NSS_SOFT;
    hspi->Init.BaudRatePrescaler = hal_prescaler;
    hspi->Init.FirstBit = SPI_FIRSTBIT_MSB;
    hspi->Init.TIMode = SPI_TIMODE_DISABLE;
    hspi->Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
    hspi->Init.CRCPolynomial = 7U;

    SpiFastRead_CsDeassert(port);

    if (HAL_SPI_Init(hspi) != HAL_OK)
    {
        return HAL_ERROR;
    }

    (void)SpiFastRead_EnableCycleCounter();
    return HAL_OK;
}

/**
 * @brief 组装一帧 Fast Read 的 opcode + address + dummy 头部。
 * @param port 端口对象。
 * @param address 起始地址。
 * @param header 输出头部缓冲区。
 * @param out_len 输出头部字节数。
 * @retval true 组帧成功。
 * @retval false 头部长度越界。
 *
 * @note 当 dummy 位数不是 8 的整数倍时，这里按 byte 向上取整填充。
 *       这会多送 0~7 个空时钟，但不会少送，符合“宁可多买时间、不低估首字节预算”的原则。
 */
static bool SpiFastRead_BuildHeader(const SpiFastReadPort_t *port,
                                    uint32_t address,
                                    uint8_t *header,
                                    uint16_t *out_len)
{
    uint16_t index = 0U;

    if ((port == NULL) || (header == NULL) || (out_len == NULL))
    {
        return false;
    }

    *out_len = (uint16_t)(1U + port->timing.address_bytes + port->plan.dummy_bytes);
    if (*out_len > SPI_FAST_READ_MAX_HEADER_BYTES)
    {
        return false;
    }

    header[index++] = port->timing.opcode;

    /*
     * 地址按高字节优先发出，让寄存器/Flash 类设备在 opcode 之后
     * 直接进入标准的高位到低位地址解析路径。
     */
    for (uint8_t i = 0U; i < port->timing.address_bytes; ++i)
    {
        const uint8_t shift = (uint8_t)((port->timing.address_bytes - 1U - i) * 8U);
        header[index++] = (uint8_t)((address >> shift) & 0xFFU);
    }

    memset(&header[index], SPI_FAST_READ_DUMMY_FILL, port->plan.dummy_bytes);
    return true;
}

/**
 * @brief 执行一次带自动 Dummy 预算的高速 SPI 阻塞读事务。
 * @param port 端口对象。
 * @param address 起始地址。
 * @param payload 输出缓冲区。
 * @param payload_len 负载长度，单位 byte。
 * @retval HAL_OK 读取成功。
 * @retval HAL_ERROR 参数非法或组帧失败。
 * @retval HAL_TIMEOUT 等待 TXE / BSY 超时。
 *
 * @note 总线流程如下:
 *       1. 拉低 CS，并等待 `tCSS`
 *       2. 发送 opcode + address + dummy
 *       3. 保持 CS 低电平，继续时钟出 payload
 *       4. 确认 TXE=1、BSY=0，再等待 `tCSH`
 *       5. 拉高 CS
 *
 *       之所以在 HAL 返回后还要显式检查 `BSY`，是因为事务语义结束点
 *       不是“软件函数返回”，而是“最后一位真正离开移位链并满足保持时间”。
 */
HAL_StatusTypeDef SpiFastRead_Read(SpiFastReadPort_t *port,
                                   uint32_t address,
                                   uint8_t *payload,
                                   uint16_t payload_len)
{
    HAL_StatusTypeDef status;
    uint8_t header[SPI_FAST_READ_MAX_HEADER_BYTES];
    uint16_t header_len;
    uint32_t timeout_ms;

    if ((port == NULL) || (payload == NULL) || (payload_len == 0U) || (payload_len > SPI_FAST_READ_MAX_PAYLOAD_BYTES))
    {
        return HAL_ERROR;
    }

    if (!SpiFastRead_BuildHeader(port, address, header, &header_len))
    {
        return HAL_ERROR;
    }

    timeout_ms = SpiFastRead_ComputeTimeoutMs(&port->plan, &port->timing, payload_len);

    SpiFastRead_CsAssert(port);
    SpiFastRead_DelayNs(port->core_clock_hz, port->timing.cs_setup_ns);

    status = HAL_SPI_Transmit(port->hspi, header, header_len, timeout_ms);
    if (status != HAL_OK)
    {
        SpiFastRead_CsDeassert(port);
        return status;
    }

    /*
     * 对主机来说，HAL_SPI_Receive 的本质依然是“边发 Dummy 边收 MISO”。
     * 这里只是把 Dummy 发送动作交给 HAL 内部完成，避免手工逐字节维护。
     */
    status = HAL_SPI_Receive(port->hspi, payload, payload_len, timeout_ms);
    if (status != HAL_OK)
    {
        SpiFastRead_CsDeassert(port);
        return status;
    }

    if (!SpiFastRead_WaitFlag(port->hspi, SPI_FLAG_TXE, SET, timeout_ms) ||
        !SpiFastRead_WaitFlag(port->hspi, SPI_FLAG_BSY, RESET, timeout_ms))
    {
        SpiFastRead_CsDeassert(port);
        return HAL_TIMEOUT;
    }

    SpiFastRead_DelayNs(port->core_clock_hz, port->timing.cs_hold_ns);
    SpiFastRead_CsDeassert(port);
    return HAL_OK;
}

extern SPI_HandleTypeDef hspi1;

static SpiFastReadPort_t g_ext_flash_port;

HAL_StatusTypeDef App_ExtFlashLinkInit(void)
{
    const SpiFastReadTiming_t flash_timing =
    {
        .idle_clock_high = false,
        .sample_on_second_edge = false,
        .opcode = 0x0BU,
        .address_bytes = 3U,
        .fixed_dummy_bits = 8U,
        .desired_sck_hz = 48000000U,
        .slave_max_sck_hz = 50000000U,
        .first_data_valid_ns = 22U,
        .per_bit_tco_ns = 7U,
        .board_delay_ns = 4U,
        .master_setup_ns = 5U,
        .edge_jitter_ns = 2U,
        .timing_margin_ns = 4U,
        .cs_setup_ns = 10U,
        .cs_hold_ns = 10U
    };

    return SpiFastRead_Init(&g_ext_flash_port,
                            &hspi1,
                            FLASH_CS_GPIO_Port,
                            FLASH_CS_Pin,
                            120000000U,
                            SystemCoreClock,
                            &flash_timing);
}

bool App_ExtFlashReadPage(uint32_t address, uint8_t *buffer, uint16_t length)
{
    if (SpiFastRead_Read(&g_ext_flash_port, address, buffer, length) != HAL_OK)
    {
        return false;
    }

    /*
     * g_ext_flash_port.plan 中保留了本次链路的预算结果:
     * 1. steady_state_slack_ns < 0 说明必须继续降频；
     * 2. first_bit_slack_ns < 0 说明首字节周转仍不够，Dummy 预算过小；
     * 3. dummy_bytes 反映了“bit 级需求”到 8bit 帧事务的实际映射结果。
     */
    return true;
}
```

这段实现最关键的不是把 `opcode` 和 `address` 发出去，而是它把几个常被凭经验处理的问题全部显式化了：

- `SpiFastRead_ComputeSteadySafeHz()` 先验证稳态半周期是否装得下 `t_co + t_board + t_su`，如果这一步过不去，首字节再怎么补 Dummy 都没有意义。
- `SpiFastRead_BuildPlan()` 把首字节延迟映射成 `dummy_bits`，并进一步映射为 `dummy_bytes`，明确承认普通 8 位 SPI 帧无法精确表达任意 bit 数的 Dummy，只能向上取整。
- `SpiFastRead_ComputeTimeoutMs()` 用总线位数和 SCK 反推阻塞超时，避免高频短包和低频长包共用同一个拍脑袋 timeout。
- `SpiFastRead_Read()` 在 `HAL_SPI_Transmit()` 和 `HAL_SPI_Receive()` 之后仍然显式等 `TXE` 与 `BSY`，因为总线语义的结束点是“最后一位真正发完”，不是“HAL 函数先返回了”。

如果现场继续出错，排查顺序应该非常明确：

- `steady_state_slack_ns` 为负，先降频，再谈任何软件补救。
- `steady_state_slack_ns` 为正但 `first_bit_slack_ns` 为负，优先检查 Fast Read 指令要求的 Dummy 和器件 `t_first_valid`。
- 两个裕量都为正却仍读错，优先去看板级振铃、MISO 过冲、地参考和 `CS` 建立保持，而不是先怀疑 `HAL_SPI_Receive()`。

真正成熟的高速 SPI 设计，不会把“为什么 24 MHz 稳、36 MHz 偶发错、48 MHz 全错”归结为玄学，而是会把每一档频率对应的 **半周期采样窗**、**首字节周转** 和 **Dummy 周期购买到的时间** 都明明白白算出来。只有这样，SPI 提速才是工程化扩边界，而不是靠运气碰上刚好能跑的那一档。
