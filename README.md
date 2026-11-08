# 唤醒电脑（Wake PC）

在 LG webOS 电视上，**开机后自动向局域网内的电脑发送 Wake-on-LAN 魔术包**，实现「电视一开机，电脑就被唤醒」。

本项目是一个完整的 webOS 原生 Web 应用：前台是一个用遥控器操作的可视化界面，后台是一个常驻的 JavaScript Luna 服务，负责在电视开机 / 待机恢复时自动发送魔术包，并在界面里完成设备的扫描、配置与状态诊断。

- **适用平台**：webOS TV（已实测 LG G6 / webOS 26 中国版固件，开发者模式）
- **License**：[MIT](./LICENSE)

---

## 功能特性

- **开机自动唤醒**：电视开机（冷启动）或从待机快速恢复（快速启动+）后，自动发送一次魔术包，无需打开应用。
- **定时调节音量**：**按小时记录用户手动设置的音量目标值（24 个）**，下次该小时自动调到记录值；未设置的小时用默认（09:00–22:00 音量 13、其余 7）。通过**订阅音量变化实时感知**、**电视开机/待机恢复事件立即调节**、整点精确定时切换，订阅断开由 `cancel` 事件自动重连，无高频轮询。
- **亮度定时调节已取消**：实机验证第三方 app 无法写入 OLED 亮度（ACG 权限限制，需 root/Homebrew），详见探索记录。
- **两种开机场景全覆盖**：
  - 冷启动 → 通过 ActivityManager `persist` 常驻 Activity 拉起服务；
  - 快速启动+ → 订阅 `com.webos.service.tvpower` 的开机通知事件。
- **局域网设备扫描**：读取 `/proc/net/arp` 并做一次 TCP 扫描，自动列出网段内在线的电脑（IP + MAC）。
- **遥控器友好**：方向键 + OK + 返回即可完成全部操作，下拉列表、输入框均做了焦点管理。
- **配置持久化**：目标 MAC / IP / 端口保存在 DB8 数据库（`com.palm.db`），重启不丢失。
- **状态自诊断**：界面实时显示后台服务是否常驻、开机触发是否注册成功、最近发送结果、事件计数。
- **构建溯源**：打包时自动把当前 Git 提交哈希注入到 `appinfo.json`，并在界面显示电视上跑的是哪个提交。

---

## 工作原理（简版）

```
电视开机
   ├─ 冷启动   → persist Activity → luna://com.woltv.wakepc.service/wake
   └─ 快速启动+ → tvpower 推送 preparePowerOn → 常驻服务应答 → 发送魔术包
                        │
                        ▼
   等 connectionmanager 报告网络就绪 → 向目标 IP:端口 发送 1 次魔术包
```

另有兜底保护：10 秒心跳检测时钟跳变（判定从待机恢复）、30 秒事件去重、60 秒自动重注册订阅。

详细机制与实机验证记录见 [docs/探索经验/快速启动开机唤醒-探索记录.md](docs/探索经验/快速启动开机唤醒-探索记录.md)。

---

## 目录结构

```
├─ index.html                 应用入口（单页界面）
├─ appinfo.json               应用元数据（id / version / icon / ACG 权限）
├─ js/app.js                  前端逻辑（PalmServiceBridge 调用服务、遥控器焦点管理）
├─ css/style.css              界面样式
├─ services/
│  └─ com.woltv.wakepc.service/
│     ├─ wol_service.js       后台 Luna 服务（魔术包发送、开机订阅、配置存储）
│     ├─ services.json        Luna 方法声明
│     └─ package.json         服务包元数据
├─ tools/
│  └─ tv-shell.ps1            走中继执行任意 ares 命令的只读诊断工具
├─ docs/
│  ├─ 开发者文档.md            面向开发者的架构、API、构建与开发约定
│  ├─ 使用者文档.md            面向用户的安装、部署与使用指南
│  └─ 探索经验/               真实排障与实机探测笔记
├─ deploy.ps1                 打包 + 安装 + 启动一站式部署脚本（含本地中继绕开 VPN）
├─ listen-magic-packet.ps1    电脑端魔术包监听器（调试用）
└─ copy-project.ps1           平铺导出项目文件（内部工具）
```

---

## 快速开始

### 前置条件

1. **电视**：LG webOS 电视已开启 **开发者模式**（安装 Developer Mode 应用、Dev Mode Status 为 ON），并记录开发者模式界面左下角的 6 位 Passphrase。
2. **电脑**：与电视处于同一局域网，已安装 **Node.js** 与 **@webos-tools/cli**：

```bash
npm install -g @webos-tools/cli
```

### 一键部署

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1
```

脚本会自动完成：检查 ares CLI → 定位本地网卡 → 测试电视连通性 → 启动本地中继并指向电视 → 获取 SSH 密钥 → 打包（注入提交哈希）→ 安装 → 启动应用。

> 详细的分步说明、参数、以及遇到「网段冲突 / VPN 劫持」时的处理，见 [docs/使用者文档.md](docs/使用者文档.md) 与 [docs/探索经验/TROUBLESHOOTING.md](docs/探索经验/TROUBLESHOOTING.md)。

---

## 使用方式

1. 在电视上打开 **唤醒电脑** 应用。
2. 点 **「扫描设备」** 让电视自动列出局域网内在线电脑，选择目标；或直接在 **MAC 地址 / 目标 IP / 端口** 中手动填写。
3. 点 **「保存」** 写入配置。
4. 点 **「立即唤醒（测试）」** 验证电脑能被唤醒。
5. 之后电视每次开机，都会自动唤醒这台电脑。

完整的使用说明见 [docs/使用者文档.md](docs/使用者文档.md)。

---

## 文档

| 文档 | 说明 |
|---|---|
| [开发者文档](docs/开发者文档.md) | 架构设计、Luna 服务 API、开机唤醒机制、构建部署、开发约定 |
| [使用者文档](docs/使用者文档.md) | 环境准备、安装部署、电视端操作、常见问题 |
| [快速启动开机唤醒-探索记录](docs/探索经验/快速启动开机唤醒-探索记录.md) | 快速启动+ 场景的实现原理与实机探测方法 |
| [亮度音量定时调节-探索记录](docs/探索经验/亮度音量定时调节-探索记录.md) | 音量/亮度内部 API 探测；音量调度已实现、亮度因权限不可行 |
| [电视 SSH 调试指南](docs/探索经验/电视SSH调试指南.md) | 电视端日志、命令、文件系统调试经验 |
| [TROUBLESHOOTING](docs/探索经验/TROUBLESHOOTING.md) | SecoClient 网段冲突与源地址绑定绕行方法 |

---

## 开发约定

本仓库遵循以下内部约定（详见 [开发者文档](docs/开发者文档.md) 中的「开发约定」一节）：

- `*.ps1` 保存为 **UTF-8 with BOM**（恰好一个 BOM）。
- 代码**不添加任何注释**。
- 应用界面**不放功能开关**，所有功能默认开启并在代码中写死。
- 每次修改代码后提交，并把该提交的哈希打包进电视应用界面（`buildHash`），用于构建溯源。

---

## 安全与隐私提示

- 开发者模式的 **Passphrase 是电视的访问凭证**，`passphrase.txt` 已被 `.gitignore` 忽略，**请勿提交**。
- 本仓库的示例 / 历史提交中保留有作者的个人信息（电视 IP、MAC 等），如要对外公开请自行评估。

---

## 许可证

[MIT](./LICENSE) © tv-wake-pc contributors
