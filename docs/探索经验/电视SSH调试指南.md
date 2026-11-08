# 电视 SSH 调试指南（含实测经验）

> 记录时间：2026-10-14 ｜ 电视：LG OLED55G6PCA（G6，webOS 26 中国版固件，开发者模式）｜ `192.168.1.4:9922`
> 适用：需要在电视上跑命令、看日志、核对已安装文件时。网络绕行原理见同目录 `TROUBLESHOOTING.md`。

## 0. 结论速查

| 想做的事 | 用什么 | 说明 |
|---|---|---|
| 在电视上跑 shell 命令、看日志 | **`ssh -b <本地网卡IP>` 直连** | 最简单，见 §2.1。不需要改 ares 配置 |
| 跑 ares 命令（`ares-install --list` 等） | **`tools/tv-shell.ps1`** | ares 不支持绑源地址，必须走中继，见 §2.2 |
| 看应用日志 | `ssh -b … "tail -40 /tmp/var/log/legacy-log"` | 见 §4 |
| 核对电视上装的文件是不是最新 | `md5sum` + 本地 `Get-FileHash` | 见 §5.1 ⭐ |
| ~~`ares-shell` / `ares-pull` / `ares-push`~~ | **不可用** | `tv` profile 下直接报 `This command is not supported by current profile` |

## 1. 环境信息（从哪来）

连电视需要的四项，全都在 ares 的设备配置里，**没有秘密**：

`%APPDATA%\.webos\tv\novacom-devices.json`

```json
{
  "name": "lg", "profile": "tv", "type": "starfish",
  "host": "192.168.1.4", "port": "9922",
  "username": "prisoner",
  "privateKey": { "openSsh": "lg_webos" },
  "passphrase": "……"          ← 电视「开发者模式」左下角那 6 位
}
```

| 项 | 值 |
|---|---|
| 主机 / 端口 | `192.168.1.4` / `9922` |
| SSH 用户 | **`prisoner`**（不是 root，也不是 `developer`——后者是模拟器用的） |
| 私钥 | `%USERPROFILE%\.ssh\lg_webos`（**PEM RSA，带口令加密**，口令即上面那个 passphrase） |
| 本机可用源地址 | `192.168.1.6`（以太网，见 §2.1 为何必须绑它） |

> 私钥是加密的（文件头 `Proc-Type: 4,ENCRYPTED`），所以裸 `ssh` 会静默等口令输入、表现成"卡住"。必须用 §2.1 的 `SSH_ASKPASS` 方式喂口令。
> 电视重启/开发者模式重启后**可能重新生成 host key**（实测 2026-10-14 20:41 那批 `/var/lib/devmode/sshd/ssh_host_*_key`），于是 `known_hosts` 报 `REMOTE HOST IDENTIFICATION HAS CHANGED`。用独立的临时 `known_hosts` 规避，不要去改用户正式的 `known_hosts`。

## 2. 三种连接方式

### 2.1 ⭐ 直接 SSH（推荐，最省事）

```powershell
# 口令用临时 askpass 脚本喂给 ssh，避免交互卡死
$ask = Join-Path $env:TEMP "wol-askpass.cmd"
Set-Content -Path $ask -Value "@echo <passphrase>" -Encoding ASCII
$env:SSH_ASKPASS        = $ask
$env:SSH_ASKPASS_REQUIRE = 'force'      # 没有 tty 也强制走 askpass
$env:DISPLAY            = 'localhost:0' # 某些构建仍读这个变量

$kh = Join-Path $env:TEMP "wol-known-hosts"
New-Item -ItemType File -Force $kh | Out-Null

ssh -b 192.168.1.6 -i "$env:USERPROFILE\.ssh\lg_webos" -p 9922 `
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=$kh `
    -o ConnectTimeout=8 `
    prisoner@192.168.1.4 "id; uname -a"

Remove-Item $ask -Force            # 用完立刻删
```

要点：

1. **`-b 192.168.1.6` 是绕开 VPN 的关键**。SecoClient 会把 `192.168.1.4` 的默认路由劫持到 VPN 网卡，但 SSH 绑定了源地址后会强制走该源地址所属的那块物理网卡，路由表被完全绕开。比 §2.2 的中继简单得多——**只做 shell 调试时不要用中继**。
2. `SSH_ASKPASS_REQUIRE=force` 是必须的，否则 ssh 还是去找 tty。
3. `-o UserKnownHostsFile=<临时文件>` 规避 host key 漂移告警；加了 `StrictHostKeyChecking=no` 后首次会自动写入该临时文件。
4. 如果命令里要带引号，把整条命令作为**一个参数**传给 ssh；再复杂的（含 `$`、管道、多层引号）用 base64 包一层，见 §5.4。
5. 超时是常见现象：**注意 `-o ConnectTimeout` 只管建连**。跑全盘 `grep`/`find` 这种重命令很容易超过工具侧超时，见 §6.5。

### 2.2 ares 命令：`tools/tv-shell.ps1`

ares 系列工具不支持绑源地址，只能沿用部署脚本那套中继：起一个监听 `127.0.0.1` 的 TCP 中继 → 由它绑 `192.168.1.6` 去连电视 → 临时把 ares 设备配置指向中继 → 执行完自动还原。

```powershell
# 列出电视上已安装的应用
.\tools\tv-shell.ps1 -AresArgs 'ares-install','--device','lg','--list'

# 在电视上执行命令（等价 ssh 方式，但绕了中继）
.\tools\tv-shell.ps1 -AresArgs 'ares-novacom','--device','lg','--run','id; ls /media'
```

脚本只读诊断用：**不打包、不安装**，结束时一定还原 `novacom-devices.json`（备份为 `*.wolbak2`）。

### 2.3 各 ares 子命令在 `profile=tv` 下的可用性（实测）

| 命令 | 可用 | 备注 |
|---|---|---|
| `ares-install`（装/卸/`--list`） | ✅ | 部署主力 |
| `ares-launch`、`ares-device -i` | ✅ | |
| `ares-novacom --getkey` / `--run` | ✅ | `--run` 仍是 `prisoner` 身份 |
| `ares-config`、`ares-package` | ✅ | |
| `ares-shell` | ❌ | `This command is not supported by current profile` |
| `ares-pull` / `ares-push` | ❌ | 同上。**想读电视上的文件请用 §2.1 的 ssh** |

> 连带影响：`deploy.ps1` 的 `-TestWake` 开关依赖 `ares-shell`，**在电视上永远是无效代码**。要触发服务，用 ssh 跑 `luna-send-pub`（见 §5.3）。

## 3. 电视文件系统实测地图

`prisoner` **不是 chroot**：整个根文件系统（`/lib`、`/usr/share`、`/tmp/var/log`…）基本可读。被遮蔽的只有 `/var`（只剩 `/var/lib/devmode`，即 sshd host key）。

| 路径 | 内容 | 可读 |
|---|---|---|
| `/media/developer/apps/usr/palm/applications/<appId>/` | **开发模式安装的应用本体**（`appinfo.json`、`icon.png`、`largeIcon.png`、`js/`、`css/`…） | ✅ |
| `/media/developer/apps/usr/palm/packages/<appId>/packageinfo.json` | 包信息（id / version / app / services） | ✅ |
| `/media/developer/apps/usr/palm/services/<svcId>/` | 服务（`services.json`、`wol_service.js`…） | ✅ |
| `/media/developer/apps/var/lib/opkg/status` | opkg 安装记录（版本、安装时间、`Status: install ok unpacked`） | ✅ |
| `/media/developer/jail_app.conf` | 开发模式 jail 配置 | ✅ |
| `/media/developer/temp`、`/media/developer/tmp` | 安装临时目录，成功后为空 | ✅ |
| `/tmp/var/log/legacy-log` | **各 JS 服务的 `console.log` 输出**，排查服务问题首选 | ✅ |
| `/tmp/var/log/dbg-log` | tvpowerd / surfacemanager 等原生服务启动期日志 | ✅ |
| `/tmp/var/log/messages`、`bootd.log`、`configd.log`… | 系统日志（见 §4 完整清单） | ✅ |
| `/usr/share/luna-service2/api-permissions.d/*.api.json` | luna 方法权限分组，判断"能不能调"必看 | ✅ |
| `/lib/node_modules/webos-service/lib/*.js` | JS 服务运行时源码 | ✅ |
| `/usr/palm/applications/` | **不存在**（webOS 26 已换布局）；系统应用不在这个老路径 | ❌ |
| `/var/`（除 `/var/lib/devmode`） | 系统状态、启动器数据库 | ❌ 只可进入不可列举 |
| 桌面的 `luna-send` | root only | ❌ 用 `luna-send-pub` |

## 4. 日志速查

```powershell
# 完整日志清单
ssh -b 192.168.1.6 -i "$env:USERPROFILE\.ssh\lg_webos" -p 9922 -o StrictHostKeyChecking=no `
    -o UserKnownHostsFile=$env:TEMP\wol-known-hosts prisoner@192.168.1.4 "ls /tmp/var/log"

# 应用/服务日志
... "tail -60 /tmp/var/log/legacy-log"
... "grep -E 'power event|magic packet' /tmp/var/log/legacy-log | tail -40"

# 系统原生服务
... "tail -60 /tmp/var/log/dbg-log"
```

`/tmp/var/log` 实测包含：`bootd.log`、`calibrator_log`、`cecmessages`、`configd.log`、`crashd/`、`dbg-log`、`faultmanager/`、`home/`、`initctl.log`、`legacy-log`、`legacy-broadcast-booting.log`、`livemenu/`、`messages`、`reports/`、`serviceloggermessages`、`update.log`、`upload-log`、`uploadd/`。

## 5. 常用命令

### 5.1 ⭐ 核对电视上装的是不是最新构建

在电脑上算本地哈希，再去电视上算：

```powershell
(Get-FileHash .\icon.png -Algorithm MD5).Hash.ToLower()
```

```sh
cd /media/developer/apps/usr/palm/applications/com.woltv.wakepc && \
  ls -l && md5sum icon.png largeIcon.png appinfo.json && grep -E 'version|buildHash' appinfo.json
```

两边哈希一致 = 电视上确实是这份文件。**排查"改了没生效"类问题的第一件事就是这个**，能一句话把"打包/安装的问题"和"渲染/缓存的问题"分开。

`appinfo.json` 里的 `buildHash` 由 `deploy.ps1` 注入，等于**电视上当前运行的是哪个提交**。

### 5.2 看安装记录

```sh
cat /media/developer/apps/var/lib/opkg/status
cat /media/developer/apps/usr/palm/packages/<appId>/packageinfo.json
```

### 5.3 调用 luna 服务

```sh
# 跑自己的服务
/usr/bin/luna-send-pub -n 1 -f luna://com.woltv.wakepc.service/getStatus '{}' < /dev/null
```

**`< /dev/null` 不能省**：`luna-send-pub` 会从 stdin 读 payload，如果脚本是管道喂给 `sh` 的，它会把后续脚本一起吃掉，表现为"命令跑了但没有任何输出"。

### 5.4 复杂命令的 base64 包装

含引号、`$`、多行时，逐层转义很容易出错，直接把脚本 base64 送过去：

```powershell
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content .\probe.sh -Raw)))
ssh -b 192.168.1.6 -i "$env:USERPROFILE\.ssh\lg_webos" -p 9922 prisoner@192.168.1.4 "echo $b64 | base64 -d | sh"
```

## 6. 踩坑清单

### 6.1 私钥有口令 → 裸 ssh 会"卡住"

表现：命令无输出、直到超时。原因：ssh 在等口令输入。解法见 §2.1 的 `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`。

### 6.2 `find / -xdev` 会漏掉独立挂载点

`/usr`、`/lib`、`/tmp` 等是独立挂载，`-xdev` 直接跳过。排查"文件到底在哪"时**不要加 `-xdev`**；我因此一度误判"jail 里什么都看不到"。

### 6.3 全盘 `grep -r` / `find` 会跑到超时

电视的根文件系统很大（含 Python/numpy、Qt QML 资源）。`grep -r woltv /tmp /usr/share /etc /media` 实测 **3 分钟不返回**。要限定目录、限定文件名模式，或直接查 §3 表里的已知路径。

### 6.4 host key 漂移

开发模式重启会重建 sshd host key → `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!`。不要盲目删用户 `known_hosts`；用临时文件（§2.1）。表现上还有个衍生坑：警告文字被 PowerShell 当成错误流输出（`NativeCommandError`），**并不代表命令失败**，看 `$LASTEXITCODE`。

### 6.5 PowerShell 脚本必须存成 UTF-8 with BOM

PS 5.1 读无 BOM 的 UTF-8 文件会按 GBK 解码，中文字节偏移错位会让**注释行吞掉下一行代码**，报出完全无关的"Missing closing '}'"。本仓库 `README.md` 也有这条约定。写完脚本顺手验证：

```powershell
$errs = $null; $tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errs)
$errs.Count    # 必须是 0
```

### 6.6 `ares-novacom --run` 不等于提权

它仍然以 `prisoner` 执行（`id` → `uid=5472(prisoner) gid=5000(jailer)`），拿不到 root，也看不到 `/var`。

### 6.7 别忘了清理

用 askpass 方式时口令会短暂落到临时文件；用完 `Remove-Item`。中继方式会改 ares 配置，`tools/tv-shell.ps1` 已在 `finally` 里还原，但**被强制执行中断时仍要人工检查** `%APPDATA%\.webos\tv\novacom-devices.json` 的 `host`/`port` 是否还是 `192.168.1.4`/`9922`。

## 7. 案例：换了应用图标，电视上还是旧图

一次完整的"改了没生效"排查，方法可复用。

**现象**：`icon.png` / `largeIcon.png` 换成新图并重新部署（版本 `0.0.7`、`0.0.8`），电视主页应用列表的磁贴仍显示旧图。期间做过：卸载应用重装、重启电视。

**排查步骤**：

1. **确认打包产物对不对**——解开 `dist/*.ipk`（`ar` 格式：`tar -xf` 取出 `data.tar.gz` 再 `tar -xzf`），比对 `icon.png`、`largeIcon.png` 的 SHA256。
   → 结论：**包里就是新图**，且 `appinfo.json` 的 `version`/`buildHash` 都是新的。排除"打包拿了旧文件"。
2. **确认电视上装的对不对**——`md5sum` 电视上的 `icon.png`（§5.1）。
   → 结论：**与本地逐字节一致**。排除"安装没覆盖"。
3. **确认没有第二份安装**——`/media/developer/apps/usr/palm/applications/` 下只有一个应用，`/usr/palm/applications/*woltv*` 不存在。
   → 排除"启动器读的是另一份旧应用"。
4. **确认不是"看起来一样"**——把新旧图标都降采样成 16×16 灰度、打成 ASCII 图对比像素：旧图是**透明底上的一个小圆角方块**（占位图风格），新图是**满幅图片**，两者明显不同。
   → 排除"其实换了但长得像"。
5. **画指纹找旧图藏哪**——旧 `icon.png` 恰好 970 字节，用 `find / -type f -size 970c` 全盘搜；再 `find / -type f -name "*.png"` 搜。
   → 结论：**电视上根本不存在旧图文件**。旧图只可能来自 jail 之外（`/var`，见 §3）的启动器缓存。
6. **消除唯一的文件差异再试**——旧图是 **32bpp ARGB**，我生成的新图是 24bpp RGB（无 Alpha）。重新导出为 32bpp ARGB 后部署 `0.0.8`。

**当前状态**：`0.0.8`（32bpp ARGB）已部署并核对哈希一致，**尚未拿到电视端的人工确认**。

**若仍不生效**，下一步是换 app id（启动器按 app id 缓存图标）。改动面：`appinfo.json` 的 `id`、`services.json` 的 `id` 与 `services[].name`、服务目录名、`services/.../package.json` 的 `name`、`wol_service.js` 的 `SERVICE_NAME` 与 `KIND`、`js/app.js` 的 `SERVICE`、以及 `deploy.ps1` 中 4 处引用。

**这个案例的通用教训**：

- "改了没生效"先做**两次哈希比对**（包内 vs 本地、电视上 vs 本地），一次就能定位问题层。
- 找不到旧文件时，**用文件体积当指纹**去搜，比按名字搜有效（图标没有特殊文件名）。
- 平台约定（这里是 32bpp ARGB）值得对齐——旧文件能用、新文件不行时，差异本身就是线索。

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `tools/tv-shell.ps1` | 走中继执行任意 ares 命令的只读诊断工具 |
| `deploy.ps1` | 打包部署；含中继与 ares 配置改写/还原的完整实现 |
| `docs/探索经验/TROUBLESHOOTING.md` | SecoClient 网段冲突与源地址绑定的原理、诊断方法论 |
| `docs/探索经验/快速启动开机唤醒-探索记录.md` | 服务常驻、tvpowerd 订阅等电视端调试经验 |
