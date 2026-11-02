/** Windows evaluation licensing inside a VM. The base images are Windows 11 Enterprise Evaluation: an expired evaluation
 * shuts Windows down about an hour after boot. `slmgr /rearm` (ReArmWindows) plus a reboot grants another 90 days.
 * Each VM's C: drive is a qcow2 overlay on its read-only base image, so a rearm only uses up the VM's own count, and a
 * new VM starts again with the count stored in its image. */

/** Rearm while fewer days than this remain, so that no run (at most 7 days) reaches the end of the evaluation. */
export const REARM_BELOW_DAYS = 7;
/** A VM is rearmed (and rebooted) without asking only this soon after its run started; later a user confirms it. */
export const AUTO_REARM_WINDOW_MS = 20 * 60000;

/** Read through CIM, which is independent of the Windows display language (slmgr's text output is not). Progress records
 * would reach the redirected stderr as CLIXML, so they are silenced. */
const READ = [
  "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'",
  '$s = Get-CimInstance SoftwareLicensingService', '$o = Get-CimInstance Win32_OperatingSystem',
  '$rearms = [long]$s.RemainingWindowsReArmCount; $p = $null; $pending = $false',
  // While a rearm waits for its reboot, the product cannot be read ("the trusted data store was rearmed").
  "try { $p = Get-CimInstance SoftwareLicensingProduct -Filter \"ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL\" | Select-Object -First 1 } catch { if ($rearms -eq 4294967295) { $pending = $true } else { throw } }",
  '[pscustomobject]@{ name = [string]$p.Name; description = [string]$p.Description; licenseStatus = [int]$p.LicenseStatus; graceMinutes = [int]$p.GracePeriodRemaining; rearms = $rearms; pendingReboot = $pending; lastBoot = $o.LastBootUpTime.ToUniversalTime().ToString(\'o\') } | ConvertTo-Json -Compress',
].join('\n');
/** ReArmWindows needs an elevated caller (the agent service is). A rearm already done waits for the reboot: the call then
 * fails ("the trusted data store was rearmed") and the count reads PENDING_REBOOT, so the reboot still follows. The
 * reboot is scheduled a few seconds later so the result can be read back; the outcome is JSON on stdout. */
const REARM = [
  "$ProgressPreference = 'SilentlyContinue'",
  '$out = [ordered]@{ rearmed = $false; error = $null; shutdown = $null }',
  'try { $r = Invoke-CimMethod -InputObject (Get-CimInstance SoftwareLicensingService) -MethodName ReArmWindows -ErrorAction Stop; if ($r.ReturnValue -eq 0) { $out.rearmed = $true } else { $out.error = "ReArmWindows returned $($r.ReturnValue)" } }',
  'catch { $out.error = $_.Exception.Message }',
  'if (-not $out.rearmed) { try { if ([long](Get-CimInstance SoftwareLicensingService).RemainingWindowsReArmCount -eq 4294967295) { $out.rearmed = $true } } catch {} }',
  'if ($out.rearmed) { & shutdown.exe /r /t 10 /c "HarnessStudio: Windows evaluation rearm" 2>&1 | Out-Null; $out.shutdown = $LASTEXITCODE }',
  '$out | ConvertTo-Json -Compress',
].join('\n');
/** RemainingWindowsReArmCount while a rearm waits for its reboot. */
export const PENDING_REBOOT = 4294967295;
/** A cmd.exe command line running a script with -EncodedCommand: no quoting, and not subject to the script execution policy. */
function powershell(script: string) { return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`; }
export const LICENSE_READ_COMMAND = powershell(READ), LICENSE_REARM_COMMAND = powershell(REARM);

export interface WindowsLicense {
  name: string; description: string;
  /** SoftwareLicensingProduct.LicenseStatus: 1 licensed, 0 unlicensed, 2–6 grace or notification (5 is an expired evaluation). */
  licenseStatus: number;
  /** Minutes left in the evaluation or grace period; 0 when expired. */
  graceMinutes: number;
  rearms: number;
  /** A rearm is done and waits for the reboot (the licence itself cannot be read until then). */
  pendingReboot: boolean;
  lastBoot: string;
}
export function parseLicense(stdout: unknown): WindowsLicense {
  let raw: unknown; try { raw = JSON.parse(String(stdout ?? '').trim()); } catch { throw new Error('虚拟机没有返回可解析的授权信息'); }
  const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}, number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  const value = { name: String(row.name ?? '').slice(0, 200), description: String(row.description ?? '').slice(0, 300), licenseStatus: number(row.licenseStatus), graceMinutes: number(row.graceMinutes), rearms: number(row.rearms), pendingReboot: row.pendingReboot === true, lastBoot: String(row.lastBoot ?? '') };
  if ([value.licenseStatus, value.graceMinutes, value.rearms].some(Number.isNaN) || !value.lastBoot) throw new Error('虚拟机返回的授权信息不完整');
  return value;
}
/** What the rearm script reported; it always exits 0. */
export function parseRearm(stdout: unknown): { rearmed: boolean; error: string | null; shutdown: number | null } {
  let raw: unknown; try { raw = JSON.parse(String(stdout ?? '').trim()); } catch { throw new Error('续期脚本没有返回可解析的结果'); }
  const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return { rearmed: row.rearmed === true, error: typeof row.error === 'string' ? row.error.slice(0, 300) : null, shutdown: typeof row.shutdown === 'number' ? row.shutdown : null };
}
export const isEvaluation = (license: Pick<WindowsLicense, 'name' | 'description'>) => /eval/i.test(`${license.name} ${license.description}`);
/** An evaluation that has expired, or will before the longest run ends. Other editions are left alone. */
export const needsRearm = (license: WindowsLicense) => license.pendingReboot || isEvaluation(license) && (license.licenseStatus !== 1 || license.graceMinutes < REARM_BELOW_DAYS * 1440);
