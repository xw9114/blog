---
title: "技能档案：OpenCV 双目标定与深度重建，从极线校正到视差误差放大"
slug: "skill-opencv-stereo-calibration-disparity-depth-error-budget"
date: 2026-05-13T09:04:13+08:00
draft: false
description: "从双目基线、极线校正、视差搜索到 Z = fB / d 的误差传播，系统拆解 OpenCV 双目标定为何本质上是在给深度估计做几何预算。"
tags: ["OpenCV", "双目标定", "立体视觉", "深度重建", "误差传播"]
categories: ["技能档案"]
image: ""
---

## 技能概述

双目标定真正解决的，不是“把两路摄像头同时打开”这么表面的软件问题，而是让一套视觉系统第一次具备可靠的深度感。无论是双目测距、机械臂抓取、AGV 对位、边缘端避障，还是低成本三维重建，核心痛点都不在于能否算出一张视差图，而在于系统是否真的理解了两颗镜头之间的**基线长度**、两路曝光之间的**时间一致性**、极线校正后的**一维对应关系**，以及视差量化误差如何被放大成厘米级甚至米级的深度漂移。双目视觉本质上不是图像技巧，而是一份关于空间几何、同步时序与误差预算的物理合同。

## 核心底层概念解析

- **双目不是两张图片，而是两条光线对同一物点的三角测量**：左目和右目各自只看到二维像素，但同一个空间点会在两块成像平面上留下两个投影。双目重建做的事，不是“猜这个点多远”，而是利用两条已知姿态的观测射线去求它们在空间中的交会关系。
- **基线 `B` 决定了系统的深度杠杆，不是越大越好，也不是越小越稳**：`B` 太小，远距离目标的视差过于接近量化台阶，深度分辨率塌陷；`B` 太大，左右视场重叠变小，遮挡和匹配失败会急剧增加。基线不是机械安装尺寸那么简单，它是深度灵敏度和可匹配视场之间的工程折中。
- **极线约束把二维搜索压缩成一维搜索，是双目可实时化的前提**：未校正前，同一物点在左右图上的对应点可能沿任意方向漂移；完成 **极线校正** 后，理想情况下对应点应落在同一行，匹配问题从二维窗口搜索收缩为单行位移搜索。校正不是“把图拉正”，而是把几何自由度从 2D 压回 1D。
- **视差 `d` 是深度的倒数量纲，不是图像上的一个普通像素差**：在校正后的双目模型里，常用近似关系是 `Z = f_x * B / d`。这里的 `f_x` 是校正后左目的等效焦距，`B` 是左右相机光心间基线，`d = u_l - u_r` 是同一行上的像素位移。它直接揭示了一个事实：深度不是与视差线性相关，而是与视差成反比。
- **误差传播的主导项不是标定 RMS，而是 `d` 进入分母后的平方放大**：对 `Z = f_x * B / d` 求微分，可得 `Delta Z ≈ (f_x * B / d^2) * Delta d`，等价地也可写成 `Delta Z ≈ (Z^2 / (f_x * B)) * Delta d`。这意味着同样的 `0.25 px` 亚像素误差，在近距离可能只是毫米级波动，在远距离却会被放大为成倍增长的深度不确定性。
- **亚像素视差不是锦上添花，而是远距深度是否可用的生死线**：若视差只保留整数像素，系统的最小深度台阶就被硬性钉死在 `1 px`。当目标越来越远时，真实视差越来越小，整数化会让深度输出出现严重跳变，因此 `StereoSGBM` 这类算法内部常以 `1/16 px` 或更细的固定点尺度表示视差。
- **双目标定不只是在求两套内参，还在声明两颗相机之间的刚体关系**：单目标定给出各自的 `K` 与畸变参数，双目标定再求出左右相机之间的 `R`、`T`、`E`、`F`。其中 `T` 的模长就是基线，`R` 决定两路视轴的夹角，`F` 和 `E` 则描述了像点与极线之间的几何约束。缺任何一项，后续的校正和重建都只是近似拼接。
- **校正质量不能只看重投影 RMS，还要看校正后的垂直残差**：很多项目只盯着 `stereoCalibrate()` 返回的 RMS，却忽略了校正后同名角点是否还存在明显的行方向偏差。对双目系统来说，`|y_l' - y_r'|` 的平均值常常比单一 RMS 更接近真实匹配难度，因为它直接决定代价体是不是还能安全地只沿行搜索。
- **同步和曝光是双目几何的隐藏前提**：如果左右图像不是同一时刻曝光，快速运动目标在左右目看到的就不是同一空间状态，视差不再只是几何位移，还混进了时间位移。滚动快门、主从触发抖动、曝光不一致和自动增益差异，都会让本来应由标定解释的问题，退化成无法建模的匹配噪声。
- **纹理稀缺、遮挡和反射不是算法边角料，而是视差图里的不可观测区域**：白墙、金属反光、重复纹理和遮挡边界会让匹配代价函数出现多个近似最优解，或者根本没有有效对应点。左一致性检查、唯一性约束、散斑过滤和 ROI 裁剪，本质上都在回答一个问题：哪些像素根本不具备稳定的深度可观测性。
- **双目深度的工程哲学，不是“把 3D 算出来”，而是知道哪些 3D 值值得信、哪些必须丢**：一张视差图里最危险的不是空洞，而是看起来连续、实际上来自错误匹配的伪深度。真正可靠的系统，宁可主动输出“这里不可测”，也不应把不满足几何与误差预算的点伪装成可用距离。

## 代码能力展现

下面给出一个基于 OpenCV C++ 的双目标定与单点深度估计示例。代码覆盖四条关键链路：**棋盘格双目标定**、**极线校正残差评估**、**校正后视差计算**、**从视差到三维点与深度不确定度的映射**。重点不是把 API 串起来，而是把 `Z = f_x * B / d` 背后的几何预算、亚像素量化和边界保护写进实现里。

```cpp
#include <opencv2/calib3d.hpp>
#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <utility>
#include <vector>

struct StereoFramePair
{
    std::string left_path;
    std::string right_path;
};

struct StereoCalibrationConfig
{
    cv::Size board_size;                 // 棋盘格内角点，例如 9x6
    float square_size_mm;                // 每个方格的物理边长，单位 mm
    int min_valid_pairs;                 // 参与双目标定的最少有效图像对数
    double max_stereo_rms_px;            // 可接受的双目标定 RMS 上限
    double max_rectified_y_error_px;     // 校正后左右同名点平均行误差上限
    int min_disparity_px;                // SGBM 最小视差
    int num_disparities_px;              // SGBM 视差搜索范围，必须为 16 的倍数
    int block_size_px;                   // 匹配块大小，必须为奇数
    float disparity_sigma_px;            // 经验性亚像素视差标准差
    float min_valid_disparity_px;        // 视差小于该值时视为远距失真或无效
    float max_depth_mm;                  // 最大可信深度上限
};

struct StereoCalibrationResult
{
    cv::Size image_size;
    cv::Mat k_left;
    cv::Mat d_left;
    cv::Mat k_right;
    cv::Mat d_right;
    cv::Mat r_left_to_right;
    cv::Mat t_left_to_right;
    cv::Mat essential;
    cv::Mat fundamental;
    cv::Mat r1;
    cv::Mat r2;
    cv::Mat p1;
    cv::Mat p2;
    cv::Mat q;
    double mono_rms_left_px;
    double mono_rms_right_px;
    double stereo_rms_px;
    double rectified_y_error_px;
    double baseline_mm;
};

struct DepthEstimate
{
    bool valid;
    float disparity_px;
    float depth_mm;
    float depth_sigma_mm;
    cv::Point3f point_left_rect_mm;
};

/**
 * @brief 构造棋盘格在世界坐标系中的平面对象点。
 * @param config 双目标定配置，内部包含角点尺寸与方格边长。
 * @return Z=0 平面上的对象点数组，单位 mm。
 *
 * @note 对象点定义为：
 *       P_w(r, c) = [c * square_size, r * square_size, 0]^T
 *       square_size 决定了后续平移向量 T 与基线 B 的物理尺度。
 */
static std::vector<cv::Point3f> BuildBoardModel(const StereoCalibrationConfig &config)
{
    const int board_w = std::max(config.board_size.width, 2);
    const int board_h = std::max(config.board_size.height, 2);
    const float square_size_mm = std::clamp(config.square_size_mm, 0.1f, 200.0f);
    std::vector<cv::Point3f> points;

    points.reserve(static_cast<size_t>(board_w * board_h));

    for (int row = 0; row < board_h; ++row)
    {
        for (int col = 0; col < board_w; ++col)
        {
            points.emplace_back(static_cast<float>(col) * square_size_mm,
                                static_cast<float>(row) * square_size_mm,
                                0.0f);
        }
    }

    return points;
}

/**
 * @brief 提取棋盘格角点并进一步做亚像素细化。
 * @param gray 输入灰度图像。
 * @param board_size 棋盘格内角点尺寸。
 * @param out_corners 输出角点。
 * @retval true 找到完整角点并细化成功。
 * @retval false 角点不完整、图像为空或质量不足。
 *
 * @note 角点若仅停留在整数像素，后续深度链路会把这部分量化误差经由
 *       `Delta Z ≈ (Z^2 / (f_x * B)) * Delta d` 非线性放大。
 */
static bool FindChessboardCornersSubPix(const cv::Mat &gray,
                                        const cv::Size &board_size,
                                        std::vector<cv::Point2f> *out_corners)
{
    std::vector<cv::Point2f> corners;
    const cv::Size safe_board_size(std::max(board_size.width, 2), std::max(board_size.height, 2));
    const int flags = cv::CALIB_CB_ADAPTIVE_THRESH
                    | cv::CALIB_CB_NORMALIZE_IMAGE
                    | cv::CALIB_CB_FAST_CHECK;

    if ((out_corners == nullptr) || gray.empty() || (gray.type() != CV_8UC1))
    {
        return false;
    }

    if (!cv::findChessboardCorners(gray, safe_board_size, corners, flags))
    {
        return false;
    }

    cv::cornerSubPix(gray,
                     corners,
                     cv::Size(11, 11),
                     cv::Size(-1, -1),
                     cv::TermCriteria(cv::TermCriteria::COUNT + cv::TermCriteria::EPS, 30, 0.01));

    *out_corners = std::move(corners);
    return true;
}

/**
 * @brief 评估极线校正后的平均垂直残差。
 * @param left_points 左目角点集合。
 * @param right_points 右目角点集合。
 * @param calib 双目标定结果。
 * @return 校正后平均绝对行误差，单位 px。
 *
 * @note 使用 `undistortPoints(..., R1, P1)` 与 `undistortPoints(..., R2, P2)` 将点映射到
 *       校正图平面后，理论上有 `y_l' ≈ y_r'`。该误差越小，后续视差搜索越接近真正的一维问题。
 */
static double ComputeRectifiedAverageYError(
    const std::vector<std::vector<cv::Point2f>> &left_points,
    const std::vector<std::vector<cv::Point2f>> &right_points,
    const StereoCalibrationResult &calib)
{
    double abs_error_sum = 0.0;
    size_t total_points = 0U;

    for (size_t i = 0U; i < left_points.size(); ++i)
    {
        std::vector<cv::Point2f> rect_left;
        std::vector<cv::Point2f> rect_right;

        cv::undistortPoints(left_points[i],
                            rect_left,
                            calib.k_left,
                            calib.d_left,
                            calib.r1,
                            calib.p1);

        cv::undistortPoints(right_points[i],
                            rect_right,
                            calib.k_right,
                            calib.d_right,
                            calib.r2,
                            calib.p2);

        for (size_t j = 0U; j < rect_left.size(); ++j)
        {
            abs_error_sum += std::fabs(static_cast<double>(rect_left[j].y) - static_cast<double>(rect_right[j].y));
        }

        total_points += rect_left.size();
    }

    if (total_points == 0U)
    {
        return std::numeric_limits<double>::infinity();
    }

    return abs_error_sum / static_cast<double>(total_points);
}

/**
 * @brief 运行完整双目标定流程，并生成极线校正所需参数。
 * @param frame_pairs 左右棋盘格图像对列表。
 * @param config 双目标定配置。
 * @param out_result 输出标定结果。
 * @retval true 标定成功，且 RMS 与校正行误差均在阈值内。
 * @retval false 有效图像对不足、尺寸不一致、优化失败或误差超限。
 *
 * @note 推荐流程是：
 *       1. 分别单目标定左右相机，获得各自内参与畸变。
 *       2. 固定内参，运行 stereoCalibrate 求相对位姿 R/T。
 *       3. stereoRectify 生成 R1/R2/P1/P2/Q，使对应点尽量共行。
 */
bool RunStereoCalibration(const std::vector<StereoFramePair> &frame_pairs,
                          const StereoCalibrationConfig &config,
                          StereoCalibrationResult *out_result)
{
    const int min_pairs = std::clamp(config.min_valid_pairs, 8, 128);
    const double max_rms = std::clamp(config.max_stereo_rms_px, 0.1, 3.0);
    const double max_rectified_y_err = std::clamp(config.max_rectified_y_error_px, 0.05, 2.0);
    const std::vector<cv::Point3f> board_model = BuildBoardModel(config);
    std::vector<std::vector<cv::Point3f>> object_points;
    std::vector<std::vector<cv::Point2f>> left_points;
    std::vector<std::vector<cv::Point2f>> right_points;
    cv::Size image_size;

    if ((out_result == nullptr) || frame_pairs.empty())
    {
        return false;
    }

    for (const StereoFramePair &pair : frame_pairs)
    {
        cv::Mat left_gray = cv::imread(pair.left_path, cv::IMREAD_GRAYSCALE);
        cv::Mat right_gray = cv::imread(pair.right_path, cv::IMREAD_GRAYSCALE);
        std::vector<cv::Point2f> corners_left;
        std::vector<cv::Point2f> corners_right;

        if (left_gray.empty() || right_gray.empty())
        {
            continue;
        }

        if (left_gray.size() != right_gray.size())
        {
            continue;
        }

        if (image_size.empty())
        {
            image_size = left_gray.size();
        }
        else if (left_gray.size() != image_size)
        {
            /* 分辨率变化会直接改变像素坐标系尺度，不能混入同一批次优化。 */
            continue;
        }

        if (!FindChessboardCornersSubPix(left_gray, config.board_size, &corners_left) ||
            !FindChessboardCornersSubPix(right_gray, config.board_size, &corners_right))
        {
            continue;
        }

        object_points.push_back(board_model);
        left_points.push_back(std::move(corners_left));
        right_points.push_back(std::move(corners_right));
    }

    if (static_cast<int>(left_points.size()) < min_pairs)
    {
        return false;
    }

    out_result->image_size = image_size;
    out_result->k_left = cv::Mat::eye(3, 3, CV_64F);
    out_result->d_left = cv::Mat::zeros(5, 1, CV_64F);
    out_result->k_right = cv::Mat::eye(3, 3, CV_64F);
    out_result->d_right = cv::Mat::zeros(5, 1, CV_64F);

    {
        std::vector<cv::Mat> rvecs;
        std::vector<cv::Mat> tvecs;

        out_result->mono_rms_left_px = cv::calibrateCamera(object_points,
                                                           left_points,
                                                           image_size,
                                                           out_result->k_left,
                                                           out_result->d_left,
                                                           rvecs,
                                                           tvecs);

        out_result->mono_rms_right_px = cv::calibrateCamera(object_points,
                                                            right_points,
                                                            image_size,
                                                            out_result->k_right,
                                                            out_result->d_right,
                                                            rvecs,
                                                            tvecs);
    }

    out_result->stereo_rms_px = cv::stereoCalibrate(object_points,
                                                    left_points,
                                                    right_points,
                                                    out_result->k_left,
                                                    out_result->d_left,
                                                    out_result->k_right,
                                                    out_result->d_right,
                                                    image_size,
                                                    out_result->r_left_to_right,
                                                    out_result->t_left_to_right,
                                                    out_result->essential,
                                                    out_result->fundamental,
                                                    cv::CALIB_FIX_INTRINSIC,
                                                    cv::TermCriteria(cv::TermCriteria::COUNT + cv::TermCriteria::EPS,
                                                                     100,
                                                                     1.0e-6));

    cv::stereoRectify(out_result->k_left,
                      out_result->d_left,
                      out_result->k_right,
                      out_result->d_right,
                      image_size,
                      out_result->r_left_to_right,
                      out_result->t_left_to_right,
                      out_result->r1,
                      out_result->r2,
                      out_result->p1,
                      out_result->p2,
                      out_result->q,
                      cv::CALIB_ZERO_DISPARITY,
                      0.0,
                      image_size);

    out_result->baseline_mm = cv::norm(out_result->t_left_to_right);
    out_result->rectified_y_error_px = ComputeRectifiedAverageYError(left_points, right_points, *out_result);

    return std::isfinite(out_result->stereo_rms_px)
        && std::isfinite(out_result->rectified_y_error_px)
        && (out_result->baseline_mm > 1.0)
        && (out_result->stereo_rms_px <= max_rms)
        && (out_result->rectified_y_error_px <= max_rectified_y_err);
}

/**
 * @brief 对一对原始图像执行极线校正。
 * @param left_raw 原始左图。
 * @param right_raw 原始右图。
 * @param calib 双目标定结果。
 * @param out_left_rect 输出左校正图。
 * @param out_right_rect 输出右校正图。
 * @retval true 校正成功。
 * @retval false 输入图像非法或尺寸与标定结果不匹配。
 *
 * @note 生产系统应缓存 remap 所需的 map1/map2，而不是每帧重建。
 *       这里直接展开，是为了把几何校正逻辑写清楚。
 */
bool RectifyStereoPair(const cv::Mat &left_raw,
                       const cv::Mat &right_raw,
                       const StereoCalibrationResult &calib,
                       cv::Mat *out_left_rect,
                       cv::Mat *out_right_rect)
{
    cv::Mat map_l1;
    cv::Mat map_l2;
    cv::Mat map_r1;
    cv::Mat map_r2;

    if ((out_left_rect == nullptr) || (out_right_rect == nullptr))
    {
        return false;
    }

    if (left_raw.empty() || right_raw.empty() ||
        (left_raw.size() != calib.image_size) ||
        (right_raw.size() != calib.image_size))
    {
        return false;
    }

    cv::initUndistortRectifyMap(calib.k_left,
                                calib.d_left,
                                calib.r1,
                                calib.p1,
                                calib.image_size,
                                CV_16SC2,
                                map_l1,
                                map_l2);

    cv::initUndistortRectifyMap(calib.k_right,
                                calib.d_right,
                                calib.r2,
                                calib.p2,
                                calib.image_size,
                                CV_16SC2,
                                map_r1,
                                map_r2);

    cv::remap(left_raw, *out_left_rect, map_l1, map_l2, cv::INTER_LINEAR);
    cv::remap(right_raw, *out_right_rect, map_r1, map_r2, cv::INTER_LINEAR);
    return true;
}

/**
 * @brief 基于校正后的双目灰度图计算亚像素视差图。
 * @param left_rect 左校正灰度图。
 * @param right_rect 右校正灰度图。
 * @param config 视差计算配置。
 * @param out_disparity_px 输出视差图，单位 px，类型 CV_32F。
 * @retval true 视差图计算成功。
 * @retval false 图像非法或参数越界。
 *
 * @note OpenCV 的 SGBM 默认输出 4 位小数固定点，常见缩放关系是：
 *       disparity_px = disparity_raw / 16
 *       这正对应“以 1/16 px 作为亚像素台阶”的量化设计。
 */
bool ComputeDisparitySgbm(const cv::Mat &left_rect,
                          const cv::Mat &right_rect,
                          const StereoCalibrationConfig &config,
                          cv::Mat *out_disparity_px)
{
    cv::Mat disparity_raw;
    const int block_size = std::clamp(config.block_size_px | 1, 3, 21);
    const int num_disparities = std::max(16, ((config.num_disparities_px + 15) / 16) * 16);
    const int channels = 1;
    cv::Ptr<cv::StereoSGBM> matcher;

    if ((out_disparity_px == nullptr) ||
        left_rect.empty() ||
        right_rect.empty() ||
        (left_rect.type() != CV_8UC1) ||
        (right_rect.type() != CV_8UC1))
    {
        return false;
    }

    matcher = cv::StereoSGBM::create(config.min_disparity_px,
                                     num_disparities,
                                     block_size);

    matcher->setP1(8 * channels * block_size * block_size);
    matcher->setP2(32 * channels * block_size * block_size);
    matcher->setDisp12MaxDiff(1);
    matcher->setPreFilterCap(31);
    matcher->setUniquenessRatio(10);
    matcher->setSpeckleWindowSize(80);
    matcher->setSpeckleRange(2);
    matcher->setMode(cv::StereoSGBM::MODE_SGBM_3WAY);

    matcher->compute(left_rect, right_rect, disparity_raw);

    if (disparity_raw.empty())
    {
        return false;
    }

    disparity_raw.convertTo(*out_disparity_px, CV_32F, 1.0 / 16.0);
    return true;
}

/**
 * @brief 从校正后的视差图中估计单点深度及其一阶误差传播结果。
 * @param disparity_px 视差图，类型 CV_32F，单位 px。
 * @param pixel 左校正图中的采样像素点。
 * @param calib 双目标定结果。
 * @param config 视差与深度约束配置。
 * @param out_depth 输出深度结果。
 * @retval true 深度估计可信。
 * @retval false 视差无效、像素越界、深度超限或误差过大。
 *
 * @note 使用的核心映射关系为：
 *       Z = f_x * B / d
 *       X = (u - c_x) * Z / f_x
 *       Y = (v - c_y) * Z / f_y
 *       一阶误差传播：
 *       Delta Z ≈ |dZ/dd| * Delta d = (f_x * B / d^2) * Delta d
 *       这里显式将 `disparity_sigma_px` 注入深度不确定度，避免把远距伪深度当真值使用。
 */
bool EstimateDepthAtPixel(const cv::Mat &disparity_px,
                          const cv::Point &pixel,
                          const StereoCalibrationResult &calib,
                          const StereoCalibrationConfig &config,
                          DepthEstimate *out_depth)
{
    const double fx = calib.p1.at<double>(0, 0);
    const double fy = calib.p1.at<double>(1, 1);
    const double cx = calib.p1.at<double>(0, 2);
    const double cy = calib.p1.at<double>(1, 2);
    const float min_disp = std::max(config.min_valid_disparity_px, 0.1f);
    const float max_depth_mm = std::max(config.max_depth_mm, 10.0f);
    float disparity_sum = 0.0f;
    int valid_count = 0;

    if ((out_depth == nullptr) ||
        disparity_px.empty() ||
        (disparity_px.type() != CV_32F))
    {
        return false;
    }

    if ((pixel.x < 1) || (pixel.y < 1) ||
        (pixel.x >= disparity_px.cols - 1) ||
        (pixel.y >= disparity_px.rows - 1))
    {
        return false;
    }

    *out_depth = DepthEstimate{};

    for (int dy = -1; dy <= 1; ++dy)
    {
        for (int dx = -1; dx <= 1; ++dx)
        {
            const float d = disparity_px.at<float>(pixel.y + dy, pixel.x + dx);

            if (std::isfinite(d) && (d >= min_disp))
            {
                disparity_sum += d;
                valid_count++;
            }
        }
    }

    if (valid_count < 5)
    {
        return false;
    }

    out_depth->disparity_px = disparity_sum / static_cast<float>(valid_count);

    if (out_depth->disparity_px < min_disp)
    {
        return false;
    }

    out_depth->depth_mm = static_cast<float>((fx * calib.baseline_mm) / static_cast<double>(out_depth->disparity_px));
    out_depth->depth_sigma_mm = static_cast<float>((fx * calib.baseline_mm * config.disparity_sigma_px) /
                                                   (static_cast<double>(out_depth->disparity_px) *
                                                    static_cast<double>(out_depth->disparity_px)));

    if (!std::isfinite(out_depth->depth_mm) ||
        !std::isfinite(out_depth->depth_sigma_mm) ||
        (out_depth->depth_mm <= 0.0f) ||
        (out_depth->depth_mm > max_depth_mm) ||
        (out_depth->depth_sigma_mm > (0.25f * out_depth->depth_mm)))
    {
        return false;
    }

    out_depth->point_left_rect_mm.x =
        static_cast<float>(((static_cast<double>(pixel.x) - cx) * out_depth->depth_mm) / fx);
    out_depth->point_left_rect_mm.y =
        static_cast<float>(((static_cast<double>(pixel.y) - cy) * out_depth->depth_mm) / fy);
    out_depth->point_left_rect_mm.z = out_depth->depth_mm;
    out_depth->valid = true;
    return true;
}

/**
 * @brief 示例：执行双目标定、极线校正、视差计算与中心点深度估计。
 *
 * @note 这条链路展示的不是“怎么调一个 OpenCV Demo”，而是如何把
 *       机械基线、校正矩阵、亚像素视差和误差阈值收束为一个可审计的深度输出。
 */
void Example_RunStereoDepthPipeline(void)
{
    const StereoCalibrationConfig config{
        cv::Size(9, 6),
        24.0f,      // 棋盘格方格边长 24 mm
        14,         // 至少 14 对有效标定图像
        0.70,       // 双目标定 RMS 上限
        0.20,       // 校正后平均行误差上限
        0,          // SGBM 最小视差
        128,        // 视差搜索范围，必须为 16 的倍数
        5,          // 匹配块大小
        0.25f,      // 经验性亚像素视差标准差
        1.0f,       // 小于 1 px 的视差不再可信
        5000.0f     // 最大可信深度 5 m
    };

    const std::vector<StereoFramePair> calibration_pairs{
        {"calib/left_01.png", "calib/right_01.png"},
        {"calib/left_02.png", "calib/right_02.png"},
        {"calib/left_03.png", "calib/right_03.png"},
        {"calib/left_04.png", "calib/right_04.png"},
        {"calib/left_05.png", "calib/right_05.png"},
        {"calib/left_06.png", "calib/right_06.png"},
        {"calib/left_07.png", "calib/right_07.png"},
        {"calib/left_08.png", "calib/right_08.png"},
        {"calib/left_09.png", "calib/right_09.png"},
        {"calib/left_10.png", "calib/right_10.png"},
        {"calib/left_11.png", "calib/right_11.png"},
        {"calib/left_12.png", "calib/right_12.png"},
        {"calib/left_13.png", "calib/right_13.png"},
        {"calib/left_14.png", "calib/right_14.png"}
    };

    StereoCalibrationResult calib;
    cv::Mat left_raw;
    cv::Mat right_raw;
    cv::Mat left_rect;
    cv::Mat right_rect;
    cv::Mat disparity_px;
    DepthEstimate depth;

    if (!RunStereoCalibration(calibration_pairs, config, &calib))
    {
        return;
    }

    left_raw = cv::imread("runtime/left_runtime.png", cv::IMREAD_GRAYSCALE);
    right_raw = cv::imread("runtime/right_runtime.png", cv::IMREAD_GRAYSCALE);

    if (!RectifyStereoPair(left_raw, right_raw, calib, &left_rect, &right_rect))
    {
        return;
    }

    if (!ComputeDisparitySgbm(left_rect, right_rect, config, &disparity_px))
    {
        return;
    }

    /* 以图像中心附近一点为例，估计它在左校正相机坐标系中的三维位置。 */
    if (!EstimateDepthAtPixel(disparity_px,
                              cv::Point(left_rect.cols / 2, left_rect.rows / 2),
                              calib,
                              config,
                              &depth))
    {
        return;
    }

    /* depth.point_left_rect_mm 即为校正后左目坐标系下的三维点；
     * depth.depth_sigma_mm 则给出由亚像素视差误差传播得到的深度不确定度。
     * 工程上应优先使用“值 + 可信区间”，而不是只消费一个看似精确的 Z。 */
    (void)depth;
}
```

这段实现真正想强调的，不是“双目深度也能用 OpenCV 跑出来”，而是**双目深度一旦进入工程系统，就必须被当成误差会被平方放大的几何测量链路**。标定决定两颗相机有没有共同坐标语义，校正决定匹配是否还能退化为单行搜索，视差量化决定远距深度能不能避免台阶跳变，而深度不确定度门限决定哪些 3D 点有资格进入后续控制或感知融合。真正硬核的双目系统，从来不是把彩色图变成立体图，而是知道哪一份深度值配得上“可用”这两个字。
