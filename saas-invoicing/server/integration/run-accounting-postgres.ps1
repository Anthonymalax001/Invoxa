$securePassword = $null
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$encodedPassword = $null
$databaseUrl = $null
$exitCode = 1
$locationPushed = $false

try {
  $securePassword = Read-Host 'Password for local invoxa_accounting_test_role' -AsSecureString
  if ($securePassword.Length -eq 0) {
    throw 'A password is required for the local SCRAM-authenticated test role.'
  }

  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $encodedPassword = [Uri]::EscapeDataString($plainPassword)
  $databaseUrl = "postgresql://invoxa_accounting_test_role:$encodedPassword@127.0.0.1:5432/invoxa_accounting_test_local"

  $env:ACCOUNTING_TEST_DATABASE_URL = $databaseUrl
  $env:ACCOUNTING_TEST_DATABASE_CONFIRMATION = 'I_CONFIRM_THIS_IS_DISPOSABLE'

  Push-Location (Join-Path $PSScriptRoot '..')
  $locationPushed = $true
  & npm.cmd run test:accounting:integration
  if ($null -ne $LASTEXITCODE) {
    $exitCode = $LASTEXITCODE
  }
} catch {
  [Console]::Error.WriteLine('The local accounting integration launcher failed. No password or connection URL was displayed.')
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
  $encodedPassword = $null
  $databaseUrl = $null
}

exit $exitCode
