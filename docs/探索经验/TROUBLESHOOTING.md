# 排查笔记：SecoClient VPN 与家庭 LAN 网段冲突导致 webOS 部署失败

> 本文记录一次真实排查的**方法论**，不只是结论。
> 现象是「ping 不通电视」，真正的病根却是「网段冲突 + VPN 强推路由」，
> 中途还被 PowerShell 的编码问题误导过。
> 面向后来人：重点是**怎么用实验把猜测变成结论**，以及**哪些反直觉的坑**。

---

## 1. 现象

运行 `deploy.ps1`：

```
[2/7] 检查电视连通性 192.168.1.4:9922 ...
  [OK]   已为 192.168.1.4 添加本地路由 (网关 192.168.1.1, 接口 5)，绕过 VPN
  [FAIL] ping 不通 192.168.1.4。即使加了本地路由仍不通
```

初版脚本的假设是：**公司 VPN 劫持了路由，加一条 /32 本地路由就能绕过**。
这个假设**是错的**，而且错得很有代表性 —— 见第 4 节。

---

## 2. 结论（先看这里）

| 事实 | 证据 |
| --- | --- |
| 电视本身完全正常 | 端口 9922/3000/3001/9998 全开，SSH 密钥 `~/.ssh/lg_webos` 已存在 |
| 公司 VPN 和家里 LAN **都是 `192.168.1.0/24`** | 两个网卡、两条 `192.168.1.0/24` 路由 |
| `192.168.1.4` 在**两个网络里都存在**，是两台不同机器 | 两个 MAC、TTL 64 vs 62 |
| SecoClient 每 2~3 秒**重新注入路由**并**复位网卡 metric** | 轮询实验，见 4.2 |
| 加路由**无论如何赢不了** | metric 完全打平仍选 VPN 网卡，见 4.3 |
| 解法：**socket 绑定源地址**，绕过路由表 | 见 5 |

---

## 3. 诊断方法论（可复用）

核心思想：**不要相信「通/不通」，要验证「通到了哪台机器」。**

### 3.1 先看路由选择了哪个网卡

```powershell
Find-NetRoute -RemoteIPAddress 192.168.1.4 |
  Select-Object IPAddress, InterfaceIndex, InterfaceAlias, DestinationPrefix, NextHop
```

如果选中的是 VPN/虚拟网卡而不是同网段的物理网卡 → 路由被劫持。

### 3.2 看全部网卡和路由，找出冲突网段

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Select IPAddress, InterfaceIndex, InterfaceAlias, PrefixLength
Get-NetAdapter | Select ifIndex, Name, InterfaceDescription, Status
Get-NetRoute -AddressFamily IPv4 | Where-Object { $_.DestinationPrefix -like '192.168.1*' } |
  Select DestinationPrefix, InterfaceIndex, InterfaceAlias, NextHop, RouteMetric
```

物理网卡叫「以太网」(Realtek)，VPN 网卡叫「以太网 2」但描述是 `SVN Adapter V1.0`
—— **不要靠名字判断，要看 `InterfaceDescription`**。

### 3.3 ⭐ 决定性实验：源地址绑定对比

这是本次排查最有价值的一招。同一个目标 IP，分别绑定两个网卡的源地址去 ping：

```powershell
ping -n 2 -S 192.168.1.6   192.168.1.4   # 绑定家庭网卡
ping -n 2 -S 172.16.1.113  192.168.1.4   # 绑定 VPN 网卡
```

结果：

```
-S 192.168.1.6    -> TTL=64, 1ms    ← 直连，1 跳
-S 172.16.1.113   -> TTL=62, 23ms   ← 绕了 2 跳，是另一条路
```

**两条路都「通」，但通的是两台不同的机器。** 只看 `ping 通不通` 会得出完全错误的结论。

> TTL 推断跳数：Windows/Linux 默认 64，`64-62=2` 跳，说明被路由过，不是直连。

### 3.4 用 ARP 表佐证「同一个 IP 有两台机器」

```powershell
Get-NetNeighbor -IPAddress 192.168.1.4 | Select IPAddress, LinkLayerAddress, State, InterfaceIndex
```

```
192.168.1.4  00-FF-EC-6D-71-C5  Reachable  11   ← VPN 侧
192.168.1.4  8C-77-79-46-02-90  Reachable   5   ← 家庭 LAN 侧
```

一个 IP 对应两个不同 MAC 且都 Reachable → 网段冲突的铁证。

### 3.5 ⭐ 读 SSH banner：确认「到底连上了谁」

端口探测只能告诉你有东西在监听。读 banner 才能确认身份：

```powershell
# 绑定源地址读 banner
$sock = New-Object System.Net.Sockets.Socket(
  [System.Net.Sockets.AddressFamily]::InterNetwork,
  [System.Net.Sockets.SocketType]::Stream,
  [System.Net.Sockets.ProtocolType]::Tcp)
$sock.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse('192.168.1.6'), 0)))
$sock.ReceiveTimeout = 3000
$sock.Connect('192.168.1.4', 9922)
$buf = New-Object byte[] 128
$n = $sock.Receive($buf)
[System.Text.Encoding]::ASCII.GetString($buf, 0, $n).Trim()
$sock.Close()
```

```
绑定家庭网卡 -> SSH-2.0-OpenSSH_6.1                        ← 真电视
默认路由     -> 目标计算机积极拒绝 (connection refused)     ← 公司那台机器没开 9922
```

---

## 4. 关键的三个反直觉点

### 4.1 「经网关」和「on-link」不是一回事

同一网段内互访，路由应该用 **next hop = `0.0.0.0`（on-link）**，
而不是指向网关。指向网关会让家用路由器收到一个「发给本网段设备」的包，
很多家用路由器不转发（不做 hairpin）→ 直接丢包。

```powershell
route delete 192.168.1.4
route add 192.168.1.4 mask 255.255.255.255 192.168.1.1 metric 1 if 5   # 经网关 -> 超时
route add 192.168.1.4 mask 255.255.255.255 0.0.0.0      metric 1 if 5   # on-link -> TTL=64 ✓
```

### 4.2 VPN 客户端有「强推循环」，静态修改会被推翻

加完路由后连续轮询，观察它多久被抢回去：

```powershell
route add 192.168.1.4 mask 255.255.255.255 0.0.0.0 metric 1 if 5
for ($i=1; $i -le 6; $i++) {
  Start-Sleep 1
  $rts = (Get-NetRoute -DestinationPrefix '192.168.1.4/32' -EA SilentlyContinue |
          Select -ExpandProperty InterfaceIndex) -join ','
  $chosen = (Find-NetRoute -RemoteIPAddress 192.168.1.4).InterfaceIndex | Select -Last 1
  "t=${i}s  /32-on=[$rts]  chosen=$chosen"
}
```

```
t=1s  /32-on=[5]     chosen=5    ← 自己的路由生效
t=2s  /32-on=[5]     chosen=5
t=3s  /32-on=[11,5]  chosen=11   ← SecoClient 注入了自己的 /32，且优先级更高
```

同样地，把 VPN 网卡 metric 抬到 9999，**2 秒后会被改回 1**：

```powershell
Set-NetIPInterface -InterfaceIndex 11 -AddressFamily IPv4 -InterfaceMetric 9999
# ... 2~3 秒后 ...
(Get-NetIPInterface -InterfaceIndex 11 -AddressFamily IPv4).InterfaceMetric   # => 1
```

> **教训**：对付这类有守护进程的 VPN，别做静态配置对抗，会一直输。

### 4.3 ⭐ metric「完全打平」也还是输

Windows 选路：先比前缀长度（最长匹配），再比 `路由 metric + 网卡 metric`。

把物理网卡 metric 压到 1、路由 metric 压到 0 → 合计 **1**；
SecoClient 那边是 `0 + 1` → 也是 **1**。**打平了。**

实测结果：**依然 100% 选中 VPN 网卡**。

```
t=3s  m5=1 m11=1  /32=[11,5] chosen=11 -> TTL=62   ← 平局仍然输
```

> **教训**：以为「metric 压到最低就能赢」是错的。平局由 Windows 内部规则裁决，
> 不要指望它站在你这边。**必须换思路，而不是继续调参数。**

---

## 5. 解法：socket 绑定源地址，绕过路由表

Windows 在 socket 绑定源地址时，会**强制从该地址所属网卡发出**，
不查路由表。这就是 3.3 里 `ping -S` 能直连的原因。

于是做一个本地 TCP 中继：

```
ares  ->  127.0.0.1:<随机端口>   （改 ares 设备配置指向它）
                 ||
        [ 绑定 192.168.1.6 再 dial ]      ← 关键：源地址绑定
                 ||
              192.168.1.4:9922  （真电视）
```

要点：

- 只监听 `127.0.0.1`（`TcpListener([IPAddress]::Loopback, 0)`，端口 0 = 让系统选空闲端口）
- 出站连接前先 `Bind()` 到本地物理网卡 IP
- **不改路由表、不影响公司 VPN**，这是相比「禁用 VPN」最大的优势

### 中继实现要点（PowerShell）

```powershell
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port   # 系统分配的空闲端口
```

后台用 runspace 跑（**不要用 `Start-Job`** —— 跨进程，启停慢且 `Stop-Job` 可能挂住）：

```powershell
$rs = [runspacefactory]::CreateRunspace(); $rs.ApartmentState = 'MTA'; $rs.Open()
$ps = [powershell]::Create(); $ps.Runspace = $rs
$null = $ps.AddScript({ param($listener,$srcIp,$dstIp,$dstPort) ... }).AddArgument($listener)...
$null = $ps.BeginInvoke()
```

循环里的两个技巧：

1. `AcceptTcpClientAsync()` + `Wait(150)`，而不是阻塞的 `AcceptTcpClient()`
   —— 这样主循环有空隙做清理，也让外部能停掉它
2. `CopyToAsync()` 双向对拷是**纯 .NET 异步**，不需要 PowerShell 脚本块回调，
   所以**天然支持并发连接**（SSH 会话 + SFTP 可能并存）

退出方式：**从外面调 `$listener.Stop()`**，让阻塞的 accept 抛异常，循环自然结束。
这比依赖 `$ps.Stop()` 可靠（`Stop()` 遇到不可中断的 .NET 阻塞调用会挂住）。

```powershell
$script:RelayListener.Stop()
$null = $script:RelayPs.BeginStop($null, $null)   # 用 BeginStop，不用 Stop，避免阻塞
```

### 让 ares 走中继

改 `%APPDATA%\.webos\tv\novacom-devices.json` 里对应设备的 `host` / `port`：

```json
{ "name": "lg", "host": "127.0.0.1", "port": "64414", "username": "prisoner", ... }
```

**必须先备份，且保证任何退出路径都还原**（见 6.4）。

---

## 6. 工程踩坑清单（与网络无关，但都会让你白折腾）

### 6.1 ⭐ 文件开头有两个 BOM → 假的语法错误

`.ps1` 开头出现了 `EF BB BF EF BB BF`。PowerShell 只剥掉**一个** BOM，
第二个变成内容里字面的 `U+FEFF`，挡在 `#` 前面，第 1 行就不是注释了。

报错却指向 param 块，**极具误导性**：

```
Unexpected attribute 'CmdletBinding'.
Unexpected token 'param' in expression or statement.
The assignment expression is not valid. ...
```

**真正的位置在第 1 行，报错位置在第 6 行。**

排查手法 —— 直接数 BOM：

```powershell
$b = [System.IO.File]::ReadAllBytes($p)
$bom = 0
while ($bom*3+2 -lt $b.Length -and $b[$bom*3] -eq 0xEF -and
       $b[$bom*3+1] -eq 0xBB -and $b[$bom*3+2] -eq 0xBF) { $bom++ }
"BOM count = $bom"
```

修法是**按字节**删掉多余那 3 个字节，别用文本编辑器「另存为」，容易再来一遍：

```powershell
[System.IO.File]::WriteAllBytes($p, $b[3..($b.Length-1)])
```

> 项目 README 也写了 `*.ps1 保存为 UTF-8 with BOM 编码` —— 是**恰好一个** BOM。

### 6.2 ⭐ 无 BOM 的 UTF-8 会被 PS 5.1 当 GBK，产生**假的语法错误**

PowerShell 5.1 读无 BOM 文件时按系统 ANSI 代码页（中文系统 = GBK）解码。
UTF-8 的中文被按 GBK 拆成双字节，**字节 `0x5C`（即 `\`）可能被当成 GBK 尾字节吃掉**，
于是字符串里的 `\` 或引号被吞，报出一堆莫名其妙的语法错误：

```
line 455 col 6: The Try statement is missing its Catch or Finally block.
line 502 col 12: Missing file specification after redirection operator.
```

**同一个文件，加 BOM 前后：3 个错误 → 0 个错误。**

> 教训：看到 PS 5.1 报「莫名其妙的语法错误」，**先怀疑编码，别怀疑语法**。
> 验证方式：加 BOM 后重新 `Parser::ParseFile` 对比错误数。

### 6.3 不要把中文塞进 `pwsh -Command`

在 `-Command` 里内联中文做字符串替换，会让引号配对错乱（同样是被吞字节）：

```
Unexpected token '按回车键"...' in expression or statement.
The hash literal was incomplete.
```

**做法**：把带中文的逻辑写成**独立脚本文件**（由工具落盘，UTF-8），再执行；
或者干脆让命令行保持**纯 ASCII**，用正则捕获组保留中文：

```powershell
# 用 [^"]* 捕获原本的中文提示行，替换时用 $1 原样带回，命令行里不出现中文
$pat = '(?s)Write-Host ""\n(Write-Host "[^"]*" -ForegroundColor Yellow)\nRead-Host\s*$'
$rep = "if (-not `$NoPause) {`n    Write-Host `"`"`n    `$1`n    Read-Host`n}"
```

### 6.4 清理逻辑必须幂等，且覆盖「所有」退出路径

第一版中继测试时，命令**超时被强杀**，`Copy-Item $bak $cfg` 那步没执行到，
结果 **ares 配置停留在 `127.0.0.1:19922`**，留下了 `.wolbak` 备份。

修法三件套：

1. 清理函数**幂等**（`if ($script:Cleaned) { return }`），可以重复调用
2. 主流程包在 `try { ... } finally { Invoke-Cleanup }` 里
   —— PowerShell 的 `exit` 和 `trap` 都会跑到 `finally`
3. 再加一个 `trap { Invoke-Cleanup; ... }` 兜底

> 教训：**改的是用户的环境（配置文件/路由/网卡）时，清理路径要和主逻辑一样认真对待。**

### 6.5 结尾的 `Read-Host` 会卡住自动化

脚本为了「防闪退」在结尾 `Read-Host`，在 CI / 非交互场景会挂住或报错。
加一个 `-NoPause` 开关；但注意 `Register-EngineEvent` 的 action 块
**看不到脚本作用域变量**，要用环境变量传递：

```powershell
if ($NoPause) { $env:WOL_NO_PAUSE = '1' }

Register-EngineEvent PowerShell.Exiting -Action {
    if ($env:WOL_NO_PAUSE) { return }
    ...
}
```

### 6.6 安全：`ares-novacom --getkey` 失败不代表要停

它报 `Failed to get ssh private key`，但 `~/.ssh/lg_webos` **本来就存在且可用**，
`ares-device -i` 完全正常。**先检查密钥是否已存在，存在就跳过 `--getkey`**，
不要把一个非必需步骤当成致命错误。

### 6.7 顺手发现的：明文口令在配置里

`novacom-devices.json` 里存着 `"passphrase": "C30E73"`。这文件在 `%APPDATA%` 下，
分享配置/截图时记得打码。

---

## 7. 命令速查

```powershell
# —— 定位 ——
Find-NetRoute -RemoteIPAddress <IP>                       # 实际会走哪张网卡
Get-NetIPAddress -AddressFamily IPv4                      # 所有 IPv4
Get-NetAdapter | Select ifIndex,Name,InterfaceDescription # 辨认真实/虚拟网卡
Get-NetRoute -AddressFamily IPv4                          # 路由表（重点看 RouteMetric）
Get-NetIPInterface -AddressFamily IPv4                    # 网卡 metric
Get-NetNeighbor -IPAddress <IP>                           # ARP：一个 IP 几个 MAC？

# —— 判定「连到了谁」 ——
ping -n 2 -S <源IP> <目标IP>                              # 源绑定 ping，看 TTL
# TTL 64 = 直连；明显 <64 = 被路由过

# —— 修 BOM ——
$b = [System.IO.File]::ReadAllBytes($p)
$bom = 0; while ($b[$bom*3] -eq 0xEF -and $b[$bom*3+1] -eq 0xBB -and
              $b[$bom*3+2] -eq 0xBF) { $bom++ }           # 应为 1
[System.IO.File]::WriteAllBytes($p, $b[3..($b.Length-1)]) # 删掉多余的

# —— 验证脚本语法（不执行）——
$e=$null; [System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$null,[ref]$e)
$e.Count                                                  # 0 才干净

# —— 不执行也能列参数 ——
(Get-Command $p).Parameters.Keys
```

---

## 8. 可迁移的经验（重点）

1. **「通」不等于「通到对端」。** 网段冲突时两边的机器都能应答。
   一定要验证**身份**（MAC / TTL / banner），不能只看连通性。
2. **先做对照实验，再下结论。** 源地址绑定对比（3.3）一次就把问题钉死了，
   比读十遍文档有用。
3. **区分「现象」和「病根」。** 现象是「ping 不通」，
   病根是「网段冲突 + VPN 强推路由」。盯着现象改，会一直改错地方。
4. **对抗有守护进程的软件，别拼参数。** metric 打平都输，说明这条路根本不通，
   要换机制（这里换成源地址绑定）。
5. **报错位置可能是假的。** 语法错误先查编码；网络错误先查身份。
   工具的报错是线索，不是结论。
6. **改到用户环境就要能还原。** 幂等清理 + `finally` + `trap`，
   并且在**正常结束**后也复查一遍（本次就是靠复查才发现配置被留在中继地址上）。
7. **留证据，别只留结论。** 每个判断后面都跟一条可复现的命令和它的真实输出，
   后来人才能验证你是不是对的。
