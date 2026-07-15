---
title: "技能档案：YOLO 边缘部署里的特征图分块、双缓冲 DMA 与算子流水时序闭合"
slug: "skill-yolo-edge-feature-map-tiling-double-buffer-dma-and-operator-pipeline-closure"
date: 2026-07-12T09:03:11+08:00
draft: false
description: "从卷积 halo、SRAM 瓦片预算、双缓冲 DMA 重叠到 steady-state 吞吐公式，系统拆解边缘端 YOLO 为什么常败给特征图搬运而不是 MAC 数量本身。"
tags: ["YOLO", "STM32", "Edge AI", "DMA", "双缓冲", "SRAM"]
categories: ["技能档案", "算法与人工智能", "机器视觉"]
image: ""
---

## 技能概述

很多边缘端 YOLO 项目并不是算力不够，而是**数据在不该停下来的地方停住了**：相机一帧刚搬进 SRAM，上一层特征图还没出 AXI，总线又被下一层权重预取抢走；卷积核本身的 `MAC` 看起来足够快，系统却仍然在 tile 边界、cache line、DMA 粒度和输出回写上反复丢拍。真正的痛点从来不是“模型是否已经量化成 `INT8`”，而是你能否把**卷积几何映射**、**SRAM 容量边界**、**DMA 双缓冲重叠**与**帧级截止时间**绑成同一份时序合同。这个主题要解决的核心问题，就是让 YOLO 在小内存 MCU/MPU 上不只“能跑”，而是能把每一层的搬运、计算和回写真正闭合成稳定流水。

## 核心底层概念解析

- **边缘端 YOLO 首先是搬运问题，其次才是乘加问题**：很多人先看 `MAC` 数，却忽略了激活张量往往比权重更“贵”。某一层若输入特征图尺寸为 `H * W * C_in`，输出为 `H_o * W_o * C_out`，单次完整层计算至少要触碰 `B_act ≈ HWC_in + H_oW_oC_out` 个元素；当片上 SRAM 放不下整层激活时，系统就只能把空间连续的图像重新切成 tile，把时间连续的流水拆成多次局部事务。

- **tile 不是矩形裁剪，而是带 halo 的卷积局部世界**：输出 tile 若大小为 `(W_to, H_to)`，卷积核大小为 `(K_x, K_y)`，步幅为 `(S_x, S_y)`，则它在输入平面上对应的逻辑覆盖范围近似满足  
  `W_ti = (W_to - 1) * S_x + K_x`，  
  `H_ti = (H_to - 1) * S_y + K_y`。  
  真正难的地方在于：tile 外面那一圈 halo 并不是“多搬几列像素”这么简单，而是卷积正确性和 SRAM 上界同时签字的地方。halo 算少了，边界会裂；算多了，tile 数减少不了，搬运又会拖死总线。

- **SRAM 预算必须按“同时活着的数据”记账，而不是按单缓冲数组长度记账**：对双缓冲流水，任一时刻至少同时存在上一 tile 的输出、当前 tile 的输入和下一 tile 的预取输入。若输入/输出都为 `INT8`，则片上占用近似满足  
  `B_total ≈ 2 * B_in_tile + 2 * B_out_tile + B_scratch + B_guard`。  
  这里 `B_guard` 往往包含 `32/64 byte` 对齐浪费、DMA 描述符、cache line 清洗区和 backend 的额外 scratch。真正的系统约束，永远不是“理论元素个数刚好放得下”，而是“所有活跃缓冲同时存在时仍不越界”。

- **双缓冲的本质不是 ping-pong 这四个字，而是把串行链条折成并行链条**：若单个 tile 的三个阶段分别耗时 `T_in`、`T_compute`、`T_out`，那么未重叠时总时间为 `T_serial = T_in + T_compute + T_out`；而稳态双缓冲流水的 tile 周期更接近  
  `T_steady ≈ max(T_in, T_compute, T_out)`。  
  整层总时延近似写成  
  `T_layer ≈ T_fill + N_tile * T_steady + T_drain`。  
  这条式子直接揭示了工程现实：一旦 DMA 和计算不平衡，最慢那一级就会变成整条流水的节拍器。

- **tile 切得太小不一定更快，因为固定开销会吞掉你省下来的 MAC**：每个 tile 都要重新配置 DMA、处理边界零填充、切 cache line、回写输出偏移。若输出 tile 面积从 `32x32` 再切成 `16x16`，MAC 虽然同步减少，但 `N_tile` 却翻倍，`T_fill/T_drain/descriptor` 开销也跟着翻倍。调 tile 大小，本质上是在**halo 冗余**与**调度固定损耗**之间找平衡点。

- **总线冲突会把纸面上的并行重叠重新打回串行**：输入 DMA、输出 DMA、CPU/NPU 取权重、cache 回填，很多时候都在抢同一条 AXI/AHB 路。只要输入预取与权重读取落在同一 SRAM bank 或外部 PSRAM 窗口，`T_in` 就会被动拉长，表面上看像“DMA 够快”，实际上是**共享互连上的背压**在吞吞吐吐。流水是否成立，不只取决于代码逻辑，更取决于物理存储拓扑。

- **padding 语义必须在每个 tile 上重新兑现，而不能假设整图语义自动继承**：整图卷积里的 `same padding` 到 tile 世界里，会变成“边界 tile 的一部分输入来自真实特征图，另一部分来自逻辑零值”。如果软件偷懒，把 tile 当成连续内存直接搬，不单独填充左/右/上/下缺失区域，边界输出就会在 tile 接缝上产生系统性亮缝或暗缝。YOLO 里这类错误常表现为目标框在网格边界附近跳动，而不是直接崩溃。

- **量化并没有消灭流水问题，反而让对齐和回写更敏感**：`INT8` 把元素字节数降下来了，但 backend 常常仍需 `INT32` 累加与 scratch 展开。于是 `B_in_tile` 变小了，`B_scratch` 却不一定同步变小。再加上很多 SIMD/NPU 要求通道数按 `8/16/32` 对齐，名义上 `C=24` 的层，在片上实际上可能按 `32` 通道记账。省下来的，不一定是你真正能回收的 SRAM。

- **帧级实时性取决于流水是否追得上相机，而不是某一层 benchmark 多漂亮**：若相机周期为 `T_cam`，整网处理时间为 `T_net`，则系统是否积压首先看 `T_net <= T_cam` 是否成立；一旦 `T_net > T_cam`，队列长度近似按  
  `Q[k+1] = max(0, Q[k] + 1 - T_cam / T_net)`  
  演化。工程上必须尽早决定是“丢最旧帧保低延迟”，还是“保每一帧但允许尾延迟变长”。这不是产品层决策，而是从第一层 tile 计划就该定好的系统合同。

- **真正成熟的 edge AI 代码不是把模型塞进 MCU，而是把时间也量化进了实现里**：输入何时到、哪一块 SRAM 先释放、何时允许复用 bank、输出何时必须完成回写，这些都应当像卷积核尺寸一样被显式编码。否则所谓“跑通”只是在一台机器、一次温度、一次输入分布下侥幸成立。

## 代码能力展现

下面给出一段基于 **STM32 HAL** 风格的 YOLO 卷积层 tile 流水骨架。代码刻意把重点放在四件真正决定能否时序闭合的事情上：

- 先从**输出 tile**反推**输入 tile + halo**；
- 再按双缓冲真实活跃数据估算**SRAM 占用**；
- 然后用 **DMA 预取 / backend 计算 / DMA 回写**三阶段做重叠；
- 最后在复用 bank 前显式等待上一笔事务完成，避免“逻辑正确、物理冲突”。

这段代码假设特征图按 **HWC** 连续存储，输入/输出激活为 `INT8`，卷积 backend 可以是 CMSIS-NN、自研 SIMD kernel 或外部 NPU 包装层。DMA 的二维拷贝细节在不同 STM32 系列上会对应 **MDMA / GPDMA / DMA2D 风格适配器**，因此这里把硬件相关部分收口到统一的 `Submit2dCopy()` 接口里，把文章重点留给几何、调度与边界控制本身。

```c
#include "stm32h7xx_hal.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define YOLO_PIPE_MAX_TILES               64U
#define YOLO_PIPE_ALIGN_BYTES             32U
#define YOLO_PIPE_MAX_IN_TILE_BYTES       32768U
#define YOLO_PIPE_MAX_OUT_TILE_BYTES      16384U
#define YOLO_PIPE_MAX_LAYER_TIMEOUT_US    200000U

typedef struct
{
    uint16_t in_w;
    uint16_t in_h;
    uint16_t in_c;

    uint16_t out_w;
    uint16_t out_h;
    uint16_t out_c;

    uint16_t kernel_w;
    uint16_t kernel_h;
    uint16_t stride_x;
    uint16_t stride_y;

    uint16_t pad_left;
    uint16_t pad_right;
    uint16_t pad_top;
    uint16_t pad_bottom;

    uint16_t out_tile_w;
    uint16_t out_tile_h;

    uint8_t input_zero_point;
    uint8_t output_zero_point;

    uint32_t backend_scratch_bytes;
    uint32_t layer_budget_us;
} YoloConvLayer_t;

typedef struct
{
    uint16_t out_x;
    uint16_t out_y;
    uint16_t out_w;
    uint16_t out_h;

    int32_t in_origin_x;
    int32_t in_origin_y;
    uint16_t in_logical_w;
    uint16_t in_logical_h;

    uint16_t valid_src_x;
    uint16_t valid_src_y;
    uint16_t valid_w;
    uint16_t valid_h;

    uint16_t dst_insert_x;
    uint16_t dst_insert_y;

    uint32_t in_tile_bytes;
    uint32_t out_tile_bytes;
} YoloTileDesc_t;

typedef struct
{
    DMA_HandleTypeDef *hdma;
    const uint8_t *src;
    uint8_t *dst;
    uint32_t src_stride_bytes;
    uint32_t dst_stride_bytes;
    uint16_t row_bytes;
    uint16_t row_count;
    bool active;
} Yolo2dCopyJob_t;

typedef bool (*YoloBackendTileFn)(const YoloConvLayer_t *layer,
                                  const YoloTileDesc_t *tile,
                                  const int8_t *tile_input,
                                  int8_t *tile_output);

typedef struct
{
    DMA_HandleTypeDef *hdma_in;
    DMA_HandleTypeDef *hdma_out;
    TIM_HandleTypeDef *htim_us;
    YoloBackendTileFn backend_fn;

    int8_t in_bank[2][YOLO_PIPE_MAX_IN_TILE_BYTES];
    int8_t out_bank[2][YOLO_PIPE_MAX_OUT_TILE_BYTES];

    Yolo2dCopyJob_t in_job[2];
    Yolo2dCopyJob_t out_job[2];
} YoloPipeContext_t;

static uint16_t YoloPipe_MinU16(uint16_t a, uint16_t b)
{
    return (a < b) ? a : b;
}

static uint16_t YoloPipe_ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static uint32_t YoloPipe_ClampU32(uint32_t value, uint32_t min_value, uint32_t max_value)
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

static uint32_t YoloPipe_AlignUpU32(uint32_t value, uint32_t align_bytes)
{
    return (value + align_bytes - 1U) / align_bytes * align_bytes;
}

static uint32_t YoloPipe_ElapsedUs(const TIM_HandleTypeDef *htim, uint32_t start_tick)
{
    return __HAL_TIM_GET_COUNTER(htim) - start_tick;
}

/**
 * @brief 从输出 tile 反推出输入 tile 的逻辑范围、有效拷贝窗口和片上字节数。
 * @param layer 当前卷积层几何参数。
 * @param out_x 输出 tile 左上角 x（单位：输出像素）。
 * @param out_y 输出 tile 左上角 y（单位：输出像素）。
 * @param out_w 输出 tile 实际宽度，边缘 tile 可能小于配置值。
 * @param out_h 输出 tile 实际高度，边缘 tile 可能小于配置值。
 * @param out_tile [out] 输出 tile 描述。
 * @retval true  成功。
 * @retval false 参数非法。
 *
 * @note 对卷积层，输出 tile `(W_to, H_to)` 对应的输入逻辑跨度满足：
 *       `W_ti = (W_to - 1) * Sx + Kx`
 *       `H_ti = (H_to - 1) * Sy + Ky`
 *
 *       输入逻辑原点则为：
 *       `x_in_origin = out_x * Sx - pad_left`
 *       `y_in_origin = out_y * Sy - pad_top`
 *
 *       其中超出真实特征图边界的部分不从外存搬运，而是在片上缓冲中填 `input_zero_point`，
 *       这正是 tile 级 same-padding 语义得以成立的关键。
 */
static bool YoloPipe_DescribeTile(const YoloConvLayer_t *layer,
                                  uint16_t out_x,
                                  uint16_t out_y,
                                  uint16_t out_w,
                                  uint16_t out_h,
                                  YoloTileDesc_t *out_tile)
{
    int32_t logical_x0;
    int32_t logical_y0;
    int32_t logical_x1;
    int32_t logical_y1;
    int32_t clipped_x0;
    int32_t clipped_y0;
    int32_t clipped_x1;
    int32_t clipped_y1;

    if ((layer == NULL) || (out_tile == NULL) || (out_w == 0U) || (out_h == 0U))
    {
        return false;
    }

    logical_x0 = (int32_t)out_x * (int32_t)layer->stride_x - (int32_t)layer->pad_left;
    logical_y0 = (int32_t)out_y * (int32_t)layer->stride_y - (int32_t)layer->pad_top;

    logical_x1 = logical_x0 + (int32_t)((out_w - 1U) * layer->stride_x + layer->kernel_w);
    logical_y1 = logical_y0 + (int32_t)((out_h - 1U) * layer->stride_y + layer->kernel_h);

    clipped_x0 = (logical_x0 < 0) ? 0 : logical_x0;
    clipped_y0 = (logical_y0 < 0) ? 0 : logical_y0;
    clipped_x1 = (logical_x1 > (int32_t)layer->in_w) ? (int32_t)layer->in_w : logical_x1;
    clipped_y1 = (logical_y1 > (int32_t)layer->in_h) ? (int32_t)layer->in_h : logical_y1;

    out_tile->out_x = out_x;
    out_tile->out_y = out_y;
    out_tile->out_w = out_w;
    out_tile->out_h = out_h;

    out_tile->in_origin_x = logical_x0;
    out_tile->in_origin_y = logical_y0;
    out_tile->in_logical_w = (uint16_t)(logical_x1 - logical_x0);
    out_tile->in_logical_h = (uint16_t)(logical_y1 - logical_y0);

    out_tile->valid_src_x = (uint16_t)clipped_x0;
    out_tile->valid_src_y = (uint16_t)clipped_y0;
    out_tile->valid_w = (uint16_t)((clipped_x1 > clipped_x0) ? (clipped_x1 - clipped_x0) : 0);
    out_tile->valid_h = (uint16_t)((clipped_y1 > clipped_y0) ? (clipped_y1 - clipped_y0) : 0);

    out_tile->dst_insert_x = (uint16_t)(clipped_x0 - logical_x0);
    out_tile->dst_insert_y = (uint16_t)(clipped_y0 - logical_y0);

    out_tile->in_tile_bytes = YoloPipe_AlignUpU32(
        (uint32_t)out_tile->in_logical_w * (uint32_t)out_tile->in_logical_h * (uint32_t)layer->in_c,
        YOLO_PIPE_ALIGN_BYTES);

    out_tile->out_tile_bytes = YoloPipe_AlignUpU32(
        (uint32_t)out_tile->out_w * (uint32_t)out_tile->out_h * (uint32_t)layer->out_c,
        YOLO_PIPE_ALIGN_BYTES);

    return true;
}

/**
 * @brief 为整层生成 tile 列表，并在生成过程中完成 SRAM 上界检查。
 * @param layer 当前卷积层配置。
 * @param tiles [out] tile 描述数组。
 * @param tile_count [out] 生成出的 tile 数量。
 * @retval true  规划成功，且单 tile SRAM 未越上界。
 * @retval false tile 数过多，或单 tile 片上占用超限。
 *
 * @note 双缓冲稳态下，片上同时活着的数据近似为：
 *       `B_total ≈ 2 * B_in_tile + 2 * B_out_tile + B_scratch + B_guard`
 *
 *       本函数逐 tile 检查：
 *       - `B_in_tile <= YOLO_PIPE_MAX_IN_TILE_BYTES`
 *       - `B_out_tile <= YOLO_PIPE_MAX_OUT_TILE_BYTES`
 *
 *       真正系统接入时，还应再核对：`2 * Bin + 2 * Bout + scratch` 是否与整机 SRAM 预算一致。
 */
static bool YoloPipe_BuildTilePlan(const YoloConvLayer_t *layer,
                                   YoloTileDesc_t *tiles,
                                   uint16_t *tile_count)
{
    uint16_t ty;
    uint16_t tx;
    uint16_t count = 0U;

    if ((layer == NULL) || (tiles == NULL) || (tile_count == NULL))
    {
        return false;
    }

    for (ty = 0U; ty < layer->out_h; ty = (uint16_t)(ty + layer->out_tile_h))
    {
        const uint16_t out_h = YoloPipe_MinU16(layer->out_tile_h, (uint16_t)(layer->out_h - ty));

        for (tx = 0U; tx < layer->out_w; tx = (uint16_t)(tx + layer->out_tile_w))
        {
            const uint16_t out_w = YoloPipe_MinU16(layer->out_tile_w, (uint16_t)(layer->out_w - tx));

            if (count >= YOLO_PIPE_MAX_TILES)
            {
                return false;
            }

            if (!YoloPipe_DescribeTile(layer, tx, ty, out_w, out_h, &tiles[count]))
            {
                return false;
            }

            if ((tiles[count].in_tile_bytes > YOLO_PIPE_MAX_IN_TILE_BYTES) ||
                (tiles[count].out_tile_bytes > YOLO_PIPE_MAX_OUT_TILE_BYTES))
            {
                return false;
            }

            ++count;
        }
    }

    *tile_count = count;
    return true;
}

/**
 * @brief 提交一笔二维 DMA 拷贝任务。
 * @param job [out] DMA 任务句柄。
 * @param hdma HAL DMA 句柄。
 * @param src 源地址。
 * @param dst 目标地址。
 * @param src_stride_bytes 源行跨度。
 * @param dst_stride_bytes 目标行跨度。
 * @param row_bytes 每一行有效字节数。
 * @param row_count 行数。
 * @retval HAL 状态码。
 *
 * @note 不同 STM32 系列的 2D 复制写法不同：
 *       - H7 可映射到 MDMA repeat block / linked list；
 *       - U5/H5 可映射到 GPDMA block repeat；
 *       - 若硬件只有 1D DMA，则可退化为“每行一笔 DMA”的小状态机。
 *
 *       这里把硬件差异都收口到一个适配器里，使上层流水逻辑只关心
 *       “这笔搬运是否已经在后台进行”，而不关心底层具体是哪种 DMA。
 */
static HAL_StatusTypeDef YoloPipe_Submit2dCopy(Yolo2dCopyJob_t *job,
                                               DMA_HandleTypeDef *hdma,
                                               const uint8_t *src,
                                               uint8_t *dst,
                                               uint32_t src_stride_bytes,
                                               uint32_t dst_stride_bytes,
                                               uint16_t row_bytes,
                                               uint16_t row_count)
{
    if ((job == NULL) || (hdma == NULL) || (src == NULL) || (dst == NULL) ||
        (row_bytes == 0U) || (row_count == 0U))
    {
        return HAL_ERROR;
    }

    job->hdma = hdma;
    job->src = src;
    job->dst = dst;
    job->src_stride_bytes = src_stride_bytes;
    job->dst_stride_bytes = dst_stride_bytes;
    job->row_bytes = row_bytes;
    job->row_count = row_count;
    job->active = true;

    /* 这里省略具体的 MDMA/GPDMA 配置细节，只保留上层接口。
     * 实际平台适配时，应在此处提交真正的二维后台搬运。
     */
    return HAL_OK;
}

/**
 * @brief 等待一笔二维 DMA 拷贝完成。
 * @param job DMA 任务句柄。
 * @param timeout_ms 超时，单位 ms。
 * @retval HAL_OK      任务完成。
 * @retval HAL_TIMEOUT 超时未完成。
 * @retval HAL_ERROR   参数非法。
 *
 * @note 工程实现里可以映射到：
 *       - `HAL_MDMA_PollForTransfer()`
 *       - 等待 DMA TC flag
 *       - 或 RTOS 事件组 / 信号量
 *
 *       本文重点是 tile 调度骨架，因此硬件等待细节统一收口在这里。
 */
static HAL_StatusTypeDef YoloPipe_Wait2dCopy(Yolo2dCopyJob_t *job, uint32_t timeout_ms)
{
    uint32_t start_ms = HAL_GetTick();

    if (job == NULL)
    {
        return HAL_ERROR;
    }

    while (job->active)
    {
        /* 平台适配层应在后台 DMA 完成后把 active 清零。
         * 这里保留轮询骨架，便于与实际 HAL 项目整合。
         */
        if ((HAL_GetTick() - start_ms) > timeout_ms)
        {
            return HAL_TIMEOUT;
        }
    }

    return HAL_OK;
}

/**
 * @brief 把带 halo 的输入 tile 预取到片上 bank，并先完成 zero-point 填充。
 * @param ctx 流水上下文。
 * @param layer 当前卷积层配置。
 * @param src_ext 外部输入特征图首地址（HWC 连续）。
 * @param tile 当前 tile 描述。
 * @param bank 目标 bank，0 或 1。
 * @retval HAL 状态码。
 *
 * @note 片上 tile 先整体填 `input_zero_point`，再只 DMA 有效矩形区域。
 *       这样即使 tile 落在整图边界，padding 区域也自动满足卷积语义。
 *
 *       输入 bank 行跨度为：
 *       `dst_stride = in_logical_w * C_in`
 *
 *       外部源特征图行跨度为：
 *       `src_stride = in_w * C_in`
 */
static HAL_StatusTypeDef YoloPipe_PreloadInputTile(YoloPipeContext_t *ctx,
                                                   const YoloConvLayer_t *layer,
                                                   const int8_t *src_ext,
                                                   const YoloTileDesc_t *tile,
                                                   uint8_t bank)
{
    uint8_t *dst_bank;
    uint32_t dst_stride_bytes;
    uint32_t src_stride_bytes;
    uint32_t dst_offset_bytes;
    uint32_t src_offset_bytes;

    if ((ctx == NULL) || (layer == NULL) || (src_ext == NULL) || (tile == NULL) || (bank > 1U))
    {
        return HAL_ERROR;
    }

    dst_bank = (uint8_t *)ctx->in_bank[bank];
    memset(dst_bank, layer->input_zero_point, tile->in_tile_bytes);

    if ((tile->valid_w == 0U) || (tile->valid_h == 0U))
    {
        ctx->in_job[bank].active = false;
        return HAL_OK;
    }

    dst_stride_bytes = (uint32_t)tile->in_logical_w * (uint32_t)layer->in_c;
    src_stride_bytes = (uint32_t)layer->in_w * (uint32_t)layer->in_c;

    dst_offset_bytes = ((uint32_t)tile->dst_insert_y * (uint32_t)tile->in_logical_w +
                        (uint32_t)tile->dst_insert_x) * (uint32_t)layer->in_c;

    src_offset_bytes = ((uint32_t)tile->valid_src_y * (uint32_t)layer->in_w +
                        (uint32_t)tile->valid_src_x) * (uint32_t)layer->in_c;

    return YoloPipe_Submit2dCopy(&ctx->in_job[bank],
                                 ctx->hdma_in,
                                 (const uint8_t *)&src_ext[src_offset_bytes],
                                 &dst_bank[dst_offset_bytes],
                                 src_stride_bytes,
                                 dst_stride_bytes,
                                 (uint16_t)((uint32_t)tile->valid_w * (uint32_t)layer->in_c),
                                 tile->valid_h);
}

/**
 * @brief 将输出 tile 从片上 bank 回写到外部特征图。
 * @param ctx 流水上下文。
 * @param layer 当前卷积层配置。
 * @param dst_ext 外部输出特征图首地址（HWC 连续）。
 * @param tile 当前 tile 描述。
 * @param bank 输出 bank，0 或 1。
 * @retval HAL 状态码。
 *
 * @note 输出行跨度为：
 *       `src_stride = out_w_tile * C_out`
 *       `dst_stride = out_w * C_out`
 *
 *       输出 tile 不需要像输入那样做 halo 填充，因为输出平面本身已经是合法采样结果。
 */
static HAL_StatusTypeDef YoloPipe_CommitOutputTile(YoloPipeContext_t *ctx,
                                                   const YoloConvLayer_t *layer,
                                                   int8_t *dst_ext,
                                                   const YoloTileDesc_t *tile,
                                                   uint8_t bank)
{
    uint32_t src_stride_bytes;
    uint32_t dst_stride_bytes;
    uint32_t dst_offset_bytes;

    if ((ctx == NULL) || (layer == NULL) || (dst_ext == NULL) || (tile == NULL) || (bank > 1U))
    {
        return HAL_ERROR;
    }

    src_stride_bytes = (uint32_t)tile->out_w * (uint32_t)layer->out_c;
    dst_stride_bytes = (uint32_t)layer->out_w * (uint32_t)layer->out_c;

    dst_offset_bytes = ((uint32_t)tile->out_y * (uint32_t)layer->out_w +
                        (uint32_t)tile->out_x) * (uint32_t)layer->out_c;

    return YoloPipe_Submit2dCopy(&ctx->out_job[bank],
                                 ctx->hdma_out,
                                 (const uint8_t *)ctx->out_bank[bank],
                                 (uint8_t *)&dst_ext[dst_offset_bytes],
                                 src_stride_bytes,
                                 dst_stride_bytes,
                                 (uint16_t)src_stride_bytes,
                                 tile->out_h);
}

/**
 * @brief 以双缓冲方式处理整层卷积 tile。
 * @param ctx 流水上下文，持有 DMA 句柄、计时器与 ping-pong bank。
 * @param layer 当前卷积层配置。
 * @param src_ext 外部输入特征图首地址。
 * @param dst_ext 外部输出特征图首地址。
 * @retval true  整层按预算完成。
 * @retval false 任一 tile 规划失败、DMA 超时或超出层预算。
 *
 * @note 稳态调度顺序如下：
 *       1. 先预取 tile0 到 bank0；
 *       2. 计算 tile_k 时，同时预取 tile_{k+1} 到另一个 bank；
 *       3. 计算结束立刻把 tile_k 输出回写；
 *       4. 在复用某个 bank 前，必须等待该 bank 关联的上一次回写结束。
 *
 *       若 `T_in / T_compute / T_out` 三段能良好重叠，则整层时延接近：
 *       `T_layer ≈ T_fill + N_tile * max(T_in, T_compute, T_out) + T_drain`
 */
bool YoloPipe_ProcessLayer(YoloPipeContext_t *ctx,
                           const YoloConvLayer_t *layer,
                           const int8_t *src_ext,
                           int8_t *dst_ext)
{
    YoloTileDesc_t tiles[YOLO_PIPE_MAX_TILES];
    uint16_t tile_count = 0U;
    uint16_t tile_idx = 0U;
    uint32_t start_us;

    if ((ctx == NULL) || (layer == NULL) || (src_ext == NULL) || (dst_ext == NULL) ||
        (ctx->backend_fn == NULL) || (ctx->htim_us == NULL))
    {
        return false;
    }

    if (!YoloPipe_BuildTilePlan(layer, tiles, &tile_count))
    {
        return false;
    }

    start_us = __HAL_TIM_GET_COUNTER(ctx->htim_us);

    if (YoloPipe_PreloadInputTile(ctx, layer, src_ext, &tiles[0], 0U) != HAL_OK)
    {
        return false;
    }

    if (YoloPipe_Wait2dCopy(&ctx->in_job[0], 5U) != HAL_OK)
    {
        return false;
    }

    for (tile_idx = 0U; tile_idx < tile_count; ++tile_idx)
    {
        const uint8_t bank = (uint8_t)(tile_idx & 0x1U);
        const uint8_t next_bank = (uint8_t)(bank ^ 0x1U);

        if (tile_idx >= 2U)
        {
            /* bank 两轮后复用；在覆盖旧输出前，先确认上一笔回写已经完成。 */
            if (YoloPipe_Wait2dCopy(&ctx->out_job[bank], 5U) != HAL_OK)
            {
                return false;
            }
        }

        if ((tile_idx + 1U) < tile_count)
        {
            if (YoloPipe_PreloadInputTile(ctx, layer, src_ext, &tiles[tile_idx + 1U], next_bank) != HAL_OK)
            {
                return false;
            }
        }

        memset(ctx->out_bank[bank], layer->output_zero_point, tiles[tile_idx].out_tile_bytes);

        if (!ctx->backend_fn(layer,
                             &tiles[tile_idx],
                             ctx->in_bank[bank],
                             ctx->out_bank[bank]))
        {
            return false;
        }

        if (YoloPipe_CommitOutputTile(ctx, layer, dst_ext, &tiles[tile_idx], bank) != HAL_OK)
        {
            return false;
        }

        if ((tile_idx + 1U) < tile_count)
        {
            /* 下一轮要读取 next_bank 做计算，因此必须保证预取已经落地。 */
            if (YoloPipe_Wait2dCopy(&ctx->in_job[next_bank], 5U) != HAL_OK)
            {
                return false;
            }
        }

        if (YoloPipe_ElapsedUs(ctx->htim_us, start_us) >
            YoloPipe_ClampU32(layer->layer_budget_us, 1000U, YOLO_PIPE_MAX_LAYER_TIMEOUT_US))
        {
            return false;
        }
    }

    if (YoloPipe_Wait2dCopy(&ctx->out_job[(tile_count - 1U) & 0x1U], 5U) != HAL_OK)
    {
        return false;
    }

    if ((tile_count > 1U) &&
        (YoloPipe_Wait2dCopy(&ctx->out_job[((tile_count - 2U) & 0x1U)], 5U) != HAL_OK))
    {
        return false;
    }

    return true;
}

/**
 * @brief 示例：为 YOLO 某个 3x3 stride=1 层配置 tile 参数。
 * @param ctx 流水上下文。
 * @param src_ext 外部输入特征图。
 * @param dst_ext 外部输出特征图。
 * @retval true 成功。
 * @retval false 失败。
 *
 * @note 这里显式展示 tile 预算是如何被层配置决定的：
 *       - 输入 `80x80x32`
 *       - 输出 `80x80x64`
 *       - 输出 tile 取 `16x12`
 *
 *       则逻辑输入 tile 约为：
 *       `W_ti = (16 - 1) * 1 + 3 = 18`
 *       `H_ti = (12 - 1) * 1 + 3 = 14`
 *
 *       片上输入字节约为：
 *       `18 * 14 * 32 = 8064 byte`
 *
 *       单 tile 输出字节约为：
 *       `16 * 12 * 64 = 12288 byte`
 *
 *       因而若输出 bank 上限只有 16 KB，就必须继续调小 `out_tile_w/h`，
 *       这正是“由 SRAM 反推 tile 形状”的工程思路。
 */
bool App_RunYoloConvStage(YoloPipeContext_t *ctx, const int8_t *src_ext, int8_t *dst_ext)
{
    YoloConvLayer_t layer =
    {
        .in_w = 80U,
        .in_h = 80U,
        .in_c = 32U,
        .out_w = 80U,
        .out_h = 80U,
        .out_c = 64U,
        .kernel_w = 3U,
        .kernel_h = 3U,
        .stride_x = 1U,
        .stride_y = 1U,
        .pad_left = 1U,
        .pad_right = 1U,
        .pad_top = 1U,
        .pad_bottom = 1U,
        .out_tile_w = 16U,
        .out_tile_h = 12U,
        .input_zero_point = 0U,
        .output_zero_point = 0U,
        .backend_scratch_bytes = 4096U,
        .layer_budget_us = 4000U
    };

    return YoloPipe_ProcessLayer(ctx, &layer, src_ext, dst_ext);
}
```

这段代码真正想强调的，不是“STM32 HAL 也能排 tile”，而是三条更底层的工程结论：

- **tile 计划必须从输出几何倒推输入 halo，而不是从“我手头还有多少 SRAM”正向拍脑袋切块**。几何关系错了，接缝一定出错。
- **双缓冲的正确姿势不是简单准备两个数组，而是显式管理“何时预取、何时计算、何时回写、何时允许复用 bank”**。少任何一步，都会把纸面并行退化成总线互锁。
- **实时性优化最终要落在 `max(T_in, T_compute, T_out)` 这条最慢腿上**。如果最慢的是回写，继续优化卷积没有意义；如果最慢的是预取，再高效的 kernel 也会在等数据。

继续沿着这条线深挖，下一步通常不再是“把模型再剪一点”，而是去审视更底层的系统契约：特征图布局是否适合 DMA、权重预取和输入预取是否抢同一条总线、某些层是否值得改成更窄通道或更大 stride、以及当 `T_net` 偶尔超过 `T_cam` 时，你究竟准备丢帧、降分辨率，还是容忍控制闭环吃到更老的世界。只有这些问题被一起写进实现里，YOLO 的边缘部署才不再是“模型勉强落地”，而是真正完成了一次从算子到时序的工程闭环。
