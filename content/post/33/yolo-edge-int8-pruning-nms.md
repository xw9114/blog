---
title: "技能档案：YOLO 边缘端部署的硬约束，从 INT8 量化到 NMS 尾延迟预算"
slug: "skill-yolo-edge-int8-pruning-and-nms-budget"
date: 2026-05-06T10:11:17+08:00
draft: false
description: "从特征图带宽、结构化通道剪枝、INT8 量化映射到候选框解码与 NMS 尾延迟预算，系统拆解 YOLO 为什么在边缘端首先受制于内存与时序，而不是模型名气。"
tags: ["STM32", "YOLO", "Edge AI", "INT8量化", "NMS"]
categories: ["技能档案"]
image: ""
---

## 技能概述

YOLO 落在边缘端时，真正困难的往往不是把模型导出成 `onnx`、`tflite` 或某家 NPU 的专有格式，而是把相机曝光、特征图搬运、量化误差、片上 SRAM 上限与后处理尾延迟一并压进一个有限帧周期里。很多项目看起来“模型已经能跑”，最后却死在 `letterbox` 变换、候选框解码、`INT8` 反量化和 `NMS` 的最坏时延上。边缘部署的核心痛点，不是 API 能不能调起来，而是系统是否真的能在可控误差内，稳定完成每一帧从光子到框的闭环。

## 核心底层概念解析

- **边缘视觉首先受制于时间，不受制于框架名气**：一帧检测延迟不是单个推理算子的时间，而是 `T_total = T_exp + T_dma + T_pre + T_infer + T_post + T_act`。其中 `T_exp` 是相机曝光，`T_dma` 是图像进内存，`T_pre` 是缩放与归一化，`T_infer` 是卷积主干，`T_post` 是解码与 `NMS`，`T_act` 是控制或告警执行。系统看到的不是“当前世界”，而是 `T_total` 之前的世界，延迟一旦接近目标运动时间常数，检测再准也会显得迟钝。
- **参数量不是主敌，特征图带宽才经常是**：卷积的计算量大致满足 `MAC ≈ H * W * C_in * C_out * K^2`，但边缘端的真实瓶颈很多时候是激活张量搬运，近似可写成 `Bytes_act ≈ Σ(H_l * W_l * C_l * b)`，其中 `b` 为每元素字节数。参数量变小只说明 Flash 占用下降，若中间特征图仍巨大，SRAM 与 AXI 带宽照样会把系统拖住。
- **轻量化的本质不是“删参数”，而是删掉不会再被下游读取的通道**：非结构化稀疏虽然理论上让权重更多为零，但在 MCU、DSP 或小型 NPU 上往往难以转成真实加速，因为访存仍按稠密张量进行。只有**结构化通道剪枝**这类直接减少 `C_in / C_out` 的做法，才能同时压低卷积 `MAC`、中间特征图尺寸与后续 1x1 卷积的搬运成本。
- **量化不是把 `float` 改成 `int8` 这么朴素，它是一次有损坐标映射**：最常见的仿射量化满足 `x_real ≈ scale * (x_q - zero_point)`。如果校准阶段让少数异常大值主导了 `scale`，那大部分常见小值就会被压缩进很少的量化台阶里，信息分辨率直接下降。量化误差不是随机白噪声，而是和数据分布、截断策略、层位置强耦合的系统性误差。
- **INT8 的收益来自计算与带宽双降，但前提是量纲真的被对齐**：卷积累计通常先在 `int32` 域完成，再映射回输出量化域。其近似关系可写为 `y_q = clamp(round(acc_int32 * (s_x * s_w / s_y)) + z_y)`。其中 `s_x`、`s_w`、`s_y` 分别为输入、权重与输出缩放因子。只要这组比例失配，哪怕网络拓扑没变，激活分布也会飘，最终表现为置信度塌陷或框尺度异常。
- **权重量化和激活量化不该被等同对待**：权重可离线量化，且常用**按通道量化**，因为每个输出通道的动态范围差异很大；激活则更常使用**按张量量化**，因为运行时切换通道级缩放会增加额外控制与访存成本。边缘系统不是追求最漂亮的论文指标，而是在误差、代码复杂度与硬件调度之间做可实现折中。
- **候选框阈值最好尽量在量化域里完成预筛，而不是全部反量化后再判断**：若对象性分支输出的是 logit，则目标概率阈值 `p_thr` 可先映射成 `l_thr = ln(p_thr / (1 - p_thr))`，再量化为 `q_thr = round(l_thr / scale + zero_point)`。这样就能在 `int8` 域里先丢弃大量低价值格点，避免 MCU 把时间浪费在无意义的 `sigmoid`、`exp` 和 `IoU` 上。
- **YOLO 的后处理常常是尾延迟黑洞，而不是“小尾巴”**：卷积部分可能交给 NPU，MCU 最后却还要自己完成框解码、排序和 `NMS`。如果候选框数为 `N`，朴素 `NMS` 复杂度近似 `O(N^2)`。这意味着平均帧很快，不代表最坏帧也快；而工程系统最怕的恰恰是少数“目标很多”的帧把实时链路拖穿。
- **`letterbox` 不是视觉前处理细节，而是几何坐标系变换**：假设原图尺寸为 `(W_f, H_f)`，模型输入为 `(W_in, H_in)`，缩放系数 `s = min(W_in / W_f, H_in / H_f)`，左右与上下填充分别为 `pad_x`、`pad_y`。那么输入平面上的点 `(u_in, v_in)` 映射回原图需满足 `u_f = (u_in - pad_x) / s`、`v_f = (v_in - pad_y) / s`。如果这一层几何回映做错，后面再精妙的 `NMS` 也只是在错误坐标系里做精细计算。
- **量化误差、插值误差和裁剪误差会串联，而不是彼此独立**：图像缩放把高频细节压到有限像素格点，量化再把连续值压到有限台阶，通道剪枝则进一步减少表示自由度。最终精度损失并不是三者简单相加，而是会在小目标、低对比度目标和密集目标场景中相互放大。
- **边缘端真正要优化的是最坏情况的资源上界**：工程系统不会因为“平均 12 ms”而安全，只有在 `max(T_total)` 被控制住时，控制链路和告警链路才可信。因此结构化剪枝、候选框 Top-K、量化域预筛与时间预算截断，本质上都不是“偷精度”，而是在给系统建立一个可证明的时序边界。
- **边缘 AI 不是把云端模型缩小，而是重新谈判数字世界与物理世界的合同**：模型名义精度告诉你它“看见了什么”，而部署时序告诉你它“何时看见”。在嵌入式系统里，晚到的正确答案和准时到达的近似答案，后者往往更有工程价值。

## 代码能力展现

下面给出一个基于 STM32 HAL 的 YOLO 单检测头后处理示例。代码假定卷积主干已经由 NPU、DSP 或外部加速器完成，MCU 负责**量化域预筛、边界限幅的反量化解码、Top-K 候选框保留，以及带微秒预算的 `NMS`**。这样做的重点不是“在 MCU 上重写整套神经网络”，而是把真正容易失控的尾部时序收回来。

```c
#include "stm32f4xx_hal.h"
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define YOLO_EDGE_MAX_CLASSES       8U
#define YOLO_EDGE_MAX_PROPOSALS     48U
#define YOLO_EDGE_MAX_KEEP          12U
#define YOLO_EDGE_BOX_COMPONENTS    5U   /* tx, ty, tw, th, obj */

typedef struct
{
    uint16_t model_input_w;
    uint16_t model_input_h;
    uint16_t frame_w;
    uint16_t frame_h;
    uint16_t grid_w;
    uint16_t grid_h;
    uint16_t stride_px;
    uint16_t class_count;
    float anchor_w_px;
    float anchor_h_px;
    float box_scale;
    int32_t box_zero_point;
    float obj_scale;
    int32_t obj_zero_point;
    float cls_scale;
    int32_t cls_zero_point;
    float objectness_gate;
    float score_threshold;
    float iou_threshold;
    uint16_t max_proposals;
    uint16_t max_keep;
    uint32_t postprocess_budget_us;
    TIM_HandleTypeDef *budget_timer; /* 1 MHz 自由运行定时器。 */
} YoloEdgeConfig_t;

typedef struct
{
    float x1;
    float y1;
    float x2;
    float y2;
    float score;
    uint8_t class_id;
    bool suppressed;
} YoloProposal_t;

typedef struct
{
    YoloProposal_t proposals[YOLO_EDGE_MAX_PROPOSALS];
    uint16_t proposal_count;
    uint16_t keep_count;
    uint32_t elapsed_us;
    bool budget_exceeded;
} YoloEdgeResult_t;

static float YoloEdge_ClampFloat(float value, float min_value, float max_value)
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

static uint16_t YoloEdge_ClampU16(uint16_t value, uint16_t min_value, uint16_t max_value)
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

static uint32_t YoloEdge_ReadUs(const TIM_HandleTypeDef *timer)
{
    return __HAL_TIM_GET_COUNTER(timer);
}

static uint32_t YoloEdge_ElapsedUs(uint32_t start_us, uint32_t now_us)
{
    /* 无符号减法天然兼容计数器回卷。前提是 budget 远小于 2^32 us。 */
    return now_us - start_us;
}

/**
 * @brief 将实数概率阈值映射为量化 logit 阈值，便于在 int8 域预筛。
 * @param probability 概率阈值，范围 (0, 1)。
 * @param scale 对象性分支的量化 scale。
 * @param zero_point 对象性分支的量化零点。
 * @retval 可直接与 int8 logit 比较的阈值。
 *
 * @note 若对象性分支输出为 logit，则:
 *       logit(p) = ln(p / (1 - p))
 *       q_thr = round(logit(p_thr) / scale + zero_point)
 *       这样能在反量化之前先砍掉大量低价值格点，减少后续 sigmoid 与 NMS 负担。
 */
static int8_t YoloEdge_QuantizeLogitThreshold(float probability, float scale, int32_t zero_point)
{
    const float p = YoloEdge_ClampFloat(probability, 0.01f, 0.99f);
    const float logit = logf(p / (1.0f - p));
    float q = 0.0f;

    if (scale <= 1.0e-7f)
    {
        return 127;
    }

    q = roundf(logit / scale) + (float)zero_point;
    q = YoloEdge_ClampFloat(q, -128.0f, 127.0f);
    return (int8_t)q;
}

/**
 * @brief 将 int8 量化值恢复为实数。
 * @param q 量化整数。
 * @param scale 缩放因子。
 * @param zero_point 零点。
 * @retval 实数近似值。
 *
 * @note 仿射量化关系:
 *       x_real ≈ scale * (x_q - zero_point)
 *       scale 越小，步距越细；但若被异常值拖大，常见值会挤在更少台阶里。
 */
static float YoloEdge_DequantizeI8(int8_t q, float scale, int32_t zero_point)
{
    return scale * ((float)q - (float)zero_point);
}

static float YoloEdge_SigmoidFast(float x)
{
    const float limited = YoloEdge_ClampFloat(x, -8.0f, 8.0f);
    return 1.0f / (1.0f + expf(-limited));
}

static float YoloEdge_IoU(const YoloProposal_t *a, const YoloProposal_t *b)
{
    const float inter_x1 = (a->x1 > b->x1) ? a->x1 : b->x1;
    const float inter_y1 = (a->y1 > b->y1) ? a->y1 : b->y1;
    const float inter_x2 = (a->x2 < b->x2) ? a->x2 : b->x2;
    const float inter_y2 = (a->y2 < b->y2) ? a->y2 : b->y2;
    const float inter_w = YoloEdge_ClampFloat(inter_x2 - inter_x1, 0.0f, 1.0e9f);
    const float inter_h = YoloEdge_ClampFloat(inter_y2 - inter_y1, 0.0f, 1.0e9f);
    const float inter_area = inter_w * inter_h;
    const float area_a = YoloEdge_ClampFloat(a->x2 - a->x1, 0.0f, 1.0e9f) *
                         YoloEdge_ClampFloat(a->y2 - a->y1, 0.0f, 1.0e9f);
    const float area_b = YoloEdge_ClampFloat(b->x2 - b->x1, 0.0f, 1.0e9f) *
                         YoloEdge_ClampFloat(b->y2 - b->y1, 0.0f, 1.0e9f);
    const float union_area = area_a + area_b - inter_area;

    if (union_area <= 1.0e-7f)
    {
        return 0.0f;
    }

    return inter_area / union_area;
}

/**
 * @brief 将输入平面坐标映射回原始图像坐标。
 * @param cfg 检测头配置。
 * @param input_x 模型输入平面中的 x 坐标。
 * @param input_y 模型输入平面中的 y 坐标。
 * @param frame_x 输出原图 x 坐标。
 * @param frame_y 输出原图 y 坐标。
 *
 * @note 若采用 letterbox:
 *       s = min(W_in / W_f, H_in / H_f)
 *       pad_x = (W_in - W_f * s) / 2
 *       pad_y = (H_in - H_f * s) / 2
 *       则回原图坐标:
 *       x_f = (x_in - pad_x) / s
 *       y_f = (y_in - pad_y) / s
 */
static void YoloEdge_MapInputToFrame(const YoloEdgeConfig_t *cfg,
                                     float input_x,
                                     float input_y,
                                     float *frame_x,
                                     float *frame_y)
{
    const float sx = (float)cfg->model_input_w / (float)cfg->frame_w;
    const float sy = (float)cfg->model_input_h / (float)cfg->frame_h;
    const float scale = (sx < sy) ? sx : sy;
    const float pad_x = 0.5f * ((float)cfg->model_input_w - ((float)cfg->frame_w * scale));
    const float pad_y = 0.5f * ((float)cfg->model_input_h - ((float)cfg->frame_h * scale));

    *frame_x = (input_x - pad_x) / scale;
    *frame_y = (input_y - pad_y) / scale;
}

/**
 * @brief 将新候选框插入到按分数降序排列的固定容量缓冲区。
 * @param result 输出结果缓冲区。
 * @param candidate 待插入候选框。
 * @param capacity 允许保留的最大候选数。
 *
 * @note NMS 的复杂度近似 O(N^2)，因此这里先做 Top-K 截断。
 *       这不是“作弊”，而是在 MCU 上把最坏时延从无界拖回可预算区间。
 */
static void YoloEdge_InsertCandidate(YoloEdgeResult_t *result,
                                     const YoloProposal_t *candidate,
                                     uint16_t capacity)
{
    uint16_t count = result->proposal_count;
    uint16_t insert_pos = count;

    if ((capacity == 0U) || (candidate->score <= 0.0f))
    {
        return;
    }

    if ((count >= capacity) && (candidate->score <= result->proposals[count - 1U].score))
    {
        return;
    }

    if (count < capacity)
    {
        result->proposal_count++;
        count++;
    }

    while ((insert_pos > 0U) && (result->proposals[insert_pos - 1U].score < candidate->score))
    {
        if (insert_pos < capacity)
        {
            result->proposals[insert_pos] = result->proposals[insert_pos - 1U];
        }
        insert_pos--;
    }

    if (insert_pos < capacity)
    {
        result->proposals[insert_pos] = *candidate;
    }
}

/**
 * @brief 对按分数排序的候选框执行时间受限的 NMS。
 * @param cfg 检测头配置。
 * @param start_us 后处理起始时间戳。
 * @param result 候选框与输出结果。
 *
 * @note 朴素 NMS 的比较数近似为 N*(N-1)/2。
 *       这里给出预算截断，一旦 elapsed_us > postprocess_budget_us，
 *       就立即停止更深的两两比较，优先保住系统整体实时性。
 */
static void YoloEdge_RunNms(const YoloEdgeConfig_t *cfg,
                            uint32_t start_us,
                            YoloEdgeResult_t *result)
{
    const uint16_t proposal_count = result->proposal_count;
    const uint16_t keep_limit = YoloEdge_ClampU16(cfg->max_keep, 1U, YOLO_EDGE_MAX_KEEP);
    uint16_t keep_count = 0U;
    uint16_t i = 0U;
    uint16_t write_idx = 0U;

    for (i = 0U; i < proposal_count; ++i)
    {
        uint16_t j = 0U;

        if (YoloEdge_ElapsedUs(start_us, YoloEdge_ReadUs(cfg->budget_timer)) >= cfg->postprocess_budget_us)
        {
            result->budget_exceeded = true;
            break;
        }

        if (result->proposals[i].suppressed)
        {
            continue;
        }

        keep_count++;
        if (keep_count >= keep_limit)
        {
            break;
        }

        for (j = i + 1U; j < proposal_count; ++j)
        {
            const bool same_class = (result->proposals[i].class_id == result->proposals[j].class_id);

            if (YoloEdge_ElapsedUs(start_us, YoloEdge_ReadUs(cfg->budget_timer)) >= cfg->postprocess_budget_us)
            {
                result->budget_exceeded = true;
                break;
            }

            if ((!same_class) || (result->proposals[j].suppressed))
            {
                continue;
            }

            if (YoloEdge_IoU(&result->proposals[i], &result->proposals[j]) >= cfg->iou_threshold)
            {
                result->proposals[j].suppressed = true;
            }
        }

        if (result->budget_exceeded)
        {
            break;
        }
    }

    /* 将保留下来的框压缩到数组前部，便于业务层直接读取。 */
    for (i = 0U; i < proposal_count; ++i)
    {
        if (!result->proposals[i].suppressed)
        {
            result->proposals[write_idx++] = result->proposals[i];
            if (write_idx >= keep_limit)
            {
                break;
            }
        }
    }

    result->keep_count = write_idx;
}

/**
 * @brief 在 STM32 上执行 YOLO 单检测头的量化后处理。
 * @param head_tensor 格点张量，布局为 [grid_h][grid_w][tx,ty,tw,th,obj,cls...]
 * @param cfg 配置参数。
 * @param result 输出检测结果。
 * @retval true  正常完成扫描。
 * @retval false 参数非法或预算超时。
 *
 * @note 框解码使用典型 YOLO 关系:
 *       cx = (col + sigmoid(tx)) * stride
 *       cy = (row + sigmoid(ty)) * stride
 *       w  = anchor_w * exp(tw)
 *       h  = anchor_h * exp(th)
 *       score = sigmoid(obj) * sigmoid(cls_best)
 *       其中 tx/ty/tw/th、obj、cls 都先由 int8 反量化到实数域。
 */
bool YoloEdge_PostprocessSingleHead(const int8_t *head_tensor,
                                    const YoloEdgeConfig_t *cfg,
                                    YoloEdgeResult_t *result)
{
    const uint16_t class_count = YoloEdge_ClampU16(cfg->class_count, 1U, YOLO_EDGE_MAX_CLASSES);
    const uint16_t proposal_cap = YoloEdge_ClampU16(cfg->max_proposals, 1U, YOLO_EDGE_MAX_PROPOSALS);
    const uint16_t cell_stride = YOLO_EDGE_BOX_COMPONENTS + class_count;
    const int8_t obj_gate_q = YoloEdge_QuantizeLogitThreshold(cfg->objectness_gate,
                                                              cfg->obj_scale,
                                                              cfg->obj_zero_point);
    const uint32_t start_us = YoloEdge_ReadUs(cfg->budget_timer);
    uint16_t row = 0U;

    if ((head_tensor == NULL) || (cfg == NULL) || (result == NULL) || (cfg->budget_timer == NULL))
    {
        return false;
    }

    memset(result, 0, sizeof(*result));

    for (row = 0U; row < cfg->grid_h; ++row)
    {
        uint16_t col = 0U;

        for (col = 0U; col < cfg->grid_w; ++col)
        {
            const uint32_t cell_index = ((uint32_t)row * (uint32_t)cfg->grid_w) + (uint32_t)col;
            const uint32_t base = cell_index * (uint32_t)cell_stride;
            const int8_t obj_q = head_tensor[base + 4U];
            float obj_prob = 0.0f;
            float best_cls_prob = 0.0f;
            uint8_t best_cls_id = 0U;
            uint16_t cls = 0U;

            if (YoloEdge_ElapsedUs(start_us, YoloEdge_ReadUs(cfg->budget_timer)) >= cfg->postprocess_budget_us)
            {
                result->budget_exceeded = true;
                result->elapsed_us = YoloEdge_ElapsedUs(start_us, YoloEdge_ReadUs(cfg->budget_timer));
                return false;
            }

            if (obj_q < obj_gate_q)
            {
                continue;
            }

            obj_prob = YoloEdge_SigmoidFast(YoloEdge_DequantizeI8(obj_q,
                                                                  cfg->obj_scale,
                                                                  cfg->obj_zero_point));

            for (cls = 0U; cls < class_count; ++cls)
            {
                const int8_t cls_q = head_tensor[base + YOLO_EDGE_BOX_COMPONENTS + cls];
                const float cls_prob = YoloEdge_SigmoidFast(YoloEdge_DequantizeI8(cls_q,
                                                                                  cfg->cls_scale,
                                                                                  cfg->cls_zero_point));

                if (cls_prob > best_cls_prob)
                {
                    best_cls_prob = cls_prob;
                    best_cls_id = (uint8_t)cls;
                }
            }

            if ((obj_prob * best_cls_prob) >= cfg->score_threshold)
            {
                const float tx = YoloEdge_DequantizeI8(head_tensor[base + 0U],
                                                       cfg->box_scale,
                                                       cfg->box_zero_point);
                const float ty = YoloEdge_DequantizeI8(head_tensor[base + 1U],
                                                       cfg->box_scale,
                                                       cfg->box_zero_point);
                const float tw = YoloEdge_DequantizeI8(head_tensor[base + 2U],
                                                       cfg->box_scale,
                                                       cfg->box_zero_point);
                const float th = YoloEdge_DequantizeI8(head_tensor[base + 3U],
                                                       cfg->box_scale,
                                                       cfg->box_zero_point);
                const float center_x_in = ((float)col + YoloEdge_SigmoidFast(tx)) * (float)cfg->stride_px;
                const float center_y_in = ((float)row + YoloEdge_SigmoidFast(ty)) * (float)cfg->stride_px;
                const float box_w_in = cfg->anchor_w_px * expf(YoloEdge_ClampFloat(tw, -4.0f, 4.0f));
                const float box_h_in = cfg->anchor_h_px * expf(YoloEdge_ClampFloat(th, -4.0f, 4.0f));
                float x1 = 0.0f;
                float y1 = 0.0f;
                float x2 = 0.0f;
                float y2 = 0.0f;
                YoloProposal_t proposal = {0};

                YoloEdge_MapInputToFrame(cfg, center_x_in - (0.5f * box_w_in), center_y_in - (0.5f * box_h_in), &x1, &y1);
                YoloEdge_MapInputToFrame(cfg, center_x_in + (0.5f * box_w_in), center_y_in + (0.5f * box_h_in), &x2, &y2);

                proposal.x1 = YoloEdge_ClampFloat(x1, 0.0f, (float)(cfg->frame_w - 1U));
                proposal.y1 = YoloEdge_ClampFloat(y1, 0.0f, (float)(cfg->frame_h - 1U));
                proposal.x2 = YoloEdge_ClampFloat(x2, 0.0f, (float)(cfg->frame_w - 1U));
                proposal.y2 = YoloEdge_ClampFloat(y2, 0.0f, (float)(cfg->frame_h - 1U));
                proposal.score = obj_prob * best_cls_prob;
                proposal.class_id = best_cls_id;
                proposal.suppressed = false;

                if ((proposal.x2 - proposal.x1) < 2.0f || (proposal.y2 - proposal.y1) < 2.0f)
                {
                    /* 太小的框通常来自量化噪声或解码抖动，直接丢弃。 */
                    continue;
                }

                YoloEdge_InsertCandidate(result, &proposal, proposal_cap);
            }
        }
    }

    YoloEdge_RunNms(cfg, start_us, result);
    result->elapsed_us = YoloEdge_ElapsedUs(start_us, YoloEdge_ReadUs(cfg->budget_timer));
    return !result->budget_exceeded;
}

static TIM_HandleTypeDef htim5;

void App_RunYoloHeadPostprocess(const int8_t *head_tensor)
{
    YoloEdgeResult_t result;
    const YoloEdgeConfig_t cfg =
    {
        .model_input_w = 320U,
        .model_input_h = 320U,
        .frame_w = 640U,
        .frame_h = 480U,
        .grid_w = 20U,
        .grid_h = 20U,
        .stride_px = 16U,
        .class_count = 4U,
        .anchor_w_px = 42.0f,
        .anchor_h_px = 58.0f,
        .box_scale = 0.09375f,
        .box_zero_point = 0,
        .obj_scale = 0.125f,
        .obj_zero_point = 0,
        .cls_scale = 0.125f,
        .cls_zero_point = 0,
        .objectness_gate = 0.20f,
        .score_threshold = 0.35f,
        .iou_threshold = 0.50f,
        .max_proposals = 32U,
        .max_keep = 10U,
        .postprocess_budget_us = 2500U,
        .budget_timer = &htim5
    };

    if (!YoloEdge_PostprocessSingleHead(head_tensor, &cfg, &result))
    {
        /* 若超时，业务层可以降低 max_proposals、提高 gate 或切换更小 head。 */
    }

    for (uint16_t i = 0U; i < result.keep_count; ++i)
    {
        const YoloProposal_t *det = &result.proposals[i];
        /* 例: 将 det->x1/y1/x2/y2/score/class_id 发送给后级控制或告警状态机。 */
        (void)det;
    }
}
```

这段代码真正体现的不是“如何在 STM32 上写一个后处理函数”，而是**如何把后处理从不可控尾延迟，收敛成可预算的系统环节**。量化域预筛先砍掉低价值格点，Top-K 把候选数限制在 MCU 能负担的上界内，`NMS` 再在微秒预算里工作。边缘端部署的核心不是追求“每一帧都最精确”，而是确保每一帧都不会把系统拖出时序合同。
