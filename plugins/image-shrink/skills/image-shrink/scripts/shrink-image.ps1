<#
  压缩图片 / 截图，用来避开 API 请求体的体积上限。
  背景与实测数据见本 skill 的 references/limits.md。

  用法：
    # 推荐：自动压到目标体积以内（会自己迭代质量，必要时再缩小尺寸）
    powershell -ExecutionPolicy Bypass -File shrink-image.ps1 -Path "C:\shots\a.png" -MaxBytes 400KB
    powershell -ExecutionPolicy Bypass -File shrink-image.ps1 -Path "C:\shots\*.png" -MaxBytes 400KB

    # 只按长边和质量压，不管目标体积
    powershell -ExecutionPolicy Bypass -File shrink-image.ps1 -Path "C:\shots\a.png" -MaxWidth 1280 -Quality 70

    # 输出到指定目录
    powershell -ExecutionPolicy Bypass -File shrink-image.ps1 -Path "C:\shots\*.png" -OutDir "C:\shots\small"

  参数：
    -Path      必填，图片路径，支持通配符，可传多个
    -MaxWidth  最长边目标像素，默认 1600。小字看不清就调大
    -Quality   JPEG 起始质量 1-100，默认 80
    -MaxBytes  目标体积上限，如 400KB / 1MB / 300000；设了会自动迭代
    -OutDir    输出目录，默认放原图旁边，文件名加 .small.jpg
#>
param(
  [Parameter(Mandatory=$true)][string[]]$Path,
  [int]$MaxWidth = 1600,
  [int]$Quality = 80,
  [string]$MaxBytes = "",
  [string]$OutDir = ""
)

Add-Type -AssemblyName System.Drawing

function ConvertTo-ByteSize([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return [int64]0 }
  $t = $text.Trim().ToUpperInvariant()
  if ($t -match '^([0-9]+(?:\.[0-9]+)?)\s*(KB|MB|B)?$') {
    $v = [double]$Matches[1]
    if ($Matches[2] -eq 'MB') { return [int64]($v * 1048576) }
    if ($Matches[2] -eq 'KB') { return [int64]($v * 1024) }
    return [int64]$v
  }
  throw "看不懂的体积写法：$text（示例：400KB、1MB、300000）"
}

$limit = ConvertTo-ByteSize $MaxBytes
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
if (-not $codec) { Write-Host '找不到 JPEG 编码器' -ForegroundColor Red; exit 1 }

function Save-Jpeg([System.Drawing.Bitmap]$bmp, [string]$dst, [int]$q) {
  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int]$q)
  try { $bmp.Save($dst, $codec, $ep) } finally { $ep.Dispose() }
}

function New-ScaledBitmap([System.Drawing.Image]$img, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.Clear([System.Drawing.Color]::White)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $w, $h)
  } finally { $g.Dispose() }
  return $bmp
}

$sumBefore = 0
$sumAfter = 0

foreach ($pattern in $Path) {
  $items = @(Resolve-Path -Path $pattern -ErrorAction SilentlyContinue)
  if ($items.Count -eq 0) { Write-Host "没找到：$pattern" -ForegroundColor Yellow; continue }

  foreach ($item in $items) {
    $src = $item.Path
    $img = [System.Drawing.Image]::FromFile($src)
    try {
      $longest = [double][Math]::Max($img.Width, $img.Height)
      $scale = [Math]::Min(1.0, ([double]$MaxWidth) / $longest)
      $w = [int][Math]::Max(1, [Math]::Round($img.Width * $scale))
      $h = [int][Math]::Max(1, [Math]::Round($img.Height * $scale))

      $targetDir = $OutDir
      if ([string]::IsNullOrWhiteSpace($targetDir)) { $targetDir = Split-Path -Parent $src }
      if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
      $dst = Join-Path $targetDir ([System.IO.Path]::GetFileNameWithoutExtension($src) + '.small.jpg')

      $q = [int][Math]::Min(95, [Math]::Max(40, $Quality))
      $attempt = 0
      while ($true) {
        $attempt++
        $bmp = New-ScaledBitmap $img $w $h
        try { Save-Jpeg $bmp $dst $q } finally { $bmp.Dispose() }
        $size = (Get-Item -LiteralPath $dst).Length
        if ($limit -le 0) { break }
        if ($size -le $limit) { break }
        if ($q -gt 45) { $q = [int][Math]::Max(45, $q - 10); continue }
        if ($w -le 320) { break }
        $w = [int][Math]::Max(320, [Math]::Round($w * 0.8))
        $h = [int][Math]::Max(1, [Math]::Round($img.Height * $w / [double]$img.Width))
        $q = [int][Math]::Max(45, $Quality - 15)
        if ($attempt -ge 30) { break }
      }

      $before = (Get-Item -LiteralPath $src).Length
      $after = (Get-Item -LiteralPath $dst).Length
      $sumBefore += $before
      $sumAfter += $after
      "{0}  {1}x{2} -> {3}x{4}  {5:N0} -> {6:N0} 字节  (剩 {7:P0}, q={8})  -> {9}" -f `
        [System.IO.Path]::GetFileName($src), $img.Width, $img.Height, $w, $h, $before, $after, ($after / [double]$before), $q, $dst
      if ($limit -gt 0 -and $after -gt $limit) { Write-Host ('    [未达标] 已压到极限，仍超过目标 {0:N0} 字节' -f $limit) -ForegroundColor Yellow }
    } finally {
      $img.Dispose()
    }
  }
}

if ($sumBefore -gt 0) {
  ""
  "合计 {0:N0} -> {1:N0} 字节，压掉 {2:P0}" -f $sumBefore, $sumAfter, (1 - $sumAfter / [double]$sumBefore)
  "换算成请求体（base64 x1.33）：约 {0:N1} MB -> {1:N1} MB" -f (($sumBefore * 1.33) / 1MB), (($sumAfter * 1.33) / 1MB)
  if ($limit -gt 0) { "目标上限：{0:N0} 字节" -f $limit }
}