#!/usr/bin/env powershell
# SignPath 开源签名：对指定 exe 发起签名请求并下载签名后的文件（原地覆盖）。
# 配置全部来自环境变量：
#   SIGNPATH_API_TOKEN / SIGNPATH_ORGANIZATION_ID / SIGNPATH_PROJECT_SLUG / SIGNPATH_SIGNING_POLICY
# 用法：powershell -File scripts/signpath-sign.ps1 -Files "a.exe","b.exe"
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Files
)

$ErrorActionPreference = 'Stop'

$token = $env:SIGNPATH_API_TOKEN
$org = $env:SIGNPATH_ORGANIZATION_ID
$slug = $env:SIGNPATH_PROJECT_SLUG
$policy = $env:SIGNPATH_SIGNING_POLICY

if (-not ($token -and $org -and $slug -and $policy)) {
    Write-Host '[SignPath] 环境变量未配置（SIGNPATH_API_TOKEN/ORGANIZATION_ID/PROJECT_SLUG/SIGNING_POLICY），跳过签名';
    exit 0
}

$api = "https://signpath.io/api/v1/$org"

foreach ($file in $Files) {
    if (-not (Test-Path $file)) { Write-Host "[SignPath] 缺文件: $file"; continue }
    Write-Host "[SignPath] 签名 $file ..."

    # 1. 上传并创建签名请求（multipart）
    $boundary = '----vlan' + [guid]::NewGuid().ToString('N')
    $fileName = [IO.Path]::GetFileName($file)
    $fileBytes = [IO.File]::ReadAllBytes((Resolve-Path $file))
    $crlf = "`r`n"
    $head = "--$boundary$crlf" +
        "Content-Disposition: form-data; name=`"ProjectSlug`"`r`n`r`n$slug$crlf" +
        "--$boundary$crlf" +
        "Content-Disposition: form-data; name=`"SignSigningRequest`"`r`n`r`ntrue$crlf" +
        "--$boundary$crlf" +
        "Content-Disposition: form-data; name=`"File`"; filename=`"$fileName`"`r`n" +
        "Content-Type: application/octet-stream$crlf$crlf"
    $tail = "$crlf--$boundary--$crlf"
    $headB = [Text.Encoding]::UTF8.GetBytes($head)
    $tailB = [Text.Encoding]::UTF8.GetBytes($tail)
    $body = New-Object byte[] ($headB.Length + $fileBytes.Length + $tailB.Length)
    [Array]::Copy($headB, 0, $body, 0, $headB.Length)
    [Array]::Copy($fileBytes, 0, $body, $headB.Length, $fileBytes.Length)
    [Array]::Copy($tailB, 0, $body, $headB.Length + $fileBytes.Length, $tailB.Length)

    $resp = Invoke-RestMethod -Method Post `
        -Uri "$api/signing-requests?project-slug=$slug&signing-policy-guid=$policy" `
        -Headers @{ Authorization = "Bearer $token" } `
        -ContentType "multipart/form-data; boundary=$boundary" `
        -Body $body

    $reqId = $resp.id

    # 2. 轮询状态直到 Completed
    $status = ''
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        $resp = Invoke-RestMethod -Headers @{ Authorization = "Bearer $token" } `
            -Uri "$api/signing-requests/$reqId"
        $status = $resp.status
        if ($status -in 'Completed', 'Failed') { break }
        Write-Host "[SignPath] $reqId 状态: $status"
    }
    if ($status -ne 'Completed') { throw "签名未完成: $status" }

    # 3. 下载签名后的文件，原地覆盖
    Invoke-WebRequest -Headers @{ Authorization = "Bearer $token" } `
        -Uri "$api/signing-requests/$reqId/signed-artifact" `
        -OutFile (Resolve-Path $file)
    Write-Host "[SignPath] 完成: $file"
}
