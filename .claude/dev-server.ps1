param([int]$Port = 8000)

# Minimal static-file dev server for the MyHome worktree.
# Used by .claude/launch.json so previewing works on Windows boxes that
# have no real Python or Node — only the Windows-Store python.exe stub.

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.mjs'  = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.map'  = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon'
  '.woff' = 'font/woff'
  '.woff2'= 'font/woff2'
  '.ttf'  = 'font/ttf'
  '.txt'  = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

# Format mirrors python -m http.server so launcher port-detection still works.
Write-Host "Serving HTTP on 127.0.0.1 port $Port (http://127.0.0.1:$Port/) ..."

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $rel = [uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
      $path = Join-Path $root $rel
      $full = [System.IO.Path]::GetFullPath($path)

      # Path-traversal guard: keep resolved path under $root.
      if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403
        $body = [Text.Encoding]::UTF8.GetBytes('403 Forbidden')
        $res.ContentType = 'text/plain; charset=utf-8'
        $res.ContentLength64 = $body.Length
        $res.OutputStream.Write($body, 0, $body.Length)
        continue
      }

      if ((Test-Path -LiteralPath $full) -and (Get-Item -LiteralPath $full).PSIsContainer) {
        $idx = Join-Path $full 'index.html'
        if (Test-Path -LiteralPath $idx -PathType Leaf) { $full = $idx }
      }

      if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $res.StatusCode = 404
        $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
        $res.ContentType = 'text/plain; charset=utf-8'
        $res.ContentLength64 = $body.Length
        $res.OutputStream.Write($body, 0, $body.Length)
        continue
      }

      $ext  = [System.IO.Path]::GetExtension($full).ToLower()
      $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.ContentType = $type
      $res.ContentLength64 = $bytes.Length
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      try { $res.StatusCode = 500 } catch {}
      Write-Host "[dev-server] $($_.Exception.Message)"
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
