# =============================================================
#  唤醒电脑（Wake PC）webOS 部署脚本 (v2)
#
#  为什么不再改路由表：
#    本机装有 SecoClient（SVN Adapter V1.0）。它的公司内网和家里 LAN
#    都用 192.168.1.0/24，SecoClient 每隔 2~3 秒就会重新注入
#    192.168.1.0/24 和 192.168.1.4/32 路由（metric 0，网卡 metric 1），
#    并把被改过的网卡 metric 复位。实测即使在 metric 完全打平的情况下，
#    Windows 依然优先走 VPN 网卡 —— 所以「加路由绕过 VPN」这条路走不通。
#
#  现在的做法：
#    起一个只监听 127.0.0.1 的 TCP 中继，由它**绑定本地物理网卡 IP**
#    去连电视。Windows 在 socket 绑定源地址时会强制走该网卡，
#    从而完全绕开路由表，也不影响公司 VPN。部署结束自动还原 ares 配置。
# =============================================================
[CmdletBinding()]
param(
    [string]$TvIp       = '192.168.1.4',
    [int]   $TvPort     = 9922,
    [string]$Device     = 'lg',
    [string]$Passphrase = '',
    [string]$ProjectDir = '',
    [switch]$SkipLaunch,
    [switch]$TestWake,
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
$summary = @()

# -NoPause: skip the closing pause prompt (for automation / CI)
if ($NoPause) { $env:WOL_NO_PAUSE = '1' }

# === 中间态（Cleanup 要还原它们） ===
$script:RelayListener = $null
$script:RelayPs       = $null
$script:RelayRs       = $null
$script:CfgPath       = $null
$script:CfgBackup     = $null
$script:CfgExisted    = $false
$script:Cleaned       = $false

# === 防闪退：任何退出路径都暂停 ===
Register-EngineEvent PowerShell.Exiting -Action {
    if ($env:WOL_NO_PAUSE) { return }
    Write-Host ""
    Write-Host "按回车键关闭窗口..." -ForegroundColor Yellow
    try { Read-Host } catch {}
} | Out-Null

# === 输出小工具 ===
function Say($msg) { Write-Host $msg }
function Ok($msg)  { Write-Host ("  [OK]   " + $msg) -ForegroundColor Green }
function Fail($msg){ Write-Host ("  [FAIL] " + $msg) -ForegroundColor Red }
function Warn($msg){ Write-Host ("  [!!]   " + $msg) -ForegroundColor Yellow }
function Info($msg){ Write-Host ("  [..]   " + $msg) -ForegroundColor DarkGray }

trap {
    Invoke-Cleanup
    Write-Host ""
    Write-Host "发生未捕获错误: $_" -ForegroundColor Red
    exit 1
}

# =============================================================
#  清理：关闭中继 + 还原 ares 配置（幂等，可重复调用）
# =============================================================
function Invoke-Cleanup {
    if ($script:Cleaned) { return }
    $script:Cleaned = $true

    # 1) 关闭中继
    if ($script:RelayListener) {
        try { $script:RelayListener.Stop() } catch {}
        $script:RelayListener = $null
    }
    if ($script:RelayPs) {
        try { $null = $script:RelayPs.BeginStop($null, $null) } catch {}
        Start-Sleep -Milliseconds 150
        try { $script:RelayPs.Dispose() } catch {}
        $script:RelayPs = $null
    }
    if ($script:RelayRs) {
        try { $script:RelayRs.Close() } catch {}
        try { $script:RelayRs.Dispose() } catch {}
        $script:RelayRs = $null
    }

    # 2) 还原 ares 设备配置
    if ($script:CfgPath -and $script:CfgBackup) {
        try {
            if ($script:CfgExisted) {
                Copy-Item $script:CfgBackup $script:CfgPath -Force
            } else {
                Remove-Item $script:CfgPath -Force -ErrorAction SilentlyContinue
            }
            Remove-Item $script:CfgBackup -Force -ErrorAction SilentlyContinue
            Ok "已关闭中继并还原 ares 设备配置"
        } catch {
            Warn "还原 ares 配置失败，请手动检查: $script:CfgPath"
            Warn "备份仍在: $script:CfgBackup"
        }
    } else {
        Info "中继已关闭"
    }
}

# =============================================================
#  网络工具
# =============================================================

# 找到与目标 IP 同网段的本地物理网卡（自动排除 SVN/VPN/虚拟网卡）
function Get-LocalAddressFor([string]$TargetIp) {
    $target = $null
    try { $target = [System.Net.IPAddress]::Parse($TargetIp) } catch { return $null }
    if ($target.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $null }
    $tb = $target.GetAddressBytes()

    $cands = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.InterfaceAlias -notmatch 'SVN|VPN|Loopback|Virtual|TAP|VMware|Hyper-V|Bluetooth|WAN Miniport'
    }

    foreach ($c in $cands) {
        $ib = ([System.Net.IPAddress]::Parse($c.IPAddress)).GetAddressBytes()
        $pl = [int]$c.PrefixLength
        $same = $true
        for ($i = 0; $i -lt 4; $i++) {
            $bits = [Math]::Min(8, [Math]::Max(0, $pl - $i * 8))
            $mask = 0
            if ($bits -gt 0) { $mask = (0xFF -shl (8 - $bits)) -band 0xFF }
            if (($tb[$i] -band $mask) -ne ($ib[$i] -band $mask)) { $same = $false; break }
        }
        if ($same) { return $c }
    }
    return $null
}

# 绑定源地址测端口：Windows 会强制走该源地址所属网卡，绕开路由表
function Test-TvPort([string]$SourceIp, [string]$TargetIp, [int]$Port, [int]$TimeoutMs = 2500) {
    $sock = $null
    try {
        $sock = New-Object System.Net.Sockets.Socket(
            [System.Net.Sockets.AddressFamily]::InterNetwork,
            [System.Net.Sockets.SocketType]::Stream,
            [System.Net.Sockets.ProtocolType]::Tcp)
        $sock.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse($SourceIp), 0)))
        $ar = $sock.BeginConnect($TargetIp, $Port, $null, $null)
        if ($ar.AsyncWaitHandle.WaitOne($TimeoutMs, $false) -and $sock.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        if ($sock) { try { $sock.Close() } catch {} }
    }
}

# 读一次 SSH banner，确认中继确实接到了电视
function Get-RelayBanner([int]$Port, [int]$TimeoutMs = 5000) {
    $c = $null
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not ($ar.AsyncWaitHandle.WaitOne($TimeoutMs, $false) -and $c.Connected)) { return $null }
        $c.ReceiveTimeout = 3000
        $ns = $c.GetStream()
        $buf = New-Object byte[] 128
        $n = $ns.Read($buf, 0, 128)
        if ($n -le 0) { return $null }
        return [System.Text.Encoding]::ASCII.GetString($buf, 0, $n).Trim()
    } catch {
        return $null
    } finally {
        if ($c) { try { $c.Close() } catch {} }
    }
}

# =============================================================
#  中继：127.0.0.1:<随机端口> -> 电视:<TvPort>（源地址绑定本地网卡）
#  用 runspace 后台运行；AcceptTcpClientAsync + CopyToAsync 都是
#  纯 .NET 异步，不需要脚本块回调，可并发处理多条连接。
# =============================================================
function Start-TvRelay([string]$SourceIp, [string]$TargetIp, [int]$TargetPort) {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port

    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = 'MTA'
    $rs.ThreadOptions = 'ReuseThread'
    $rs.Open()

    $ps = [powershell]::Create()
    $ps.Runspace = $rs

    $null = $ps.AddScript({
        param($listener, $srcIp, $dstIp, $dstPort)

        $src = [System.Net.IPAddress]::Parse($srcIp)
        $pending = New-Object System.Collections.ArrayList

        $accept = $listener.AcceptTcpClientAsync()
        while ($true) {
            try {
                if ($accept.Wait(150)) {
                    $client = $accept.Result
                    try {
                        $remote = New-Object System.Net.Sockets.TcpClient
                        $remote.Client.Bind((New-Object System.Net.IPEndPoint($src, 0)))
                        $remote.Connect($dstIp, $dstPort)
                        $cs = $client.GetStream()
                        $rw = $remote.GetStream()
                        $t1 = $cs.CopyToAsync($rw)
                        $t2 = $rw.CopyToAsync($cs)
                        [void]$pending.Add(@{ C = $client; R = $remote; T1 = $t1; T2 = $t2 })
                    } catch {
                        try { $client.Close() } catch {}
                    }
                    $accept = $listener.AcceptTcpClientAsync()
                }
            } catch {
                break   # listener.Stop() 被调用，正常退出
            }

            # 任一方向结束就关掉这对 socket，避免连接堆积
            for ($i = $pending.Count - 1; $i -ge 0; $i--) {
                $p = $pending[$i]
                if ($p.T1.IsCompleted -or $p.T2.IsCompleted) {
                    try { $p.C.Close() } catch {}
                    try { $p.R.Close() } catch {}
                    $pending.RemoveAt($i)
                }
            }
        }
    }).AddArgument($listener).AddArgument($SourceIp).AddArgument($TargetIp).AddArgument($TargetPort)

    $null = $ps.BeginInvoke()

    $script:RelayListener = $listener
    $script:RelayPs       = $ps
    $script:RelayRs       = $rs
    return $port
}

# =============================================================
#  ares 设备配置
# =============================================================
function Get-ActiveNovacomConfig {
    $prof = (& ares-config -c 2>&1 | Out-String).Trim()
    if ($prof -match 'profile set to\s+(\S+)') { $prof = $Matches[1] }
    elseif ($prof -match '\b(ose|tv|signage|apollo)\b') { $prof = $Matches[1] }
    else { $prof = 'tv' }
    $cfg = Join-Path $env:APPDATA (".webos\$prof\novacom-devices.json")
    if (-not (Test-Path $cfg)) { $cfg = Join-Path $env:APPDATA '.webos\tv\novacom-devices.json' }
    return $cfg
}

function Read-AresDevices([string]$CfgPath) {
    if (-not (Test-Path $CfgPath)) { return $null }
    try { return (Get-Content $CfgPath -Raw | ConvertFrom-Json) } catch { return $null }
}

function Save-AresDevices([string]$CfgPath, $json) {
    $txt = $json | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($CfgPath, $txt, (New-Object System.Text.UTF8Encoding($false)))
}

# 把设备的 host/port 指向本地中继；返回该设备的 ssh 私钥名
function Set-AresEndpoint([string]$CfgPath, [string]$DeviceName, [string]$HostName, [int]$Port) {
    $json = Read-AresDevices $CfgPath
    if (-not $json) { return $null }
    $keyName = $null
    $found = $false
    foreach ($d in $json) {
        if ($d.name -eq $DeviceName) {
            $d.host = $HostName
            $d.port = "$Port"
            $d.default = $true
            if ($d.privateKey -and $d.privateKey.openSsh) { $keyName = $d.privateKey.openSsh }
            $found = $true
        }
    }
    if (-not $found) { return $null }
    Save-AresDevices $CfgPath $json
    return $keyName
}

# =============================================================
#  其它
# =============================================================
function Get-Passphrase {
    if ($Passphrase) { return $Passphrase }
    if ($env:WEBOS_PASSPHRASE) { return $env:WEBOS_PASSPHRASE }
    $pf = Join-Path $PSScriptRoot 'passphrase.txt'
    if (Test-Path $pf) {
        $p = (Get-Content $pf -Raw).Trim()
        if ($p) { return $p }
    }
    $p = Read-Host "请输入电视 Developer Mode 左下角显示的 6 位 Passphrase（区分大小写）"
    return $p.Trim()
}

function Get-CommitHash {
    $hash = ''
    try { $hash = (& git -C $ProjectDir rev-parse --short HEAD 2>$null | Out-String).Trim() } catch { $hash = '' }
    if (-not $hash) { $hash = 'nogit' }
    return $hash
}

function Set-BuildHash([string]$stageApp, [string]$hash) {
    $staged = Join-Path $stageApp 'appinfo.json'
    if (-not (Test-Path $staged)) { return $false }
    $info = Get-Content $staged -Raw | ConvertFrom-Json
    $info | Add-Member -NotePropertyName 'buildHash' -NotePropertyValue $hash -Force
    $json = $info | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($staged, $json, (New-Object System.Text.UTF8Encoding($false)))
    return $true
}

# =============================================================
#  主流程
# =============================================================
if (-not $ProjectDir) { $ProjectDir = $PSScriptRoot }
if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $ProjectDir) { $ProjectDir = (Get-Location).Path }

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " Wake-on-LAN webOS 部署脚本 (v2 / 本地中继绕开 VPN)"
Write-Host " 电视: $TvIp`:$TvPort   设备: $Device   项目: $ProjectDir"
Write-Host "==============================================" -ForegroundColor Cyan

try {

    # ---------- 1/8 ares ----------
    Say "`n[1/8] 检查 ares CLI..."
    if (Get-Command ares -ErrorAction SilentlyContinue) {
        Ok "ares 可用: $((ares -V) 2>&1)"; $summary += 'OK ares'
    } else {
        Fail "未找到 ares。先执行: npm install -g @webos-tools/cli"
        $summary += 'FAIL ares'; exit 1
    }

    # ---------- 2/8 profile ----------
    Say "`n[2/8] 确保 ares profile=tv（webOS TV Dev Mode）..."
    $cur = (& ares-config -c 2>&1 | Out-String)
    if ($cur -notmatch '\btv\b') { & ares-config -p tv 2>&1 | Out-Null }
    if ((& ares-config -c 2>&1 | Out-String) -match '\btv\b') {
        Ok "ares profile 已设为 tv（--getkey 仅 tv 支持）"; $summary += 'OK profile'
    } else {
        Fail "无法将 ares profile 切到 tv，请手动执行: ares-config -p tv"
        $summary += 'FAIL profile'; exit 1
    }

    # ---------- 3/8 本地网卡 + 绕开 VPN 的可达性 ----------
    Say "`n[3/8] 定位本地网卡并直连测试 $TvIp`:$TvPort ..."
    $addr = Get-LocalAddressFor $TvIp
    if (-not $addr) {
        Fail "找不到与 $TvIp 同网段的本地物理网卡。请确认电视和电脑在同一局域网。"
        $summary += 'FAIL nic'; exit 1
    }
    $srcIp = $addr.IPAddress
    Ok "本地网卡: $srcIp/$($addr.PrefixLength)  (接口 $($addr.InterfaceIndex) / $($addr.InterfaceAlias))"

    # 把 VPN 劫持情况讲清楚（只是诊断，不是报错）
    $chosen = (Find-NetRoute -RemoteIPAddress $TvIp -ErrorAction SilentlyContinue |
               Where-Object { $_.DestinationPrefix } | Select-Object -Last 1)
    if ($chosen -and $chosen.InterfaceIndex -ne $addr.InterfaceIndex) {
        Warn "默认路由把 $TvIp 送到了接口 $($chosen.InterfaceIndex)（$($chosen.InterfaceAlias)）—— 典型的 VPN 网段冲突劫持。"
        Info "本脚本不改路由表，而是用源地址绑定直连电视来绕开它。"
    }

    if (-not (Test-TvPort $srcIp $TvIp $TvPort)) {
        Fail "从本地网卡 $srcIp 直连 $TvIp`:$TvPort 不通。"
        Fail "请确认：① 电视已开机且与电脑同一局域网；② 电视上 Developer Mode 应用在前台（Dev Mode Status=ON、Key Server=ON、会话未过期）。"
        $summary += 'FAIL reach'; exit 1
    }
    Ok "直连成功：$srcIp -> $TvIp`:$TvPort 端口开放"
    $summary += 'OK reach'

    # ---------- 4/8 中继 + 切换 ares ----------
    Say "`n[4/8] 启动本地中继并把 ares 指向它 ..."
    $cfgPath = Get-ActiveNovacomConfig
    if (-not (Test-Path $cfgPath)) {
        Fail "找不到 ares 设备配置: $cfgPath"
        $summary += 'FAIL cfg'; exit 1
    }

    $cfgJson  = Read-AresDevices $cfgPath
    $devNames = @()
    if ($cfgJson) { $devNames = @($cfgJson | ForEach-Object { $_.name }) }
    if ($devNames -notcontains $Device) {
        Fail "ares 配置里没有名为 '$Device' 的设备（现有: $($devNames -join ', ')）。"
        $summary += 'FAIL cfg'; exit 1
    }

    # 备份配置，供 Cleanup 还原
    $script:CfgPath    = $cfgPath
    $script:CfgBackup  = "$cfgPath.wolbak"
    $script:CfgExisted = $true
    Copy-Item $cfgPath $script:CfgBackup -Force

    $relayPort = Start-TvRelay $srcIp $TvIp $TvPort
    $keyName   = Set-AresEndpoint $cfgPath $Device '127.0.0.1' $relayPort
    if (-not $keyName) {
        Fail "写入 ares 设备配置失败。"
        $summary += 'FAIL cfg'; exit 1
    }
    Ok "中继已启动: 127.0.0.1:$relayPort -> $TvIp`:$TvPort (源地址 $srcIp)"

    # 自检：中继是否真的接到了电视的 SSH
    $banner = Get-RelayBanner $relayPort
    if ($banner -like 'SSH-*') {
        Ok "中继自检通过: $banner"; $summary += 'OK relay'
    } else {
        Fail "中继自检失败（没读到电视 SSH banner，收到: '$banner'）"
        $summary += 'FAIL relay'; exit 1
    }

    # ---------- 5/8 SSH 密钥 ----------
    Say "`n[5/8] 准备 SSH 密钥 ..."
    $keyPath = Join-Path $env:USERPROFILE (".ssh\$keyName")
    if (Test-Path $keyPath) {
        Ok "已存在 SSH 密钥 $keyName，跳过 --getkey"
        $summary += 'OK key'
    } else {
        $Passphrase = Get-Passphrase
        if (-not $Passphrase) {
            Fail "未取得 Passphrase。请用 -Passphrase 参数、环境变量 WEBOS_PASSPHRASE、passphrase.txt 或交互输入提供。"
            $summary += 'FAIL key'; exit 1
        }
        $kv = & ares-novacom --device $Device --getkey --passphrase $Passphrase 2>&1 | Out-String
        if ($kv -match 'ERR!|Failed|Error|denied|invalid') {
            Fail "取密钥失败: $($kv.Trim())"
            Fail "请确认电视 Developer Mode 保持前台（Dev Mode Status=ON、Key Server=ON、会话未过期），且 Passphrase 与电视左下角 6 位字符完全一致。"
            $summary += 'FAIL key'; exit 1
        }
        Ok "取密钥成功"; $summary += 'OK key'
    }

    # ---------- 6/8 验证连接 ----------
    Say "`n[6/8] 验证连接 (ares-device -i) ..."
    $info = & ares-device -i --device $Device 2>&1 | Out-String
    if ($info -match 'modelName|sdkVersion|boardType') {
        $line = (($info -split "`r?`n") | Where-Object { $_ -match 'modelName' } | Select-Object -First 1)
        Ok "连接成功: $($line.Trim())"; $summary += 'OK connect'
    } else {
        Fail "ares-device -i 读取失败: $($info.Trim())"
        $summary += 'FAIL connect'; exit 1
    }

    # ---------- 7/8 打包 ----------
    Say "`n[7/8] 打包应用 ..."
    $svcDir   = Join-Path $ProjectDir 'services\com.woltv.wakepc.service'
    $dist     = Join-Path $ProjectDir 'dist'
    $stage    = Join-Path $env:TEMP ("wol-stage-" + [guid]::NewGuid().ToString('N'))
    $stageApp = Join-Path $stage 'app'
    New-Item -ItemType Directory -Force -Path $dist     | Out-Null
    New-Item -ItemType Directory -Force -Path $stageApp | Out-Null
    Get-ChildItem "$dist\*.ipk" -ErrorAction SilentlyContinue | Remove-Item -Force

    $appFiles = @('appinfo.json', 'index.html', 'js', 'css', 'icon.png', 'largeIcon.png')
    foreach ($f in $appFiles) {
        $src = Join-Path $ProjectDir $f
        if (Test-Path $src) { Copy-Item -Path $src -Destination $stageApp -Recurse -Force }
    }

    $commitHash = Get-CommitHash
    if (Set-BuildHash $stageApp $commitHash) {
        Ok "已注入提交哈希: buildHash=$commitHash"; $summary += "OK hash $commitHash"
    } else {
        Warn "打包副本缺少 appinfo.json，跳过哈希注入"; $summary += 'WARN hash'
    }

    $pkgOut = & ares-package $stageApp $svcDir -o $dist 2>&1 | Out-String
    Remove-Item -Path $stage -Recurse -Force -ErrorAction SilentlyContinue

    $ipk = Get-ChildItem -Path $dist -Filter '*.ipk' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($ipk) { Ok "打包完成: $($ipk.Name)"; $summary += 'OK package' }
    else { Fail "打包失败: $pkgOut"; $summary += 'FAIL package'; exit 1 }

    # ---------- 8/8 安装 ----------
    Say "`n[8/8] 安装应用到电视 ..."
    $inst = & ares-install --device $Device $ipk.FullName 2>&1 | Out-String
    if ($inst -match 'Connection timed out|ERR!|refused|unreachable') {
        Fail "安装失败: $($inst.Trim())"; $summary += 'FAIL install'; exit 1
    }
    if ($inst -match 'Success|Installed|succeeded|already installed|existing') {
        Ok "安装成功: com.woltv.wakepc"; $summary += 'OK install'
    } else {
        Fail "安装失败: $($inst.Trim())"; $summary += 'FAIL install'; exit 1
    }

    if (-not $SkipLaunch) {
        Say "`n[额外] 启动应用 ..."
        $la = & ares-launch --device $Device com.woltv.wakepc 2>&1 | Out-String
        if ($la -match 'Success|launched|success') {
            Ok "应用已启动，请到电视上核对并保存配置"; $summary += 'OK launch'
        } else {
            Warn "启动返回: $($la.Trim())"; $summary += 'WARN launch'
        }
    }

    if ($TestWake) {
        Say "`n[额外] 尝试触发一次唤醒 (luna-send)..."
        $w = & ares-shell --device $Device "luna-send -n 1 luna://com.woltv.wakepc.service/wake '{}'" 2>&1 | Out-String
        Say "  $($w.Trim())"
    }

} finally {
    Invoke-Cleanup
}

# ---------- 汇总 ----------
Say "`n================ 结果汇总 ================" -ForegroundColor Cyan
$summary | ForEach-Object { Write-Host "  $_" }
if (-not ($summary | Where-Object { $_ -like 'FAIL*' })) {
    Say ">>> 全部成功！请到电视上打开「唤醒电脑」应用，核对 MAC/IP 并保存。" -ForegroundColor Green
} else {
    Say ">>> 存在失败项，请把上面输出发给我。" -ForegroundColor Yellow
}

