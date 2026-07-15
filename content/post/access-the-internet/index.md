---
title: "访问外网实用指南"
slug: "access-the-internet"
aliases:
  - "/p/访问外网/"
---

# 访问外网实用指南

## 前言：准备工作

### 核心工具：Clash

目前，最主流和便捷的代理工具是 Clash。为了方便您快速开始，这里提供几个常用的 Clash 客户端下载地址和软件资源站。

- **Clash 快速下载资源站：** [https://clash.download/downloads](https://clash.download/downloads)
- **软件网盘分享 (多种选择)：**
  - [https://pan.aymao.com/s/gmdTp](https://pan.aymao.com/s/gmdTp)
  - [https://www.123684.com/s/BoRRVv-BxRxh](https://www.123684.com/s/BoRRVv-BxRxh) (提取码: K1zA)
  - [https://www.123912.com/s/BoRRVv-BxRxh](https://www.123912.com/s/BoRRVv-BxRxh) (提取码: K1zA)
  - **夸克网盘：** 链接：[https://pan.quark.cn/s/a6c827a5d78a](https://pan.quark.cn/s/a6c827a5d78a) 提取码：rJfc

## 推荐的“机场”服务

“机场”提供代理服务节点。这里推荐几个不同类型的服务，您可以根据自己的需求选择。

- **白嫖机场 (性价比首选)**
  - **优点：** 价格极其低廉（例如：一年19元，每月1000G流量），非常适合下载资料、观看4K视频等大流量场景。
  - **缺点：** 延迟相对较高，不适合对延迟有严格要求的在线游戏。
  - **注册链接：** [https://yes.xn--mesv7f5toqlp.biz/register?code=yOp46Eln](https://yes.xn--mesv7f5toqlp.biz/register?code=yOp46Eln)
- **魔戒 (低延迟之选)**
  - **优点：** 相比前者，延迟显著降低，能提供更流畅的网络体验。
  - **注册链接：** [https://mojie.app/register?aff=sDEtopao](https://mojie.app/register?aff=sDEtopao)
- **Flower (纯净网络之选)**
  - **优点：** 注重提供高纯净度的网络环境。
  - **注册链接：** [https://api-flowercloud.com/aff.php?aff=13285](https://api-flowercloud.com/aff.php?aff=13285)

## “机场”使用教程

大部分机场服务的使用流程都大同小异。下面我们以“白嫖机场”为例，演示一遍完整操作。

### 第一步：注册并购买套餐

首先，通过上方的链接完成注册。登录后，进入“购买订阅”页面。根据您的个人需求，选择合适的套餐（通常分为按月付费或按流量付费两种模式）并完成支付。 ![image-20250920230505236](https://s2.loli.net/2025/09/20/pPCQzFBM2U5iGka.png)

### 第二步：复制订阅链接

购买成功后，在网站的用户中心找到您的订阅链接，并点击“复制”。 ![image-20250920230627087](https://s2.loli.net/2025/09/20/6HIozCJmsTPg4VK.png) 这个链接是您的专属凭证，格式通常如下： [subscribe?token=xxxx](https://dy11.baipiaoyes.com/api/v1/client/subscribe?token=xxxx)

### 第三步：导入订阅到 Clash 客户端

打开您已经安装好的 Clash 客户端，找到的配置入口，将刚刚复制的订阅链接粘贴进去并进行导入。所有 Clash 客户端的操作逻辑基本一致。 ![image-20250920230739180](https://s2.loli.net/2025/09/20/u94lBEFtpiTnfh3.png)

### 第四步：选择节点并测速

导入成功后，您会看到一整列可用的服务器节点。为了获得最佳体验，建议先进行一次延迟测试，然后选择一个速度快、延迟低的节点。通常情况下，美国或英国的节点是比较稳妥的选择。 ![image-20250920230850264](https://s2.loli.net/2025/09/20/Rcs3KtDgUHavnYk.png)

### 第五步：开启系统代理

最后，也是最关键的一步，是开启系统代理。找到“System Proxy”（系统代理）开关并打开它。为了获得更好的兼容性，我个人习惯同时开启“TUN 模式”（虚拟网卡）。 ![image-20250920230944500](https://s2.loli.net/2025/09/20/tjlzMyHx7IrKueE.png) 至此，您已成功连接。

### **重要提示**

建议在每次关机或重启电脑前，先在 Clash 客户端中断开代理连接。如果在代理开启的状态下直接关机，下次开机时若不启动 Clash，可能会导致电脑无法访问任何网页。