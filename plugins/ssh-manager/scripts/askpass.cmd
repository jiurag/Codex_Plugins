@echo off
setlocal
if "%SSH_MANAGER_ASKPASS_FILE%"=="" exit /b 1
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$p=$env:SSH_MANAGER_ASKPASS_FILE; if(-not (Test-Path -LiteralPath $p)){exit 1}; $s=[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8); Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; [Console]::Out.Write($s); [Console]::Out.Write([Environment]::NewLine)"
exit /b %ERRORLEVEL%