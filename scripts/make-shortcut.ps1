# Gera o icone do app (a partir da marca no shell.html) e cria/atualiza o atalho
# "SQUAD CODE KIRO" na area de trabalho, apontando para SQUAD-CODE.bat.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.Drawing

# 1) Icone: extrai o apple-touch-icon (PNG) do shell.html e gera assets\squadcode.ico em 256x256.
$html = Get-Content -Raw (Join-Path $root 'src\shell.html')
$m = [regex]::Match($html, 'apple-touch-icon[^>]*base64,([^"]+)"')
if (-not $m.Success) { throw 'apple-touch-icon nao encontrado em src/shell.html' }
$png = [Convert]::FromBase64String($m.Groups[1].Value)
$ms = New-Object System.IO.MemoryStream (,$png)
$src = [System.Drawing.Bitmap]::new($ms)
$big = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, 256, 256)
$g.Dispose()
$hicon = $big.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hicon)
$icoPath = Join-Path $root 'assets\squadcode.ico'
$fs = [System.IO.File]::Create($icoPath)
$icon.Save($fs)
$fs.Close()
$icon.Dispose(); $big.Dispose(); $src.Dispose(); $ms.Dispose()
Write-Host ("icone gerado: {0} ({1} bytes)" -f $icoPath, (Get-Item $icoPath).Length)

# 2) Atalho na area de trabalho -> SQUAD-CODE.bat, com o icone.
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'SQUAD CODE KIRO.lnk'
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $root 'SQUAD-CODE.bat'
$lnk.WorkingDirectory = $root
$lnk.IconLocation = "$icoPath,0"
$lnk.Description = 'Iniciar o SQUAD/CODE KIRO (bridge local + UI em http://127.0.0.1:4317)'
$lnk.WindowStyle = 1
$lnk.Save()
Write-Host ("atalho criado: {0} (existe={1})" -f $lnkPath, (Test-Path $lnkPath))
