$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (-not $env:SCANIT_EVAL_URL) {
  $env:SCANIT_EVAL_URL = "http://127.0.0.1:5173/api/audit-document"
}
# Preferir IPv4 al resolver nombres (Windows / Node 18+)
if (-not $env:NODE_OPTIONS -or $env:NODE_OPTIONS -notmatch "dns-result-order") {
  $suffix = if ($env:NODE_OPTIONS) { " " + $env:NODE_OPTIONS } else { "" }
  $env:NODE_OPTIONS = "--dns-result-order=ipv4first" + $suffix
}

# Hasta las 12:00 del dia local; si ya paso, margen de 6 h desde ahora
$deadline = [DateTime]::Today.AddHours(12)
if ((Get-Date) -ge $deadline) {
  $deadline = (Get-Date).AddHours(6)
  Write-Host "[eval-until-noon] Las 12:00 ya pasaron; reintentando hasta $($deadline.ToString('yyyy-MM-dd HH:mm'))."
}
else {
  Write-Host "[eval-until-noon] Reintentos hasta $($deadline.ToString('yyyy-MM-dd HH:mm')) (o hasta evaluacion sin fallos HTTP)."
}

while ((Get-Date) -lt $deadline) {
  node scripts/eval-dataset.mjs
  $code = $LASTEXITCODE

  if ($code -eq 0) {
    Write-Host "[eval-until-noon] Listo: todas las peticiones respondieron OK."
    exit 0
  }

  $latest = Get-ChildItem -Path (Join-Path $ProjectRoot "dataset\reports\eval-metrics-*.json") -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $detail = ""
  if ($latest) {
    try {
      $m = Get-Content $latest.FullName -Raw | ConvertFrom-Json
      $detail = " (failed=$($m.dataset.failed)/$($m.dataset.total))"
    }
    catch { }
  }

  $wait = 90
  Write-Host "[eval-until-noon] Codigo salida $code$detail. Nueva pasada en ${wait}s..."
  Start-Sleep -Seconds $wait
}

Write-Host "[eval-until-noon] Tiempo limite alcanzado sin una pasada completa sin errores HTTP."
exit 1
