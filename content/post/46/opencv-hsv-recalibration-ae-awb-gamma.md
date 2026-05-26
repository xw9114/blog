---
title: "技能档案：自动曝光、白平衡与伽马漂移下的 HSV 阈值回标定"
slug: "skill-opencv-hsv-threshold-recalibration-under-ae-awb-and-gamma-drift"
date: 2026-05-26T09:56:40+08:00
draft: false
description: "从传感器光谱响应、自动曝光、白平衡增益到 sRGB 伽马与色相环统计，系统拆解颜色识别为何常死在光照变化而不是阈值本身。"
tags: ["OpenCV", "颜色识别", "HSV", "自动曝光", "白平衡", "伽马校正", "机器视觉"]
categories: ["技能档案"]
image: ""
---

## 技能概述

颜色识别在分拣、巡线、机械臂抓取、视觉对位和边缘告警里看似门槛不高，但真正让系统失效的，往往不是 `inRange()` 本身，而是环境光、自动曝光、自动白平衡和 ISP 伽马把“同一个物体”映射成了完全不同的像素分布。工程痛点不在于你能否手调出一组 HSV 阈值，而在于系统是否理解了颜色从光谱反射到数字像素的整条传感链路，并据此把阈值重新绑定回可观测、可校正的物理参照。

## 核心底层概念解析

- **颜色不是物体的静态属性，而是光源、表面与传感器三者卷积后的结果**：对某个通道 `c ∈ {R, G, B}`，像素响应更接近 `I_c ≈ t_exp * g_analog * g_digital * ∫E(λ) * ρ(λ) * S_c(λ)dλ`。这里 `E(λ)` 是入射光谱，`ρ(λ)` 是表面反射率，`S_c(λ)` 是 CFA 与传感器的光谱响应。也就是说，颜色检测从来不是“看见红色”，而是在估计这三个函数相乘后落到 ADC 上的能量。
- **自动曝光首先改变的是尺度，不是类别，但它会通过饱和和量化重新改变类别**：曝光时间 `t_exp` 或总增益 `g_total` 上升时，三个通道近似共同放大；一旦高亮区域碰到满量程，原本线性的比例关系就被截断，HSV 的色相与饱和度也会跟着漂。
- **自动白平衡不是“把图调暖调冷”，而是对通道施加不对称增益**：ISP 常见形式是 `R' = k_r * R`、`G' = k_g * G`、`B' = k_b * B`。当 `k_r`、`k_b` 为了抵消环境色温而变化时，原先在实验室里测得的 `H/S/V` 分布会整体平移，尤其对红橙、青蓝这类临近色区更明显。
- **HSV 并不天然稳定，因为它通常建立在伽马编码后的 BGR 上**：显示链路中的 `C_srgb ≈ C_lin^(1 / γ)` 会压缩高亮、拉伸暗部。OpenCV 常见 `cvtColor(BGR, HSV)` 输入的是 8 位 gamma 域像素，而不是物理线性光强，所以同样的照度扰动在暗部与亮部产生的 HSV 位移并不等价。
- **色相在低饱和度区域天然不稳，噪声会被几何放大**：当 `S` 接近 0 时，三个通道数值彼此靠近，微小噪声就足以让“最大通道”切换，色相会像相位跳变一样突然翻转。工程上经常看到的“白墙边缘误检成蓝色”本质上不是阈值太宽，而是 `H` 在低 `S` 区域已经失去物理意义。
- **阈值漂移的根因往往来自 ISP，而不是算法没有做形态学**：不少项目会先加开闭运算、再调最小面积、再调轮廓筛选，但如果上游 AE/AWB 已经把目标颜色整体推离了原阈值窗，后处理做得再漂亮也只是在清理错误前提上的伪前景。
- **要把颜色重新绑回物理世界，必须引入参考块而不是只盯目标本体**：一块灰卡或白卡 ROI 可以提供当前帧的通道增益估计。对线性域均值 `mean(R_lin, G_lin, B_lin)`，可令 `Y_ref = (R_lin + G_lin + B_lin) / 3`，再构造 `g_c = Y_ref / mean(C_lin)`。这一步的意义不是“修图”，而是把光源色温变化从目标颜色里先剥离出去。
- **Hue 的统计必须按环形变量处理，不能直接算算术平均**：OpenCV 的 `H ∈ [0, 179]` 本质上是一个模 `180` 的圆周变量。若一组样本分布在 `179` 和 `1` 附近，线性平均会错误落在 `90` 左右。正确做法是先映射到角度 `θ_i = 2πH_i / 180`，再计算 `H_mean = atan2(Σsinθ_i, Σcosθ_i)`。
- **阈值不该只由均值决定，而应当由分布宽度和分位数共同约束**：色相窗口可由环形方差决定，`H_span = max(H_base, kσ_H + margin)`；饱和度和值更适合用低分位数防守，即 `S_min' ≈ P10(S_ref) - margin`、`V_min' ≈ P10(V_ref) - margin`。这样做不是让阈值“更聪明”，而是让它们对亮度起伏和局部反光更有余量。
- **补偿应发生在检测前，而不是误检后**：若你先在原始 BGR 上做 HSV 分割，再试图通过面积或轮廓去挽救结果，系统已经错过了把颜色映射拉回正确坐标系的机会。更稳妥的流程是先通道补偿、再色相统计、再阈值回标定、最后才是分割与连通域。
- **颜色阈值本质上是一份传感合同，而不是一组六元组常量**：实验室里保存的 `H_min/H_max/S_min/V_min` 只是某个曝光、某个白平衡、某个镜头和某个表面反射条件下的快照。真正可运行的工程系统，必须承认这份合同会被光照打破，并提供一套在线修约机制。

## 代码能力展现

下面给出一个基于 OpenCV C++ 的自适应颜色检测示例。设计重点不在“再写一遍 HSV 阈值分割”，而在于把 **灰参考 ROI 的 AWB 增益估计、sRGB 近似逆伽马线性化、色相环统计、分位数驱动的阈值回标定，以及最终的色块质心提取** 串成一条完整链路。

```cpp
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <vector>

struct HsvThreshold
{
    int h_min;
    int h_max;
    int s_min;
    int s_max;
    int v_min;
    int v_max;
    bool hue_wrap;
};

struct AdaptiveColorConfig
{
    cv::Rect gray_roi;               // 灰卡/白卡参考区域
    cv::Rect target_roi;             // 目标颜色参考区域
    float gamma;                     // sRGB 近似伽马，工程上可取 2.2
    float gain_min;                  // AWB 增益下限
    float gain_max;                  // AWB 增益上限
    int hue_guard_deg;               // Hue 额外防守裕量
    float hue_sigma_scale;           // Hue 方差放大系数
    int sv_guard;                    // S/V 阈值防守裕量
    int min_valid_pixels;            // 参考样本最小像素数
    int min_blob_area;               // 输出色块最小面积
    HsvThreshold base_threshold;     // 实验室标定得到的基础阈值
};

struct ReferenceStats
{
    cv::Vec3f awb_gain_bgr;          // B/G/R 三通道线性域增益
    float hue_center_deg;            // Hue 中心，单位 OpenCV Hue 度数 [0, 179]
    float hue_sigma_deg;             // Hue 环形标准差
    int sat_p10;                     // 参考色块 S 的 10% 分位
    int val_p10;                     // 参考色块 V 的 10% 分位
    int valid_pixels;
};

struct ColorBlob
{
    bool valid;
    int area;
    cv::Rect bbox;
    cv::Point2f centroid;
};

static int ClampInt(int value, int min_value, int max_value)
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

static float ClampFloat(float value, float min_value, float max_value)
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

static cv::Rect ClampRectToImage(const cv::Rect &roi, const cv::Size &image_size)
{
    const int x = ClampInt(roi.x, 0, image_size.width);
    const int y = ClampInt(roi.y, 0, image_size.height);
    const int max_w = std::max(0, image_size.width - x);
    const int max_h = std::max(0, image_size.height - y);

    return cv::Rect(x,
                    y,
                    ClampInt(roi.width, 0, max_w),
                    ClampInt(roi.height, 0, max_h));
}

static int WrapHue180(int hue)
{
    int wrapped = hue % 180;

    if (wrapped < 0)
    {
        wrapped += 180;
    }

    return wrapped;
}

/**
 * @brief 构建 8 位 sRGB 到线性光强的近似逆伽马查找表。
 * @param gamma 近似伽马，常用 2.2。
 * @return 256 项 LUT，输出范围 [0, 1]。
 *
 * @note 这里采用工程上常见的幂函数近似：
 *       L = (C / 255)^gamma
 *       它不是完整的 sRGB 分段函数，但足以把 AWB 增益估计从显示域拉回近似线性域。
 */
static std::array<float, 256> BuildInverseGammaLut(float gamma)
{
    std::array<float, 256> lut{};
    const float safe_gamma = ClampFloat(gamma, 1.0f, 3.0f);

    for (int i = 0; i < 256; ++i)
    {
        const float normalized = static_cast<float>(i) / 255.0f;
        lut[static_cast<size_t>(i)] = std::pow(normalized, safe_gamma);
    }

    return lut;
}

/**
 * @brief 将线性域浮点值重新编码回 8 位近似 sRGB。
 * @param linear_value 线性域值，范围近似 [0, 1]。
 * @param gamma 近似伽马。
 * @return 8 位像素。
 *
 * @note 编码关系近似为：
 *       C_8bit = round(255 * L^(1 / gamma))
 *       这样做的目的，是让后续 OpenCV 的 HSV 转换仍工作在常见 8 位 BGR 约定下。
 */
static uint8_t EncodeLinearToSrgb8(float linear_value, float gamma)
{
    const float safe_gamma = ClampFloat(gamma, 1.0f, 3.0f);
    const float clamped = ClampFloat(linear_value, 0.0f, 1.0f);
    const float encoded = std::pow(clamped, 1.0f / safe_gamma) * 255.0f;
    return static_cast<uint8_t>(ClampInt(static_cast<int>(std::lround(encoded)), 0, 255));
}

/**
 * @brief 使用灰参考 ROI 估计当前帧的通道增益漂移。
 * @param bgr_frame 当前 8 位 BGR 图像。
 * @param cfg 自适应配置。
 * @param inverse_gamma_lut 逆伽马查找表。
 * @param out_gain_bgr 输出 B/G/R 三通道增益。
 * @retval true 估计成功。
 * @retval false ROI 非法或有效像素不足。
 *
 * @note 若灰卡理想上满足 `B_lin ≈ G_lin ≈ R_lin ≈ Y_ref`，
 *       则通道增益可按
 *       `g_c = Y_ref / mean(C_lin)` 求得，
 *       其中 `Y_ref = (mean(B_lin) + mean(G_lin) + mean(R_lin)) / 3`。
 *       这一步的物理含义是：把环境色温引入的通道倾斜先从线性域里剥掉。
 */
static bool EstimateGrayWorldGain(const cv::Mat &bgr_frame,
                                  const AdaptiveColorConfig &cfg,
                                  const std::array<float, 256> &inverse_gamma_lut,
                                  cv::Vec3f *out_gain_bgr)
{
    const cv::Rect roi = ClampRectToImage(cfg.gray_roi, bgr_frame.size());
    cv::Vec3f linear_sum(0.0f, 0.0f, 0.0f);
    int pixel_count = 0;

    if ((out_gain_bgr == nullptr) || roi.empty() || (bgr_frame.type() != CV_8UC3))
    {
        return false;
    }

    for (int y = roi.y; y < (roi.y + roi.height); ++y)
    {
        const cv::Vec3b *row_ptr = bgr_frame.ptr<cv::Vec3b>(y);

        for (int x = roi.x; x < (roi.x + roi.width); ++x)
        {
            const cv::Vec3b bgr = row_ptr[x];
            linear_sum[0] += inverse_gamma_lut[bgr[0]];
            linear_sum[1] += inverse_gamma_lut[bgr[1]];
            linear_sum[2] += inverse_gamma_lut[bgr[2]];
            pixel_count++;
        }
    }

    if (pixel_count < cfg.min_valid_pixels)
    {
        return false;
    }

    {
        const cv::Vec3f linear_mean = linear_sum / static_cast<float>(pixel_count);
        const float y_ref = (linear_mean[0] + linear_mean[1] + linear_mean[2]) / 3.0f;

        (*out_gain_bgr)[0] = ClampFloat(y_ref / std::max(linear_mean[0], 1.0e-6f), cfg.gain_min, cfg.gain_max);
        (*out_gain_bgr)[1] = ClampFloat(y_ref / std::max(linear_mean[1], 1.0e-6f), cfg.gain_min, cfg.gain_max);
        (*out_gain_bgr)[2] = ClampFloat(y_ref / std::max(linear_mean[2], 1.0e-6f), cfg.gain_min, cfg.gain_max);
    }

    return true;
}

/**
 * @brief 将估计出的通道增益应用到整帧，并重新编码为 8 位 BGR。
 * @param bgr_frame 原始 8 位 BGR 图像。
 * @param gain_bgr B/G/R 三通道线性域增益。
 * @param gamma 近似伽马。
 * @param inverse_gamma_lut 逆伽马 LUT。
 * @param out_corrected_bgr 输出补偿后的 8 位 BGR 图像。
 *
 * @note 处理链路为：
 *       1. `L = (C / 255)^gamma` 近似恢复线性光强；
 *       2. `L'_c = clamp(g_c * L_c)` 执行 AWB 反补偿；
 *       3. `C'_8bit = 255 * (L'_c)^(1 / gamma)` 编码回 8 位。
 *       核心目的不是“让图更好看”，而是让后续 HSV 统计回到更一致的颜色坐标。
 */
static void ApplyGainCompensation(const cv::Mat &bgr_frame,
                                  const cv::Vec3f &gain_bgr,
                                  float gamma,
                                  const std::array<float, 256> &inverse_gamma_lut,
                                  cv::Mat *out_corrected_bgr)
{
    out_corrected_bgr->create(bgr_frame.size(), bgr_frame.type());

    for (int y = 0; y < bgr_frame.rows; ++y)
    {
        const cv::Vec3b *src_row = bgr_frame.ptr<cv::Vec3b>(y);
        cv::Vec3b *dst_row = out_corrected_bgr->ptr<cv::Vec3b>(y);

        for (int x = 0; x < bgr_frame.cols; ++x)
        {
            cv::Vec3b corrected{};

            for (int c = 0; c < 3; ++c)
            {
                const float linear = inverse_gamma_lut[src_row[x][c]];
                const float compensated = ClampFloat(linear * gain_bgr[c], 0.0f, 1.0f);
                corrected[c] = EncodeLinearToSrgb8(compensated, gamma);
            }

            dst_row[x] = corrected;
        }
    }
}

static int ComputePercentile(std::vector<int> *values, float percentile)
{
    const float p = ClampFloat(percentile, 0.0f, 1.0f);
    const size_t count = values->size();
    const size_t index = static_cast<size_t>(std::floor((count - 1U) * p));

    std::nth_element(values->begin(),
                     values->begin() + static_cast<std::ptrdiff_t>(index),
                     values->end());
    return (*values)[index];
}

/**
 * @brief 在补偿后的图像中统计目标颜色参考 ROI 的 HSV 分布。
 * @param corrected_bgr 已做通道补偿的 8 位 BGR 图像。
 * @param cfg 自适应配置。
 * @param out_stats 输出统计量。
 * @retval true 统计成功。
 * @retval false ROI 非法或有效样本不足。
 *
 * @note Hue 是环形变量，正确统计方式应为：
 *       `theta_i = 2π * H_i / 180`
 *       `H_mean = atan2(sum(sin(theta_i)), sum(cos(theta_i)))`
 *       `R = sqrt((sum cos / N)^2 + (sum sin / N)^2)`
 *       `sigma_H ≈ sqrt(-2 ln R)`
 *       这里再把 `sigma_H` 映回 OpenCV Hue 度数，避免 179/0 边界被线性平均破坏。
 */
static bool MeasureReferenceHsv(const cv::Mat &corrected_bgr,
                                const AdaptiveColorConfig &cfg,
                                ReferenceStats *out_stats)
{
    const cv::Rect roi = ClampRectToImage(cfg.target_roi, corrected_bgr.size());
    cv::Mat hsv_roi;
    double sin_sum = 0.0;
    double cos_sum = 0.0;
    std::vector<int> sat_values;
    std::vector<int> val_values;
    int valid_pixels = 0;

    if ((out_stats == nullptr) || roi.empty())
    {
        return false;
    }

    cv::cvtColor(corrected_bgr(roi), hsv_roi, cv::COLOR_BGR2HSV);
    sat_values.reserve(static_cast<size_t>(roi.area()));
    val_values.reserve(static_cast<size_t>(roi.area()));

    for (int y = 0; y < hsv_roi.rows; ++y)
    {
        const cv::Vec3b *row_ptr = hsv_roi.ptr<cv::Vec3b>(y);

        for (int x = 0; x < hsv_roi.cols; ++x)
        {
            const cv::Vec3b hsv = row_ptr[x];

            if (hsv[1] < 24U)
            {
                /*
                 * 低饱和度区域的 Hue 已接近退化，保留下来只会把色相中心拉偏，
                 * 因此这里显式剔除。
                 */
                continue;
            }

            {
                const double theta = (2.0 * CV_PI * static_cast<double>(hsv[0])) / 180.0;
                sin_sum += std::sin(theta);
                cos_sum += std::cos(theta);
            }

            sat_values.push_back(static_cast<int>(hsv[1]));
            val_values.push_back(static_cast<int>(hsv[2]));
            valid_pixels++;
        }
    }

    if (valid_pixels < cfg.min_valid_pixels)
    {
        return false;
    }

    {
        const double mean_theta = std::atan2(sin_sum, cos_sum);
        const double r = std::sqrt((sin_sum * sin_sum) + (cos_sum * cos_sum)) / static_cast<double>(valid_pixels);
        const double sigma_rad = std::sqrt(std::max(0.0, -2.0 * std::log(std::max(r, 1.0e-6))));
        double hue_deg = mean_theta * 180.0 / (2.0 * CV_PI);

        if (hue_deg < 0.0)
        {
            hue_deg += 180.0;
        }

        out_stats->hue_center_deg = static_cast<float>(hue_deg);
        out_stats->hue_sigma_deg = static_cast<float>(sigma_rad * 180.0 / (2.0 * CV_PI));
        out_stats->sat_p10 = ComputePercentile(&sat_values, 0.10f);
        out_stats->val_p10 = ComputePercentile(&val_values, 0.10f);
        out_stats->valid_pixels = valid_pixels;
    }

    return true;
}

/**
 * @brief 根据当前参考块统计值回标定 HSV 阈值。
 * @param cfg 自适应配置，内部含实验室基础阈值。
 * @param stats 当前帧参考块统计值。
 * @return 自适应后的阈值。
 *
 * @note 这里不直接迷信单个均值，而是采用：
 *       `H_half = max(H_base_half, k * sigma_H + hue_guard)`
 *       `S_min' = min(S_base_min, P10(S_ref) - sv_guard)`
 *       `V_min' = min(V_base_min, P10(V_ref) - sv_guard)`
 *       物理含义是：Hue 用方差守住色相漂移，S/V 用低分位数守住曝光起伏和局部阴影。
 */
static HsvThreshold BuildAdaptiveThreshold(const AdaptiveColorConfig &cfg, const ReferenceStats &stats)
{
    HsvThreshold threshold = cfg.base_threshold;
    const int base_center = WrapHue180((cfg.base_threshold.h_min + cfg.base_threshold.h_max) / 2);
    const int base_half =
        std::min((cfg.base_threshold.h_max - cfg.base_threshold.h_min + 180) % 180, 179) / 2;
    const int adaptive_half = static_cast<int>(std::lround(
        std::max(static_cast<float>(base_half),
                 (cfg.hue_sigma_scale * stats.hue_sigma_deg) + static_cast<float>(cfg.hue_guard_deg))));
    const int center = WrapHue180(static_cast<int>(std::lround(stats.hue_center_deg)));

    (void)base_center;

    threshold.h_min = WrapHue180(center - adaptive_half);
    threshold.h_max = WrapHue180(center + adaptive_half);
    threshold.hue_wrap = (threshold.h_min > threshold.h_max);
    threshold.s_min = ClampInt(std::min(cfg.base_threshold.s_min, stats.sat_p10 - cfg.sv_guard), 0, 255);
    threshold.s_max = 255;
    threshold.v_min = ClampInt(std::min(cfg.base_threshold.v_min, stats.val_p10 - cfg.sv_guard), 0, 255);
    threshold.v_max = 255;

    return threshold;
}

/**
 * @brief 使用支持色相回绕的 HSV 阈值对图像进行掩码分割。
 * @param hsv_image HSV 图像，8 位，Hue 范围 [0, 179]。
 * @param threshold 自适应阈值。
 * @param out_mask 输出二值掩码。
 *
 * @note 当目标色相跨过 179/0 边界时，需要拆成两个区间：
 *       `[h_min, 179] U [0, h_max]`
 *       否则红色这类靠近边界的目标会被线性阈值错误截断。
 */
static void MaskByAdaptiveThreshold(const cv::Mat &hsv_image,
                                    const HsvThreshold &threshold,
                                    cv::Mat *out_mask)
{
    if (!threshold.hue_wrap)
    {
        cv::inRange(hsv_image,
                    cv::Scalar(threshold.h_min, threshold.s_min, threshold.v_min),
                    cv::Scalar(threshold.h_max, threshold.s_max, threshold.v_max),
                    *out_mask);
        return;
    }

    {
        cv::Mat lower_mask;
        cv::Mat upper_mask;

        cv::inRange(hsv_image,
                    cv::Scalar(0, threshold.s_min, threshold.v_min),
                    cv::Scalar(threshold.h_max, threshold.s_max, threshold.v_max),
                    lower_mask);

        cv::inRange(hsv_image,
                    cv::Scalar(threshold.h_min, threshold.s_min, threshold.v_min),
                    cv::Scalar(179, threshold.s_max, threshold.v_max),
                    upper_mask);

        cv::bitwise_or(lower_mask, upper_mask, *out_mask);
    }
}

/**
 * @brief 从二值掩码中提取最大连通域的包围盒与质心。
 * @param binary_mask 输入二值图。
 * @param min_blob_area 最小面积约束。
 * @return 最大色块结果。若无合法目标，`valid = false`。
 *
 * @note 质心来自图像矩：
 *       `cx = M10 / M00`, `cy = M01 / M00`
 *       这样输出的不是“框中心”，而是与前景实际分布更一致的几何中心。
 */
static ColorBlob ExtractLargestBlob(const cv::Mat &binary_mask, int min_blob_area)
{
    std::vector<std::vector<cv::Point>> contours;
    ColorBlob blob{};

    cv::findContours(binary_mask, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

    for (const std::vector<cv::Point> &contour : contours)
    {
        const double area = cv::contourArea(contour);

        if (area < static_cast<double>(min_blob_area))
        {
            continue;
        }

        if ((!blob.valid) || (area > static_cast<double>(blob.area)))
        {
            const cv::Moments mu = cv::moments(contour);

            if (std::fabs(mu.m00) < 1.0e-6)
            {
                continue;
            }

            blob.valid = true;
            blob.area = static_cast<int>(std::lround(area));
            blob.bbox = cv::boundingRect(contour);
            blob.centroid.x = static_cast<float>(mu.m10 / mu.m00);
            blob.centroid.y = static_cast<float>(mu.m01 / mu.m00);
        }
    }

    return blob;
}

/**
 * @brief 执行一帧自适应颜色检测。
 * @param bgr_frame 当前帧 8 位 BGR 图像。
 * @param cfg 自适应配置。
 * @param out_threshold 输出本帧回标定后的 HSV 阈值。
 * @param out_blob 输出最大色块。
 * @retval true 检测链路成功完成。
 * @retval false 参考 ROI 失效或输入非法。
 *
 * @note 完整链路为：
 *       1. 用灰卡 ROI 估计 `g_B/g_G/g_R`；
 *       2. 在线性域应用通道补偿，再编码回 8 位 BGR；
 *       3. 在目标参考 ROI 上统计环形 Hue 与 S/V 分位数；
 *       4. 回标定阈值；
 *       5. 对整帧执行颜色分割和连通域提取。
 */
bool DetectColorWithAdaptiveRecalibration(const cv::Mat &bgr_frame,
                                          const AdaptiveColorConfig &cfg,
                                          HsvThreshold *out_threshold,
                                          ColorBlob *out_blob)
{
    const std::array<float, 256> inverse_gamma_lut = BuildInverseGammaLut(cfg.gamma);
    cv::Vec3f gain_bgr(1.0f, 1.0f, 1.0f);
    cv::Mat corrected_bgr;
    cv::Mat corrected_hsv;
    cv::Mat binary_mask;
    ReferenceStats stats{};

    if ((out_threshold == nullptr) || (out_blob == nullptr) || bgr_frame.empty() || (bgr_frame.type() != CV_8UC3))
    {
        return false;
    }

    if (!EstimateGrayWorldGain(bgr_frame, cfg, inverse_gamma_lut, &gain_bgr))
    {
        return false;
    }

    ApplyGainCompensation(bgr_frame, gain_bgr, cfg.gamma, inverse_gamma_lut, &corrected_bgr);

    if (!MeasureReferenceHsv(corrected_bgr, cfg, &stats))
    {
        return false;
    }

    stats.awb_gain_bgr = gain_bgr;
    *out_threshold = BuildAdaptiveThreshold(cfg, stats);

    cv::cvtColor(corrected_bgr, corrected_hsv, cv::COLOR_BGR2HSV);
    MaskByAdaptiveThreshold(corrected_hsv, *out_threshold, &binary_mask);

    /*
     * 这里只做一次轻量形态学开运算，用于抑制残余孤立噪点。
     * 真正的稳定性来源仍是前面的颜色补偿与阈值回标定，而不是盲目堆后处理。
     */
    cv::morphologyEx(binary_mask,
                     binary_mask,
                     cv::MORPH_OPEN,
                     cv::getStructuringElement(cv::MORPH_RECT, cv::Size(3, 3)));

    *out_blob = ExtractLargestBlob(binary_mask, cfg.min_blob_area);
    return true;
}

void Example_RunAdaptiveColorDetector(const cv::Mat &bgr_frame)
{
    const AdaptiveColorConfig config{
        cv::Rect(20, 20, 32, 32),          // 灰卡/白卡 ROI
        cv::Rect(80, 40, 36, 36),          // 目标颜色参考 ROI
        2.2f,                              // 近似伽马
        0.60f,                             // 增益下限
        1.80f,                             // 增益上限
        4,                                 // Hue 裕量
        2.5f,                              // Hue sigma 放大系数
        12,                                // S/V 裕量
        64,                                // 参考最小像素数
        80,                                // 最小色块面积
        HsvThreshold{0, 12, 90, 255, 60, 255, false}   // 以红色目标为例
    };

    HsvThreshold adaptive_threshold{};
    ColorBlob blob{};

    if (!DetectColorWithAdaptiveRecalibration(bgr_frame, config, &adaptive_threshold, &blob))
    {
        return;
    }

    if (blob.valid)
    {
        /*
         * 若后级是控制系统，可继续把像素误差映射为角度或位置误差。
         * 例如在已知焦距 fx 时，有：
         * yaw_error ≈ atan((blob.centroid.x - cx) / fx)
         * 这样颜色识别就不再只是“找到一个框”，而是进入闭环的可控状态量。
         */
        (void)adaptive_threshold;
        (void)blob;
    }
}
```

这段实现真正想强调的，是 **HSV 阈值不该被当成一组静态常量，而应当被当成 ISP 和场景光照共同作用下的在线估计量**。灰参考 ROI 负责提供当前光照下的通道倾斜，逆伽马补偿负责把白平衡估计尽量拉回线性域，环形 Hue 统计负责避免 179/0 边界的均值失真，而分位数驱动的 `S/V` 回标定则把曝光起伏和阴影波动纳入了阈值预算。对真正要上线的颜色检测系统来说，最关键的不是“阈值调得有多细”，而是系统能不能在光照把合同打破之后，自己把合同重新签回来。
