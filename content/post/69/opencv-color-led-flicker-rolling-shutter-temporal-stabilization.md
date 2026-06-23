---
title: "技能档案：颜色识别里的 LED 频闪、滚动快门条纹与时域颜色稳定化"
slug: "skill-opencv-color-recognition-led-flicker-rolling-shutter-and-temporal-stabilization"
date: 2026-06-23T09:04:20+08:00
draft: false
description: "从 LED 驱动纹波、滚动快门逐行曝光到同排白参考归一化与自适应时域融合，系统拆解颜色识别为何常死在照明时序而不是 HSV 阈值。"
tags: ["OpenCV", "颜色识别", "LED频闪", "滚动快门", "时域滤波", "机器视觉", "边缘计算"]
categories: ["技能档案"]
image: ""
---

## 技能概述

在产线分拣、指示灯状态识别、药片比色、线束套管检测和实验设备读数里，颜色识别经常在静态截图上看起来很准，一接上 LED 工位灯、恒流驱动纹波或廉价 CMOS 相机就开始“一帧偏黄、一帧偏灰”。真正的痛点不在 `cv::inRange()` 会不会写，而在 **相机并不是整帧同一时刻曝光**：滚动快门把一帧拆成逐行采样的时间栅格，而 LED 驱动又把光强随时间调制。于是系统失败的第一现场，往往不是颜色空间选错，而是 **颜色量测先被时域采样失配污染**。这个主题要解决的，就是如何用 **逐行曝光建模**、**同排白参考归一化** 和 **自适应时域融合**，把颜色判决重新拉回一个可比较、可复现的坐标系。

## 核心底层概念解析

- **滚动快门不是整帧快照，而是逐行时间扫描**：对第 `y` 行来说，其曝光中心时刻可近似写成  
  `t_row(y) = t_frame_start + y * T_line + T_exp / 2`。  
  同一帧里最上面和最下面两行，看到的其实不是同一个瞬时世界。
- **LED 频闪本质上是时间调制，而不是简单亮一点或暗一点**：若驱动电流带有纹波，可把光强近似成  
  `L(t) = L_0 + A * sin(2 * pi * f_f * t + phi)`，  
  若是 PWM 驱动，则更接近分段脉冲。无论哪一种，只要 `f_f` 没有高到被曝光时间完全平均掉，滚动快门就会把时间起伏折叠成空间条纹。
- **条纹来自“时间被相机按行重新采样”**：一行像素最终记录的亮度近似满足  
  `I_row(y) ~= rho * (1 / T_exp) * integral(L(t) dt)`，积分区间是该行的曝光窗。  
  这里 `rho` 是物体反射率和镜头/传感器增益的合成量。照明在时间域振荡，图像却以行号为索引保存，于是时间纹波被翻译成空间亮暗带。
- **曝光时间本身就是一个低通滤波器**：若频闪近似正弦，曝光积分会带来  
  `A_eff = A * sinc(pi * f_f * T_exp)`。  
  曝光越长，条纹越容易被平均；但代价是运动模糊、拖尾和高光饱和风险上升。它不是“越长越好”，而是在时域抑制与空间清晰度之间做交易。
- **条纹空间周期由行时间决定，而不是由分辨率名义值决定**：若已知频闪频率 `f_f` 与行时间 `T_line`，每个明暗周期大致跨越  
  `N_cycle ~= 1 / (f_f * T_line)` 行。  
  所以同样的灯、同样的相机模组，改一档 ROI 高度、binning 或读出模式，条纹密度都可能变化。
- **整块 ROI 求均值会把不同相位的照明混在一起**：一个目标色块若跨越几十行甚至上百行，顶部行和底部行可能处在不同照明相位。直接把整块 ROI 平均，相当于把多个时间片的颜色混成一个数，再去假装它们来自同一时刻。
- **同排白参考的价值，在于用相同时间相位做归一化**：若画面中有一条贯穿垂直方向的白参考带，对目标第 `y` 行和白带第 `y` 行有相同的曝光中心时刻，于是可构造  
  `c_norm(y) = c_target(y) / (c_white(y) + eps)`。  
  这相当于把同一时刻的照明幅值先除掉，再讨论物体自己的反射率坐标。
- **白参考必须“同排”，而不是“同帧随便找块白色”**：如果白参考在另一个行区间，它看到的是不同的照明相位，无法消掉滚动快门引入的条纹。很多人以为做了全局白平衡就够了，问题就在这里。
- **条纹强度需要量化，而不能靠肉眼看图**：工程上可以定义  
  `stripe_ratio = mean(|g[y] - g[y-1]|) / mean(g[y])`，  
  用逐行亮度一阶差分衡量当前这帧的频闪污染程度。它比“画面看起来有条纹吗”更适合写进算法门控。
- **时域融合不是为了好看，而是为了在照明相位不稳定时降低瞬时测量权重**：当 `stripe_ratio` 很大时，应降低当前帧测量的信任度，做  
  `c_fused[k] = alpha * c_meas[k] + (1 - alpha) * c_fused[k-1]`，  
  且 `alpha = clamp(1 - stripe_ratio / stripe_limit, alpha_min, alpha_max)`。  
  条纹越重，`alpha` 越小，系统越依赖历史稳定值。
- **稳定行选择是对“同一 ROI 内部也有受害者和幸存者”的承认**：即便同排白参考已经做了归一化，仍可能存在局部饱和、高光或纹理行。选取逐行亮度偏离中位数较小的连续带，再做颜色统计，比整块平均更接近可靠测量。
- **技术哲学上，颜色识别首先是一份时域合同**：当照明、读出、曝光和参考坐标不同步时，颜色空间再高级也只是对污染后的数据做更精致的解释。真正稳健的系统，会先问“这一帧颜色是否还值得相信”，再问“它像不像红色”。

## 代码能力展现

下面给出一个基于 OpenCV C++ 的抗频闪颜色测量模块。它不把问题简化成“拍一帧图然后做阈值”，而是把 **逐行曝光**、**同排白参考归一化**、**条纹强度估计**、**稳定行筛选** 和 **自适应时域融合** 串成一条完整链路。场景假设如下：

- 图像来自 `8-bit BGR` 的滚动快门相机。
- 画面左侧或右侧布置了一条纵向白参考带，覆盖目标 ROI 对应的全部行区间。
- 目标是单色或近单色工件，最终仍在 `Lab` 空间里用 `DeltaE76` 做判别，但真正的重点放在进入 `Lab` 之前的时域净化。

```cpp
#include <opencv2/core.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

struct LedFlickerTimingConfig_t
{
    float row_time_us;               /* 单行读出时间，决定逐行采样相位步进。 */
    float exposure_us;               /* 当前曝光时间，用于估算积分平均效应。 */
    float flicker_hz_hint;           /* 频闪频率提示值，例如 100 Hz、120 Hz 或 PWM 频率。未知时可填 0。 */
    float stripe_ratio_limit;        /* 条纹强度门限，超过后降低当前帧信任度。 */
    float alpha_min;                 /* 时域融合最小 alpha。 */
    float alpha_max;                 /* 时域融合最大 alpha。 */
    float saturation_code_limit;     /* 码值超过该阈值视为接近饱和。 */
    float darkness_code_limit;       /* 平均码值低于该阈值视为过暗。 */
};

struct ColorTarget_t
{
    std::string name;
    cv::Vec3f target_lab;
    float max_delta_e76;
};

struct TemporalColorState_t
{
    cv::Vec3f filtered_linear_rgb;
    bool initialized;
};

struct FlickerColorResult_t
{
    cv::Vec3f instant_linear_rgb;
    cv::Vec3f filtered_linear_rgb;
    cv::Vec3f filtered_lab;
    float stripe_ratio;
    float adaptive_alpha;
    float rows_per_cycle_hint;
    float exposure_attenuation;
    float stable_window_us;
    int stable_row_begin;
    int stable_row_end;
    float best_delta_e76;
    bool saturated;
    bool too_dark;
    bool valid;
    std::string name;
};

static float ClampF(float value, float min_value, float max_value)
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

static cv::Rect ClampRoi(const cv::Rect &roi, const cv::Size &image_size)
{
    const int x = std::max(0, roi.x);
    const int y = std::max(0, roi.y);
    const int w = std::max(0, std::min(roi.width, image_size.width - x));
    const int h = std::max(0, std::min(roi.height, image_size.height - y));

    return cv::Rect(x, y, w, h);
}

static float SrgbToLinearUnit(float srgb_unit)
{
    const float x = ClampF(srgb_unit, 0.0f, 1.0f);

    if (x <= 0.04045f)
    {
        return x / 12.92f;
    }

    return std::pow((x + 0.055f) / 1.055f, 2.4f);
}

static cv::Vec3f Bgr8ToLinearRgb(const cv::Vec3b &bgr)
{
    const float b = SrgbToLinearUnit(static_cast<float>(bgr[0]) / 255.0f);
    const float g = SrgbToLinearUnit(static_cast<float>(bgr[1]) / 255.0f);
    const float r = SrgbToLinearUnit(static_cast<float>(bgr[2]) / 255.0f);

    return cv::Vec3f(r, g, b);
}

static float ProjectLuma(const cv::Vec3f &linear_rgb)
{
    return (0.2126f * linear_rgb[0]) + (0.7152f * linear_rgb[1]) + (0.0722f * linear_rgb[2]);
}

static cv::Vec3f LinearRgbToXyzD65(const cv::Vec3f &linear_rgb)
{
    return cv::Vec3f(0.4124564f * linear_rgb[0] + 0.3575761f * linear_rgb[1] + 0.1804375f * linear_rgb[2],
                     0.2126729f * linear_rgb[0] + 0.7151522f * linear_rgb[1] + 0.0721750f * linear_rgb[2],
                     0.0193339f * linear_rgb[0] + 0.1191920f * linear_rgb[1] + 0.9503041f * linear_rgb[2]);
}

static float LabPivot(float value)
{
    const float delta = 6.0f / 29.0f;
    const float delta_cube = delta * delta * delta;

    if (value > delta_cube)
    {
        return std::cbrt(value);
    }

    return (value / (3.0f * delta * delta)) + (4.0f / 29.0f);
}

static cv::Vec3f XyzToLabD65(const cv::Vec3f &xyz)
{
    static const cv::Vec3f kWhiteD65(0.95047f, 1.00000f, 1.08883f);

    const float fx = LabPivot(xyz[0] / kWhiteD65[0]);
    const float fy = LabPivot(xyz[1] / kWhiteD65[1]);
    const float fz = LabPivot(xyz[2] / kWhiteD65[2]);

    return cv::Vec3f((116.0f * fy) - 16.0f,
                     500.0f * (fx - fy),
                     200.0f * (fy - fz));
}

static float DeltaE76(const cv::Vec3f &lab_a, const cv::Vec3f &lab_b)
{
    const float dl = lab_a[0] - lab_b[0];
    const float da = lab_a[1] - lab_b[1];
    const float db = lab_a[2] - lab_b[2];

    return std::sqrt((dl * dl) + (da * da) + (db * db));
}

/**
 * @brief 提取 ROI 的逐行线性 RGB 与逐行亮度。
 * @param frame_bgr 输入图像，要求为 CV_8UC3。
 * @param roi 目标 ROI。
 * @param row_rgb 输出每一行的平均线性 RGB。
 * @param row_luma 输出每一行的平均线性亮度。
 * @param peak_code 输出 ROI 内最大 8-bit 码值。
 * @param mean_code 输出 ROI 的平均 8-bit 码值。
 * @retval true 提取成功。
 * @retval false ROI 非法或输入为空。
 *
 * @note 逐行统计的意义不在“多做几次平均”，而在于保留滚动快门沿 y 轴展开的时间结构。
 *       一旦直接把整块 ROI 压成一个均值，条纹相位信息就被永久丢掉了。
 */
static bool ExtractRowLinearRgb(const cv::Mat &frame_bgr,
                                const cv::Rect &roi,
                                std::vector<cv::Vec3f> *row_rgb,
                                std::vector<float> *row_luma,
                                float *peak_code,
                                float *mean_code)
{
    uint64_t sample_count = 0U;
    double code_sum = 0.0;
    float local_peak = 0.0f;
    const cv::Rect safe_roi = ClampRoi(roi, frame_bgr.size());

    if ((row_rgb == nullptr) || (row_luma == nullptr) || frame_bgr.empty() || (frame_bgr.type() != CV_8UC3))
    {
        return false;
    }

    if ((safe_roi.width <= 0) || (safe_roi.height <= 0))
    {
        return false;
    }

    row_rgb->assign(static_cast<size_t>(safe_roi.height), cv::Vec3f(0.0f, 0.0f, 0.0f));
    row_luma->assign(static_cast<size_t>(safe_roi.height), 0.0f);

    for (int row = 0; row < safe_roi.height; ++row)
    {
        cv::Vec3f rgb_sum(0.0f, 0.0f, 0.0f);
        const cv::Vec3b *src = frame_bgr.ptr<cv::Vec3b>(safe_roi.y + row);

        for (int x = safe_roi.x; x < (safe_roi.x + safe_roi.width); ++x)
        {
            const cv::Vec3b &bgr = src[x];
            const cv::Vec3f linear_rgb = Bgr8ToLinearRgb(bgr);

            rgb_sum += linear_rgb;
            code_sum += static_cast<double>(bgr[0] + bgr[1] + bgr[2]) / 3.0;
            local_peak = std::max(local_peak, static_cast<float>(std::max(bgr[0], std::max(bgr[1], bgr[2]))));
            ++sample_count;
        }

        (*row_rgb)[static_cast<size_t>(row)] = rgb_sum * (1.0f / static_cast<float>(safe_roi.width));
        (*row_luma)[static_cast<size_t>(row)] = ProjectLuma((*row_rgb)[static_cast<size_t>(row)]);
    }

    if (peak_code != nullptr)
    {
        *peak_code = local_peak;
    }

    if (mean_code != nullptr)
    {
        *mean_code = (sample_count > 0U) ? static_cast<float>(code_sum / static_cast<double>(sample_count)) : 0.0f;
    }

    return true;
}

/**
 * @brief 根据逐行白参考构造目标 ROI 的同排归一化结果。
 * @param target_rows 目标 ROI 每行平均线性 RGB。
 * @param target_roi 目标 ROI，用于将局部行号映射回图像绝对行号。
 * @param white_rows 白参考带每行平均线性 RGB，建议覆盖整幅图像高度。
 * @param white_roi 白参考带 ROI。
 * @param normalized_rows 输出归一化后的逐行 RGB。
 * @param normalized_luma 输出归一化后的逐行亮度。
 * @retval true 归一化成功。
 * @retval false 白参考行范围不足或输入非法。
 *
 * @note 对目标第 y 行，使用同一绝对行号的白参考做归一化:
 *       rgb_norm(y) = diag(g_r(y), g_g(y), g_b(y)) * rgb_target(y)
 *       g_c(y)      = white_ref_c / max(white_meas_c(y), eps)
 *
 *       这等价于在相同曝光相位下消去照明幅值的一阶影响。
 */
static bool BuildSameRowNormalizedRows(const std::vector<cv::Vec3f> &target_rows,
                                       const cv::Rect &target_roi,
                                       const std::vector<cv::Vec3f> &white_rows,
                                       const cv::Rect &white_roi,
                                       std::vector<cv::Vec3f> *normalized_rows,
                                       std::vector<float> *normalized_luma)
{
    static const cv::Vec3f kWhiteReference(1.0f, 1.0f, 1.0f);

    if ((normalized_rows == nullptr) || (normalized_luma == nullptr) || target_rows.empty() || white_rows.empty())
    {
        return false;
    }

    normalized_rows->assign(target_rows.size(), cv::Vec3f(0.0f, 0.0f, 0.0f));
    normalized_luma->assign(target_rows.size(), 0.0f);

    for (size_t row = 0U; row < target_rows.size(); ++row)
    {
        const int abs_y = target_roi.y + static_cast<int>(row);
        const int white_idx = abs_y - white_roi.y;

        if ((white_idx < 0) || (white_idx >= static_cast<int>(white_rows.size())))
        {
            return false;
        }

        cv::Vec3f gain;
        gain[0] = ClampF(kWhiteReference[0] / std::max(white_rows[static_cast<size_t>(white_idx)][0], 1.0e-6f), 0.25f, 4.0f);
        gain[1] = ClampF(kWhiteReference[1] / std::max(white_rows[static_cast<size_t>(white_idx)][1], 1.0e-6f), 0.25f, 4.0f);
        gain[2] = ClampF(kWhiteReference[2] / std::max(white_rows[static_cast<size_t>(white_idx)][2], 1.0e-6f), 0.25f, 4.0f);

        (*normalized_rows)[row] = cv::Vec3f(target_rows[row][0] * gain[0],
                                            target_rows[row][1] * gain[1],
                                            target_rows[row][2] * gain[2]);
        (*normalized_luma)[row] = ProjectLuma((*normalized_rows)[row]);
    }

    return true;
}

/**
 * @brief 用逐行亮度一阶差分估计条纹强度。
 * @param row_luma 逐行亮度。
 * @return [0, 1] 区间的经验条纹比值，越大表示相邻行起伏越剧烈。
 *
 * @note 定义:
 *       stripe_ratio = mean(|g[y] - g[y - 1]|) / mean(g[y])
 *
 *       该指标不是颜色语义，而是照明污染程度的观测量。
 */
static float EstimateStripeRatio(const std::vector<float> &row_luma)
{
    double mean_luma = 0.0;
    double diff_sum = 0.0;

    if (row_luma.size() < 2U)
    {
        return 0.0f;
    }

    for (float value : row_luma)
    {
        mean_luma += value;
    }

    mean_luma /= static_cast<double>(row_luma.size());

    if (mean_luma <= 1.0e-9)
    {
        return 0.0f;
    }

    for (size_t i = 1U; i < row_luma.size(); ++i)
    {
        diff_sum += std::fabs(static_cast<double>(row_luma[i] - row_luma[i - 1U]));
    }

    return ClampF(static_cast<float>(diff_sum /
                                     (static_cast<double>(row_luma.size() - 1U) * mean_luma)),
                  0.0f,
                  1.0f);
}

/**
 * @brief 在归一化后的逐行亮度里挑选最稳定的连续行带。
 * @param normalized_luma 归一化后的逐行亮度。
 * @param stripe_ratio 当前条纹强度。
 * @param stable_begin 输出稳定带起始行。
 * @param stable_end 输出稳定带结束行。
 *
 * @note 逻辑：
 *       1. 以中位亮度作为稳态中心；
 *       2. 允许偏差 = median * tolerance_ratio；
 *       3. 选取满足偏差约束的最长连续区间。
 *
 *       tolerance_ratio 会随 stripe_ratio 轻微放宽，
 *       但仍被限制在较窄范围，避免把整块污染区误当成稳定带。
 */
static void SelectStableRowBand(const std::vector<float> &normalized_luma,
                                float stripe_ratio,
                                int *stable_begin,
                                int *stable_end)
{
    std::vector<float> sorted_luma = normalized_luma;
    const int full_begin = 0;
    const int full_end = static_cast<int>(normalized_luma.size()) - 1;
    const float tolerance_ratio = ClampF(0.03f + (0.25f * stripe_ratio), 0.03f, 0.10f);
    int current_begin = -1;
    int best_begin = full_begin;
    int best_end = full_end;
    int best_length = 0;
    float median_luma = 0.0f;

    if ((stable_begin == nullptr) || (stable_end == nullptr) || normalized_luma.empty())
    {
        return;
    }

    std::sort(sorted_luma.begin(), sorted_luma.end());
    median_luma = sorted_luma[sorted_luma.size() / 2U];

    if (median_luma <= 1.0e-9f)
    {
        *stable_begin = full_begin;
        *stable_end = full_end;
        return;
    }

    for (int i = 0; i <= full_end; ++i)
    {
        const float deviation = std::fabs(normalized_luma[static_cast<size_t>(i)] - median_luma);
        const bool inside = (deviation <= (tolerance_ratio * median_luma));

        if (inside)
        {
            if (current_begin < 0)
            {
                current_begin = i;
            }
        }
        else if (current_begin >= 0)
        {
            const int current_end = i - 1;
            const int current_length = current_end - current_begin + 1;

            if (current_length > best_length)
            {
                best_length = current_length;
                best_begin = current_begin;
                best_end = current_end;
            }

            current_begin = -1;
        }
    }

    if (current_begin >= 0)
    {
        const int current_end = full_end;
        const int current_length = current_end - current_begin + 1;

        if (current_length > best_length)
        {
            best_length = current_length;
            best_begin = current_begin;
            best_end = current_end;
        }
    }

    if (best_length <= 0)
    {
        best_begin = full_begin;
        best_end = full_end;
    }

    *stable_begin = best_begin;
    *stable_end = best_end;
}

static cv::Vec3f AverageRows(const std::vector<cv::Vec3f> &rows, int begin_row, int end_row)
{
    cv::Vec3f sum(0.0f, 0.0f, 0.0f);
    const int begin_safe = std::max(0, begin_row);
    const int end_safe = std::min(end_row, static_cast<int>(rows.size()) - 1);
    const int count = std::max(0, end_safe - begin_safe + 1);

    if (count <= 0)
    {
        return sum;
    }

    for (int i = begin_safe; i <= end_safe; ++i)
    {
        sum += rows[static_cast<size_t>(i)];
    }

    return sum * (1.0f / static_cast<float>(count));
}

static float SincF(float x)
{
    if (std::fabs(x) <= 1.0e-6f)
    {
        return 1.0f;
    }

    return std::sinf(x) / x;
}

/**
 * @brief 根据频闪强度对颜色做自适应时域融合。
 * @param instant_linear_rgb 当前帧瞬时颜色测量值。
 * @param stripe_ratio 当前条纹强度。
 * @param config 时序配置。
 * @param state_inout 跨帧滤波状态。
 * @param filtered_linear_rgb 输出滤波后颜色。
 * @param adaptive_alpha 输出本次采用的 alpha。
 *
 * @note 融合公式:
 *       alpha = clamp(1 - stripe_ratio / stripe_limit, alpha_min, alpha_max)
 *       c_f[k] = alpha * c_meas[k] + (1 - alpha) * c_f[k - 1]
 *
 *       条纹越重，当前帧越不可信，alpha 越小。
 */
static void UpdateTemporalColor(const cv::Vec3f &instant_linear_rgb,
                                float stripe_ratio,
                                const LedFlickerTimingConfig_t &config,
                                TemporalColorState_t *state_inout,
                                cv::Vec3f *filtered_linear_rgb,
                                float *adaptive_alpha)
{
    const float limit = std::max(config.stripe_ratio_limit, 1.0e-6f);
    const float alpha = ClampF(1.0f - (stripe_ratio / limit), config.alpha_min, config.alpha_max);

    if ((filtered_linear_rgb == nullptr) || (adaptive_alpha == nullptr))
    {
        return;
    }

    *adaptive_alpha = alpha;

    if ((state_inout == nullptr) || !state_inout->initialized)
    {
        *filtered_linear_rgb = instant_linear_rgb;

        if (state_inout != nullptr)
        {
            state_inout->filtered_linear_rgb = instant_linear_rgb;
            state_inout->initialized = true;
        }

        return;
    }

    *filtered_linear_rgb = (alpha * instant_linear_rgb) + ((1.0f - alpha) * state_inout->filtered_linear_rgb);
    state_inout->filtered_linear_rgb = *filtered_linear_rgb;
}

static void ClassifyColorByLab(const cv::Vec3f &lab,
                               const std::vector<ColorTarget_t> &targets,
                               std::string *best_name,
                               float *best_delta_e76,
                               bool *valid)
{
    float best_distance = std::numeric_limits<float>::infinity();
    std::string name;
    bool is_valid = false;

    for (const ColorTarget_t &target : targets)
    {
        const float delta_e76 = DeltaE76(lab, target.target_lab);

        if (delta_e76 < best_distance)
        {
            best_distance = delta_e76;
            name = target.name;
            is_valid = (delta_e76 <= target.max_delta_e76);
        }
    }

    if (best_name != nullptr)
    {
        *best_name = name;
    }

    if (best_delta_e76 != nullptr)
    {
        *best_delta_e76 = best_distance;
    }

    if (valid != nullptr)
    {
        *valid = is_valid;
    }
}

/**
 * @brief 在 LED 频闪与滚动快门场景下执行一次稳健颜色测量。
 * @param frame_bgr 输入 BGR 图像。
 * @param target_roi 目标色块 ROI。
 * @param white_strip_roi 纵向白参考带 ROI，建议覆盖 target_roi 的全部行区间。
 * @param config 时序参数与门限。
 * @param targets 目标颜色表，基于 Lab 与 DeltaE76 做最终分类。
 * @param state_inout 跨帧状态，用于自适应时域融合。
 * @param result 输出结果。
 * @retval true 本帧量测可信。
 * @retval false 本帧因饱和、过暗、参考缺失或分类失败而拒绝。
 *
 * @note 物理链路可以概括为：
 *       1. 第 y 行曝光时刻：t_row(y) = t0 + y * T_line + T_exp / 2
 *       2. 同排参考归一化：c_norm(y) = c_target(y) / (c_white(y) + eps)
 *       3. 条纹估计：stripe_ratio = mean(|g[y] - g[y - 1]|) / mean(g[y])
 *       4. 时域融合：c_f[k] = alpha * c_meas[k] + (1 - alpha) * c_f[k - 1]
 *
 *       它解决的不是“把条纹修得更好看”，而是把颜色判决重新放回相同照明相位上比较。
 */
bool MeasureColorUnderLedFlicker(const cv::Mat &frame_bgr,
                                 const cv::Rect &target_roi,
                                 const cv::Rect &white_strip_roi,
                                 const LedFlickerTimingConfig_t &config,
                                 const std::vector<ColorTarget_t> &targets,
                                 TemporalColorState_t *state_inout,
                                 FlickerColorResult_t *result)
{
    std::vector<cv::Vec3f> target_rows_rgb;
    std::vector<cv::Vec3f> white_rows_rgb;
    std::vector<cv::Vec3f> normalized_rows_rgb;
    std::vector<float> target_rows_luma;
    std::vector<float> white_rows_luma;
    std::vector<float> normalized_rows_luma;
    std::vector<float> white_slice_luma;
    float target_peak_code = 255.0f;
    float target_mean_code = 0.0f;
    float white_peak_code = 255.0f;
    float white_mean_code = 0.0f;

    if (result == nullptr)
    {
        return false;
    }

    *result = {};

    if (!ExtractRowLinearRgb(frame_bgr,
                             target_roi,
                             &target_rows_rgb,
                             &target_rows_luma,
                             &target_peak_code,
                             &target_mean_code))
    {
        return false;
    }

    if (!ExtractRowLinearRgb(frame_bgr,
                             white_strip_roi,
                             &white_rows_rgb,
                             &white_rows_luma,
                             &white_peak_code,
                             &white_mean_code))
    {
        return false;
    }

    result->saturated = (target_peak_code >= config.saturation_code_limit) ||
                        (white_peak_code >= config.saturation_code_limit);
    result->too_dark = (target_mean_code <= config.darkness_code_limit) ||
                       (white_mean_code <= config.darkness_code_limit);

    if (result->saturated || result->too_dark)
    {
        return false;
    }

    if (!BuildSameRowNormalizedRows(target_rows_rgb,
                                    ClampRoi(target_roi, frame_bgr.size()),
                                    white_rows_rgb,
                                    ClampRoi(white_strip_roi, frame_bgr.size()),
                                    &normalized_rows_rgb,
                                    &normalized_rows_luma))
    {
        return false;
    }

    white_slice_luma.reserve(target_rows_rgb.size());

    for (size_t row = 0U; row < target_rows_rgb.size(); ++row)
    {
        const int abs_y = ClampRoi(target_roi, frame_bgr.size()).y + static_cast<int>(row);
        const int white_idx = abs_y - ClampRoi(white_strip_roi, frame_bgr.size()).y;

        if ((white_idx < 0) || (white_idx >= static_cast<int>(white_rows_luma.size())))
        {
            return false;
        }

        white_slice_luma.push_back(white_rows_luma[static_cast<size_t>(white_idx)]);
    }

    result->stripe_ratio = EstimateStripeRatio(white_slice_luma);
    SelectStableRowBand(normalized_rows_luma,
                        result->stripe_ratio,
                        &result->stable_row_begin,
                        &result->stable_row_end);

    result->instant_linear_rgb = AverageRows(normalized_rows_rgb,
                                             result->stable_row_begin,
                                             result->stable_row_end);

    UpdateTemporalColor(result->instant_linear_rgb,
                        result->stripe_ratio,
                        config,
                        state_inout,
                        &result->filtered_linear_rgb,
                        &result->adaptive_alpha);

    result->filtered_lab = XyzToLabD65(LinearRgbToXyzD65(result->filtered_linear_rgb));
    ClassifyColorByLab(result->filtered_lab,
                       targets,
                       &result->name,
                       &result->best_delta_e76,
                       &result->valid);

    result->stable_window_us =
        static_cast<float>(result->stable_row_end - result->stable_row_begin + 1) *
        std::max(config.row_time_us, 0.0f);

    if ((config.flicker_hz_hint > 1.0f) && (config.row_time_us > 1.0e-6f))
    {
        result->rows_per_cycle_hint = 1.0e6f / (config.flicker_hz_hint * config.row_time_us);
        result->exposure_attenuation =
            std::fabs(SincF(static_cast<float>(CV_PI) * config.flicker_hz_hint * config.exposure_us * 1.0e-6f));
    }
    else
    {
        result->rows_per_cycle_hint = 0.0f;
        result->exposure_attenuation = 1.0f;
    }

    return result->valid;
}

static const std::vector<ColorTarget_t> g_demo_caps =
{
    { "red_cap",    cv::Vec3f(43.0f, 57.0f, 31.0f),  8.5f },
    { "green_cap",  cv::Vec3f(64.0f, -41.0f, 27.0f), 8.0f },
    { "blue_cap",   cv::Vec3f(34.0f, 16.0f, -45.0f), 8.0f },
    { "yellow_cap", cv::Vec3f(79.0f, -5.0f, 71.0f),  9.5f }
};

void Example_LedFlickerColorStep(const cv::Mat &frame_bgr)
{
    static TemporalColorState_t s_state = { cv::Vec3f(0.0f, 0.0f, 0.0f), false };

    const LedFlickerTimingConfig_t config =
    {
        18.5f,   /* row_time_us: 逐行读出约 18.5 us。 */
        3200.0f, /* exposure_us: 3.2 ms 曝光。 */
        100.0f,  /* flicker_hz_hint: 市电整流 LED 常见 100 Hz。 */
        0.08f,   /* stripe_ratio_limit */
        0.12f,   /* alpha_min */
        0.92f,   /* alpha_max */
        250.0f,  /* saturation_code_limit */
        12.0f    /* darkness_code_limit */
    };

    FlickerColorResult_t result = {};

    if (!MeasureColorUnderLedFlicker(frame_bgr,
                                     cv::Rect(420, 180, 96, 140),
                                     cv::Rect(48, 0, 24, frame_bgr.rows),
                                     config,
                                     g_demo_caps,
                                     &s_state,
                                     &result))
    {
        return;
    }

    /*
     * 上层系统可根据 result 里的诊断量做策略分层：
     * 1. stripe_ratio 持续偏高：优先检查灯源驱动与曝光配置。
     * 2. stable_window_us 太短：说明同一帧里真正稳定的行带不足，应降低节拍或增加参考带宽度。
     * 3. exposure_attenuation 接近 0：说明当前曝光已对该频率形成强平均，但要警惕运动模糊副作用。
     */
    (void)result;
}
```

这段实现真正重要的地方有三点：

- **先承认滚动快门把一帧切成了很多个时间片**，所以颜色测量不能再把 ROI 当成“同一时刻的空间块”。
- **再用同排白参考把照明相位的一阶影响除掉**，把“当前这行有多亮”与“物体本身反射率坐标”尽量分开。
- **最后才用条纹强度驱动时域融合与颜色分类**，把当前帧不可信这件事显式写进 `alpha`，而不是让它悄悄污染分类边界。

如果现场无法提供一条覆盖全高的白参考带，那么再精致的 `Lab` 阈值也很难彻底消掉频闪条纹，因为系统始终缺少“同一行、同一曝光相位”的照明坐标。颜色识别在这种工况下真正该优化的，不是继续调 `HSV` 半径，而是先把 **照明驱动、曝光时序、白参考布局和相机读出模式** 这四个物理约束摆平。
