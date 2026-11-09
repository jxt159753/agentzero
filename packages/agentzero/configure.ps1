param(
  [string]$ApiUrl = 'http://127.0.0.1:3000',
  [string]$ConfigPath = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agentzero\config.json')
)
$ErrorActionPreference = 'Stop'
$api = [Uri]$ApiUrl
$localHosts = @('localhost', '127.0.0.1', '[::1]', '::1')
if (-not $api.IsAbsoluteUri -or ($api.Scheme -ne 'https' -and -not ($api.Scheme -eq 'http' -and $localHosts -contains $api.Host)) -or $api.UserInfo -or $api.Query -or $api.Fragment -or $api.AbsolutePath -ne '/') {
  throw 'API 地址必须是 HTTPS origin（本机可用 HTTP），不包含 /api、账号或查询参数。'
}
if (-not [IO.Path]::IsPathRooted($ConfigPath)) { throw '配置文件需要绝对路径。' }
$origin = $api.GetLeftPart([UriPartial]::Authority)
Write-Host "将凭证仅发送到 $origin 验证，成功后保存到 $ConfigPath。"
$secureKey = Read-Host '粘贴平台生成的完整 Agent 凭证（输入隐藏）' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $agentKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ($agentKey -notmatch '^azk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$') { throw '访问凭证格式错误。' }
  try {
    $identity = Invoke-RestMethod -Uri "$origin/api/v1/me" -Headers @{ Authorization = "Bearer $agentKey" } -MaximumRedirection 0 -TimeoutSec 15
  } catch { throw '身份验证失败。请确认 API 已启动、地址正确，并使用有效的 Agent 访问凭证。' }
  if ($identity.actor.type -ne 'agent' -or -not $identity.actor.agentId) { throw '该凭证没有绑定平台 Agent。' }
  $folder = Split-Path -Parent $ConfigPath
  [IO.Directory]::CreateDirectory($folder) | Out-Null
  $json = @{ api_url = $origin; agent_key = $agentKey } | ConvertTo-Json
  [IO.File]::WriteAllText($ConfigPath, $json, (New-Object Text.UTF8Encoding($false)))
  $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $ConfigPath /inheritance:r /grant:r "${account}:(F)" 'SYSTEM:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '配置已写入，但文件权限设置失败；请限制为当前用户可读后使用。' }
  Write-Host "已连接 Agent $($identity.actor.agentId)。重启插件 MCP 服务或开启新的客户端会话后生效。"
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $agentKey = $null
  $json = $null
  $secureKey.Dispose()
}
