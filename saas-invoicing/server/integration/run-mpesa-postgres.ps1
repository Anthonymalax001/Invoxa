$securePassword = $null
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$encodedPassword = $null
$databaseUrl = $null
$exitCode = 1
$locationPushed = $false
$testProcessInvoked = $false

try {
  $securePassword = Read-Host 'Password for local invoxa_mpesa_test_role' -AsSecureString
  if ($securePassword.Length -eq 0) {
    throw 'A password is required for the local test role.'
  }

  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $encodedPassword = [Uri]::EscapeDataString($plainPassword)
  $databaseUrl = "postgresql://invoxa_mpesa_test_role:$encodedPassword@127.0.0.1:5432/invoxa_mpesa_test_local"

  Get-ChildItem Env: |
    Where-Object { $_.Name -ieq 'DATABASE_URL' -or $_.Name -like 'PG*' } |
    ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }

  $env:MPESA_TEST_DATABASE_URL = $databaseUrl
  $env:MPESA_TEST_DATABASE_CONFIRMATION = 'I_CONFIRM_THIS_IS_A_DISPOSABLE_MPESA_TEST_DATABASE'

  Push-Location (Join-Path $PSScriptRoot '..')
  $locationPushed = $true
  Get-Command npm.cmd -ErrorAction Stop | Out-Null
  $testProcessInvoked = $true
  & npm.cmd run test:mpesa:integration
  if ($null -ne $LASTEXITCODE) {
    $exitCode = $LASTEXITCODE
  }
} catch {
  [Console]::Error.WriteLine('The local M-Pesa PostgreSQL integration launcher failed. No password or connection URL was displayed.')
  $exitCode = 1
} finally {
  if ($locationPushed) {
    Pop-Location
  }
  Remove-Item Env:MPESA_TEST_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:MPESA_TEST_DATABASE_CONFIRMATION -ErrorAction SilentlyContinue
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  if ($securePassword) {
    $securePassword.Dispose()
  }
  $plainPassword = $null
  $encodedPassword = $null
  $databaseUrl = $null
  if ($testProcessInvoked) {
    [Console]::WriteLine("M-Pesa PostgreSQL integration test process exit code: $exitCode")
  } else {
    [Console]::WriteLine("M-Pesa PostgreSQL integration launcher exit code: $exitCode (test process was not started)")
  }
}

exit $exitCode
