using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;

[assembly: AssemblyTitle("Netease Island Lyrics Watcher")]
[assembly: AssemblyDescription("Starts Netease Island Lyrics with NetEase Cloud Music.")]
[assembly: AssemblyCompany("Netease Island Lyrics contributors")]
[assembly: AssemblyProduct("Netease Island Lyrics Watcher")]
[assembly: AssemblyVersion("0.3.2.0")]
[assembly: AssemblyFileVersion("0.3.2.0")]

namespace NeteaseIslandLyrics.Watcher
{
    internal static class Program
    {
        private const string WatcherBuildVersion = "0.3.2";
        private const string CloudMusicProcessName = "cloudmusic";
        private const string ConfigurationKeyPath = @"Software\Netease Island Lyrics\Watcher";
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValueName = "com.codex.netease-island-lyrics";
        private const int StartDebounceMilliseconds = 500;
        private const int WmiReconcileMilliseconds = 15000;
        private const int PollFallbackMilliseconds = 2000;
        private const int StateHeartbeatMilliseconds = 30000;
        private const long MaximumLogBytes = 512 * 1024;
        private const int CommandUsageExitCode = 2;
        private const int RegistrationFailureExitCode = 5;
        private const int WatcherStartFailureExitCode = 6;
        private const int RollbackFailureExitCode = 7;
        private const int RetryUnregisterExitCode = 20;

        private static readonly object ProcessLock = new object();
        private static readonly object LogLock = new object();
        private static readonly HashSet<int> CloudMusicProcessIds = new HashSet<int>();
        private static readonly AutoResetEvent ProcessChanged = new AutoResetEvent(false);

        private static readonly string WatcherDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Netease Island Lyrics",
            "Watcher");

        private static readonly string StatePath = Path.Combine(WatcherDirectory, "state.json");
        private static readonly string LogPath = Path.Combine(WatcherDirectory, "watcher.log");
        private static readonly int CurrentProcessId = GetCurrentProcessId();
        private static readonly string UserIdentitySuffix = GetCurrentUserIdentitySuffix();
        private static readonly string MutexName = @"Local\NeteaseIslandLyrics.Watcher.Mutex." + UserIdentitySuffix;
        private static readonly string StopEventName = @"Local\NeteaseIslandLyrics.Watcher.Stop." + UserIdentitySuffix;
        private static readonly string RegistrationMutexName =
            @"Local\NeteaseIslandLyrics.Watcher.Registration." + UserIdentitySuffix;

        private static ManagementEventWatcher _processStartWatcher;
        private static ManagementEventWatcher _processStopWatcher;
        private static EventWaitHandle _stopEvent;
        private static Mutex _singleInstanceMutex;
        private static bool _ownsMutex;
        private static volatile bool _wmiFailed;
        private static volatile bool _shuttingDown;
        private static bool _wmiEnabled;
        private static bool _fatalTargetError;
        private static bool _targetConfigurationReadFailed;
        private static string _targetPath = string.Empty;
        private static string _configuredVersion = WatcherBuildVersion;

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                if (IsFirstArgument(args, "--configure"))
                {
                    return ConfigureRegistration(args);
                }

                if (IsFirstArgument(args, "--unregister"))
                {
                    return UnregisterRegistration(args);
                }

                if (HasArgument(args, "--stop"))
                {
                    return StopRunningWatcher();
                }

                if (HasArgument(args, "--status"))
                {
                    return ReportWatcherStatus();
                }

                Directory.CreateDirectory(WatcherDirectory);
                return RunWatcher();
            }
            catch (Exception error)
            {
                Log("Fatal watcher error: " + error);
                TryWriteConsole("Watcher failed: " + error.Message);
                return 10;
            }
        }

        private static int ConfigureRegistration(string[] args)
        {
            return ExecuteRegistrationCommand(delegate { return ConfigureRegistrationLocked(args); });
        }

        private static int ConfigureRegistrationLocked(string[] args)
        {
            if (args.Length != 3 || string.IsNullOrWhiteSpace(args[2]))
            {
                TryWriteConsole("Usage: NeteaseIslandWatcher.exe --configure <targetPath> <version>");
                return CommandUsageExitCode;
            }

            string targetPath;
            if (!TryNormalizeExistingFilePath(args[1], out targetPath))
            {
                TryWriteConsole("The configured target does not exist.");
                return CommandUsageExitCode;
            }

            string watcherExecutablePath;
            if (!TryNormalizeExistingFilePath(Assembly.GetExecutingAssembly().Location, out watcherExecutablePath))
            {
                TryWriteConsole("The watcher executable path is invalid.");
                return CommandUsageExitCode;
            }

            RegistrationSnapshot snapshot;
            try
            {
                snapshot = RegistrationSnapshot.Capture();
            }
            catch (Exception error)
            {
                Log("Could not snapshot registration before configure: " + error.Message);
                TryWriteConsole("Could not read the existing watcher registration.");
                return RegistrationFailureExitCode;
            }

            bool watcherWasRunning = IsWatcherRunning();
            Process startedWatcherProcess = null;
            try
            {
                WriteRegistration(targetPath, args[2].Trim(), watcherExecutablePath);

                if (!StartWatcherExecutableAndConfirm(watcherExecutablePath, out startedWatcherProcess))
                {
                    throw new WatcherStartException("The watcher singleton did not become ready.");
                }

                Log("Watcher registration configured. Target: " + targetPath);
                TryWriteConsole("Watcher registration configured.");
                return 0;
            }
            catch (Exception error)
            {
                Log("Configure transaction failed: " + error.Message);
                bool cleanupSucceeded = true;

                if (startedWatcherProcess != null)
                {
                    cleanupSucceeded = StopAndReleaseStartedWatcher(startedWatcherProcess);
                }
                else if (!watcherWasRunning && IsWatcherRunning())
                {
                    cleanupSucceeded = StopRunningWatcher() == 0;
                }

                bool rollbackSucceeded = TryRestoreRegistration(snapshot);
                if (!cleanupSucceeded || !rollbackSucceeded)
                {
                    TryWriteConsole("Watcher configuration failed and could not be fully rolled back.");
                    return RollbackFailureExitCode;
                }

                TryWriteConsole("Watcher configuration failed; the previous registration was restored.");
                return error is WatcherStartException
                    ? WatcherStartFailureExitCode
                    : RegistrationFailureExitCode;
            }
            finally
            {
                if (startedWatcherProcess != null)
                {
                    startedWatcherProcess.Dispose();
                }
            }
        }

        private static int UnregisterRegistration(string[] args)
        {
            if (args.Length != 1)
            {
                TryWriteConsole("Usage: NeteaseIslandWatcher.exe --unregister");
                return CommandUsageExitCode;
            }

            bool watcherWasRunning = false;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                watcherWasRunning = watcherWasRunning || IsWatcherRunning();

                // Never wait for the resident process while holding RegistrationMutex.
                // A resident that is itself waiting for that mutex can therefore observe
                // StopEvent, leave HandleMissingTarget, and release the singleton.
                int stopExitCode = StopRunningWatcher();
                if (stopExitCode != 0)
                {
                    return stopExitCode;
                }

                UnregisterTransactionResult transactionResult = null;
                int transactionExitCode = ExecuteRegistrationCommand(delegate
                {
                    transactionResult = UnregisterRegistrationLocked(watcherWasRunning);
                    return transactionResult.ExitCode;
                });

                if (transactionExitCode == RetryUnregisterExitCode)
                {
                    continue;
                }

                if (transactionResult != null && transactionResult.RestartWatcher)
                {
                    Process restartedWatcherProcess;
                    bool restarted = StartWatcherExecutableAndConfirm(
                        transactionResult.RestartExecutablePath,
                        out restartedWatcherProcess);
                    if (restartedWatcherProcess != null)
                    {
                        restartedWatcherProcess.Dispose();
                    }

                    if (!restarted)
                    {
                        TryWriteConsole("Watcher removal failed and the previous watcher could not be restarted.");
                        return RollbackFailureExitCode;
                    }
                }

                return transactionExitCode;
            }

            TryWriteConsole("Watcher kept restarting while removal was in progress.");
            return CommandUsageExitCode;
        }

        private static UnregisterTransactionResult UnregisterRegistrationLocked(bool watcherWasRunning)
        {
            // A configure operation may have completed between the stop phase and lock
            // acquisition. Do not wait here; release the lock and repeat stop/revalidate.
            if (IsWatcherRunning())
            {
                return new UnregisterTransactionResult(RetryUnregisterExitCode, false, string.Empty);
            }

            RegistrationSnapshot snapshot;
            try
            {
                snapshot = RegistrationSnapshot.Capture();
            }
            catch (Exception error)
            {
                Log("Could not snapshot registration before unregister: " + error.Message);
                TryWriteConsole("Could not read the existing watcher registration.");
                return new UnregisterTransactionResult(
                    RegistrationFailureExitCode,
                    false,
                    string.Empty);
            }

            try
            {
                DeleteRegistration();
                Log("Watcher registration removed.");
                TryWriteConsole("Watcher registration removed.");
                return new UnregisterTransactionResult(0, false, string.Empty);
            }
            catch (Exception error)
            {
                Log("Unregister transaction failed: " + error.Message);
                bool rollbackSucceeded = TryRestoreRegistration(snapshot);
                if (!rollbackSucceeded)
                {
                    TryWriteConsole("Watcher removal failed and could not be fully rolled back.");
                    return new UnregisterTransactionResult(
                        RollbackFailureExitCode,
                        false,
                        string.Empty);
                }

                TryWriteConsole("Watcher removal failed; the previous registration was restored.");
                return new UnregisterTransactionResult(
                    RegistrationFailureExitCode,
                    watcherWasRunning,
                    watcherWasRunning ? GetPriorWatcherExecutablePath(snapshot) : string.Empty);
            }
        }

        private sealed class UnregisterTransactionResult
        {
            internal UnregisterTransactionResult(
                int exitCode,
                bool restartWatcher,
                string restartExecutablePath)
            {
                ExitCode = exitCode;
                RestartWatcher = restartWatcher;
                RestartExecutablePath = restartExecutablePath;
            }

            internal int ExitCode { get; private set; }
            internal bool RestartWatcher { get; private set; }
            internal string RestartExecutablePath { get; private set; }
        }

        private static int ExecuteRegistrationCommand(Func<int> command)
        {
            Mutex registrationMutex = null;
            bool acquired = false;
            try
            {
                registrationMutex = new Mutex(false, RegistrationMutexName);
                try
                {
                    acquired = registrationMutex.WaitOne(10000, false);
                }
                catch (AbandonedMutexException)
                {
                    acquired = true;
                }

                if (!acquired)
                {
                    Log("Timed out waiting for the watcher registration transaction lock.");
                    TryWriteConsole("Another watcher registration operation is still running.");
                    return RegistrationFailureExitCode;
                }

                return command();
            }
            finally
            {
                if (acquired && registrationMutex != null)
                {
                    try
                    {
                        registrationMutex.ReleaseMutex();
                    }
                    catch (ApplicationException)
                    {
                    }
                }

                if (registrationMutex != null)
                {
                    registrationMutex.Close();
                }
            }
        }

        private static void WriteRegistration(
            string targetPath,
            string version,
            string watcherExecutablePath)
        {
            using (RegistryKey configurationKey = Registry.CurrentUser.CreateSubKey(ConfigurationKeyPath))
            {
                if (configurationKey == null)
                {
                    throw new IOException("Could not create the watcher configuration key.");
                }

                configurationKey.SetValue("TargetPath", targetPath, RegistryValueKind.String);
                configurationKey.SetValue("Version", version, RegistryValueKind.String);
                configurationKey.Flush();
            }

            using (RegistryKey runKey = Registry.CurrentUser.CreateSubKey(RunKeyPath))
            {
                if (runKey == null)
                {
                    throw new IOException("Could not open the current-user Run key.");
                }

                runKey.SetValue(
                    RunValueName,
                    QuoteExecutablePath(watcherExecutablePath),
                    RegistryValueKind.String);
                runKey.Flush();
            }
        }

        private static void DeleteRegistration()
        {
            using (RegistryKey runKey = Registry.CurrentUser.OpenSubKey(RunKeyPath, true))
            {
                if (runKey != null)
                {
                    runKey.DeleteValue(RunValueName, false);
                    runKey.Flush();
                }
            }

            using (RegistryKey configurationKey = Registry.CurrentUser.OpenSubKey(ConfigurationKeyPath, true))
            {
                if (configurationKey != null)
                {
                    configurationKey.DeleteValue("TargetPath", false);
                    configurationKey.DeleteValue("Version", false);
                    configurationKey.Flush();
                }
            }

            DeleteConfigurationKeyIfEmpty();
        }

        private static bool TryRestoreRegistration(RegistrationSnapshot snapshot)
        {
            try
            {
                snapshot.Restore();
                Log("Previous watcher registration restored.");
                return true;
            }
            catch (Exception error)
            {
                Log("Could not restore previous watcher registration: " + error);
                return false;
            }
        }

        private static bool StartWatcherExecutableAndConfirm(
            string watcherExecutablePath,
            out Process startedWatcherProcess)
        {
            startedWatcherProcess = null;

            if (IsWatcherRunning())
            {
                Thread.Sleep(200);
                if (IsWatcherRunning())
                {
                    return true;
                }
            }

            string normalizedPath;
            if (!TryNormalizeExistingFilePath(watcherExecutablePath, out normalizedPath))
            {
                Log("Cannot start watcher because its executable is missing: " + watcherExecutablePath);
                return false;
            }

            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo
                {
                    FileName = normalizedPath,
                    WorkingDirectory = Path.GetDirectoryName(normalizedPath) ?? WatcherDirectory,
                    // ShellExecute deliberately detaches the resident watcher from a
                    // synchronous --configure caller's redirected stdout/stderr. Without
                    // this, the child can keep the caller's pipe open indefinitely.
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                startedWatcherProcess = Process.Start(startInfo);
            }
            catch (Exception error)
            {
                Log("Could not start watcher executable: " + error.Message);
                return false;
            }

            DateTime deadlineUtc = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < deadlineUtc)
            {
                if (IsWatcherRunning())
                {
                    // Confirm that this was not only a momentary mutex acquisition
                    // before a configuration/startup failure.
                    Thread.Sleep(200);
                    if (IsWatcherRunning())
                    {
                        return true;
                    }
                }

                Thread.Sleep(100);
            }

            return false;
        }

        private static bool StopAndReleaseStartedWatcher(Process startedWatcherProcess)
        {
            try
            {
                // Signal the singleton first so it can clean up WMI and state normally.
                // This is intentionally done before restoring the registry/binary backup.
                if (IsWatcherRunning() && StopRunningWatcher() != 0)
                {
                    Log("The newly started watcher did not acknowledge its stop event.");
                }

                try
                {
                    if (startedWatcherProcess.HasExited)
                    {
                        return true;
                    }
                }
                catch (InvalidOperationException)
                {
                    return true;
                }

                if (startedWatcherProcess.WaitForExit(5000))
                {
                    return true;
                }

                // The process was created by this transaction and still holds the new
                // watcher binary. Terminating it is necessary before JS can restore .old.
                startedWatcherProcess.Kill();
                return startedWatcherProcess.WaitForExit(2000);
            }
            catch (InvalidOperationException)
            {
                return true;
            }
            catch (Exception error)
            {
                Log("Could not release the newly started watcher executable: " + error.Message);
                return false;
            }
        }

        private static string GetPriorWatcherExecutablePath(RegistrationSnapshot snapshot)
        {
            string runCommand = snapshot.RunValue.Value as string;
            string executablePath = ExtractExecutablePath(runCommand);
            string normalizedPath;
            if (TryNormalizeExistingFilePath(executablePath, out normalizedPath))
            {
                return normalizedPath;
            }

            if (TryNormalizeExistingFilePath(Assembly.GetExecutingAssembly().Location, out normalizedPath))
            {
                return normalizedPath;
            }

            return executablePath;
        }

        private static string ExtractExecutablePath(string commandLine)
        {
            if (string.IsNullOrWhiteSpace(commandLine))
            {
                return string.Empty;
            }

            string command = commandLine.Trim();
            if (command[0] == '"')
            {
                int closingQuote = command.IndexOf('"', 1);
                return closingQuote > 1
                    ? command.Substring(1, closingQuote - 1)
                    : string.Empty;
            }

            int executableEnd = command.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            if (executableEnd >= 0)
            {
                return command.Substring(0, executableEnd + 4).Trim();
            }

            int firstSpace = command.IndexOf(' ');
            return firstSpace > 0 ? command.Substring(0, firstSpace) : command;
        }

        private static string QuoteExecutablePath(string executablePath)
        {
            if (executablePath.IndexOf('"') >= 0)
            {
                throw new ArgumentException("Executable paths cannot contain quote characters.", "executablePath");
            }

            return "\"" + executablePath + "\"";
        }

        private static bool TryNormalizeExistingFilePath(string path, out string normalizedPath)
        {
            return TryNormalizePath(path, out normalizedPath) && File.Exists(normalizedPath);
        }

        private static bool TryNormalizePath(string path, out string normalizedPath)
        {
            normalizedPath = string.Empty;
            if (string.IsNullOrWhiteSpace(path))
            {
                return false;
            }

            try
            {
                string candidate = Environment.ExpandEnvironmentVariables(path.Trim().Trim('"'));
                normalizedPath = Path.GetFullPath(candidate);
                return true;
            }
            catch
            {
                normalizedPath = string.Empty;
                return false;
            }
        }

        private static void DeleteConfigurationKeyIfEmpty()
        {
            bool shouldDelete = false;
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(ConfigurationKeyPath, false))
            {
                if (key == null)
                {
                    return;
                }

                shouldDelete = key.GetValueNames().Length == 0 && key.GetSubKeyNames().Length == 0;
            }

            if (shouldDelete)
            {
                try
                {
                    Registry.CurrentUser.DeleteSubKey(ConfigurationKeyPath, false);
                }
                catch (ArgumentException)
                {
                    // Another process may have removed the already-empty key.
                }
            }
        }

        private sealed class RegistrationSnapshot
        {
            private RegistrationSnapshot()
            {
            }

            internal bool ConfigurationKeyExisted { get; private set; }
            internal RegistryValueSnapshot TargetPathValue { get; private set; }
            internal RegistryValueSnapshot VersionValue { get; private set; }
            internal RegistryValueSnapshot RunValue { get; private set; }

            internal static RegistrationSnapshot Capture()
            {
                RegistrationSnapshot snapshot = new RegistrationSnapshot();
                using (RegistryKey configurationKey = Registry.CurrentUser.OpenSubKey(ConfigurationKeyPath, false))
                {
                    snapshot.ConfigurationKeyExisted = configurationKey != null;
                    snapshot.TargetPathValue = RegistryValueSnapshot.Capture(configurationKey, "TargetPath");
                    snapshot.VersionValue = RegistryValueSnapshot.Capture(configurationKey, "Version");
                }

                using (RegistryKey runKey = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
                {
                    snapshot.RunValue = RegistryValueSnapshot.Capture(runKey, RunValueName);
                }

                return snapshot;
            }

            internal void Restore()
            {
                using (RegistryKey configurationKey = Registry.CurrentUser.CreateSubKey(ConfigurationKeyPath))
                {
                    if (configurationKey == null)
                    {
                        throw new IOException("Could not restore the watcher configuration key.");
                    }

                    TargetPathValue.Restore(configurationKey, "TargetPath");
                    VersionValue.Restore(configurationKey, "Version");
                    configurationKey.Flush();
                }

                if (!ConfigurationKeyExisted &&
                    !TargetPathValue.Existed &&
                    !VersionValue.Existed)
                {
                    DeleteConfigurationKeyIfEmpty();
                }

                using (RegistryKey runKey = Registry.CurrentUser.CreateSubKey(RunKeyPath))
                {
                    if (runKey == null)
                    {
                        throw new IOException("Could not restore the current-user Run key.");
                    }

                    RunValue.Restore(runKey, RunValueName);
                    runKey.Flush();
                }
            }
        }

        private sealed class RegistryValueSnapshot
        {
            private RegistryValueSnapshot(bool existed, object value, RegistryValueKind valueKind)
            {
                Existed = existed;
                Value = value;
                ValueKind = valueKind;
            }

            internal bool Existed { get; private set; }
            internal object Value { get; private set; }
            internal RegistryValueKind ValueKind { get; private set; }

            internal static RegistryValueSnapshot Capture(RegistryKey key, string valueName)
            {
                if (key == null || !RegistryValueExists(key, valueName))
                {
                    return new RegistryValueSnapshot(false, null, RegistryValueKind.None);
                }

                object value = key.GetValue(
                    valueName,
                    null,
                    RegistryValueOptions.DoNotExpandEnvironmentNames);
                RegistryValueKind valueKind = key.GetValueKind(valueName);
                return new RegistryValueSnapshot(true, value, valueKind);
            }

            internal void Restore(RegistryKey key, string valueName)
            {
                if (Existed)
                {
                    key.SetValue(valueName, Value, ValueKind);
                }
                else
                {
                    key.DeleteValue(valueName, false);
                }
            }

            private static bool RegistryValueExists(RegistryKey key, string valueName)
            {
                foreach (string existingName in key.GetValueNames())
                {
                    if (string.Equals(existingName, valueName, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }

                return false;
            }
        }

        private sealed class WatcherStartException : Exception
        {
            internal WatcherStartException(string message)
                : base(message)
            {
            }
        }

        private static int RunWatcher()
        {
            _singleInstanceMutex = new Mutex(false, MutexName);
            try
            {
                try
                {
                    _ownsMutex = _singleInstanceMutex.WaitOne(0, false);
                }
                catch (AbandonedMutexException)
                {
                    _ownsMutex = true;
                }

                if (!_ownsMutex)
                {
                    Log("A watcher instance is already running.");
                    return 0;
                }

                bool stopEventCreated;
                _stopEvent = new EventWaitHandle(
                    false,
                    EventResetMode.ManualReset,
                    StopEventName,
                    out stopEventCreated);

                // A short-lived --stop process can keep an old named event alive for a
                // moment after the previous watcher exits. Mutex ownership proves that
                // there is no earlier watcher, so clearing the event here is safe.
                _stopEvent.Reset();

                if (!RefreshConfiguredTarget())
                {
                    if (!HandleMissingTarget())
                    {
                        return 4;
                    }
                }

                Log("Watcher started. Target: " + _targetPath);
                InitialiseProcessTracking();
                return RunEventLoop();
            }
            finally
            {
                if (_ownsMutex)
                {
                    _shuttingDown = true;
                    StopWmiWatchers();

                    try
                    {
                        WriteState(GetCloudMusicRunning(), 0);
                    }
                    catch (Exception error)
                    {
                        Log("Could not write final state: " + error.Message);
                    }

                    if (_stopEvent != null)
                    {
                        _stopEvent.Close();
                        _stopEvent = null;
                    }
                }

                ProcessChanged.Close();

                if (_ownsMutex && _singleInstanceMutex != null)
                {
                    try
                    {
                        _singleInstanceMutex.ReleaseMutex();
                    }
                    catch (ApplicationException)
                    {
                    }
                }

                if (_singleInstanceMutex != null)
                {
                    _singleInstanceMutex.Close();
                    _singleInstanceMutex = null;
                }

                if (_ownsMutex)
                {
                    Log("Watcher stopped.");
                }
            }
        }

        private static int RunEventLoop()
        {
            bool? lastRunningState = null;
            DateTime? launchDueAtUtc = null;
            int launchAttempts = 0;
            DateTime nextReconcileAtUtc = DateTime.UtcNow;
            DateTime nextHeartbeatAtUtc = DateTime.UtcNow;
            WaitHandle[] waitHandles = { _stopEvent, ProcessChanged };

            while (!_fatalTargetError)
            {
                DateTime nowUtc = DateTime.UtcNow;

                if (_wmiFailed)
                {
                    Log("WMI event monitoring stopped unexpectedly; switching to process polling.");
                    StopWmiWatchers();
                    _wmiEnabled = false;
                    _wmiFailed = false;
                    nextReconcileAtUtc = nowUtc;
                }

                if (nowUtc >= nextReconcileAtUtc)
                {
                    if (!RefreshConfiguredTarget())
                    {
                        if (!HandleMissingTarget())
                        {
                            break;
                        }
                    }

                    ReconcileCloudMusicProcesses();
                    nextReconcileAtUtc = nowUtc.AddMilliseconds(
                        _wmiEnabled ? WmiReconcileMilliseconds : PollFallbackMilliseconds);
                }

                bool running = GetCloudMusicRunning();
                if (!lastRunningState.HasValue || running != lastRunningState.Value)
                {
                    lastRunningState = running;
                    launchDueAtUtc = running
                        ? (DateTime?)DateTime.UtcNow.AddMilliseconds(StartDebounceMilliseconds)
                        : null;
                    launchAttempts = 0;
                    WriteState(running, CurrentProcessId);
                    Log(running
                        ? "NetEase Cloud Music detected; start request scheduled."
                        : "All NetEase Cloud Music processes exited.");
                }

                nowUtc = DateTime.UtcNow;
                if (launchDueAtUtc.HasValue && nowUtc >= launchDueAtUtc.Value)
                {
                    // Re-enumerate immediately before launch. This makes the debounce
                    // resilient to a fast launcher/update process that has already quit.
                    ReconcileCloudMusicProcesses();
                    running = GetCloudMusicRunning();

                    if (!running)
                    {
                        lastRunningState = false;
                        launchDueAtUtc = null;
                        launchAttempts = 0;
                        WriteState(false, CurrentProcessId);
                        Log("Cancelled start because NetEase Cloud Music exited during debounce.");
                    }
                    else if (TryStartIsland())
                    {
                        launchDueAtUtc = null;
                        launchAttempts = 0;
                    }
                    else if (!_fatalTargetError)
                    {
                        launchAttempts++;
                        launchDueAtUtc = launchAttempts < 3
                            ? (DateTime?)DateTime.UtcNow.AddSeconds(5)
                            : null;
                    }
                }

                nowUtc = DateTime.UtcNow;
                if (nowUtc >= nextHeartbeatAtUtc)
                {
                    WriteState(GetCloudMusicRunning(), CurrentProcessId);
                    nextHeartbeatAtUtc = nowUtc.AddMilliseconds(StateHeartbeatMilliseconds);
                }

                int waitMilliseconds = GetWaitMilliseconds(
                    DateTime.UtcNow,
                    nextReconcileAtUtc,
                    nextHeartbeatAtUtc,
                    launchDueAtUtc);

                int signalled = WaitHandle.WaitAny(waitHandles, waitMilliseconds, false);
                if (signalled == 0)
                {
                    break;
                }
            }

            return _fatalTargetError ? 4 : 0;
        }

        private static void InitialiseProcessTracking()
        {
            // First enumeration establishes a useful baseline before WMI subscriptions.
            ReplaceProcessIds(EnumerateCloudMusicProcessIds());

            _wmiEnabled = TryStartWmiWatchers();

            // Enumerate again while callbacks are excluded by ProcessLock. Any event
            // delivered afterwards is then applied on top of this second snapshot,
            // closing the subscribe/enumerate race window.
            lock (ProcessLock)
            {
                ReplaceProcessIdsWithoutLock(EnumerateCloudMusicProcessIds());
            }

            WriteState(GetCloudMusicRunning(), CurrentProcessId);
        }

        private static bool TryStartWmiWatchers()
        {
            try
            {
                _processStartWatcher = new ManagementEventWatcher(
                    new WqlEventQuery(
                        "SELECT * FROM Win32_ProcessStartTrace " +
                        "WHERE ProcessName = 'cloudmusic.exe'"));
                _processStopWatcher = new ManagementEventWatcher(
                    new WqlEventQuery(
                        "SELECT * FROM Win32_ProcessStopTrace " +
                        "WHERE ProcessName = 'cloudmusic.exe'"));

                _processStartWatcher.EventArrived += OnCloudMusicStarted;
                _processStopWatcher.EventArrived += OnCloudMusicStopped;
                _processStartWatcher.Stopped += OnWmiWatcherStopped;
                _processStopWatcher.Stopped += OnWmiWatcherStopped;

                _processStartWatcher.Start();
                _processStopWatcher.Start();
                Log("WMI process event monitoring enabled.");
                return true;
            }
            catch (Exception error)
            {
                Log("WMI monitoring unavailable; using process polling: " + error.Message);
                StopWmiWatchers();
                return false;
            }
        }

        private static void StopWmiWatchers()
        {
            DisposeWmiWatcher(ref _processStartWatcher, OnCloudMusicStarted);
            DisposeWmiWatcher(ref _processStopWatcher, OnCloudMusicStopped);
            _wmiEnabled = false;
        }

        private static void DisposeWmiWatcher(
            ref ManagementEventWatcher watcher,
            EventArrivedEventHandler eventHandler)
        {
            ManagementEventWatcher current = watcher;
            watcher = null;
            if (current == null)
            {
                return;
            }

            try
            {
                current.EventArrived -= eventHandler;
                current.Stopped -= OnWmiWatcherStopped;
                current.Stop();
            }
            catch
            {
            }
            finally
            {
                try
                {
                    current.Dispose();
                }
                catch
                {
                }
            }
        }

        private static void OnCloudMusicStarted(object sender, EventArrivedEventArgs args)
        {
            int processId;
            if (_shuttingDown || !TryGetEventProcessId(args, out processId))
            {
                return;
            }

            lock (ProcessLock)
            {
                CloudMusicProcessIds.Add(processId);
            }

            ProcessChanged.Set();
        }

        private static void OnCloudMusicStopped(object sender, EventArrivedEventArgs args)
        {
            int processId;
            if (_shuttingDown || !TryGetEventProcessId(args, out processId))
            {
                return;
            }

            lock (ProcessLock)
            {
                CloudMusicProcessIds.Remove(processId);
            }

            ProcessChanged.Set();
        }

        private static void OnWmiWatcherStopped(object sender, StoppedEventArgs args)
        {
            if (!_shuttingDown)
            {
                _wmiFailed = true;
                ProcessChanged.Set();
            }
        }

        private static bool TryGetEventProcessId(EventArrivedEventArgs args, out int processId)
        {
            processId = 0;
            try
            {
                object value = args.NewEvent.Properties["ProcessID"].Value;
                long numericValue = Convert.ToInt64(value, CultureInfo.InvariantCulture);
                if (numericValue <= 0 || numericValue > int.MaxValue)
                {
                    return false;
                }

                processId = (int)numericValue;
                return true;
            }
            catch (Exception error)
            {
                Log("Could not read WMI process event: " + error.Message);
                return false;
            }
        }

        private static HashSet<int> EnumerateCloudMusicProcessIds()
        {
            HashSet<int> processIds = new HashSet<int>();
            Process[] processes = null;
            try
            {
                processes = Process.GetProcessesByName(CloudMusicProcessName);
                foreach (Process process in processes)
                {
                    try
                    {
                        if (!process.HasExited)
                        {
                            processIds.Add(process.Id);
                        }
                    }
                    catch (InvalidOperationException)
                    {
                    }
                    catch (System.ComponentModel.Win32Exception)
                    {
                    }
                }
            }
            catch (Exception error)
            {
                Log("Could not enumerate NetEase Cloud Music processes: " + error.Message);
            }
            finally
            {
                if (processes != null)
                {
                    foreach (Process process in processes)
                    {
                        process.Dispose();
                    }
                }
            }

            return processIds;
        }

        private static void ReconcileCloudMusicProcesses()
        {
            bool changed;
            lock (ProcessLock)
            {
                // Keep enumeration and replacement in the same critical section.
                // WMI callbacks queue on ProcessLock and are applied after this snapshot,
                // so a newer event can never be overwritten by an older enumeration.
                HashSet<int> processIds = EnumerateCloudMusicProcessIds();
                changed = !CloudMusicProcessIds.SetEquals(processIds);
                ReplaceProcessIdsWithoutLock(processIds);
            }

            if (changed)
            {
                ProcessChanged.Set();
            }
        }

        private static void ReplaceProcessIds(HashSet<int> processIds)
        {
            bool changed;
            lock (ProcessLock)
            {
                changed = !CloudMusicProcessIds.SetEquals(processIds);
                ReplaceProcessIdsWithoutLock(processIds);
            }

            if (changed)
            {
                ProcessChanged.Set();
            }
        }

        private static void ReplaceProcessIdsWithoutLock(HashSet<int> processIds)
        {
            CloudMusicProcessIds.Clear();
            CloudMusicProcessIds.UnionWith(processIds);
        }

        private static bool GetCloudMusicRunning()
        {
            lock (ProcessLock)
            {
                return CloudMusicProcessIds.Count > 0;
            }
        }

        private static bool TryStartIsland()
        {
            if (!RefreshConfiguredTarget())
            {
                if (!HandleMissingTarget())
                {
                    return false;
                }
            }

            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo
                {
                    FileName = _targetPath,
                    Arguments = "--background --managed-by-watcher",
                    WorkingDirectory = Path.GetDirectoryName(_targetPath) ?? WatcherDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                Process launchedProcess = Process.Start(startInfo);
                if (launchedProcess != null)
                {
                    launchedProcess.Dispose();
                }

                Log("Started managed island instance: " + _targetPath);
                return true;
            }
            catch (Exception error)
            {
                Log("Could not start island target: " + error.Message);
                return false;
            }
        }

        private static bool RefreshConfiguredTarget()
        {
            string configuredPath = null;
            string configuredVersion = null;
            _targetConfigurationReadFailed = false;

            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(ConfigurationKeyPath, false))
                {
                    if (key != null)
                    {
                        configuredPath = key.GetValue("TargetPath") as string;
                        configuredVersion = key.GetValue("Version") as string;
                    }
                }
            }
            catch (Exception error)
            {
                _targetConfigurationReadFailed = true;
                Log("Could not read watcher configuration: " + error.Message);
                return false;
            }

            if (string.IsNullOrWhiteSpace(configuredPath))
            {
                _targetPath = string.Empty;
                return false;
            }

            configuredPath = Environment.ExpandEnvironmentVariables(configuredPath.Trim().Trim('"'));
            try
            {
                configuredPath = Path.GetFullPath(configuredPath);
            }
            catch
            {
                return false;
            }

            if (!File.Exists(configuredPath))
            {
                _targetPath = configuredPath;
                return false;
            }

            _targetPath = configuredPath;
            _configuredVersion = string.IsNullOrWhiteSpace(configuredVersion)
                ? WatcherBuildVersion
                : configuredVersion.Trim();
            return true;
        }

        private static bool HandleMissingTarget()
        {
            if (_fatalTargetError)
            {
                return false;
            }

            if (_targetConfigurationReadFailed)
            {
                _fatalTargetError = true;
                Log("Watcher configuration could not be read; preserving startup and target values.");
                try
                {
                    WriteState(false, 0);
                }
                catch (Exception error)
                {
                    Log("Could not write configuration-error state: " + error.Message);
                }

                return false;
            }

            string originallyMissingPath = _targetPath ?? string.Empty;
            Mutex registrationMutex = null;
            bool registrationLockAcquired = false;
            try
            {
                registrationMutex = new Mutex(false, RegistrationMutexName);
                try
                {
                    if (_stopEvent == null)
                    {
                        registrationLockAcquired = registrationMutex.WaitOne(10000, false);
                    }
                    else
                    {
                        int signalled = WaitHandle.WaitAny(
                            new WaitHandle[] { registrationMutex, _stopEvent },
                            10000,
                            false);
                        registrationLockAcquired = signalled == 0;
                        if (signalled == 1)
                        {
                            _fatalTargetError = true;
                            Log("Missing-target cleanup interrupted by watcher stop request.");
                            return false;
                        }
                    }
                }
                catch (AbandonedMutexException)
                {
                    registrationLockAcquired = true;
                }

                if (!registrationLockAcquired)
                {
                    _fatalTargetError = true;
                    Log("Timed out rechecking a missing target; preserving startup configuration.");
                    return false;
                }

                // Configure/unregister use the same mutex. Re-read while holding it so a
                // stale missing-path observation can never erase a newly committed target.
                if (RefreshConfiguredTarget())
                {
                    Log("Missing-target cleanup cancelled because configuration now points to: " + _targetPath);
                    return true;
                }

                if (_targetConfigurationReadFailed)
                {
                    _fatalTargetError = true;
                    Log("Watcher configuration became unreadable; preserving startup and target values.");
                    return false;
                }

                string currentConfiguredPath = _targetPath ?? string.Empty;
                if (!string.Equals(
                    originallyMissingPath,
                    currentConfiguredPath,
                    StringComparison.OrdinalIgnoreCase))
                {
                    _fatalTargetError = true;
                    Log(
                        "Missing-target cleanup cancelled because TargetPath changed from " +
                        originallyMissingPath + " to " + currentConfiguredPath + ".");
                    return false;
                }

                try
                {
                    using (RegistryKey configurationKey = Registry.CurrentUser.OpenSubKey(ConfigurationKeyPath, false))
                    {
                        string value = configurationKey == null
                            ? string.Empty
                            : configurationKey.GetValue("TargetPath") as string;
                        string normalizedValue = string.Empty;
                        bool valueValid = string.IsNullOrWhiteSpace(value) ||
                            TryNormalizePath(value, out normalizedValue);
                        if (!valueValid ||
                            !string.Equals(
                                normalizedValue,
                                originallyMissingPath,
                                StringComparison.OrdinalIgnoreCase))
                        {
                            Log("Stale target cleanup aborted by final TargetPath comparison.");
                            if (RefreshConfiguredTarget())
                            {
                                return true;
                            }

                            _fatalTargetError = true;
                            return false;
                        }
                    }
                }
                catch (Exception error)
                {
                    _fatalTargetError = true;
                    Log("Could not perform final TargetPath comparison; preserving registration: " + error.Message);
                    return false;
                }

                _fatalTargetError = true;
                Log("Configured portable target is missing; removing stale startup configuration: " + originallyMissingPath);

                try
                {
                    using (RegistryKey runKey = Registry.CurrentUser.OpenSubKey(RunKeyPath, true))
                    {
                        if (runKey != null)
                        {
                            runKey.DeleteValue(RunValueName, false);
                        }
                    }
                }
                catch (Exception error)
                {
                    Log("Could not remove stale Run value: " + error.Message);
                }

                try
                {
                    using (RegistryKey configurationKey = Registry.CurrentUser.OpenSubKey(ConfigurationKeyPath, true))
                    {
                        if (configurationKey != null)
                        {
                            configurationKey.DeleteValue("TargetPath", false);
                            configurationKey.DeleteValue("Version", false);
                        }
                    }
                }
                catch (Exception error)
                {
                    Log("Could not remove stale target configuration: " + error.Message);
                }

                try
                {
                    WriteState(false, 0);
                }
                catch (Exception error)
                {
                    Log("Could not write missing-target state: " + error.Message);
                }

                return false;
            }
            finally
            {
                if (registrationLockAcquired && registrationMutex != null)
                {
                    try
                    {
                        registrationMutex.ReleaseMutex();
                    }
                    catch (ApplicationException)
                    {
                    }
                }

                if (registrationMutex != null)
                {
                    registrationMutex.Close();
                }
            }
        }

        private static void WriteState(bool cloudMusicRunning, int watcherProcessId)
        {
            Directory.CreateDirectory(WatcherDirectory);

            string targetPath = _targetPath ?? string.Empty;
            string version = string.IsNullOrWhiteSpace(_configuredVersion)
                ? WatcherBuildVersion
                : _configuredVersion;
            string json = "{" +
                "\"watcherPid\":" + watcherProcessId.ToString(CultureInfo.InvariantCulture) + "," +
                "\"cloudMusicRunning\":" + (cloudMusicRunning ? "true" : "false") + "," +
                "\"updatedAtUtc\":" + JsonString(DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)) + "," +
                "\"targetPath\":" + JsonString(targetPath) + "," +
                "\"version\":" + JsonString(version) +
                "}";

            string temporaryPath = StatePath + ".tmp." + CurrentProcessId.ToString(CultureInfo.InvariantCulture);
            File.WriteAllText(temporaryPath, json, new UTF8Encoding(false));

            try
            {
                if (File.Exists(StatePath))
                {
                    File.Replace(temporaryPath, StatePath, null);
                }
                else
                {
                    File.Move(temporaryPath, StatePath);
                }
            }
            catch
            {
                // LocalAppData normally resides on NTFS, where File.Replace is atomic.
                // Keep a compatibility fallback for redirected/non-NTFS profiles.
                try
                {
                    if (File.Exists(StatePath))
                    {
                        File.Delete(StatePath);
                    }

                    if (File.Exists(temporaryPath))
                    {
                        File.Move(temporaryPath, StatePath);
                    }
                }
                finally
                {
                    if (File.Exists(temporaryPath))
                    {
                        File.Delete(temporaryPath);
                    }
                }
            }
        }

        private static int StopRunningWatcher()
        {
            bool wasRunning = IsWatcherRunning();
            int watcherProcessId = wasRunning ? ReadWatcherProcessIdFromState() : 0;
            try
            {
                using (EventWaitHandle stopEvent = EventWaitHandle.OpenExisting(StopEventName))
                {
                    stopEvent.Set();
                }
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                TryWriteConsole("Watcher is not running.");
                return 0;
            }
            catch (UnauthorizedAccessException error)
            {
                TryWriteConsole("Could not stop watcher: " + error.Message);
                return 2;
            }

            DateTime deadlineUtc = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < deadlineUtc)
            {
                if (!IsWatcherRunning())
                {
                    if (!wasRunning || WaitForWatcherProcessExit(watcherProcessId, deadlineUtc))
                    {
                        TryWriteConsole("Watcher stopped.");
                        return 0;
                    }

                    break;
                }

                Thread.Sleep(100);
            }

            if (!wasRunning ||
                (!IsWatcherRunning() && WaitForWatcherProcessExit(watcherProcessId, deadlineUtc)))
            {
                TryWriteConsole("Watcher stopped.");
                return 0;
            }

            TryWriteConsole("Timed out waiting for watcher to stop.");
            return 2;
        }

        private static int ReadWatcherProcessIdFromState()
        {
            try
            {
                if (!File.Exists(StatePath))
                {
                    return 0;
                }

                string state = File.ReadAllText(StatePath, Encoding.UTF8);
                const string marker = "\"watcherPid\"";
                int markerIndex = state.IndexOf(marker, StringComparison.Ordinal);
                if (markerIndex < 0)
                {
                    return 0;
                }

                int colonIndex = state.IndexOf(':', markerIndex + marker.Length);
                if (colonIndex < 0)
                {
                    return 0;
                }

                int numberStart = colonIndex + 1;
                while (numberStart < state.Length && char.IsWhiteSpace(state[numberStart]))
                {
                    numberStart++;
                }

                int numberEnd = numberStart;
                while (numberEnd < state.Length && char.IsDigit(state[numberEnd]))
                {
                    numberEnd++;
                }

                int processId;
                return numberEnd > numberStart && int.TryParse(
                    state.Substring(numberStart, numberEnd - numberStart),
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out processId)
                    ? processId
                    : 0;
            }
            catch
            {
                return 0;
            }
        }

        private static bool WaitForWatcherProcessExit(int watcherProcessId, DateTime deadlineUtc)
        {
            if (watcherProcessId <= 0 || watcherProcessId == CurrentProcessId)
            {
                // State may be unavailable during very early startup. A short grace
                // period still closes the mutex-release/final-logging window.
                int graceMilliseconds = (int)Math.Min(
                    250,
                    Math.Max(0, (deadlineUtc - DateTime.UtcNow).TotalMilliseconds));
                if (graceMilliseconds > 0)
                {
                    Thread.Sleep(graceMilliseconds);
                }

                return !IsWatcherRunning();
            }

            try
            {
                using (Process watcherProcess = Process.GetProcessById(watcherProcessId))
                {
                    if (watcherProcess.HasExited)
                    {
                        return true;
                    }

                    int remainingMilliseconds = (int)Math.Min(
                        int.MaxValue - 1,
                        Math.Max(0, (deadlineUtc - DateTime.UtcNow).TotalMilliseconds));
                    return remainingMilliseconds > 0 && watcherProcess.WaitForExit(remainingMilliseconds);
                }
            }
            catch (ArgumentException)
            {
                return true;
            }
            catch (InvalidOperationException)
            {
                return true;
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                Log("Could not confirm watcher process exit: " + error.Message);
                return false;
            }
        }

        private static int ReportWatcherStatus()
        {
            bool running = IsWatcherRunning();
            string state = null;
            try
            {
                if (File.Exists(StatePath))
                {
                    state = File.ReadAllText(StatePath, Encoding.UTF8).Trim();
                    if (!state.StartsWith("{", StringComparison.Ordinal) ||
                        !state.EndsWith("}", StringComparison.Ordinal))
                    {
                        state = null;
                    }
                }
            }
            catch
            {
                state = null;
            }

            string statusJson = "{" +
                "\"watcherRunning\":" + (running ? "true" : "false") + "," +
                "\"statePath\":" + JsonString(StatePath) + "," +
                "\"state\":" + (state ?? "null") +
                "}";
            TryWriteConsole(statusJson);
            return running ? 0 : 1;
        }

        private static bool IsWatcherRunning()
        {
            Mutex mutex = null;
            bool acquired = false;
            try
            {
                mutex = Mutex.OpenExisting(MutexName);
                try
                {
                    acquired = mutex.WaitOne(0, false);
                }
                catch (AbandonedMutexException)
                {
                    acquired = true;
                }

                return !acquired;
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                // The object exists but cannot be opened, so conservatively report it
                // as running instead of allowing a second watcher to be installed.
                return true;
            }
            finally
            {
                if (acquired && mutex != null)
                {
                    try
                    {
                        mutex.ReleaseMutex();
                    }
                    catch (ApplicationException)
                    {
                    }
                }

                if (mutex != null)
                {
                    mutex.Close();
                }
            }
        }

        private static int GetWaitMilliseconds(
            DateTime nowUtc,
            DateTime nextReconcileAtUtc,
            DateTime nextHeartbeatAtUtc,
            DateTime? launchDueAtUtc)
        {
            DateTime nextWakeUtc = nextReconcileAtUtc < nextHeartbeatAtUtc
                ? nextReconcileAtUtc
                : nextHeartbeatAtUtc;

            if (launchDueAtUtc.HasValue && launchDueAtUtc.Value < nextWakeUtc)
            {
                nextWakeUtc = launchDueAtUtc.Value;
            }

            double milliseconds = (nextWakeUtc - nowUtc).TotalMilliseconds;
            if (milliseconds <= 0)
            {
                return 0;
            }

            return (int)Math.Min(milliseconds, int.MaxValue - 1);
        }

        private static bool HasArgument(string[] args, string expected)
        {
            foreach (string argument in args)
            {
                if (string.Equals(argument, expected, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool IsFirstArgument(string[] args, string expected)
        {
            return args.Length > 0 &&
                string.Equals(args[0], expected, StringComparison.OrdinalIgnoreCase);
        }

        private static string GetCurrentUserIdentitySuffix()
        {
            try
            {
                WindowsIdentity identity = WindowsIdentity.GetCurrent();
                if (identity != null && identity.User != null)
                {
                    return identity.User.Value.Replace('-', '_');
                }
            }
            catch
            {
            }

            return Environment.UserName.Replace('\\', '_').Replace('/', '_').Replace(' ', '_');
        }

        private static int GetCurrentProcessId()
        {
            using (Process process = Process.GetCurrentProcess())
            {
                return process.Id;
            }
        }

        private static string JsonString(string value)
        {
            if (value == null)
            {
                return "null";
            }

            StringBuilder builder = new StringBuilder(value.Length + 2);
            builder.Append('"');
            foreach (char character in value)
            {
                switch (character)
                {
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '\b':
                        builder.Append("\\b");
                        break;
                    case '\f':
                        builder.Append("\\f");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (character < 0x20)
                        {
                            builder.Append("\\u");
                            builder.Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(character);
                        }
                        break;
                }
            }

            builder.Append('"');
            return builder.ToString();
        }

        private static void Log(string message)
        {
            try
            {
                lock (LogLock)
                {
                    Directory.CreateDirectory(WatcherDirectory);
                    if (File.Exists(LogPath) && new FileInfo(LogPath).Length >= MaximumLogBytes)
                    {
                        string previousLogPath = LogPath + ".old";
                        if (File.Exists(previousLogPath))
                        {
                            File.Delete(previousLogPath);
                        }

                        File.Move(LogPath, previousLogPath);
                    }

                    string line = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) +
                        " [" + CurrentProcessId.ToString(CultureInfo.InvariantCulture) + "] " +
                        message + Environment.NewLine;
                    File.AppendAllText(LogPath, line, new UTF8Encoding(false));
                }
            }
            catch
            {
            }
        }

        private static void TryWriteConsole(string message)
        {
            try
            {
                Console.WriteLine(message);
            }
            catch
            {
            }
        }
    }
}
