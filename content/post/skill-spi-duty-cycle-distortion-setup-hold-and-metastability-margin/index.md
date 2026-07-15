---
title: "技能档案：SPI 时钟占空比塌缩、建立保持时间与亚稳态容限"
slug: "skill-spi-duty-cycle-distortion-setup-hold-and-metastability-margin"
date: 2026-07-02T14:27:51+08:00
draft: false
description: "从 CPOL/CPHA 之外的半周期预算、板级飞行时间、主从建立保持边界到 STM32 上的安全分频选择，系统拆解 SPI 为什么会在示波器上看着正常、板上却偶发错位。"
tags: ["STM32", "SPI", "CPOL/CPHA", "建立保持时间", "亚稳态", "时序分析", "嵌入式"]
categories: ["技能档案", "工业通信"]
image: ""
---

## 技能概述

很多人把 `SPI` 调通理解成三件事：`CPOL` 选对、`CPHA` 选对、示波器上能看到时钟和数据在跳。可一旦频率提上去、板子换长线、串了隔离器或电平转换器，系统就会进入一种很讨厌的状态: 逻辑分析仪偶尔抓不到错，固件却周期性读出错位字节、首位翻转或者回读寄存器偶发崩坏。这个主题解决的核心痛点，不是再背一遍 Mode0/1/2/3，而是把 `SPI` 理解成一份**围绕采样瞬间建立/保持窗口展开的时域合同**: `CPOL/CPHA` 只定义“在哪个边沿采”，真正决定链路能否长期稳定的，是高低电平半周期到底还剩多少时间给数据传播、板级偏斜、输入同步器收敛和片选前后保护窗。

## 核心底层概念解析

- **CPOL/CPHA 只是边沿命名法，不是完整时序模型**：`CPOL` 定义空闲电平，`CPHA` 定义首个还是次个有效边沿采样。它们回答的是“在哪一沿采”，却没有回答“采样前后到底留了多少稳定时间”。工程失效多数发生在后一个问题上。

- **真正要预算的是采样前窗 `Tpre` 和采样后窗 `Tpost`**：若 `Tclk = 1 / f_sck`，高电平占空比为 `D`，则  
  `Thigh = D * Tclk`，`Tlow = (1 - D) * Tclk`。  
  对 `Mode0/3`，常见近似可写成 `Tpre = Tlow`、`Tpost = Thigh`；对 `Mode1/2`，则 `Tpre = Thigh`、`Tpost = Tlow`。  
  也就是说，**占空比塌缩不是示波器上的小瑕疵，而是在直接偷走建立时间或保持时间**。

- **建立时间不是器件数据手册里的孤立参数，而是半周期预算减法**：对 `MOSI` 路径，可把建立裕量近似写成  
  `Msetup = Tpre - (tco_master + tflight_mosi + tjitter + tmeta_slave) - tSU_slave`。  
  这里每一项都在抢同一个半周期。频率翻倍不只把 `Tpre` 砍半，也会把之前被忽略的纳秒级板延迟突然放大成可见故障。

- **保持时间同样不是“反正一般都够”的免费午餐**：若在采样后下一个翻转边沿很快到来，则  
  `Mhold = Tpost - tjitter - tH_slave`。  
  当 `SCK` 占空比偏斜、PLL 抖动加大或隔离器让时钟边沿更毛躁时，本来富余的 `Tpost` 会被压缩到只剩几纳秒。

- **板级飞行时间不是只有长线才需要担心**：`tflight` 里通常不仅有走线传播，还包含连接器、电平转换器、数字隔离器、串联阻尼电阻造成的边沿变缓和相对偏斜。很多“裸板能跑、整机不稳”的问题，本质上就是 `SPI` 已经不再运行在原先那张时序预算表里。

- **同步器亚稳态不会在协议层报错，它只会偶发把位翻错**：从设备输入采样寄存器或主机接收同步器，如果恰好在门限附近看到尚未收敛的边沿，就可能进入亚稳态。它不是持续性故障，而是概率性错位，所以最容易把人带进“软件偶现 bug”的歧路。

- **片选 `CS` 也是时域合同的一部分**：不少从设备要求 `tCSS`（`CS` 拉低到首个 `SCK` 的最短时间）与 `tCSH`（最后一个 `SCK` 到 `CS` 拉高的保持时间）。如果 `CS` 通过普通 GPIO 软控，而 `SPI` 通过外设硬件立刻起跳，就会出现“边沿模式都对，第一位永远不稳”的现象。

- **MOSI 和 MISO 不一定同样宽松**：写命令时只要主机输出能被从机正确采到即可；回读时还叠加了从机内部 `tV`、状态机准备时间和返回路径飞行时间。很多器件“写稳读炸”，不是协议两套规则，而是 `MISO` 路径的 `Msetup` 比 `MOSI` 更紧。

- **高频不一定比低频更危险，坏占空比常常更危险**：一个 `50 MHz`、`50/50` 的 `SCK`，未必比一个 `40 MHz`、`62/38` 的 `SCK` 风险更高。因为从采样视角看，真正参与预算的不是名义频率，而是最短那半个周期。

- **数字总线本质上仍然受模拟世界支配**：`SPI` 报文在软件里看是字节流，在板子上其实是驱动器充放电、门限比较器、走线分布参数和同步器时间常数的合谋。所谓“通信稳定”，从来不是 API 级概念，而是模拟边界被数字接口成功驯化的结果。

- **工程上最可靠的做法不是盲提频，而是显式算裕量**：把 `pclk`、预分频、占空比、主从 `tSU/tH`、路径延迟和抖动都拉到一张表里，选“最快但仍为正裕量”的配置，比看到波形能跑就直接量产稳健得多。

- **技术哲学上，SPI 不是四种模式，而是一条采样契约**：`CPOL/CPHA` 只是契约封面的索引页，真正的正文是“数据在物理线上何时稳定、稳定多久、谁来承担抖动和偏斜成本”。只有把这层说清楚，SPI 才不再只是“偶尔错一位”的玄学接口。

## 代码能力展现

下面给出一个基于 **STM32 HAL** 的 `SPI` 时序守卫模块。它不试图做复杂的自动校准，而是坚持 `KISS`：

- 把 `SPI` 四种模式统一折叠成 `Tpre/Tpost` 两个半周期窗口；
- 把 `MOSI` 与 `MISO` 的建立/保持需求显式写成预算公式；
- 在 `STM32` 允许的分频器集合里，选择**最快但仍满足双向裕量**的预分频；
- 用 `CS` 前后保护延迟，把 GPIO 片选和外设时钟之间的空窗补齐。

```c
#include "stm32f4xx_hal.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define SPI_GUARD_DUTY_MIN_PERMILLE              100U
#define SPI_GUARD_DUTY_MAX_PERMILLE              900U
#define SPI_GUARD_NS_PER_SECOND                  1000000000ULL
#define SPI_GUARD_PRESCALER_COUNT                8U

typedef enum
{
    SPI_GUARD_MODE_0 = 0U,
    SPI_GUARD_MODE_1 = 1U,
    SPI_GUARD_MODE_2 = 2U,
    SPI_GUARD_MODE_3 = 3U
} SpiGuardMode_t;

typedef struct
{
    uint32_t pclk_hz;                  /* SPI 内核时钟，例如 APB2 上的 84 MHz。 */
    uint32_t cpu_hz;                   /* 用于近似延迟片选保护窗。 */
    uint16_t duty_high_permille;       /* SCK 高电平占比，500 表示理想 50/50。 */
    uint16_t mosi_path_ns;             /* 主机时钟边沿到从机 MOSI 引脚稳定的最坏延迟。 */
    uint16_t miso_path_ns;             /* 从机时钟边沿到主机 MISO 引脚稳定的最坏延迟。 */
    uint16_t edge_jitter_ns;           /* 时钟抖动、驱动偏斜与板级不确定性合并预算。 */
    uint16_t cs_setup_ns;              /* 软件想要保证的 CS 拉低到首时钟保护窗。 */
    uint16_t cs_hold_ns;               /* 最后一个时钟到 CS 拉高的保护窗。 */
} SpiGuardPhysicalBudget_t;

typedef struct
{
    uint32_t max_sck_hz;               /* 从设备宣称可接受的最大 SCK 频率。 */
    uint16_t slave_setup_ns;           /* 从设备接收 MOSI 的建立时间要求。 */
    uint16_t slave_hold_ns;            /* 从设备接收 MOSI 的保持时间要求。 */
    uint16_t master_setup_ns;          /* 主机接收 MISO 的建立时间要求。 */
    uint16_t master_hold_ns;           /* 主机接收 MISO 的保持时间要求。 */
    uint16_t slave_meta_guard_ns;      /* 给从设备输入同步器预留的亚稳态收敛余量。 */
    uint16_t master_meta_guard_ns;     /* 给主机输入同步器预留的亚稳态收敛余量。 */
    uint16_t tcss_ns;                  /* 器件要求的 CS setup。 */
    uint16_t tcsh_ns;                  /* 器件要求的 CS hold。 */
} SpiGuardPeerTiming_t;

typedef struct
{
    SPI_HandleTypeDef *hspi;
    GPIO_TypeDef *cs_port;
    uint16_t cs_pin;
    SpiGuardMode_t mode;
    SpiGuardPhysicalBudget_t physical;
    SpiGuardPeerTiming_t peer;
} SpiGuardDevice_t;

typedef struct
{
    uint32_t prescaler_value;
    uint32_t prescaler_reg;
    uint32_t sck_hz;
    uint32_t tclk_ns;
    uint16_t thigh_ns;
    uint16_t tlow_ns;
    uint16_t pre_sample_ns;
    uint16_t post_sample_ns;
    int32_t mosi_setup_margin_ns;
    int32_t mosi_hold_margin_ns;
    int32_t miso_setup_margin_ns;
    int32_t miso_hold_margin_ns;
    uint8_t valid;
} SpiGuardTimingResult_t;

static uint16_t SpiGuard_ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static uint16_t SpiGuard_MaxU16(uint16_t a, uint16_t b)
{
    return (a > b) ? a : b;
}

static void SpiGuard_GetModePolarityPhase(SpiGuardMode_t mode,
                                          uint32_t *polarity,
                                          uint32_t *phase)
{
    switch (mode)
    {
        case SPI_GUARD_MODE_0:
            *polarity = SPI_POLARITY_LOW;
            *phase = SPI_PHASE_1EDGE;
            break;

        case SPI_GUARD_MODE_1:
            *polarity = SPI_POLARITY_LOW;
            *phase = SPI_PHASE_2EDGE;
            break;

        case SPI_GUARD_MODE_2:
            *polarity = SPI_POLARITY_HIGH;
            *phase = SPI_PHASE_1EDGE;
            break;

        case SPI_GUARD_MODE_3:
        default:
            *polarity = SPI_POLARITY_HIGH;
            *phase = SPI_PHASE_2EDGE;
            break;
    }
}

static void SpiGuard_GetPrePostWindow(SpiGuardMode_t mode,
                                      uint16_t thigh_ns,
                                      uint16_t tlow_ns,
                                      uint16_t *pre_sample_ns,
                                      uint16_t *post_sample_ns)
{
    /*
     * 近似约定:
     * - Mode0/3: 数据在 falling 附近翻转，在 rising 附近采样
     *            因此前窗取 Tlow，后窗取 Thigh
     * - Mode1/2: 数据在 rising 附近翻转，在 falling 附近采样
     *            因此前窗取 Thigh，后窗取 Tlow
     */
    if ((mode == SPI_GUARD_MODE_0) || (mode == SPI_GUARD_MODE_3))
    {
        *pre_sample_ns = tlow_ns;
        *post_sample_ns = thigh_ns;
    }
    else
    {
        *pre_sample_ns = thigh_ns;
        *post_sample_ns = tlow_ns;
    }
}

/**
 * @brief 评估某个 SPI 预分频下的双向建立/保持裕量。
 * @param device 目标 SPI 设备。
 * @param prescaler_value 实际预分频值，只能是 2/4/8/.../256。
 * @param prescaler_reg HAL 使用的寄存器枚举值。
 * @param result 输出结果。
 * @retval true 该分频下建立/保持与器件最大频率要求全部满足。
 * @retval false 任一方向裕量为负，或参数非法。
 *
 * @note 建立裕量采用保守近似:
 *       Msetup = Tpre - (tpath + tjitter + tmeta) - tSU
 *
 *       其中:
 *       1. Tpre 为数据翻转边沿到采样边沿之间的半周期
 *       2. tpath 含驱动器 clock-to-out、板级飞行时间和隔离/电平转换延迟
 *       3. tmeta 是给输入同步器留出的亚稳态收敛保护
 *
 *       保持裕量采用:
 *       Mhold = Tpost - tjitter - tH
 *
 *       这里故意不做过度乐观的最小时延抵消，而是把不确定性都并入 tjitter，
 *       这样得到的是更接近量产约束的“最坏情况预算”。
 */
static bool SpiGuard_EvaluatePrescaler(const SpiGuardDevice_t *device,
                                       uint32_t prescaler_value,
                                       uint32_t prescaler_reg,
                                       SpiGuardTimingResult_t *result)
{
    uint64_t tclk_ns_u64;
    uint64_t thigh_ns_u64;
    uint16_t duty_permille;

    if ((device == NULL) || (result == NULL) || (device->physical.pclk_hz == 0U))
    {
        return false;
    }

    memset(result, 0, sizeof(*result));
    duty_permille = SpiGuard_ClampU16(device->physical.duty_high_permille,
                                      SPI_GUARD_DUTY_MIN_PERMILLE,
                                      SPI_GUARD_DUTY_MAX_PERMILLE);

    result->prescaler_value = prescaler_value;
    result->prescaler_reg = prescaler_reg;
    result->sck_hz = device->physical.pclk_hz / prescaler_value;

    if ((result->sck_hz == 0U) || (result->sck_hz > device->peer.max_sck_hz))
    {
        return false;
    }

    tclk_ns_u64 = SPI_GUARD_NS_PER_SECOND / result->sck_hz;
    thigh_ns_u64 = (tclk_ns_u64 * duty_permille) / 1000ULL;

    result->tclk_ns = (uint32_t)tclk_ns_u64;
    result->thigh_ns = (uint16_t)thigh_ns_u64;
    result->tlow_ns = (uint16_t)(tclk_ns_u64 - thigh_ns_u64);

    SpiGuard_GetPrePostWindow(device->mode,
                              result->thigh_ns,
                              result->tlow_ns,
                              &result->pre_sample_ns,
                              &result->post_sample_ns);

    result->mosi_setup_margin_ns =
        (int32_t)result->pre_sample_ns -
        (int32_t)device->physical.mosi_path_ns -
        (int32_t)device->physical.edge_jitter_ns -
        (int32_t)device->peer.slave_meta_guard_ns -
        (int32_t)device->peer.slave_setup_ns;
    result->mosi_hold_margin_ns =
        (int32_t)result->post_sample_ns -
        (int32_t)device->physical.edge_jitter_ns -
        (int32_t)device->peer.slave_hold_ns;

    result->miso_setup_margin_ns =
        (int32_t)result->pre_sample_ns -
        (int32_t)device->physical.miso_path_ns -
        (int32_t)device->physical.edge_jitter_ns -
        (int32_t)device->peer.master_meta_guard_ns -
        (int32_t)device->peer.master_setup_ns;
    result->miso_hold_margin_ns =
        (int32_t)result->post_sample_ns -
        (int32_t)device->physical.edge_jitter_ns -
        (int32_t)device->peer.master_hold_ns;

    result->valid =
        (result->mosi_setup_margin_ns >= 0) &&
        (result->mosi_hold_margin_ns >= 0) &&
        (result->miso_setup_margin_ns >= 0) &&
        (result->miso_hold_margin_ns >= 0);

    return (result->valid != 0U);
}

/**
 * @brief 选择当前设备可接受的最快 SPI 预分频。
 * @param device 目标设备。
 * @param result 输出所选分频的时序结果。
 * @retval true 找到满足时序预算的预分频。
 * @retval false 所有候选分频都无法满足双向建立/保持约束。
 */
static bool SpiGuard_SelectFastestBudget(const SpiGuardDevice_t *device,
                                         SpiGuardTimingResult_t *result)
{
    static const uint16_t s_prescaler_value[SPI_GUARD_PRESCALER_COUNT] =
    {
        2U, 4U, 8U, 16U, 32U, 64U, 128U, 256U
    };

    static const uint32_t s_prescaler_reg[SPI_GUARD_PRESCALER_COUNT] =
    {
        SPI_BAUDRATEPRESCALER_2,
        SPI_BAUDRATEPRESCALER_4,
        SPI_BAUDRATEPRESCALER_8,
        SPI_BAUDRATEPRESCALER_16,
        SPI_BAUDRATEPRESCALER_32,
        SPI_BAUDRATEPRESCALER_64,
        SPI_BAUDRATEPRESCALER_128,
        SPI_BAUDRATEPRESCALER_256
    };

    uint32_t i;
    SpiGuardTimingResult_t local_result;

    if ((device == NULL) || (result == NULL))
    {
        return false;
    }

    for (i = 0U; i < SPI_GUARD_PRESCALER_COUNT; ++i)
    {
        if (SpiGuard_EvaluatePrescaler(device,
                                       s_prescaler_value[i],
                                       s_prescaler_reg[i],
                                       &local_result))
        {
            *result = local_result;
            return true;
        }
    }

    memset(result, 0, sizeof(*result));
    return false;
}

/**
 * @brief 把模式与分频应用到 HAL SPI 句柄。
 * @param device 目标设备。
 * @param budget 已选中的时序预算结果。
 * @retval HAL_OK 配置成功。
 * @retval HAL_ERROR HAL 初始化失败或参数非法。
 */
static HAL_StatusTypeDef SpiGuard_ApplyBudget(const SpiGuardDevice_t *device,
                                              const SpiGuardTimingResult_t *budget)
{
    uint32_t polarity;
    uint32_t phase;

    if ((device == NULL) || (budget == NULL) || (device->hspi == NULL))
    {
        return HAL_ERROR;
    }

    SpiGuard_GetModePolarityPhase(device->mode, &polarity, &phase);

    device->hspi->Init.CLKPolarity = polarity;
    device->hspi->Init.CLKPhase = phase;
    device->hspi->Init.BaudRatePrescaler = budget->prescaler_reg;

    return HAL_SPI_Init(device->hspi);
}

static void SpiGuard_EnableCycleCounter(void)
{
#if (__CORTEX_M >= 3U)
    if ((CoreDebug->DEMCR & CoreDebug_DEMCR_TRCENA_Msk) == 0U)
    {
        CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    }

    if ((DWT->CTRL & DWT_CTRL_CYCCNTENA_Msk) == 0U)
    {
        DWT->CYCCNT = 0U;
        DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
    }
#endif
}

/**
 * @brief 近似延迟若干纳秒，用于 CS 保护窗。
 * @param cpu_hz CPU 主频。
 * @param delay_ns 需要延迟的时间。
 *
 * @note 对 Cortex-M3/M4/M7 使用 DWT 周期计数器；其余内核退化为 NOP 忙等。
 *       这类延迟只适合补足几十纳秒到几微秒级的保护窗，不应替代系统级调度定时。
 */
static void SpiGuard_DelayNs(uint32_t cpu_hz, uint32_t delay_ns)
{
    if ((cpu_hz == 0U) || (delay_ns == 0U))
    {
        return;
    }

#if (__CORTEX_M >= 3U)
    {
        const uint64_t cycles_u64 =
            (((uint64_t)cpu_hz * (uint64_t)delay_ns) + (SPI_GUARD_NS_PER_SECOND - 1ULL)) /
            SPI_GUARD_NS_PER_SECOND;
        const uint32_t cycles = (uint32_t)((cycles_u64 == 0ULL) ? 1ULL : cycles_u64);
        const uint32_t start = DWT->CYCCNT;

        while ((uint32_t)(DWT->CYCCNT - start) < cycles)
        {
            __NOP();
        }
    }
#else
    {
        uint32_t loops =
            (uint32_t)((((uint64_t)cpu_hz * (uint64_t)delay_ns) / SPI_GUARD_NS_PER_SECOND) / 4ULL);

        if (loops == 0U)
        {
            loops = 1U;
        }

        while (loops-- > 0U)
        {
            __NOP();
        }
    }
#endif
}

/**
 * @brief 在满足时序预算的前提下执行一次片选受保护的 SPI 传输。
 * @param device 目标设备。
 * @param tx_data 发送缓冲区。
 * @param rx_data 接收缓冲区。
 * @param size 传输字节数。
 * @param timeout_ms HAL 超时时间。
 * @param budget_out 输出最终采用的时序预算，可为 NULL。
 * @retval HAL_OK 传输成功。
 * @retval HAL_ERROR 未找到合法分频或配置失败。
 * @retval 其他 HAL 状态 由底层 SPI 传输返回。
 */
HAL_StatusTypeDef SpiGuard_TransmitReceive(const SpiGuardDevice_t *device,
                                           const uint8_t *tx_data,
                                           uint8_t *rx_data,
                                           uint16_t size,
                                           uint32_t timeout_ms,
                                           SpiGuardTimingResult_t *budget_out)
{
    SpiGuardTimingResult_t budget;
    HAL_StatusTypeDef status;
    uint16_t cs_setup_ns;
    uint16_t cs_hold_ns;

    if ((device == NULL) || (device->hspi == NULL) || (device->cs_port == NULL) || (size == 0U))
    {
        return HAL_ERROR;
    }

    if (!SpiGuard_SelectFastestBudget(device, &budget))
    {
        return HAL_ERROR;
    }

    status = SpiGuard_ApplyBudget(device, &budget);
    if (status != HAL_OK)
    {
        return status;
    }

    SpiGuard_EnableCycleCounter();

    /*
     * 片选保护窗取“主机意图”和“从设备最低要求”中的较大者。
     * 这样做的目的是把 GPIO 拉低/拉高与 SPI 外设启动/收尾之间的竞态显式消掉。
     */
    cs_setup_ns = SpiGuard_MaxU16(device->physical.cs_setup_ns, device->peer.tcss_ns);
    cs_hold_ns = SpiGuard_MaxU16(device->physical.cs_hold_ns, device->peer.tcsh_ns);

    HAL_GPIO_WritePin(device->cs_port, device->cs_pin, GPIO_PIN_RESET);
    SpiGuard_DelayNs(device->physical.cpu_hz, cs_setup_ns);

    status = HAL_SPI_TransmitReceive(device->hspi,
                                     (uint8_t *)tx_data,
                                     rx_data,
                                     size,
                                     timeout_ms);

    SpiGuard_DelayNs(device->physical.cpu_hz, cs_hold_ns);
    HAL_GPIO_WritePin(device->cs_port, device->cs_pin, GPIO_PIN_SET);

    if (budget_out != NULL)
    {
        *budget_out = budget;
    }

    return status;
}

void Example_SpiFlash_ReadJedecId(SPI_HandleTypeDef *hspi1)
{
    /*
     * 这个例子模拟一颗 SPI Flash 的 JEDEC ID 回读。
     * 重点不在 0x9F 指令本身，而在“先算安全分频，再带着时序预算发命令”。
     */
    static const SpiGuardDevice_t s_flash =
    {
        .hspi = hspi1,
        .cs_port = GPIOA,
        .cs_pin = GPIO_PIN_4,
        .mode = SPI_GUARD_MODE_0,
        .physical =
        {
            .pclk_hz = 84000000U,
            .cpu_hz = 168000000U,
            .duty_high_permille = 460U,  /* 实测高电平约 46%，说明 SCK 已有占空比塌缩。 */
            .mosi_path_ns = 18U,         /* master tco + level shifter + trace delay */
            .miso_path_ns = 26U,         /* slave tV + trace delay */
            .edge_jitter_ns = 4U,
            .cs_setup_ns = 40U,
            .cs_hold_ns = 30U
        },
        .peer =
        {
            .max_sck_hz = 42000000U,
            .slave_setup_ns = 5U,
            .slave_hold_ns = 3U,
            .master_setup_ns = 4U,
            .master_hold_ns = 2U,
            .slave_meta_guard_ns = 3U,
            .master_meta_guard_ns = 3U,
            .tcss_ns = 20U,
            .tcsh_ns = 20U
        }
    };

    uint8_t tx_buffer[4] = { 0x9FU, 0xFFU, 0xFFU, 0xFFU };
    uint8_t rx_buffer[4] = { 0U };
    SpiGuardTimingResult_t budget;

    if (SpiGuard_TransmitReceive(&s_flash,
                                 tx_buffer,
                                 rx_buffer,
                                 sizeof(tx_buffer),
                                 10U,
                                 &budget) != HAL_OK)
    {
        return;
    }

    /*
     * 上层在调试时应记录 budget，而不是只记“这次读通了”。
     * 例如:
     * - budget.mosi_setup_margin_ns < 5: 说明再加长排线就可能先炸写命令
     * - budget.miso_setup_margin_ns < 5: 回读路径更紧，应优先降频或换缓冲器件
     * - budget.pre_sample_ns << budget.post_sample_ns:
     *   表明当前模式下前窗极窄，后续可考虑评估是否换 Mode1/2 或改善占空比
     */
    (void)rx_buffer;
    (void)budget;
}
```

这段代码想表达的核心，不是“再封一层 `HAL_SPI_TransmitReceive()`”，而是把 `SPI` 的工程决策从“这颗芯片标称 50 MHz，那我就先开 42 MHz 试试”改成“我这块板在当前模式、当前占空比、当前路径延迟下，到底还剩多少建立/保持裕量”。当团队开始用这张预算表说话，很多过去归咎于“偶发噪声”“某批板子玄学不稳”的问题，都会回到可计算、可验证、可收敛的物理边界上。
