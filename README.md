# 月栖之地

这是一个基于 [Hugo](https://gohugo.io/) 的静态博客项目，当前启用主题为 `Stack`，部署地址配置为 `https://xw911-blog.vercel.app/`。

## 项目结构

```text
blog
├─ hugo.toml                    # Hugo 主配置，当前 theme = "Stack"
├─ vercel.json                  # Vercel 部署配置
├─ config/_default/
│  ├─ menu.toml                 # 导航菜单配置
│  └─ params.toml               # 主题参数、背景图、轻量 AI 问答配置
├─ content/                     # 站点内容源文件
│  ├─ post/                     # 主文章内容
│  ├─ notes/                    # 知识笔记
│  ├─ reference/                # 参考速查内容
│  ├─ page/                     # 关于、归档、链接、搜索等独立页面
│  └─ categories/               # 分类页面内容
├─ layouts/                     # 自定义 Hugo 模板覆盖
│  ├─ page/search.json          # AI 与站内搜索共用的索引输出
│  ├─ reference/list.html       # 参考速查列表页
│  ├─ reference/single.html     # 参考速查详情页
│  ├─ _partials/
│  │  ├─ head/custom.html       # 页面背景与 head 注入
│  │  ├─ footer/custom.html     # 轻量 AI 问答入口
│  │  └─ sidebar/left.html      # 左侧栏覆盖
│  └─ _shortcodes/              # 参考速查短代码
│     ├─ ref-card.html
│     └─ ref-cols.html
├─ assets/                      # Hugo Pipes 资源
│  ├─ scss/custom.scss          # 全站自定义样式、透明卡片、AI 面板样式
│  ├─ img/avatar.jpg            # 头像资源
│  └─ icons/                    # 自定义图标
├─ static/                      # 静态直出资源
│  ├─ js/blog-ai.js             # 浏览器端 AI 检索与对话逻辑
│  ├─ images/ai/claude.png      # AI 浮窗头像
│  ├─ images/backgrounds/nav/   # 不同页面的背景图
│  └─ img/avatar.jpg            # 静态头像
├─ api/
│  └─ blog-ai.js                # Vercel Serverless AI 问答接口
├─ data/                        # 数据文件，例如链接数据
├─ archetypes/                  # 新内容模板
├─ themes/Stack/                # 当前使用主题
├─ public/                      # Hugo 构建产物
├─ resources/                   # Hugo 缓存与资源产物
└─ img2ref.py / img2ref_gui.py  # 本地内容辅助脚本
```

## 主要配置

- 站点语言：`zh-CN`
- 默认内容语言：`zh-cn`
- 当前主题：`Stack`
- 文章永久链接：`/p/:slug/`
- 页面永久链接：`/:slug/`
- 首页输出：`HTML`、`RSS`、`JSON`
- Markdown 渲染允许 HTML：`unsafe = true`
- 轻量 AI 问答索引：`post` 与 `reference`

## 内容组织

- `content/post/`：博客主文章。
- `content/notes/`：知识笔记类内容。
- `content/reference/`：速查内容，目前包含 `cpp`、`python`、`opencv`、`deep learning` 等方向。
- `content/page/`：站点功能页面，例如关于、归档、链接、搜索。

## 轻量 AI 问答

- 前端入口：`layouts/_partials/footer/custom.html`
- 浏览器端检索：`static/js/blog-ai.js`
- 服务端接口：`api/blog-ai.js`
- 搜索索引模板：`layouts/page/search.json`
- 配置入口：`config/_default/params.toml` 的 `[blogAi]`
- 当前索引范围：博客文章 `post` 与参考速查 `reference`

## 维护说明

- 日常内容编辑优先修改 `content/`。
- 站点导航和主题参数优先修改 `config/_default/`。
- 页面结构定制优先修改 `layouts/`。
- 样式定制优先修改 `assets/scss/custom.scss`。
- AI 问答前端交互优先修改 `static/js/blog-ai.js`，后端调用优先修改 `api/blog-ai.js`。
- 页面背景图片优先放在 `static/images/backgrounds/nav/`，再到 `config/_default/params.toml` 里绑定路径。
- `public/` 与 `resources/` 通常为构建产物或缓存，不作为主要源文件维护。
