param([switch]$Stop, [string]$PgBin = $env:PG_BIN)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localRoot = Join-Path $projectRoot '.local'
$dataPath = Join-Path $localRoot 'pgdata'
if (-not $PgBin) { $PgBin = Join-Path $localRoot 'postgresql18\pgsql\bin' }
$pgControl = Join-Path $PgBin 'pg_ctl.exe'
if (-not (Test-Path -LiteralPath $pgControl)) {
  throw 'PostgreSQL 18 binaries are required. Extract the Windows binary archive to .local/postgresql18 or set PG_BIN to its bin directory. No system installation is performed.'
}
if ((& $pgControl --version) -notmatch '18\.') { throw 'PostgreSQL 18 is required.' }
if ($Stop) {
  if (Test-Path -LiteralPath (Join-Path $dataPath 'PG_VERSION')) {
    & $pgControl -D $dataPath -m fast stop
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the project database.' }
  }
  exit 0
}
New-Item -ItemType Directory -Path $localRoot -Force | Out-Null
$passwordFile = Join-Path $localRoot 'pwfile'
if (-not (Test-Path -LiteralPath (Join-Path $dataPath 'PG_VERSION'))) {
  $randomBytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
  $adminPassword = [Convert]::ToBase64String($randomBytes)
  [IO.File]::WriteAllText($passwordFile, $adminPassword, [Text.UTF8Encoding]::new($false))
  & (Join-Path $PgBin 'initdb.exe') -D $dataPath -U postgres --encoding=UTF8 --locale=C --auth=scram-sha-256 "--pwfile=$passwordFile" -c max_connections=100 -c shared_buffers=128MB
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed.' }
  Add-Content -LiteralPath (Join-Path $dataPath 'postgresql.conf') -Encoding UTF8 -Value "`nlisten_addresses = '127.0.0.1'`nport = 55432`n"
}
if (-not (Test-Path -LiteralPath $passwordFile)) { throw 'The project local administrator password file is missing.' }
& $pgControl -D $dataPath status *> $null
if ($LASTEXITCODE -ne 0) {
  $startArguments = @('-D', ('"' + $dataPath + '"'), '-l', ('"' + (Join-Path $localRoot 'postgresql.log') + '"'), '-w', 'start')
  $process = Start-Process -FilePath $pgControl -ArgumentList $startArguments -WindowStyle Hidden -PassThru
  # Start-Process -Wait also waits for postgres descendants, which are intentionally long lived.
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw 'PostgreSQL start failed; inspect .local/postgresql.log.' }
}
$previousPassword = $env:PGPASSWORD
try {
  $env:PGPASSWORD = [IO.File]::ReadAllText($passwordFile).Trim()
  & (Join-Path $PgBin 'psql.exe') -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -f (Join-Path $projectRoot 'deploy\bootstrap.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Local database bootstrap failed.' }
} finally { $env:PGPASSWORD = $previousPassword }
$environmentFile = Join-Path $projectRoot '.env'
if (-not (Test-Path -LiteralPath $environmentFile)) {
  Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $environmentFile
}
Write-Output 'PostgreSQL 18 is listening on 127.0.0.1:55432. Development and test databases are separate. Run pnpm db:migrate next.'
