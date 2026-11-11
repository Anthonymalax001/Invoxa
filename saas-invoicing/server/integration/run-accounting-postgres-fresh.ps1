$securePassword = $null
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$encodedUsername = $null
$encodedPassword = $null
$databaseUrl = $null
$exitCode = 1
$testProcessInvoked = $false
$locationPushed = $false

try {
  $securePassword = Read-Host 'Password for local invoxa_accounting_test_runner' -AsSecureString
  if ($securePassword.Length -eq 0) {
    throw 'A password is required for the local SCRAM-authenticated test role.'
  }

  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $encodedUsername = [Uri]::EscapeDataString('invoxa_accounting_test_runner')
  $encodedPassword = [Uri]::EscapeDataString($plainPassword)
  $databaseUrl = "postgresql://${encodedUsername}:${encodedPassword}@127.0.0.1:5432/invoxa_accounting_test_fresh"

  Push-Location (Join-Path $PSScriptRoot '..')
  $locationPushed = $true
  Get-Command npm.cmd -ErrorAction Stop | Out-Null

  $env:ACCOUNTING_TEST_DATABASE_URL = $databaseUrl
  $env:ACCOUNTING_TEST_DATABASE_CONFIRMATION = 'I_CONFIRM_THIS_IS_DISPOSABLE'
  $testProcessInvoked = $true
  try {
    & npm.cmd run test:accounting:integration
    if ($null -ne $LASTEXITCODE) {
      $exitCode = $LASTEXITCODE
    }
  } finally {
    Remove-Item Env:ACCOUNTING_TEST_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:ACCOUNTING_TEST_DATABASE_CONFIRMATION -ErrorAction SilentlyContinue
  }
} catch {
  [Console]::Error.WriteLine('The fresh local accounting integration launcher failed. No password or connection URL was displayed.')
  $exitCode = 1
} finally {
  if ($locationPushed) {
    Pop-Location
  }
  Remove-Item Env:ACCOUNTING_TEST_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:ACCOUNTING_TEST_DATABASE_CONFIRMATION -ErrorAction SilentlyContinue
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  if ($securePassword) {
    $securePassword.Dispose()
  }
  $plainPassword = $null
  $encodedUsername = $null
  $encodedPassword = $null
  $databaseUrl = $null

  if ($testProcessInvoked) {
    [Console]::WriteLine("Accounting PostgreSQL integration test process exit code: $exitCode")
  } else {
    [Console]::WriteLine("Accounting PostgreSQL integration launcher exit code: $exitCode (test process was not started)")
  }
}

exit $exitCode
