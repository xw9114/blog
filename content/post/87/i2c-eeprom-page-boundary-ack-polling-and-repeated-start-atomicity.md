---
title: "技能档案：I2C EEPROM 页写边界、ACK 轮询与重复起始的事务原子性"
slug: "skill-i2c-eeprom-page-boundary-ack-polling-and-repeated-start-atomicity"
date: 2026-07-11T09:03:29+08:00
draft: false
description: "从 EEPROM 页缓冲回卷、内部 tWR 忙周期、ACK 轮询到 repeated-start 读事务，系统拆解 I2C 为什么常败给“看不见的从机状态机”而不是 HAL 调用本身。"
tags: ["I2C", "STM32", "EEPROM", "AT24Cxx", "重复起始", "嵌入式"]
categories: ["技能档案"]
image: ""
---

## 技能概述
I2C EEPROM 看上去只是“把几个字节写进 AT24Cxx，再把它们读出来”，但真正决定系统是否可靠的，从来不是 `HAL_I2C_Mem_Read()` 和 `HAL_I2C_Master_Transmit()` 这两个 API 名字，而是**总线字节事务**与**存储阵列写入事务**之间那道看不见的鸿沟：主机在 `400 kHz` 的节拍里一口气送完一页数据，从机却还要在毫秒级 `tWR` 窗口里用内部电荷泵把页缓冲真正刻进单元；如果软件不理解页边界回卷、ACK 轮询、重复起始与地址映射，系统就会出现一种很典型的“假成功”——I2C 波形看起来完全正确，EEPROM 里落下来的却是错页、半页、回卷覆盖或者忙周期中的陈旧数据。这个主题真正要解决的，是如何把**字节流总线**、**页编程状态机**与**实时任务调度**重新绑成一份可审计的事务合同。

## 核心底层概念解析

- **I2C 传的是字节，EEPROM 写的是页，二者根本不在同一个时域**：主机眼中的一次页写入，线上的可见部分只是 `S -> DEV(W) -> WORD_ADDR -> DATA[n] -> P` 这一串 `9 bit/byte` 的同步位流；而从机眼中的真正写入，要等 `STOP` 之后才进入内部编程周期 `tWR`。也就是说，最后一个 ACK 只表示“页缓冲已接单”，并不表示“浮栅或存储阵列已经落盘”。工程上必须把一次写事务拆成 `t_total ≈ t_bus + tWR`，而不是只盯住总线传输时间。
- **页边界不是数组长度提醒，而是内部列地址低位回卷的硬件现实**：假设页大小为 `P`，起始地址为 `A0`，当前页内偏移为 `page_off = A0 mod P`，那么本次合法连续写入的最大长度只能是 `chunk_max = P - page_off`。一旦软件把更多字节塞进同一条页写指令，很多 EEPROM 并不会自动跨页，而是让页内低位地址回卷到页首，把刚写进去的前半页覆盖掉。这个错误不会表现成总线 NACK，它通常会以“写成功但内容逻辑错位”的形式潜伏下来。
- **页写次数本身就是资源调度量，而不是附属细节**：若总写入长度为 `L`，页大小为 `P`，起始偏移为 `o = A0 mod P`，那么所需页编程次数近似满足  
  `N_cycle = 1 + floor((o + L - 1) / P)`。  
  这意味着同样是写 `96` 字节，从页边界开始与从页中间开始，RTOS 任务被 `tWR` 阻塞的次数并不一样。真正稳定的驱动必须先做页切分，再决定超时预算与任务让步策略。
- **ACK 轮询不是“多试几次”，而是把不可见的内部忙周期映射成可观测的总线事件**：EEPROM 在内部编程期间通常会对控制字节 NACK，因为它此刻还不准备接受下一笔事务。固定 `HAL_Delay(5)` 看似能跑，但它把温度、电压、工艺散布带来的 `tWR` 抖动全都粗暴吞掉；ACK 轮询则更像一条观测方程：设备一旦重新 ACK，就说明隐藏在芯片内部的写状态机已经回到空闲态。它是软件对“看不见的从机时间轴”做的最廉价观测。
- **重复起始不是礼貌动作，而是读事务原子性的保证**：典型 EEPROM 随机读事务在线上应当长成  
  `S -> DEV(W) -> WORD_ADDR -> Sr -> DEV(R) -> DATA[n] -> P`。  
  这里的 `Sr`（repeated-start）意味着主机没有释放总线拥有权，只是在不插入 `STOP` 的前提下切换了方向。如果中间换成 `STOP + START`，在多主系统里你可能被别的主机抢走总线；即使在单主系统里，也等于把“设置内部字地址”和“开始读数据”拆成两笔彼此可被打断的事务。
- **逻辑地址并不总是等于 word address，很多 AT24 器件把高位地址折叠进了设备地址**：例如部分小容量 EEPROM 使用 1 字节 `word address`，但把更高的地址位放进 7-bit 设备地址低位。于是逻辑地址 `A` 要被拆成  
  `dev7 = base7 | ((A >> 8) & block_mask)`，`word = A & 0xFF`。  
  软件如果只会无脑把 `A` 塞进 16-bit 地址参数，就会在某些容量型号上出现“前 256 字节正常、后面镜像或跳页”的诡异故障。这里的本质不是 API 用错，而是没有看懂地址空间到总线帧字段的映射关系。
- **写吞吐量往往不是由 `fSCL` 决定，而是由页大小和 `tWR` 决定**：对单次页写，若总线传输位数近似为 `bits_bus ≈ 9 * (1 + N_addr + N_data)`，则有效吞吐近似满足  
  `throughput_eff ≈ N_data / (bits_bus / fSCL + tWR)`。  
  当 `tWR` 已经来到 `3~5 ms` 量级时，把总线从 `100 kHz` 拉到 `400 kHz` 只能减少前半段 `bits_bus / fSCL`，却不会改变内部编程时间这笔大头。所以很多“提频后怎么还是慢”的根因，不在 SCL，而在页组织与事务拆分。
- **真正需要分类处理的不是“失败”二字，而是失败发生在哪条状态机上**：地址阶段 NACK 可能意味着器件忙、地址映射错或写保护状态异常；`HAL_BUSY` 可能意味着总线物理层没回到空闲；写完成后读到旧值，则更像是重复起始与 ACK 轮询合同失效。把这些完全不同的根因都压成一个 `HAL_ERROR`，等价于把不同物理故障投影成同一条软件异常，调试只会越来越玄学。
- **掉电与写保护说明 EEPROM 不是“慢一点的 SRAM”，而是一台有内部能量过程的存储机器**：页写期间芯片内部在做真正的单元编程，这要求供电、写保护引脚和时序窗口都保持稳定。总线停了不代表事务已经完成，`STOP` 之后的几毫秒才是数据最脆弱的时候。系统如果没有把 brownout、WP 引脚和写事务生命周期一起考虑，所谓“写成功”只是数字世界的一厢情愿。
- **从工程哲学上说，稳健的 EEPROM 驱动要同时维护两份合同**：一份是看得见的 `SCL/SDA` 总线合同——地址、ACK、重复起始、页边界；另一份是看不见的芯片内部合同——页缓冲容量、写周期忙状态、地址回卷与编程完成时刻。只维护前者，驱动会“波形正确但数据错”；只维护后者，驱动又失去实时性。真正成熟的实现，是让这两份合同在代码里同时可见。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 的 AT24Cxx 风格 EEPROM 驱动示例。代码刻意把重点放在四件真正决定可靠性的事情上：

- 先把**逻辑地址**拆成**设备地址位**与**word address 字段**；
- 按 `page_off = address mod page_size` 做**页边界限幅切分**；
- 每次页写后都执行**ACK 轮询**，而不是盲等固定延时；
- 随机读统一走 **repeated-start** 事务，避免把“设地址”和“读数据”拆成两笔可被打断的总线行为。

代码默认兼容两类器件：

- 像 **AT24C256** 这类使用 **16-bit word address**、设备地址固定为 `0x50 ~ 0x57` 的器件；
- 像部分小容量 **AT24C04/08/16** 这类使用 **8-bit word address**，但把更高地址位编码进设备地址低位的器件。

```c
#include "stm32f4xx_hal.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define I2C_EEPROM_MAX_PAGE_SIZE              128U
#define I2C_EEPROM_MAX_ADDR_BYTES             2U
#define I2C_EEPROM_MAX_WRITE_FRAME_BYTES      (I2C_EEPROM_MAX_PAGE_SIZE + I2C_EEPROM_MAX_ADDR_BYTES)
#define I2C_EEPROM_MAX_READ_BURST_BYTES       256U
#define I2C_EEPROM_TIMEOUT_MIN_MS             2U
#define I2C_EEPROM_TIMEOUT_MAX_MS             50U
#define I2C_EEPROM_ACK_POLL_PERIOD_MS         1U
#define I2C_EEPROM_WRITE_CYCLE_MAX_US_LIMIT   10000U

typedef struct
{
    I2C_HandleTypeDef *hi2c;
    uint8_t base_7bit;              /* 典型值 0x50；若器件带硬件地址脚，可先把 A2/A1/A0 编进这里 */
    uint32_t capacity_bytes;        /* 逻辑总容量，例如 AT24C256 为 32768 */
    uint16_t page_size;             /* 页缓冲大小，例如 16/32/64/128 */
    uint8_t word_addr_bytes;        /* 1 或 2 */
    uint8_t block_select_bits;      /* 小容量 AT24 常把高地址位复用进 DEV 地址；大容量器件这里为 0 */
    uint32_t bus_speed_hz;          /* 100000 或 400000 等 */
    uint32_t write_cycle_max_us;    /* tWR 上界，常见 5000 us */
} I2cEeprom_t;

typedef struct
{
    uint16_t dev_addr_8bit;
    uint16_t mem_addr;
    uint16_t mem_addr_size;
    uint32_t block_size_bytes;
    uint32_t block_remaining_bytes;
} I2cEepromResolvedAddr_t;

static uint32_t I2cEeprom_MinU32(uint32_t a, uint32_t b)
{
    return (a < b) ? a : b;
}

static uint32_t I2cEeprom_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static bool I2cEeprom_IsPowerOfTwo(uint32_t value)
{
    return ((value != 0U) && ((value & (value - 1U)) == 0U));
}

/**
 * @brief 将逻辑线性地址映射成 EEPROM 事务真正需要的总线字段。
 * @param eeprom EEPROM 配置。
 * @param absolute_addr 逻辑线性地址，范围为 [0, capacity_bytes)。
 * @param out [out] 解析后的设备地址、word address 和块边界信息。
 * @retval true  解析成功。
 * @retval false 地址越界或配置非法。
 *
 * @note 对部分小容量器件，逻辑地址 A 并不完整地落在 word address 字段里，而要拆成：
 *       dev7 = base7 | ((A >> word_addr_bits) & block_mask)
 *       word = A & ((1 << word_addr_bits) - 1)
 *
 *       其中：
 *       - word_addr_bits = 8  * word_addr_bytes
 *       - block_mask     = (1 << block_select_bits) - 1
 *
 *       例如 8-bit word address 且 block_select_bits = 3 时：
 *       - 每个 block 的线性容量 = 2^8 = 256 byte
 *       - A[10:8] 被折叠到设备地址低 3 bit
 *       - A[7:0] 进入 word address
 */
static bool I2cEeprom_ResolveAddress(const I2cEeprom_t *eeprom,
                                     uint32_t absolute_addr,
                                     I2cEepromResolvedAddr_t *out)
{
    uint8_t block_mask = 0U;
    uint8_t dev7 = 0U;
    uint32_t block_size_bytes = 0U;
    uint32_t addr_in_block = 0U;

    if ((eeprom == NULL) || (out == NULL) || (eeprom->hi2c == NULL))
    {
        return false;
    }

    if ((eeprom->word_addr_bytes != 1U) && (eeprom->word_addr_bytes != 2U))
    {
        return false;
    }

    if (absolute_addr >= eeprom->capacity_bytes)
    {
        return false;
    }

    block_mask = (eeprom->block_select_bits == 0U)
               ? 0U
               : (uint8_t)((1U << eeprom->block_select_bits) - 1U);

    block_size_bytes = (eeprom->word_addr_bytes == 1U) ? 256UL : 65536UL;
    addr_in_block = absolute_addr % block_size_bytes;

    dev7 = (uint8_t)((eeprom->base_7bit & (uint8_t)(~block_mask))
                   | ((absolute_addr >> (8U * eeprom->word_addr_bytes)) & block_mask));

    out->dev_addr_8bit = (uint16_t)(dev7 << 1U);
    out->mem_addr = (uint16_t)addr_in_block;
    out->mem_addr_size = (eeprom->word_addr_bytes == 1U) ? I2C_MEMADD_SIZE_8BIT : I2C_MEMADD_SIZE_16BIT;
    out->block_size_bytes = block_size_bytes;
    out->block_remaining_bytes = block_size_bytes - addr_in_block;

    return true;
}

/**
 * @brief 根据一次总线传输中的有效字节数，估算 HAL 阻塞调用所需超时。
 * @param bus_speed_hz I2C 时钟频率。
 * @param payload_bytes 本次在线路上真正传输的字节数，不含隐藏的 tWR。
 * @return 建议超时，单位 ms。
 *
 * @note I2C 近似可按 9 bit/byte 估算，因为每个字节后都伴随一个 ACK/NACK 位：
 *       t_bus ~= 9 * N_bytes / fSCL
 *
 *       这里估算的是 HAL 阻塞函数对“可见总线阶段”的等待上界，
 *       不把 EEPROM 内部写周期 tWR 混进来，二者由不同函数分开处理。
 */
static uint32_t I2cEeprom_EstimateBusTimeoutMs(uint32_t bus_speed_hz, uint32_t payload_bytes)
{
    const uint32_t safe_bus_hz = I2cEeprom_ClampU32(bus_speed_hz, 10000U, 1000000U);
    const uint64_t bits_total = (uint64_t)payload_bytes * 9ULL + 18ULL; /* 额外给 Start/Stop 与调度余量 */
    const uint32_t transfer_ms = (uint32_t)((bits_total * 1000ULL + safe_bus_hz - 1ULL) / safe_bus_hz);

    return I2cEeprom_ClampU32(transfer_ms + 1U,
                              I2C_EEPROM_TIMEOUT_MIN_MS,
                              I2C_EEPROM_TIMEOUT_MAX_MS);
}

/**
 * @brief 在每次页写之后执行 ACK 轮询，等待 EEPROM 内部编程周期完成。
 * @param eeprom EEPROM 配置。
 * @param dev_addr_8bit 当前块对应的 8-bit 设备地址。
 * @retval HAL_OK      器件重新 ACK，说明内部写状态机已回到空闲。
 * @retval HAL_TIMEOUT 在预算窗口内始终未重新 ACK。
 * @retval HAL_ERROR   参数非法。
 *
 * @note 这里显式区分“总线传输结束”和“阵列编程结束”：
 *       - 总线阶段结束于 STOP；
 *       - 芯片内部写周期结束于重新 ACK。
 *
 *       轮询预算近似取：
 *       poll_budget_ms = ceil(tWR_max_us / 1000) + margin
 */
static HAL_StatusTypeDef I2cEeprom_WaitWriteReady(const I2cEeprom_t *eeprom,
                                                  uint16_t dev_addr_8bit)
{
    uint32_t poll_count = 0U;
    uint32_t poll_budget_ms = 0U;

    if ((eeprom == NULL) || (eeprom->hi2c == NULL))
    {
        return HAL_ERROR;
    }

    poll_budget_ms = I2cEeprom_ClampU32(eeprom->write_cycle_max_us,
                                        1000U,
                                        I2C_EEPROM_WRITE_CYCLE_MAX_US_LIMIT);
    poll_budget_ms = (poll_budget_ms + 999U) / 1000U;
    poll_budget_ms = I2cEeprom_ClampU32(poll_budget_ms + 2U, 2U, 20U);

    for (poll_count = 0U; poll_count < poll_budget_ms; ++poll_count)
    {
        if (HAL_I2C_IsDeviceReady(eeprom->hi2c, dev_addr_8bit, 1U, 1U) == HAL_OK)
        {
            return HAL_OK;
        }

        HAL_Delay(I2C_EEPROM_ACK_POLL_PERIOD_MS);
    }

    return HAL_TIMEOUT;
}

/**
 * @brief 发送一条不跨页也不跨地址块的页写命令。
 * @param eeprom EEPROM 配置。
 * @param absolute_addr 本页片段的起始逻辑地址。
 * @param data 待写数据。
 * @param length 本片段长度，必须已经被上层切分到合法边界内。
 * @retval HAL_OK      写入并完成 ACK 轮询。
 * @retval HAL_TIMEOUT 总线阶段或内部编程阶段超时。
 * @retval HAL_ERROR   参数非法或 HAL 返回不可恢复错误。
 *
 * @note 调用者必须保证：
 *       1. length <= page_size - (absolute_addr mod page_size)
 *       2. length <= 当前地址块剩余容量
 *
 *       这样才能确保本次写入不会触发页内回卷，也不会跨越由设备地址编码的 block。
 */
static HAL_StatusTypeDef I2cEeprom_WriteChunk(const I2cEeprom_t *eeprom,
                                              uint32_t absolute_addr,
                                              const uint8_t *data,
                                              uint16_t length)
{
    I2cEepromResolvedAddr_t resolved;
    uint8_t frame[I2C_EEPROM_MAX_WRITE_FRAME_BYTES];
    uint16_t frame_length = 0U;
    uint32_t timeout_ms = 0U;

    if ((eeprom == NULL) || (data == NULL) || (length == 0U) || (length > eeprom->page_size))
    {
        return HAL_ERROR;
    }

    if (!I2cEeprom_ResolveAddress(eeprom, absolute_addr, &resolved))
    {
        return HAL_ERROR;
    }

    if ((eeprom->word_addr_bytes + length) > I2C_EEPROM_MAX_WRITE_FRAME_BYTES)
    {
        return HAL_ERROR;
    }

    /* 先组织 word address，再拼接本页数据。
     * 对 16-bit word address：frame = [A15:8][A7:0][DATA...]
     * 对  8-bit word address：frame = [A7:0][DATA...]
     */
    if (eeprom->word_addr_bytes == 2U)
    {
        frame[0] = (uint8_t)((resolved.mem_addr >> 8U) & 0xFFU);
        frame[1] = (uint8_t)(resolved.mem_addr & 0xFFU);
        memcpy(&frame[2], data, length);
        frame_length = (uint16_t)(2U + length);
    }
    else
    {
        frame[0] = (uint8_t)(resolved.mem_addr & 0xFFU);
        memcpy(&frame[1], data, length);
        frame_length = (uint16_t)(1U + length);
    }

    timeout_ms = I2cEeprom_EstimateBusTimeoutMs(eeprom->bus_speed_hz,
                                                1U + eeprom->word_addr_bytes + length);

    if (HAL_I2C_Master_Transmit(eeprom->hi2c,
                                resolved.dev_addr_8bit,
                                frame,
                                frame_length,
                                timeout_ms) != HAL_OK)
    {
        return (HAL_I2C_GetError(eeprom->hi2c) == HAL_I2C_ERROR_TIMEOUT) ? HAL_TIMEOUT : HAL_ERROR;
    }

    return I2cEeprom_WaitWriteReady(eeprom, resolved.dev_addr_8bit);
}

/**
 * @brief 向 EEPROM 线性地址空间写入一段任意长度数据。
 * @param eeprom EEPROM 配置。
 * @param address 起始逻辑地址。
 * @param data 数据指针。
 * @param length 数据长度。
 * @retval HAL_OK      全部写入成功。
 * @retval HAL_TIMEOUT 某一页的总线阶段或 ACK 轮询阶段超时。
 * @retval HAL_ERROR   越界、配置错误或底层 HAL 返回不可恢复错误。
 *
 * @note 页切分公式：
 *       page_off       = address mod page_size
 *       page_remaining = page_size - page_off
 *       chunk          = min(length_remaining, page_remaining, block_remaining)
 *
 *       其中 block_remaining 用来防止跨越“高位地址编码进设备地址”的边界。
 */
HAL_StatusTypeDef I2cEeprom_Write(const I2cEeprom_t *eeprom,
                                  uint32_t address,
                                  const uint8_t *data,
                                  uint32_t length)
{
    HAL_StatusTypeDef status = HAL_OK;
    uint32_t written = 0U;

    if ((eeprom == NULL) || (data == NULL))
    {
        return HAL_ERROR;
    }

    if ((eeprom->page_size == 0U) ||
        (eeprom->page_size > I2C_EEPROM_MAX_PAGE_SIZE) ||
        (!I2cEeprom_IsPowerOfTwo(eeprom->page_size)))
    {
        return HAL_ERROR;
    }

    if (length == 0U)
    {
        return HAL_OK;
    }

    if (address >= eeprom->capacity_bytes)
    {
        return HAL_ERROR;
    }

    if (length > (eeprom->capacity_bytes - address))
    {
        return HAL_ERROR;
    }

    while (written < length)
    {
        I2cEepromResolvedAddr_t resolved;
        const uint32_t current_addr = address + written;
        const uint32_t page_off = current_addr % eeprom->page_size;
        const uint32_t page_remaining = eeprom->page_size - page_off;
        uint32_t chunk = 0U;

        if (!I2cEeprom_ResolveAddress(eeprom, current_addr, &resolved))
        {
            return HAL_ERROR;
        }

        chunk = length - written;
        chunk = I2cEeprom_MinU32(chunk, page_remaining);
        chunk = I2cEeprom_MinU32(chunk, resolved.block_remaining_bytes);
        chunk = I2cEeprom_MinU32(chunk, I2C_EEPROM_MAX_PAGE_SIZE);

        status = I2cEeprom_WriteChunk(eeprom,
                                      current_addr,
                                      &data[written],
                                      (uint16_t)chunk);
        if (status != HAL_OK)
        {
            return status;
        }

        written += chunk;
    }

    return HAL_OK;
}

/**
 * @brief 从 EEPROM 中执行一段随机读，内部使用 repeated-start 保持事务原子性。
 * @param eeprom EEPROM 配置。
 * @param address 起始逻辑地址。
 * @param data [out] 读出缓存。
 * @param length 读取字节数。
 * @retval HAL_OK      读取成功。
 * @retval HAL_TIMEOUT 总线阶段超时。
 * @retval HAL_ERROR   越界、配置错误或 HAL 返回不可恢复错误。
 *
 * @note HAL_I2C_Mem_Read() 在线路上的真实事务近似为：
 *       S  -> DEV(W)
 *          -> WORD_ADDR[n]
 *       Sr -> DEV(R)
 *          -> DATA[n]
 *       P
 *
 *       其中 Sr 即 repeated-start。它不是多余动作，而是保证“设地址”和“开始读”
 *       仍属于同一笔总线事务，不在两步之间释放总线。
 */
HAL_StatusTypeDef I2cEeprom_Read(const I2cEeprom_t *eeprom,
                                 uint32_t address,
                                 uint8_t *data,
                                 uint32_t length)
{
    uint32_t read_offset = 0U;

    if ((eeprom == NULL) || (data == NULL))
    {
        return HAL_ERROR;
    }

    if (length == 0U)
    {
        return HAL_OK;
    }

    if (address >= eeprom->capacity_bytes)
    {
        return HAL_ERROR;
    }

    if (length > (eeprom->capacity_bytes - address))
    {
        return HAL_ERROR;
    }

    while (read_offset < length)
    {
        I2cEepromResolvedAddr_t resolved;
        const uint32_t current_addr = address + read_offset;
        uint32_t chunk = length - read_offset;
        uint32_t timeout_ms = 0U;

        if (!I2cEeprom_ResolveAddress(eeprom, current_addr, &resolved))
        {
            return HAL_ERROR;
        }

        chunk = I2cEeprom_MinU32(chunk, resolved.block_remaining_bytes);
        chunk = I2cEeprom_MinU32(chunk, I2C_EEPROM_MAX_READ_BURST_BYTES);

        /* 读事务在线路上有两次控制字节：DEV(W) + DEV(R)。
         * 因此 bus payload 近似取 2 + word_addr_bytes + chunk。
         */
        timeout_ms = I2cEeprom_EstimateBusTimeoutMs(eeprom->bus_speed_hz,
                                                    2U + eeprom->word_addr_bytes + chunk);

        if (HAL_I2C_Mem_Read(eeprom->hi2c,
                             resolved.dev_addr_8bit,
                             resolved.mem_addr,
                             resolved.mem_addr_size,
                             &data[read_offset],
                             (uint16_t)chunk,
                             timeout_ms) != HAL_OK)
        {
            return (HAL_I2C_GetError(eeprom->hi2c) == HAL_I2C_ERROR_TIMEOUT) ? HAL_TIMEOUT : HAL_ERROR;
        }

        read_offset += chunk;
    }

    return HAL_OK;
}

extern I2C_HandleTypeDef hi2c1;

static I2cEeprom_t g_log_eeprom =
{
    .hi2c = &hi2c1,
    .base_7bit = 0x50U,
    .capacity_bytes = 32768U,     /* 32 KB = 256 Kbit */
    .page_size = 64U,
    .word_addr_bytes = 2U,
    .block_select_bits = 0U,
    .bus_speed_hz = 400000U,
    .write_cycle_max_us = 5000U
};

/**
 * @brief 将一段校准数据稳健地保存到 EEPROM 指定区域。
 * @param blob 校准数据首地址。
 * @param length 校准数据长度。
 * @retval HAL 状态码。
 *
 * @note 例如从 0x0123 开始写 100 byte：
 *       - 首页偏移 page_off = 0x0123 mod 64 = 35
 *       - 首次 chunk = 64 - 35 = 29
 *       - 剩余 71 byte 再拆成 64 + 7
 *
 *       于是总共发生 3 次页编程周期，而不是 1 次。
 */
HAL_StatusTypeDef App_SaveCalibrationBlob(const uint8_t *blob, uint32_t length)
{
    return I2cEeprom_Write(&g_log_eeprom, 0x0123U, blob, length);
}

/**
 * @brief 读取一段校准数据。
 * @param blob [out] 接收缓存。
 * @param length 读取长度。
 * @retval HAL 状态码。
 */
HAL_StatusTypeDef App_LoadCalibrationBlob(uint8_t *blob, uint32_t length)
{
    return I2cEeprom_Read(&g_log_eeprom, 0x0123U, blob, length);
}
```

这段实现真正想强调的，不是“STM32 HAL 也能把 EEPROM 跑起来”，而是三条更底层的工程结论：

- **页写 API 不应该接受未经切分的任意长度数据**。只要不显式做 `page_remaining` 限幅，所谓“连续写”就随时可能变成页内回卷覆盖。
- **ACK 轮询是写事务的一部分，不是可选优化**。少了它，驱动就会把“总线传完了”误认成“芯片已经写完了”。
- **随机读不是两笔事务，而是一笔带 repeated-start 的原子事务**。把设地址和读数据拆开，等于主动把一致性窗口撕开。

如果继续沿着这条线深挖，下一步往往就不是再堆更多 I2C API，而是回到三个更硬的问题上：你的 EEPROM 到底是哪一种地址映射模型、你的任务调度是否真的允许 `N_cycle * tWR` 这笔最坏阻塞、以及你的掉电和写保护策略是否覆盖了 `STOP` 之后那段最脆弱的内部编程窗口。只有这些问题都被写进合同里，I2C EEPROM 才不再是“偶尔会错一页”的黑盒，而是一台时序、状态机和地址映射都可被审计的存储前端。
