---
title: "技能档案：OpenCV 单目 PnP 的共面退化、条件数与姿态翻转判据"
slug: "skill-opencv-planar-pnp-degeneracy-condition-number-and-pose-flip-criteria"
date: 2026-05-31T16:44:30+08:00
draft: false
description: "从平面靶标的单应约束、IPPE 双解、法向可观测度到重投影与时间连续性判据，系统拆解单目 PnP 为何总在接近正视、远距与低纹理条件下发生姿态翻转。"
tags: ["OpenCV", "PnP", "相机标定", "姿态估计", "平面退化", "机器视觉", "边缘计算"]
categories: ["技能档案", "机器视觉", "控制与融合"]
image: ""
---

## 技能概述
单目 PnP 在机械臂抓取、AprilTag 定位、视觉对位、桌面装配和移动机器人落点估计里几乎无处不在，但工程里最难处理的并不是 `solvePnP()` 能不能返回一个 `rvec/tvec`，而是当目标点几乎共面、视角接近正视、距离拉远或角点噪声上升时，系统为什么会突然把法向翻到另一侧，让姿态在相邻两帧之间发生近似 180 度的“抽搐”。这个主题真正解决的痛点，是把单目位姿求解从“API 输出一个姿态”提升到“系统知道何时该相信、何时该降权、何时该冻结”的可观测性管理问题。

## 核心底层概念解析

- **共面靶标不是普通点集，而是把三维约束压扁成二维单应关系**：当所有物点都落在 `Z_w = 0` 的同一平面上时，投影关系会退化成 `s p ~ H P_plane`。此时相机并不是直接从完整 3D 点云里恢复姿态，而是在单应矩阵的分解空间里挑一个与成像一致的外参解释。问题从“三维点定姿态”变成了“由一个近似二维映射反推三维姿态”。
- **平面 PnP 的病根不是算法差，而是法向方向的可观测度先天更弱**：对共面点来说，平面内平移和绕光轴的旋转通常比“法向前后倾斜”更容易被像素变化感知。接近正视时，平面法向与光轴几乎同向，绕平面内轴的细小姿态扰动投影到图像上只剩下很弱的二阶变化，优化器此时更像是在一个扁平盆地里找最低点。
- **所谓姿态翻转，往往不是 `rvec` 随机跳了，而是两个近似等价解在噪声下互相换位**：平面场景里常见两个都满足正深度约束的候选姿态，它们对角点的重投影误差非常接近。`IPPE` 之类算法会显式给出双解，`ITERATIVE` 则可能在数值优化过程中隐式落入另一侧盆地。只要两个解的代价差比角点噪声还小，上一帧在解 A，下一帧掉到解 B 并不奇怪。
- **正视角是最危险的，不是因为图像最规整，而是因为透视差最弱**：当平面几乎正对相机时，四边形的投影更接近平行缩放，透视汇聚信息减少。此时由单应矩阵恢复出的旋转列向量与尺度因子之间更容易耦合，任何亚像素误差都可能被解释成“法向略偏左”或“法向略偏右”的两套故事。
- **距离变远本质上是在缩小基线，不是单纯把目标变小**：如果目标边长为 `L`、相机到平面距离为 `Z`，则单位角度扰动映射到图像上的尺度近似与 `f * L / Z^2` 相关。`Z` 上去以后，平面法向变化带来的像素位移衰减得比线性更快，于是角点提取噪声、去畸变误差和滚动快门时序误差很容易盖过真实姿态信号。
- **条件数不是数学洁癖，而是“这组角点到底有没有足够几何分离度”的量化方式**：无论你从单应 DLT 还是从 LM 优化的雅可比矩阵出发，本质都在问“不同参数方向是否会在像素域产生足够不同的响应”。当最小奇异值很小、条件数爆炸时，说明某些姿态自由度几乎不可辨识，优化器微小的输入扰动就可能换来巨大的输出姿态跳变。
- **重投影误差小不代表姿态可信，它只代表至少有一套解释把像素拟合得不错**：平面退化场景里，错误解和正确解都可能把四个角点压到 0.2 px 以内。只看 `RMS` 容易误判，因为像素域的局部最优不自动等价于时序上的稳定或物理上的唯一。工程上必须把重投影误差与双解间隔、法向朝向、时间连续性一起看。
- **法向朝向约束本质上是把视觉问题重新接回物理世界**：如果你知道标签一定贴在桌面上方、相机一定在工位上方看下去，那么平面法向与相机光轴的夹角、标签中心深度符号、目标相对桌面的先验朝向都可以成为解筛选条件。视觉给出的是候选几何，系统必须用物理常识做裁判。
- **时间连续性不是“滤波润色”，而是识别错误跳解的第一道防线**：真实机械系统的姿态变化速率有限，因此 `R_k` 与 `R_{k-1}` 的夹角、`t_k` 与 `t_{k-1}` 的速度上界都应满足约束。如果某一帧的候选姿态虽然重投影略好，但要求标签在 10 ms 内翻转 120 度，那它大概率不是观测进步，而是数值退化。
- **角点分布决定了你在求姿态还是在赌运气**：点越靠外、覆盖面积越大、长宽比越健康，对平面姿态越有利。四个点都挤在中心小 ROI，或者目标在图像中只占几十像素，等价于主动降低了法向估计的杠杆臂。很多“算法不稳”其实是靶标设计和成像尺度先失职。
- **去畸变与亚像素精炼不是配角，因为退化边界首先吞噬的就是细微信号**：平面 PnP 在危险区依赖的正是极小的透视差与角点位移，如果畸变模型不准、边缘角点带系统偏差，或者二值标签角点只做到整数像素，最先丢掉的就是本来已经很脆弱的法向信息。
- **真正的工程哲学不是“求一个姿态”，而是“维护一份姿态可信度预算”**：单目平面位姿从来不只是几何问题，它是光学、像素噪声、靶标尺度、机械先验和时间连续性共同签署的一份合同。合同快失效时，稳健系统应该主动降级，比如冻结姿态、仅更新平面内平移、要求重新观测，而不是硬把一个抖动解送进控制闭环。

## 代码能力展现

下面给出一个基于 OpenCV C++ 的平面靶标姿态守卫实现。它不满足于“调用一次 `solvePnP()`”，而是把 **单应矩阵分解的病态程度、`IPPE` 双解、重投影误差、法向可观测度与时间连续性** 串成一条完整的判定链。代码假设你已经拿到了去畸变前的角点像素坐标，目标是一个 `Z = 0` 平面上的矩形靶标；系统输出的不仅是一组 `rvec/tvec`，还包括“这次结果值不值得进闭环”的诊断信号。

```cpp
#include <opencv2/calib3d.hpp>
#include <opencv2/core.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

struct PlanarTargetConfig
{
    float width_mm;                         // 平面靶标物理宽度
    float height_mm;                        // 平面靶标物理高度
    float max_mean_reproj_px;               // 单解可接受的平均重投影误差上限
    float max_dual_error_gap_px;            // 双解误差接近阈值，小于该值说明存在翻转风险
    float min_normal_cosine;                // 法向与相机光轴夹角余弦下限，过小表示近乎掠视
    float min_observability_score;          // 透视可观测度下限
    float max_condition_number;             // 单应 DLT 条件数上限
    float max_rotation_step_deg;            // 相邻两帧允许的最大姿态变化
    float max_translation_step_mm;          // 相邻两帧允许的最大平移变化
};

struct PoseCandidate
{
    cv::Mat rvec;
    cv::Mat tvec;
    float mean_reproj_px;
    float normal_cosine;
    float observability_score;
    bool valid;
};

struct PoseState
{
    cv::Mat rvec;
    cv::Mat tvec;
    bool initialized;
};

struct PlanarPoseEstimate
{
    cv::Mat rvec;
    cv::Mat tvec;
    float mean_reproj_px;
    float dual_error_gap_px;
    float normal_cosine;
    float observability_score;
    float homography_condition_number;
    bool ambiguous_dual_solution;
    bool continuity_rejected;
    bool degraded;
    bool valid;
};

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

static std::vector<cv::Point3f> BuildPlanarRectModel(float width_mm, float height_mm)
{
    const float safe_width = ClampFloat(width_mm, 1.0f, 10000.0f);
    const float safe_height = ClampFloat(height_mm, 1.0f, 10000.0f);
    const float half_w = safe_width * 0.5f;
    const float half_h = safe_height * 0.5f;

    return {
        cv::Point3f(-half_w, -half_h, 0.0f),
        cv::Point3f( half_w, -half_h, 0.0f),
        cv::Point3f( half_w,  half_h, 0.0f),
        cv::Point3f(-half_w,  half_h, 0.0f)
    };
}

/**
 * @brief 计算位姿候选对当前角点的平均重投影误差。
 * @param object_points 平面靶标物点，要求共面且与图像角点一一对应。
 * @param image_points 图像角点像素坐标。
 * @param camera_matrix 相机内参矩阵。
 * @param distortion_coeffs 畸变参数。
 * @param rvec 候选旋转向量。
 * @param tvec 候选平移向量。
 * @return 平均重投影误差，单位 px；若输入非法则返回正无穷。
 *
 * @note 误差定义为：
 *       e_mean = (1 / N) * sum ||p_obs_i - p_proj_i||
 *       这里故意使用平均绝对范数而非 RMS，是因为工程阈值常直接按“平均偏了多少像素”来制定。
 */
static float ComputeMeanReprojectionError(const std::vector<cv::Point3f> &object_points,
                                          const std::vector<cv::Point2f> &image_points,
                                          const cv::Mat &camera_matrix,
                                          const cv::Mat &distortion_coeffs,
                                          const cv::Mat &rvec,
                                          const cv::Mat &tvec)
{
    std::vector<cv::Point2f> projected;
    double sum_error = 0.0;

    if ((object_points.size() != image_points.size()) || object_points.empty())
    {
        return std::numeric_limits<float>::infinity();
    }

    cv::projectPoints(object_points, rvec, tvec, camera_matrix, distortion_coeffs, projected);
    if (projected.size() != image_points.size())
    {
        return std::numeric_limits<float>::infinity();
    }

    for (size_t i = 0U; i < projected.size(); ++i)
    {
        const cv::Point2f delta = image_points[i] - projected[i];
        sum_error += std::sqrt(static_cast<double>(delta.x) * static_cast<double>(delta.x) +
                               static_cast<double>(delta.y) * static_cast<double>(delta.y));
    }

    return static_cast<float>(sum_error / static_cast<double>(projected.size()));
}

static cv::Vec3f RotationVectorToNormalCamera(const cv::Mat &rvec)
{
    cv::Mat rotation_matrix;
    cv::Rodrigues(rvec, rotation_matrix);

    /*
     * 世界平面定义在 Z_w = 0，因此其法向为 n_w = [0, 0, 1]^T。
     * 位姿满足 P_c = R * P_w + t，所以相机坐标系下的平面法向为：
     * n_c = R * n_w
     *
     * 当 n_c.z 越接近 1，说明平面越接近正视；
     * 当 n_c.z 越接近 0，说明平面越接近掠视，透视畸变虽强但角点遮挡风险也更高。
     */
    return cv::Vec3f(static_cast<float>(rotation_matrix.at<double>(0, 2)),
                     static_cast<float>(rotation_matrix.at<double>(1, 2)),
                     static_cast<float>(rotation_matrix.at<double>(2, 2)));
}

/**
 * @brief 计算法向可观测度分数，用于识别“几乎正视 + 几乎相似变换”的危险场景。
 * @param image_points 图像角点。
 * @param image_size 图像尺寸。
 * @param normal_camera 平面法向在相机坐标系下的方向。
 * @return [0, 1] 区间内的经验分数，越小表示越接近退化边界。
 *
 * @note 这里的分数不是教科书真值，而是工程近似量：
 *       score = area_norm * perspective_gain
 *       area_norm        = projected_quad_area / image_area
 *       perspective_gain = sqrt(max(0, 1 - n_z^2))
 *
 *       含义分别是：
 *       1. 靶标在图像里占得越大，像素杠杆臂越长；
 *       2. n_z 越接近 1 越正视，透视差越弱；sqrt(1 - n_z^2) 可以近似看作倾角正弦。
 */
static float ComputeObservabilityScore(const std::vector<cv::Point2f> &image_points,
                                       const cv::Size &image_size,
                                       const cv::Vec3f &normal_camera)
{
    double quad_area = 0.0;
    const double image_area = std::max(1, image_size.width * image_size.height);
    const float nz = ClampFloat(normal_camera[2], -1.0f, 1.0f);

    if (image_points.size() < 4U)
    {
        return 0.0f;
    }

    quad_area = std::fabs(cv::contourArea(image_points));

    return ClampFloat(static_cast<float>((quad_area / image_area) *
                                         std::sqrt(std::max(0.0f, 1.0f - (nz * nz)))),
                      0.0f,
                      1.0f);
}

/**
 * @brief 用平面点构造单应 DLT 设计矩阵并估计其条件数。
 * @param object_points 平面物点，仅使用 X/Y 坐标。
 * @param image_points 图像点。
 * @return 设计矩阵的条件数；越大说明解越病态，若失败则返回正无穷。
 *
 * @note 单应方程可写为 p ~ H P，其中 H 有 8 个自由度。
 *       每对对应点提供两行线性约束，DLT 设计矩阵 A 的零空间决定 H。
 *       条件数近似定义为：
 *       cond(A) = sigma_max / sigma_min_nonzero
 *
 *       当 cond(A) 极大时，意味着微小像素扰动就会显著改变估计出的 H，
 *       后续再由 H 分解 R/t 时，姿态跳变风险会被进一步放大。
 */
static float ComputeHomographyConditionNumber(const std::vector<cv::Point3f> &object_points,
                                              const std::vector<cv::Point2f> &image_points)
{
    cv::Mat design;
    cv::Mat w;
    cv::Mat u;
    cv::Mat vt;

    if ((object_points.size() != image_points.size()) || (object_points.size() < 4U))
    {
        return std::numeric_limits<float>::infinity();
    }

    design = cv::Mat::zeros(static_cast<int>(object_points.size() * 2U), 9, CV_64F);

    for (size_t i = 0U; i < object_points.size(); ++i)
    {
        const double X = static_cast<double>(object_points[i].x);
        const double Y = static_cast<double>(object_points[i].y);
        const double u_img = static_cast<double>(image_points[i].x);
        const double v_img = static_cast<double>(image_points[i].y);
        const int row = static_cast<int>(i * 2U);

        design.at<double>(row, 0) = -X;
        design.at<double>(row, 1) = -Y;
        design.at<double>(row, 2) = -1.0;
        design.at<double>(row, 6) = X * u_img;
        design.at<double>(row, 7) = Y * u_img;
        design.at<double>(row, 8) = u_img;

        design.at<double>(row + 1, 3) = -X;
        design.at<double>(row + 1, 4) = -Y;
        design.at<double>(row + 1, 5) = -1.0;
        design.at<double>(row + 1, 6) = X * v_img;
        design.at<double>(row + 1, 7) = Y * v_img;
        design.at<double>(row + 1, 8) = v_img;
    }

    cv::SVD::compute(design, w, u, vt, cv::SVD::NO_UV);
    if (w.rows < 8)
    {
        return std::numeric_limits<float>::infinity();
    }

    /*
     * DLT 的最后一个奇异值对应零空间，本应接近 0。
     * 为避免把理论零空间拿来做分母，这里使用倒数第二个奇异值作为最小非零尺度。
     */
    {
        const double sigma_max = w.at<double>(0, 0);
        const double sigma_min_nonzero = std::max(w.at<double>(w.rows - 2, 0), 1.0e-12);
        return static_cast<float>(sigma_max / sigma_min_nonzero);
    }
}

static double ComputeRotationStepDeg(const cv::Mat &rvec_prev, const cv::Mat &rvec_curr)
{
    cv::Mat r_prev;
    cv::Mat r_curr;
    cv::Mat r_delta;
    cv::Rodrigues(rvec_prev, r_prev);
    cv::Rodrigues(rvec_curr, r_curr);

    r_delta = r_curr * r_prev.t();

    /*
     * 旋转夹角由迹公式给出：
     * theta = acos((trace(R_delta) - 1) / 2)
     */
    {
        const double trace_value = r_delta.at<double>(0, 0) +
                                   r_delta.at<double>(1, 1) +
                                   r_delta.at<double>(2, 2);
        const double cosine_theta = std::clamp((trace_value - 1.0) * 0.5, -1.0, 1.0);
        return std::acos(cosine_theta) * 180.0 / CV_PI;
    }
}

static double ComputeTranslationStepMm(const cv::Mat &tvec_prev, const cv::Mat &tvec_curr)
{
    return cv::norm(tvec_curr - tvec_prev);
}

/**
 * @brief 基于 OpenCV IPPE 双解构造平面位姿候选。
 * @param object_points 平面靶标物点。
 * @param image_points 图像角点。
 * @param camera_matrix 内参矩阵。
 * @param distortion_coeffs 畸变参数。
 * @param image_size 图像尺寸。
 * @param out_candidates 输出两个候选，未使用的位置 valid=false。
 * @retval true 至少得到一个候选。
 * @retval false 输入非法或求解失败。
 *
 * @note 对平面目标，优先使用 SOLVEPNP_IPPE_SQUARE：
 *       - 它显式承认平面问题存在双解；
 *       - 不把“两个都差不多”的情况藏在黑盒迭代器里。
 *
 *       这比直接迷信 ITERATIVE 更符合工程诊断需求。
 */
static bool BuildPoseCandidatesFromIppe(const std::vector<cv::Point3f> &object_points,
                                        const std::vector<cv::Point2f> &image_points,
                                        const cv::Mat &camera_matrix,
                                        const cv::Mat &distortion_coeffs,
                                        const cv::Size &image_size,
                                        std::array<PoseCandidate, 2U> *out_candidates)
{
    std::vector<cv::Mat> rvecs;
    std::vector<cv::Mat> tvecs;

    if ((out_candidates == nullptr) || (object_points.size() != 4U) || (image_points.size() != 4U))
    {
        return false;
    }

    *out_candidates = {};

    if (!cv::solvePnPGeneric(object_points,
                             image_points,
                             camera_matrix,
                             distortion_coeffs,
                             rvecs,
                             tvecs,
                             false,
                             cv::SOLVEPNP_IPPE_SQUARE))
    {
        return false;
    }

    for (size_t i = 0U; (i < rvecs.size()) && (i < out_candidates->size()); ++i)
    {
        PoseCandidate candidate;
        const cv::Vec3f normal_camera = RotationVectorToNormalCamera(rvecs[i]);

        candidate.rvec = rvecs[i];
        candidate.tvec = tvecs[i];
        candidate.mean_reproj_px = ComputeMeanReprojectionError(object_points,
                                                                image_points,
                                                                camera_matrix,
                                                                distortion_coeffs,
                                                                candidate.rvec,
                                                                candidate.tvec);
        candidate.normal_cosine = ClampFloat(normal_camera[2], -1.0f, 1.0f);
        candidate.observability_score = ComputeObservabilityScore(image_points, image_size, normal_camera);
        candidate.valid = std::isfinite(candidate.mean_reproj_px) &&
                          std::isfinite(candidate.normal_cosine) &&
                          std::isfinite(candidate.observability_score);

        (*out_candidates)[i] = candidate;
    }

    return (*out_candidates)[0].valid || (*out_candidates)[1].valid;
}

static bool SelectBestCandidate(const std::array<PoseCandidate, 2U> &candidates,
                                const PlanarTargetConfig &config,
                                const PoseState *state,
                                PlanarPoseEstimate *out_estimate)
{
    std::vector<size_t> valid_indices;
    size_t best_index = 0U;

    if (out_estimate == nullptr)
    {
        return false;
    }

    *out_estimate = {};

    for (size_t i = 0U; i < candidates.size(); ++i)
    {
        if (candidates[i].valid)
        {
            valid_indices.push_back(i);
        }
    }

    if (valid_indices.empty())
    {
        return false;
    }

    best_index = valid_indices.front();
    if (valid_indices.size() == 2U)
    {
        const PoseCandidate &a = candidates[valid_indices[0]];
        const PoseCandidate &b = candidates[valid_indices[1]];

        out_estimate->dual_error_gap_px = std::fabs(a.mean_reproj_px - b.mean_reproj_px);
        out_estimate->ambiguous_dual_solution =
            (out_estimate->dual_error_gap_px <= config.max_dual_error_gap_px);

        /*
         * 候选排序优先级：
         * 1. 若已有上一帧状态，则优先选择与上一帧连续的解；
         * 2. 否则优先选择重投影误差更小者；
         * 3. 若误差接近，再优先法向更接近先验可见方向者。
         */
        if ((state != nullptr) && state->initialized)
        {
            const double rot_step_a = ComputeRotationStepDeg(state->rvec, a.rvec);
            const double rot_step_b = ComputeRotationStepDeg(state->rvec, b.rvec);
            const double trans_step_a = ComputeTranslationStepMm(state->tvec, a.tvec);
            const double trans_step_b = ComputeTranslationStepMm(state->tvec, b.tvec);
            const double continuity_cost_a = rot_step_a + (0.05 * trans_step_a);
            const double continuity_cost_b = rot_step_b + (0.05 * trans_step_b);

            best_index = (continuity_cost_a <= continuity_cost_b) ? valid_indices[0] : valid_indices[1];
        }
        else
        {
            best_index = (a.mean_reproj_px <= b.mean_reproj_px) ? valid_indices[0] : valid_indices[1];
        }
    }

    {
        const PoseCandidate &best = candidates[best_index];
        out_estimate->rvec = best.rvec.clone();
        out_estimate->tvec = best.tvec.clone();
        out_estimate->mean_reproj_px = best.mean_reproj_px;
        out_estimate->normal_cosine = best.normal_cosine;
        out_estimate->observability_score = best.observability_score;
        out_estimate->valid = true;
    }

    return true;
}

/**
 * @brief 对选出的平面位姿进行工程级可信度判定，并在必要时拒绝或降级。
 * @param estimate 当前候选估计，会被原位写入诊断标志。
 * @param config 阈值配置。
 * @param state 上一帧状态，可为空。
 * @retval true 当前估计允许输出给上层。
 * @retval false 当前估计应拒绝，保留上一帧或转入降级逻辑。
 *
 * @note 这里的设计原则不是“解不出来才失败”，而是：
 *       1. 即便几何上可解，若已进入病态边界，也应显式告警；
 *       2. 即便重投影误差更好，若违背物理连续性，也应拒绝跳解；
 *       3. degraded=true 表示仍可输出，但上层应降权使用。
 */
static bool ValidateEstimateWithContinuity(PlanarPoseEstimate *estimate,
                                           const PlanarTargetConfig &config,
                                           const PoseState *state)
{
    if ((estimate == nullptr) || !estimate->valid)
    {
        return false;
    }

    if (!std::isfinite(estimate->mean_reproj_px) ||
        !std::isfinite(estimate->normal_cosine) ||
        !std::isfinite(estimate->observability_score) ||
        !std::isfinite(estimate->homography_condition_number))
    {
        return false;
    }

    if (estimate->mean_reproj_px > config.max_mean_reproj_px)
    {
        return false;
    }

    if (estimate->homography_condition_number > config.max_condition_number)
    {
        estimate->degraded = true;
    }

    if (estimate->observability_score < config.min_observability_score)
    {
        estimate->degraded = true;
    }

    if (estimate->normal_cosine < config.min_normal_cosine)
    {
        /*
         * 这里不直接判失败，而是标记退化。
         * 对某些工位，相机必须大倾角侧视，此时低 normal_cosine 可能是正常工况。
         * 真正危险的是“几乎正视导致两解难分”，所以该阈值应结合业务先验设定。
         */
        estimate->degraded = true;
    }

    if (estimate->ambiguous_dual_solution)
    {
        estimate->degraded = true;
    }

    if ((state != nullptr) && state->initialized)
    {
        const double rotation_step_deg = ComputeRotationStepDeg(state->rvec, estimate->rvec);
        const double translation_step_mm = ComputeTranslationStepMm(state->tvec, estimate->tvec);

        if ((rotation_step_deg > static_cast<double>(config.max_rotation_step_deg)) ||
            (translation_step_mm > static_cast<double>(config.max_translation_step_mm)))
        {
            estimate->continuity_rejected = true;
            return false;
        }
    }

    return true;
}

/**
 * @brief 估计平面矩形靶标位姿，并输出退化/翻转风险诊断。
 * @param image_points 四个角点像素坐标，顺序需与物点矩形一致。
 * @param image_size 图像尺寸。
 * @param camera_matrix 内参矩阵。
 * @param distortion_coeffs 畸变参数。
 * @param config 目标与阈值配置。
 * @param state_inout 输入上一帧姿态；若本帧成功则会更新。
 * @param out_estimate 输出本帧估计与诊断。
 * @retval true 本帧姿态通过守卫，可交付上层。
 * @retval false 本帧姿态不可信，应使用上一帧或触发重新观测。
 *
 * @note 完整链路为：
 *       1. 构造平面矩形物点；
 *       2. 计算单应 DLT 条件数，先看几何分离度；
 *       3. 用 IPPE 显式求双解；
 *       4. 用重投影、法向可观测度和时间连续性筛解；
 *       5. 给出 degraded / ambiguous / continuity_rejected 三类工程标志。
 */
bool EstimatePlanarPoseGuarded(const std::vector<cv::Point2f> &image_points,
                               const cv::Size &image_size,
                               const cv::Mat &camera_matrix,
                               const cv::Mat &distortion_coeffs,
                               const PlanarTargetConfig &config,
                               PoseState *state_inout,
                               PlanarPoseEstimate *out_estimate)
{
    const std::vector<cv::Point3f> object_points = BuildPlanarRectModel(config.width_mm, config.height_mm);
    std::array<PoseCandidate, 2U> candidates{};

    if ((out_estimate == nullptr) || (image_points.size() != object_points.size()))
    {
        return false;
    }

    *out_estimate = {};
    out_estimate->homography_condition_number =
        ComputeHomographyConditionNumber(object_points, image_points);

    if (!BuildPoseCandidatesFromIppe(object_points,
                                     image_points,
                                     camera_matrix,
                                     distortion_coeffs,
                                     image_size,
                                     &candidates))
    {
        return false;
    }

    if (!SelectBestCandidate(candidates, config, state_inout, out_estimate))
    {
        return false;
    }

    out_estimate->homography_condition_number =
        std::max(out_estimate->homography_condition_number, 1.0f);

    if (!ValidateEstimateWithContinuity(out_estimate, config, state_inout))
    {
        return false;
    }

    if (state_inout != nullptr)
    {
        state_inout->rvec = out_estimate->rvec.clone();
        state_inout->tvec = out_estimate->tvec.clone();
        state_inout->initialized = true;
    }

    return true;
}

void Example_RunPlanarPoseGuard(void)
{
    const PlanarTargetConfig config{
        80.0f,   // 标签物理宽度 80 mm
        80.0f,   // 标签物理高度 80 mm
        0.8f,    // 平均重投影误差不超过 0.8 px
        0.15f,   // 双解误差差值小于 0.15 px 时标记为易翻转
        0.15f,   // 法向余弦下限
        0.0025f, // 可观测度经验阈值
        2500.0f, // DLT 条件数上限
        18.0f,   // 相邻两帧姿态旋转不应突变超过 18 deg
        35.0f    // 相邻两帧平移不应突变超过 35 mm
    };

    const cv::Mat camera_matrix = (cv::Mat_<double>(3, 3) <<
        820.0, 0.0, 640.0,
        0.0, 820.0, 360.0,
        0.0, 0.0, 1.0);
    const cv::Mat distortion_coeffs = cv::Mat::zeros(5, 1, CV_64F);

    const std::vector<cv::Point2f> corners_px{
        cv::Point2f(582.4f, 301.7f),
        cv::Point2f(699.2f, 307.9f),
        cv::Point2f(694.5f, 420.6f),
        cv::Point2f(577.0f, 414.1f)
    };

    PoseState state{};
    PlanarPoseEstimate estimate{};

    if (!EstimatePlanarPoseGuarded(corners_px,
                                   cv::Size(1280, 720),
                                   camera_matrix,
                                   distortion_coeffs,
                                   config,
                                   &state,
                                   &estimate))
    {
        return;
    }

    /*
     * 上层系统应按 estimate 里的标志决定怎么消费结果：
     * - valid=true 且 degraded=false：可直接进入闭环；
     * - valid=true 且 degraded=true：建议降权、冻结部分自由度或等待下一帧确认；
     * - ambiguous_dual_solution=true：说明两个平面姿态在像素域里过于接近；
     * - continuity_rejected=true：说明本帧虽然拟合得上，但与物理连续性冲突。
     */
    (void)estimate;
}
```

这段实现真正想表达的，不是“平面标签也能求位姿”，而是**单目平面位姿本质上是一道带病态边界的逆问题**。代码里显式暴露了 `cond(A)`、双解误差间隔、法向可观测度和时间连续性，就是为了把“看起来能解”和“值得信”彻底分开。只要系统承认共面退化是物理事实而不是偶发 bug，就会自然得出更稳健的策略：在危险区主动降权、保留上一次可信姿态、等待更大视差或更好角点，而不是把每一帧 `solvePnP()` 的输出都当成真相。
