---
title: "技能档案：SPI 的 CPOL/CPHA 时域契约，从空闲时钟到采样边沿预算"
slug: "skill-spi-cpol-cpha-idle-polarity-and-sampling-edge-timing-contract"
date: 2026-04-28T09:53:35+08:00
draft: false
description: "从空闲时钟、首边沿与次边沿、片选建立保持时间到 MISO/MOSI 有效窗口，系统拆解 SPI 四种模式如何把数字采样变成可验证的时域契约。"
tags: ["SPI", "STM32", "时序", "数字通信", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述

SPI 最容易被低估的地方，在于很多工程师把它看成“比 I2C 更快的四根线”，却没有把它当成一份严格的时域合同来理解。屏幕驱动、外部 Flash、高速 ADC、IMU、编码器和 FPGA 配套接口之所以常用 SPI，不只是因为它吞吐高，而是因为主从双方可以把“什么时候推出数据、什么时候锁存数据、片选何时生效、首位必须提前稳定多久”这些问题压缩成可验证的边沿契约。真正的痛点也正出在这里：模式编号一旦理解错，逻辑分析仪上看到的就不是“偶发错误”，而是系统性位移、首字节错乱、读回 `0xFF/0x00`、高频下间歇性失步。CPOL/CPHA 的价值，不在于记住 Mode 0 到 Mode 3，而在于把数字收发重新拉回传播延迟、建立保持时间和片选窗口这些物理约束上。

## 核心底层概念解析

- **CPOL 决定的是“边沿命名方式”，不是单纯的高低电平偏好**：当时钟空闲为低电平时，离开空闲态的第一个边沿就是上升沿；当空闲为高电平时，第一个边沿就变成下降沿。也就是说，**领先沿** 和 **滞后沿** 永远是相对于空闲态定义的，而不是绝对等于上升或下降。
- **CPHA 决定采样发生在领先沿还是滞后沿**：`CPHA = 0` 时，首个有效采样发生在领先沿，发送端必须在此之前就把首位数据稳定到线上；`CPHA = 1` 时，首位采样被推迟到滞后沿，于是主从双方多拿到了半个周期的建立时间。这个“半周期”往往就是高频 SPI 能否稳定的分水岭。
- **SPI 的底层不是“发一个字节收一个字节”，而是两个移位寄存器共享同一拍时钟**：每个时钟周期都伴随着一次移位和一次锁存。主机写入移位寄存器的同时，从机也在推出自己的下一位；全双工不是附加特性，而是这套移位机制的直接结果。所以很多所谓“读寄存器”的动作，本质上都是主机发送 Dummy Byte 去换回从机数据。
- **四种模式只是一张 2 比特时序压缩表**：当 `CPOL = 0` 时，领先沿是上升沿；当 `CPOL = 1` 时，领先沿是下降沿。再叠加 `CPHA = 0/1`，得到的不是四个孤立模式，而是“哪条边沿负责采样，另一条边沿负责更新”的四种排列。理解这一层之后，再看芯片手册里写的 “data captured on rising edge” 或 “shifted out on falling edge”，就不会再机械背 Mode 编号。
- **安全 SCK 上限来自半周期预算，而不是主观想开多快就开多快**：若把一次“数据翻转到对端采样”的可用时间记为半个时钟周期，则必须满足
  `T_sck / 2 >= max(t_do_master + t_flight + t_su_slave, t_co_slave + t_flight + t_su_master)`。
  这里的 `t_do_master` 是主机输出有效延迟，`t_co_slave` 是从机输出时钟到数据有效延迟，`t_flight` 是走线和收发路径传播延迟，`t_su_*` 是采样端建立时间。SPI 出错时，很多问题并不在软件，而是这个不等式根本没有被满足。
- **`CPHA = 0` 对首位尤其苛刻，因为第一拍没有缓冲余地**：既然第一位在领先沿就被采样，那么 `CS` 拉低后，从机译码使能、主机首位预装、线网稳定这几个动作必须先完成，才能让第一拍不出错。这就是为什么不少器件手册会单独给出 `tCSS`、`tCSH`、`tSU(CS)` 之类的指标。
- **片选线不是“通知一下我要通信”，而是帧边界与状态机复位信号**：很多从设备会在 `CS` 上升沿提交写入、在 `CS` 下降沿锁定地址阶段、在 `CS` 保持低期间连续自动递增地址。片选窗口如果被中断、抖动或过早释放，数据流即使位对位看起来正确，事务语义也可能已经错了。
- **高频 SPI 的问题常常不是电平幅值，而是边沿完整性与相位漂移**：SCK 过快、飞线过长、回流路径差、多个负载并联、MISO 悬空或扇出过大，都会把原本清晰的采样边沿拖成缓坡或振铃。数字接口一旦进入边沿不干净的区间，错误表现就会从“稳定错误”变成“温度一变、线一长、DMA 一开就错”。
- **多从机共享 MISO 的前提是未选中器件必须真正高阻**：如果某个从机在 `CS` 失效时仍然驱动 MISO，总线就不再是“一主多从”，而是多个输出级的硬碰硬。逻辑层看到的是随机数据，物理层可能已经出现电流冲突。
- **DMA、FIFO 和更高主频不能修复错误的边沿关系**：DMA 只会更快地搬运错误数据，FIFO 只会把错误延后暴露。SPI 真正的调试顺序应该是先看空闲电平，再看 `CS` 与第一拍关系，再看采样边沿和数据有效窗口，最后才是驱动代码和吞吐优化。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 SPI 主机时序封装示例。代码的目标不是堆一个“能跑”的初始化模板，而是把设备手册上的时序指标真正翻译成三类可执行约束：**模式映射、SCK 频率预算、片选建立/保持保护**。示例默认使用软件控制 `CS`，因为这类场景最能暴露 `CPOL/CPHA` 和帧边界的真实关系。

```c
#include "main.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define SPI_TIMEOUT_MS                     2U
#define SPI_DUMMY_BYTE                     0xFFU
#define SPI_BURST_MAX_BYTES                32U
#define SPI_GUARD_NS                       20U
#define SPI_NS_PER_SECOND                  1000000000ULL

typedef struct
{
    bool idle_clock_high;
    bool sample_on_trailing_edge;
    uint32_t desired_sck_hz;
    uint32_t slave_max_sck_hz;
    uint32_t cs_setup_ns;
    uint32_t cs_hold_ns;
    uint32_t trace_delay_ns;
    uint32_t master_mosi_valid_ns;
    uint32_t master_miso_setup_ns;
    uint32_t slave_miso_valid_ns;
    uint32_t slave_mosi_setup_ns;
} SpiTimingContract_t;

typedef struct
{
    uint16_t divisor;
    uint32_t hal_prescaler;
} SpiPrescalerEntry_t;

typedef struct
{
    SPI_HandleTypeDef *hspi;
    GPIO_TypeDef *cs_port;
    uint16_t cs_pin;
    uint32_t spi_kernel_hz;
    uint32_t core_clock_hz;
    uint32_t actual_sck_hz;
    SpiTimingContract_t contract;
} SpiBusService_t;

static const SpiPrescalerEntry_t kSpiPrescalerTable[] =
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

static uint32_t Spi_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint32_t Spi_MaxU32(uint32_t lhs, uint32_t rhs)
{
    return (lhs >= rhs) ? lhs : rhs;
}

static void Spi_CsAssert(const SpiBusService_t *service)
{
    HAL_GPIO_WritePin(service->cs_port, service->cs_pin, GPIO_PIN_RESET);
}

static void Spi_CsDeassert(const SpiBusService_t *service)
{
    HAL_GPIO_WritePin(service->cs_port, service->cs_pin, GPIO_PIN_SET);
}

static bool Spi_EnableCycleCounter(void)
{
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CYCCNT = 0U;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
    return ((DWT->CTRL & DWT_CTRL_CYCCNTENA_Msk) != 0U);
}

static void Spi_DelayNs(uint32_t core_clock_hz, uint32_t delay_ns)
{
    uint64_t cycles;
    uint32_t start_cycles;

    if ((delay_ns == 0U) || (!Spi_EnableCycleCounter()))
    {
        return;
    }

    /* 纳秒到 CPU 周期数的映射：
     * cycles = ceil(delay_ns * f_cpu / 1e9)
     * 这里使用向上取整，宁可稍微多等一点，也不要让 CS 建立/保持时间被低估。
     */
    cycles = ((uint64_t)delay_ns * (uint64_t)core_clock_hz) + (SPI_NS_PER_SECOND - 1ULL);
    cycles /= SPI_NS_PER_SECOND;

    start_cycles = DWT->CYCCNT;

    while ((uint32_t)(DWT->CYCCNT - start_cycles) < (uint32_t)cycles)
    {
        __NOP();
    }
}

static uint32_t Spi_ComputeSafeSckHz(const SpiTimingContract_t *contract)
{
    const uint32_t mosi_path_ns =
        contract->master_mosi_valid_ns + contract->trace_delay_ns + contract->slave_mosi_setup_ns;
    const uint32_t miso_path_ns =
        contract->slave_miso_valid_ns + contract->trace_delay_ns + contract->master_miso_setup_ns;
    const uint32_t half_cycle_budget_ns = Spi_MaxU32(mosi_path_ns, miso_path_ns) + SPI_GUARD_NS;
    uint64_t safe_hz;
    uint32_t limit_hz;

    if ((contract->desired_sck_hz == 0U) || (contract->slave_max_sck_hz == 0U))
    {
        return 0U;
    }

    /* SPI 的本质约束不是“整周期够不够”，而是相邻两个边沿之间的半周期是否足够：
     * T_sck / 2 >= t_do_master + t_flight + t_su_slave
     * T_sck / 2 >= t_co_slave + t_flight + t_su_master
     * 因此：
     * f_sck <= 1 / (2 * max(path_mosi, path_miso))
     */
    safe_hz = SPI_NS_PER_SECOND / (2ULL * (uint64_t)half_cycle_budget_ns);
    limit_hz = (uint32_t)((safe_hz > 0xFFFFFFFFULL) ? 0xFFFFFFFFULL : safe_hz);
    limit_hz = Spi_ClampU32(limit_hz, 1U, contract->slave_max_sck_hz);

    return (limit_hz < contract->desired_sck_hz) ? limit_hz : contract->desired_sck_hz;
}

static bool Spi_SelectPrescaler(uint32_t spi_kernel_hz,
                                const SpiTimingContract_t *contract,
                                uint32_t *out_hal_prescaler,
                                uint32_t *out_actual_sck_hz)
{
    const uint32_t safe_limit_hz = Spi_ComputeSafeSckHz(contract);
    uint32_t best_hz = 0U;
    uint32_t best_hal = 0U;

    if ((spi_kernel_hz == 0U) || (safe_limit_hz == 0U) || (out_hal_prescaler == NULL) || (out_actual_sck_hz == NULL))
    {
        return false;
    }

    for (uint32_t i = 0U; i < (sizeof(kSpiPrescalerTable) / sizeof(kSpiPrescalerTable[0])); ++i)
    {
        const uint32_t actual_hz = spi_kernel_hz / kSpiPrescalerTable[i].divisor;

        /* 选取“不超过约束的最快 SCK”。
         * 这和直接选最小分频不同：如果当前分频已经超过从机半周期预算，
         * SPI 在示波器上看起来也许还能翻转，但采样结果会进入偶发失真区。
         */
        if ((actual_hz <= safe_limit_hz) && (actual_hz > best_hz))
        {
            best_hz = actual_hz;
            best_hal = kSpiPrescalerTable[i].hal_prescaler;
        }
    }

    if (best_hz == 0U)
    {
        return false;
    }

    *out_hal_prescaler = best_hal;
    *out_actual_sck_hz = best_hz;
    return true;
}

static void Spi_FlushRx(SPI_HandleTypeDef *hspi)
{
    __IO uint8_t discard8;
    __IO uint32_t discard32;

    while (__HAL_SPI_GET_FLAG(hspi, SPI_FLAG_RXNE) != RESET)
    {
        discard8 = *(__IO uint8_t *)&hspi->Instance->DR;
        (void)discard8;
    }

    discard32 = hspi->Instance->SR;
    (void)discard32;
}

static HAL_StatusTypeDef Spi_WaitFlag(SPI_HandleTypeDef *hspi, uint32_t flag, bool expect_set)
{
    const uint32_t start_ms = HAL_GetTick();

    while (true)
    {
        const bool is_set = (__HAL_SPI_GET_FLAG(hspi, flag) != RESET);

        if (is_set == expect_set)
        {
            return HAL_OK;
        }

        if ((HAL_GetTick() - start_ms) >= SPI_TIMEOUT_MS)
        {
            return HAL_TIMEOUT;
        }
    }
}

/**
 * @brief 按设备时序合同初始化 SPI 主机。
 * @param service SPI 服务对象。
 * @param hspi HAL SPI 句柄。
 * @param cs_port 片选 GPIO 端口，默认按低电平有效处理。
 * @param cs_pin 片选 GPIO 引脚。
 * @param spi_kernel_hz SPI 外设核时钟，例如 APB2 上的 84 MHz。
 * @param core_clock_hz 内核主频，用于 DWT 级纳秒延时换算。
 * @param contract 由芯片手册抽取出的 SPI 时序约束。
 * @retval HAL_OK 初始化成功。
 * @retval HAL_ERROR 参数非法、分频不可达或 HAL 初始化失败。
 *
 * @note `idle_clock_high + sample_on_trailing_edge` 的组合直接映射为 STM32 HAL 的
 *       `CLKPolarity` 与 `CLKPhase`。关键不是背 Mode 编号，而是把手册上的
 *       “sample on rising/falling edge” 翻译成领先沿/滞后沿契约。
 */
HAL_StatusTypeDef SpiBus_InitMaster(SpiBusService_t *service,
                                    SPI_HandleTypeDef *hspi,
                                    GPIO_TypeDef *cs_port,
                                    uint16_t cs_pin,
                                    uint32_t spi_kernel_hz,
                                    uint32_t core_clock_hz,
                                    const SpiTimingContract_t *contract)
{
    uint32_t hal_prescaler;
    uint32_t actual_sck_hz;

    if ((service == NULL) || (hspi == NULL) || (cs_port == NULL) || (contract == NULL))
    {
        return HAL_ERROR;
    }

    if (!Spi_SelectPrescaler(spi_kernel_hz, contract, &hal_prescaler, &actual_sck_hz))
    {
        return HAL_ERROR;
    }

    memset(service, 0, sizeof(*service));
    service->hspi = hspi;
    service->cs_port = cs_port;
    service->cs_pin = cs_pin;
    service->spi_kernel_hz = spi_kernel_hz;
    service->core_clock_hz = core_clock_hz;
    service->actual_sck_hz = actual_sck_hz;
    service->contract = *contract;

    hspi->Init.Mode = SPI_MODE_MASTER;
    hspi->Init.Direction = SPI_DIRECTION_2LINES;
    hspi->Init.DataSize = SPI_DATASIZE_8BIT;
    hspi->Init.CLKPolarity = contract->idle_clock_high ? SPI_POLARITY_HIGH : SPI_POLARITY_LOW;
    hspi->Init.CLKPhase = contract->sample_on_trailing_edge ? SPI_PHASE_2EDGE : SPI_PHASE_1EDGE;
    hspi->Init.NSS = SPI_NSS_SOFT;
    hspi->Init.BaudRatePrescaler = hal_prescaler;
    hspi->Init.FirstBit = SPI_FIRSTBIT_MSB;
    hspi->Init.TIMode = SPI_TIMODE_DISABLE;
    hspi->Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
    hspi->Init.CRCPolynomial = 7U;

    Spi_CsDeassert(service);

    if (HAL_SPI_Init(hspi) != HAL_OK)
    {
        return HAL_ERROR;
    }

    (void)Spi_EnableCycleCounter();
    return HAL_OK;
}

/**
 * @brief 在手动片选保护下执行一次完整的 SPI 全双工事务。
 * @param service SPI 服务对象。
 * @param tx_data 发送缓冲区，允许为 NULL；若为 NULL 则自动发送 Dummy Byte。
 * @param rx_data 接收缓冲区，允许为 NULL。
 * @param length 本次事务字节数。
 * @retval HAL_OK 事务成功完成。
 * @retval HAL_ERROR 参数非法。
 * @retval HAL_TIMEOUT 标志位等待超时，通常意味着 SCK 未启动或总线状态异常。
 *
 * @note 当 `CPHA = 0` 时，第一拍在领先沿采样，因此 `CS` 拉低后必须先满足 `cs_setup_ns`，
 *       再写入首字节启动时钟；否则最容易出现“首字节错、后面都对”的典型故障。
 */
HAL_StatusTypeDef SpiBus_Transfer(SpiBusService_t *service,
                                  const uint8_t *tx_data,
                                  uint8_t *rx_data,
                                  uint16_t length)
{
    uint16_t index;

    if ((service == NULL) || (service->hspi == NULL) || (length == 0U))
    {
        return HAL_ERROR;
    }

    Spi_FlushRx(service->hspi);
    Spi_CsAssert(service);
    Spi_DelayNs(service->core_clock_hz, service->contract.cs_setup_ns);

    for (index = 0U; index < length; ++index)
    {
        const uint8_t tx_byte = (tx_data != NULL) ? tx_data[index] : SPI_DUMMY_BYTE;
        uint8_t rx_byte;

        if (Spi_WaitFlag(service->hspi, SPI_FLAG_TXE, true) != HAL_OK)
        {
            Spi_CsDeassert(service);
            return HAL_TIMEOUT;
        }

        *(__IO uint8_t *)&service->hspi->Instance->DR = tx_byte;

        if (Spi_WaitFlag(service->hspi, SPI_FLAG_RXNE, true) != HAL_OK)
        {
            Spi_CsDeassert(service);
            return HAL_TIMEOUT;
        }

        rx_byte = *(__IO uint8_t *)&service->hspi->Instance->DR;

        if (rx_data != NULL)
        {
            rx_data[index] = rx_byte;
        }
    }

    if (Spi_WaitFlag(service->hspi, SPI_FLAG_TXE, true) != HAL_OK)
    {
        Spi_CsDeassert(service);
        return HAL_TIMEOUT;
    }

    if (Spi_WaitFlag(service->hspi, SPI_FLAG_BSY, false) != HAL_OK)
    {
        Spi_CsDeassert(service);
        return HAL_TIMEOUT;
    }

    Spi_DelayNs(service->core_clock_hz, service->contract.cs_hold_ns);
    Spi_CsDeassert(service);
    return HAL_OK;
}

/**
 * @brief 读取连续寄存器区间，演示 SPI “读操作必须伴随 Dummy Clock”的本质。
 * @param service SPI 服务对象。
 * @param start_reg 起始寄存器地址，按常见器件约定用 bit7 表示读标志。
 * @param data 输出数据缓冲区。
 * @param length 读取字节数，最大 31 字节。
 * @retval HAL_OK 读取成功。
 * @retval HAL_ERROR 参数非法或事务失败。
 *
 * @note 对多数 SPI 外设而言，“读取 length 字节”并不意味着只发 1 个读命令。
 *       真正的线级行为是：
 *       [地址字节] + [length 个 Dummy Byte]
 *       因为只有主机持续送时钟，从机才有机会把寄存器内容从 MISO 推出来。
 */
HAL_StatusTypeDef SpiBus_ReadRegisters(SpiBusService_t *service,
                                       uint8_t start_reg,
                                       uint8_t *data,
                                       uint8_t length)
{
    uint8_t tx_frame[SPI_BURST_MAX_BYTES];
    uint8_t rx_frame[SPI_BURST_MAX_BYTES];

    if ((service == NULL) || (data == NULL) || (length == 0U) || (length >= SPI_BURST_MAX_BYTES))
    {
        return HAL_ERROR;
    }

    tx_frame[0] = start_reg | 0x80U;
    memset(&tx_frame[1], SPI_DUMMY_BYTE, length);
    memset(rx_frame, 0, sizeof(rx_frame));

    if (SpiBus_Transfer(service, tx_frame, rx_frame, (uint16_t)(length + 1U)) != HAL_OK)
    {
        return HAL_ERROR;
    }

    memcpy(data, &rx_frame[1], length);
    return HAL_OK;
}

extern SPI_HandleTypeDef hspi1;

SpiBusService_t g_imu_spi = {0};

HAL_StatusTypeDef App_ImuSpiInit(void)
{
    const SpiTimingContract_t imu_contract =
    {
        .idle_clock_high = true,
        .sample_on_trailing_edge = true,
        .desired_sck_hz = 10000000U,
        .slave_max_sck_hz = 10000000U,
        .cs_setup_ns = 80U,
        .cs_hold_ns = 60U,
        .trace_delay_ns = 12U,
        .master_mosi_valid_ns = 8U,
        .master_miso_setup_ns = 10U,
        .slave_miso_valid_ns = 35U,
        .slave_mosi_setup_ns = 5U
    };

    /* 这个配置对应典型 Mode 3 设备：
     * CPOL = 1 -> SCK 空闲高电平，领先沿为下降沿。
     * CPHA = 1 -> 在滞后沿采样，在领先沿更新数据。
     */
    return SpiBus_InitMaster(&g_imu_spi,
                             &hspi1,
                             IMU_CS_GPIO_Port,
                             IMU_CS_Pin,
                             84000000U,
                             SystemCoreClock,
                             &imu_contract);
}
```

这段实现真正想表达的是：SPI 的 Mode 0 到 Mode 3 不是四个任意可切换的“软件选项”，而是主从双方围绕同一组边沿做出的时域承诺。`CLKPolarity` 决定空闲参考系，`CLKPhase` 决定首拍与半周期预算，分频器决定这个预算是否还够装下传播延迟和建立时间，`CS` 建立/保持则决定从机状态机是否真的按你以为的帧边界工作。只要把这些约束收敛成代码里的合同对象，SPI 调试就不再是猜 Mode 编号，而是回到可测量、可推导、可复现的工程问题。
