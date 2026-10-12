<#
  探测某个 Responses 端点的请求体体积上限（黑盒）。

  关键陷阱（第一次写这个脚本时踩过）：
    如果请求里用"不存在的模型名"，服务端可能在读到 model 字段时就提前拒绝、根本
    没读完整个请求体。这样不管你发多大都"看起来通过"，探测结果完全是假的。
    正确做法：
      - model 用真实存在的名字
      - 把非法参数（超出范围的 max_output_tokens）放在 JSON 最末尾
    服务端必须读完整个 body、解析完 JSON 才能发现参数非法，于是必然完整读取请求体，
    返回结果才真实反映体积限制。同时参数校验失败不会触发推理，不产生费用。

  两种 413 要分清：
    "Failed to buffer the request body: length limit exceeded" -> 应用层限制
    "413 Request Entity Too Large" + openresty HTML 页           -> 最外层 nginx 限制

  用法：
    $env:DEEPSEEK_API_KEY = "sk-xxxx"
    powershell -ExecutionPolicy Bypass -File probe-body-limit.ps1
    可选：-Url  -ProbeModel  -LowMB  -HighMB  -TimeoutSec
#>
param(
  [string]$ApiKey = $env:DEEPSEEK_API_KEY,
  [string]$Url = "https://api.deepseek.com/responses",
  [string]$ProbeModel = "deepseek-flash",
  [double]$LowMB = 0.5,
  [double]$HighMB = 64,
  [int]$TimeoutSec = 300
)

if (-not $ApiKey) { Write-Host '错误：没找到 API Key，请先设置环境变量 DEEPSEEK_API_KEY' -ForegroundColor Red; exit 1 }

$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:BodyFile = Join-Path $env:TEMP ('ds_probe_' + [Guid]::NewGuid().ToString('N') + '.json')
$script:OutFile  = Join-Path $env:TEMP ('ds_probe_out_' + [Guid]::NewGuid().ToString('N') + '.txt')

function Invoke-Probe([int]$totalBytes) {
  $pad = 'A' * ($totalBytes - 125)
  $json = '{"model":"' + $ProbeModel + '","input":[{"role":"user","content":[{"type":"input_text","text":"' + $pad + '"}]}],"max_output_tokens":99999999}'
  [System.IO.File]::WriteAllText($script:BodyFile, $json, $script:Utf8)
  $bytes = (Get-Item -LiteralPath $script:BodyFile).Length

  $code = (curl.exe -s -o $script:OutFile -w "%{http_code}" --max-time $TimeoutSec -X POST $Url `
           -H "Authorization: Bearer $ApiKey" -H "Content-Type: application/json" `
           --data-binary "@$($script:BodyFile)")

  $resp = ''
  if (Test-Path -LiteralPath $script:OutFile) { $resp = Get-Content -Raw -LiteralPath $script:OutFile }

  $kind = 'pass'
  if ($code -eq '413') {
    if ($resp -match 'Failed to buffer the request body') { $kind = 'app413' }
    elseif ($resp -match 'Request Entity Too Large') { $kind = 'nginx413' }
    else { $kind = '413-other' }
  } elseif ($code -eq '000') { $kind = 'neterr' }

  return [pscustomobject]@{ Bytes = $bytes; Code = $code; Kind = $kind }
}

$low = [int]($LowMB * 1MB)
$high = [int]($HighMB * 1MB)

Write-Host ("先探底：{0:N0} 字节" -f $low)
$r = Invoke-Probe $low
Write-Host ("  {0:N0} 字节 -> HTTP {1} ({2})" -f $r.Bytes, $r.Code, $r.Kind)
if ($r.Kind -eq 'neterr') { Write-Host '网络不通或超时。' -ForegroundColor Red; exit 5 }
if ($r.Code -eq '401' -or $r.Code -eq '403') { Write-Host 'API Key 无效或无权限。' -ForegroundColor Red; exit 4 }
if ($r.Kind -ne 'pass') { Write-Host '连最小探测都没过，把 -LowMB 调更小再试。' -ForegroundColor Yellow; exit 2 }

Write-Host ("再探顶：{0:N0} 字节" -f $high)
$r = Invoke-Probe $high
Write-Host ("  {0:N0} 字节 -> HTTP {1} ({2})" -f $r.Bytes, $r.Code, $r.Kind)
if ($r.Kind -eq 'pass') { Write-Host '这个大小也没被拒，把 -HighMB 调更大再试。' -ForegroundColor Yellow; exit 3 }

Write-Host '开始二分（约 10 次请求）...'
while (($high - $low) -gt 4096) {
  $mid = [int](($low + $high) / 2)
  $r = Invoke-Probe $mid
  Write-Host ("  {0,12:N0} 字节 -> HTTP {1} ({2})" -f $r.Bytes, $r.Code, $r.Kind)
  if ($r.Kind -eq 'pass') { $low = $mid } else { $high = $mid }
}

Remove-Item -LiteralPath $script:BodyFile, $script:OutFile -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("结论：上限在 {0:N0} 与 {1:N0} 字节之间（约 {2:N1} MB ~ {3:N1} MB）" -f $low, $high, ($low / 1MB), ($high / 1MB)) -ForegroundColor Green