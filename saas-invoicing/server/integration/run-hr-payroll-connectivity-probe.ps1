$securePassword = $null
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$encodedPassword = $null
$databaseUrl = $null
$exitCode = 1
$locationPushed = $false

try {
  $securePassword = Read-Host 'Password for local invoxa_hr_payroll_test_role' -AsSecureString
  if ($securePassword.Length -eq 0) { throw 'A password is required for the local test role.' }
  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $encodedPassword = [Uri]::EscapeDataString($plainPassword)
  $databaseUrl = "postgresql://invoxa_hr_payroll_test_role:$encodedPassword@ep-wild-moon-bekf9r1a.c-9.us-east-2.aws.neon.tech:5432/invoxa_hr_payroll_test_local?sslmode=require"
  Get-ChildItem Env: | Where-Object { $_.Name -ieq 'DATABASE_URL' -or $_.Name -like 'PG*' } |
    ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }
  $env:HR_PAYROLL_TEST_DATABASE_URL = $databaseUrl
  $env:HR_PAYROLL_TEST_DATABASE_CONFIRMATION = 'I_CONFIRM_THIS_IS_A_DISPOSABLE_HR_PAYROLL_TEST_DATABASE'
  Push-Location (Join-Path $PSScriptRoot '..')
  $locationPushed = $true
  & npm.cmd run probe:hr-payroll:connectivity
  $exitCode = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine('The HR/payroll connectivity probe failed. No password or connection URL was displayed.')
} finally {
  if ($locationPushed) { Pop-Location }
  Remove-Item Env:HR_PAYROLL_TEST_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:HR_PAYROLL_TEST_DATABASE_CONFIRMATION -ErrorAction SilentlyContinue
  if ($passwordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
  if ($securePassword) { $securePassword.Dispose() }
  $plainPassword = $null; $encodedPassword = $null; $databaseUrl = $null
}
exit $exitCode
