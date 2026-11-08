#![windows_subsystem = "windows"]

//! agentx-worker — runs one allowlisted test command inside a Windows
//! AppContainer and prints a single JSON result on stdout.
//!
//! This is the AppContainer sandbox backend for AgentX (see
//! apps/web/lib/sandbox.ts). The end user runs only AgentX.exe: no Docker,
//! no WSL, no visible console. The worker is a GUI-subsystem binary (the
//! attribute above), so Windows never allocates it a console; its stdout
//! is a pipe owned by the server, which is how the JSON result gets back.
//!
//! What it does, in order:
//!   1. Parses args (--workspace, --command, --run-id, --branch,
//!      --timeout-ms, --memory-mb, --cpu-percent, --output-max-bytes).
//!   2. Re-validates the command against the same allowlist the server
//!      uses (defense in depth — the server already checked).
//!   3. Opens (or creates, once) the "AgentXWorker" AppContainer profile
//!      and derives its SID. No admin / elevation is required.
//!   4. Grants that SID access ONLY to the workspace directory (a
//!      disposable staging copy the server made) via an explicit DACL
//!      entry. Nothing else on the filesystem, registry, or other
//!      processes is reachable from inside the container.
//!   5. Spawns `cmd.exe /c <command>` inside the container with
//!      CreateProcessAsUserW + the AppContainer security capabilities,
//!      CREATE_NO_WINDOW, a minimal environment (TEMP/TMP/HOME point
//!      inside the staging copy so npm/node temp writes land in
//!      whitelisted space), and NO network capability.
//!   6. Enforces limits with a Job Object: KILL_ON_JOB_CLOSE (every
//!      child dies if this worker dies), a process/job memory cap, a
//!      hard CPU cap, and a wall-clock timeout (kill + report timeout).
//!   7. Captures stdout/stderr through pipes (capped), computes the
//!      sha256 output hash + excerpt with the same algorithm the server
//!      uses (apps/web/lib/workspace.ts), and prints ONE JSON object.
//!
//! Exit codes: 0 means "the test ran and its result is in the JSON"
//! (even when the test itself failed — the JSON carries exitCode). 2
//! means "the worker itself could not run the test" (infra failure);
//! the JSON then carries workerError and the server treats it as a 503,
//! never as a test result. The worker never prints anything but JSON to
//! stdout; diagnostics go to stderr.
//!
//! Non-Windows builds compile to a stub that reports "requires Windows":
//! the AppContainer APIs do not exist elsewhere, and the server only
//! selects this backend on win32 anyway.

use std::process::ExitCode;

#[cfg(windows)]
fn main() -> ExitCode {
    imp::run()
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    // Stub: the worker is Windows-only. Print the same JSON shape the
    // server parses, so a stray invocation fails closed with a clear
    // message instead of a crash or an empty output.
    println!(
        "{{\"runId\":\"\",\"branch\":\"\",\"command\":\"\",\"exitCode\":null,\"passed\":false,\"stdout\":\"\",\"stderr\":\"\",\"outputHash\":\"\",\"outputExcerpt\":\"\",\"timedOut\":false,\"backend\":\"appcontainer\",\"workerError\":\"AppContainer sandbox requires Windows (agentx-worker.exe is a Windows-only helper).\"}}"
    );
    ExitCode::from(2)
}

#[cfg(windows)]
mod imp {
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use std::ffi::OsStr;
    use std::fs;
    use std::io::Read;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::path::PathBuf;
    use std::process::ExitCode;
    use std::ptr::{null, null_mut};
    use std::thread;
    use windows_sys::core::PWSTR;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation,
        GENERIC_EXECUTE, GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT,
        WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::{
        FreeSid, ACL, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, SECURITY_ATTRIBUTES,
        SECURITY_CAPABILITIES, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY,
        TOKEN_DUPLICATE, TOKEN_QUERY,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    use windows_sys::Win32::Storage::FileSystem::DELETE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
        JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_JOB_MEMORY,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess,
        GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION,
        STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    pub const PROFILE_NAME: &str = "AgentXWorker";
    pub const PROFILE_DISPLAY_NAME: &str = "AgentX Worker";
    pub const PROFILE_DESCRIPTION: &str =
        "AgentX sandbox for running untrusted repository tests.";

    /// Same allowlist as apps/web/lib/sandbox.ts ALLOWED_TEST_COMMANDS.
    /// The server checks first; the worker re-checks so a direct
    /// invocation can never run an arbitrary command in the container.
    pub const ALLOWED_COMMANDS: [&str; 7] = [
        "npm test",
        "npm run test",
        "npm run lint",
        "pytest",
        "dotnet test",
        "cargo test",
        "go test ./...",
    ];

    const OUTPUT_EXCERPT_MAX_CHARS: usize = 2000;

    #[derive(Serialize)]
    struct WorkerResult {
        #[serde(rename = "runId")]
        run_id: String,
        branch: String,
        command: String,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        passed: bool,
        stdout: String,
        stderr: String,
        #[serde(rename = "outputHash")]
        output_hash: String,
        #[serde(rename = "outputExcerpt")]
        output_excerpt: String,
        #[serde(rename = "timedOut")]
        timed_out: bool,
        backend: &'static str,
        #[serde(rename = "workerError", skip_serializing_if = "Option::is_none")]
        worker_error: Option<String>,
    }

    impl WorkerResult {
        fn error(run_id: &str, branch: &str, command: &str, message: String) -> Self {
            let (hash, excerpt) = hash_and_excerpt("", "");
            WorkerResult {
                run_id: run_id.to_string(),
                branch: branch.to_string(),
                command: command.to_string(),
                exit_code: None,
                passed: false,
                stdout: String::new(),
                stderr: String::new(),
                output_hash: hash,
                output_excerpt: excerpt,
                timed_out: false,
                backend: "appcontainer",
                worker_error: Some(message),
            }
        }
    }

    struct Args {
        workspace: PathBuf,
        command: String,
        run_id: String,
        branch: String,
        timeout_ms: u32,
        memory_mb: u64,
        cpu_percent: u32,
        output_max_bytes: usize,
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// sha256 + excerpt with the same algorithm as the server
    /// (apps/web/lib/workspace.ts hashTestOutput / testOutputExcerpt),
    /// so a stored proof computed from the worker's stdout/stderr matches.
    fn hash_and_excerpt(stdout: &str, stderr: &str) -> (String, String) {
        let mut hasher = Sha256::new();
        hasher.update(stdout.as_bytes());
        hasher.update(b"\n---stderr---\n");
        hasher.update(stderr.as_bytes());
        let hash = format!("{:x}", hasher.finalize());
        let combined = if stdout.is_empty() {
            stderr.to_string()
        } else if stderr.is_empty() {
            stdout.to_string()
        } else {
            format!("{stdout}\n{stderr}")
        };
        let chars: Vec<char> = combined.chars().collect();
        let excerpt = if chars.len() <= OUTPUT_EXCERPT_MAX_CHARS {
            combined
        } else {
            let head: String = chars[..OUTPUT_EXCERPT_MAX_CHARS].iter().collect();
            format!(
                "{head}\n… [truncated, {} more chars]",
                chars.len() - OUTPUT_EXCERPT_MAX_CHARS
            )
        };
        (hash, excerpt)
    }

    fn parse_args() -> Result<Args, String> {
        let mut workspace: Option<String> = None;
        let mut command: Option<String> = None;
        let mut run_id: Option<String> = None;
        let mut branch: Option<String> = None;
        let mut timeout_ms: u32 = 600_000;
        let mut memory_mb: u64 = 1024;
        let mut cpu_percent: u32 = 200;
        let mut output_max_bytes: usize = 4 * 1024 * 1024;
        let mut argv = std::env::args().skip(1);
        while let Some(flag) = argv.next() {
            let value = argv
                .next()
                .ok_or_else(|| format!("Missing value for {flag}"))?;
            match flag.as_str() {
                "--workspace" => workspace = Some(value),
                "--command" => command = Some(value),
                "--run-id" => run_id = Some(value),
                "--branch" => branch = Some(value),
                "--timeout-ms" => {
                    timeout_ms = value
                        .parse()
                        .map_err(|_| format!("Invalid --timeout-ms: {value}"))?
                }
                "--memory-mb" => {
                    memory_mb = value
                        .parse()
                        .map_err(|_| format!("Invalid --memory-mb: {value}"))?
                }
                "--cpu-percent" => {
                    cpu_percent = value
                        .parse()
                        .map_err(|_| format!("Invalid --cpu-percent: {value}"))?
                }
                "--output-max-bytes" => {
                    output_max_bytes = value
                        .parse()
                        .map_err(|_| format!("Invalid --output-max-bytes: {value}"))?
                }
                other => return Err(format!("Unknown argument: {other}")),
            }
        }
        Ok(Args {
            workspace: PathBuf::from(
                workspace.ok_or_else(|| "Missing --workspace".to_string())?,
            ),
            command: command.ok_or_else(|| "Missing --command".to_string())?,
            run_id: run_id.unwrap_or_default(),
            branch: branch.unwrap_or_else(|| "unknown".to_string()),
            timeout_ms,
            memory_mb,
            cpu_percent,
            output_max_bytes,
        })
    }

    /// Derive the AppContainer SID, creating the profile first if it does
    /// not exist yet. Creating a profile needs no admin / elevation: it is
    /// a per-user profile, the same mechanism Chromium uses for its
    /// sandbox without admin rights.
    fn appcontainer_sid() -> Result<*mut std::ffi::c_void, String> {
        unsafe {
            let name = wide(PROFILE_NAME);
            let mut sid: *mut std::ffi::c_void = null_mut();
            let hr = DeriveAppContainerSidFromAppContainerName(
                name.as_ptr(),
                &mut sid,
            );
            if hr == 0 && !sid.is_null() {
                return Ok(sid);
            }
            let display = wide(PROFILE_DISPLAY_NAME);
            let description = wide(PROFILE_DESCRIPTION);
            let hr2 = CreateAppContainerProfile(
                name.as_ptr(),
                display.as_ptr(),
                description.as_ptr(),
                null(),
                0,
                &mut sid,
            );
            if hr2 == 0 && !sid.is_null() {
                return Ok(sid);
            }
            // The profile may have appeared between the two calls (another
            // AgentX run creating it concurrently): try deriving once more.
            let hr3 = DeriveAppContainerSidFromAppContainerName(
                name.as_ptr(),
                &mut sid,
            );
            if hr3 == 0 && !sid.is_null() {
                return Ok(sid);
            }
            Err(format!(
                "Could not open or create the AppContainer profile \"{PROFILE_NAME}\" \
                 (DeriveAppContainerSid HRESULT 0x{hr:08X}, CreateAppContainerProfile HRESULT 0x{hr2:08X}). \
                 AppContainer profiles cannot be created on this machine."
            ))
        }
    }

    /// Grant the container SID access to one directory only, merging the
    /// new ACE into the directory's existing DACL (never replacing it).
    /// The ACE inherits to children so files the test creates inside the
    /// staging copy are reachable; nothing outside the directory is
    /// touched. The caller keeps owning the SID until after the child is
    /// spawned; the ACE holds its own copy, so freeing the SID later is
    /// safe.
    fn grant_sid_access(dir: &std::path::Path, sid: *mut std::ffi::c_void) -> Result<(), String> {
        unsafe {
            let dir_w = wide(&dir.to_string_lossy());
            let mut sd: *mut std::ffi::c_void = null_mut();
            let mut old_dacl: *mut ACL = null_mut();
            let err = GetNamedSecurityInfoW(
                dir_w.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_dacl,
                null_mut(),
                &mut sd,
            );
            if err != 0 {
                return Err(format!(
                    "GetNamedSecurityInfoW failed for the workspace (Win32 error {err})."
                ));
            }
            let result = (|| {
                let mut entry = EXPLICIT_ACCESS_W {
                    grfAccessPermissions: GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | DELETE,
                    grfAccessMode: GRANT_ACCESS,
                    grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
                    Trustee: TRUSTEE_W {
                        pMultipleTrustee: null_mut(),
                        MultipleTrusteeOperation: 0, // NO_MULTIPLE_TRUSTEE
                        TrusteeForm: TRUSTEE_IS_SID,
                        TrusteeType: TRUSTEE_IS_UNKNOWN,
                        ptstrName: sid as PWSTR,
                    },
                };
                let mut new_dacl: *mut ACL = null_mut();
                let err = SetEntriesInAclW(1, &mut entry, old_dacl, &mut new_dacl);
                if err != 0 {
                    return Err(format!(
                        "SetEntriesInAclW failed (Win32 error {err})."
                    ));
                }
                let err2 = SetNamedSecurityInfoW(
                    dir_w.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    new_dacl,
                    null_mut(),
                );
                LocalFree(new_dacl as *mut std::ffi::c_void);
                if err2 != 0 {
                    return Err(format!(
                        "SetNamedSecurityInfoW failed (Win32 error {err2})."
                    ));
                }
                Ok(())
            })();
            LocalFree(sd);
            result
        }
    }

    fn create_job(memory_mb: u64, cpu_percent: u32) -> Result<HANDLE, String> {
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(format!(
                    "CreateJobObjectW failed (Win32 error {}).",
                    GetLastError()
                ));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_PROCESS_MEMORY
                | JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.ProcessMemoryLimit = (memory_mb as usize) * 1024 * 1024;
            info.JobMemoryLimit = (memory_mb as usize) * 1024 * 1024;
            let r = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if r == 0 {
                let e = GetLastError();
                CloseHandle(job);
                return Err(format!(
                    "SetInformationJobObject (memory limits) failed (Win32 error {e})."
                ));
            }
            // CpuRate is in hundredths of a percent of one CPU:
            // 100% of one core = 10000, so 2 CPUs = 20000.
            let mut cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = std::mem::zeroed();
            cpu.ControlFlags =
                JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
            cpu.Anonymous.CpuRate = cpu_percent * 100;
            let r2 = SetInformationJobObject(
                job,
                JobObjectCpuRateControlInformation,
                &cpu as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
            );
            if r2 == 0 {
                let e = GetLastError();
                CloseHandle(job);
                return Err(format!(
                    "SetInformationJobObject (CPU cap) failed (Win32 error {e})."
                ));
            }
            Ok(job)
        }
    }

    fn make_pipe() -> Result<(HANDLE, HANDLE), String> {
        unsafe {
            let mut sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: null_mut(),
                bInheritHandle: 1,
            };
            let mut read: HANDLE = null_mut();
            let mut write: HANDLE = null_mut();
            let ok = CreatePipe(&mut read, &mut write, &mut sa, 0);
            if ok == 0 {
                return Err(format!(
                    "CreatePipe failed (Win32 error {}).",
                    GetLastError()
                ));
            }
            // The read end must not be inherited by the child, or the pipe
            // never hits EOF and the reader threads never finish.
            SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0);
            Ok((read, write))
        }
    }

    /// Read one pipe to the end (or the cap) on a thread; the caller joins
    /// these after the child exits, so a chatty test can never block the
    /// wait. The cap is per stream: stdout + stderr together stay under
    /// the server's 8 MiB buffer even after JSON escaping.
    /// The handle crosses into the thread as an address because HANDLE
    /// (*mut c_void) is not Send.
    fn spawn_reader(handle: HANDLE, cap: usize) -> thread::JoinHandle<Vec<u8>> {
        let addr = handle as usize;
        thread::spawn(move || {
            let mut out = Vec::new();
            unsafe {
                let mut file = std::fs::File::from_raw_handle(addr as RawHandle);
                let mut limited = (&mut file).take(cap as u64);
                let _ = limited.read_to_end(&mut out);
                // File is dropped here, closing the handle.
            }
            out
        })
    }

    /// Minimal environment for the child. Only these variables cross into
    /// the container — never the host's full environment (no tokens, no
    /// secrets). TEMP/TMP/HOME/npm cache point inside the staging copy so
    /// toolchain temp writes land in whitelisted space; Path is the
    /// parent's (needed to find node/npm/dotnet) and SystemRoot is needed
    /// by cmd.exe itself.
    fn build_env_block(staging: &std::path::Path) -> Vec<u16> {
        let tmp = staging.join(".agentx-tmp");
        let npm_cache = tmp.join("npm-cache");
        let mut pairs: Vec<(String, String)> = Vec::new();
        for key in ["Path", "SystemRoot", "PATHEXT"] {
            if let Ok(value) = std::env::var(key) {
                pairs.push((key.to_string(), value));
            }
        }
        pairs.push(("TEMP".to_string(), tmp.to_string_lossy().into_owned()));
        pairs.push(("TMP".to_string(), tmp.to_string_lossy().into_owned()));
        pairs.push(("HOME".to_string(), staging.to_string_lossy().into_owned()));
        pairs.push(("CI".to_string(), "true".to_string()));
        pairs.push((
            "npm_config_cache".to_string(),
            npm_cache.to_string_lossy().into_owned(),
        ));
        let mut block: Vec<u16> = Vec::new();
        for (key, value) in pairs {
            block.extend(OsStr::new(&format!("{key}={value}")).encode_wide());
            block.push(0);
        }
        block.push(0);
        block
    }

    fn run_inner(args: &Args, staging: &std::path::Path) -> Result<WorkerResult, String> {
        unsafe {
            // Toolchain temp/cache dirs inside the staging copy (created as
            // the user, before the container exists).
            let tmp = staging.join(".agentx-tmp");
            fs::create_dir_all(tmp.join("npm-cache")).map_err(|e| {
                format!("Could not create the worker temp dir in the staging copy: {e}")
            })?;

            let sid = appcontainer_sid()?;
            let result = (|| -> Result<WorkerResult, String> {
                grant_sid_access(staging, sid)?;
                let job = create_job(args.memory_mb, args.cpu_percent)?;

                let (stdout_read, stdout_write) = make_pipe()?;
                let (stderr_read, stderr_write) = make_pipe()?;
                let (stdin_read, stdin_write) = make_pipe()?;
                // The child's stdin is an empty pipe whose write end we
                // close right after spawn, so the child sees EOF at once.
                let _ = CloseHandle(stdin_write);

                let system_root =
                    std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
                let cmd_path = format!("{system_root}\\System32\\cmd.exe");
                let mut cmdline = wide(&format!("\"{cmd_path}\" /c {}", args.command));

                // Security capabilities: the container SID, and NO
                // well-known capabilities — in particular no network
                // (internetClient) capability. Tests run offline.
                let caps = SECURITY_CAPABILITIES {
                    AppContainerSid: sid,
                    Capabilities: null_mut(),
                    CapabilityCount: 0,
                    Reserved: 0,
                };
                let mut attr_size: usize = 0;
                let ok = InitializeProcThreadAttributeList(
                    null_mut(),
                    1,
                    0,
                    &mut attr_size,
                );
                if ok == 0 && GetLastError() != 122 {
                    // 122 = ERROR_INSUFFICIENT_BUFFER, the expected size
                    // query result. Any other error is real.
                    return Err(format!(
                        "InitializeProcThreadAttributeList (size query) failed (Win32 error {}).",
                        GetLastError()
                    ));
                }
                let mut attr_list = vec![0u8; attr_size];
                let ok = InitializeProcThreadAttributeList(
                    attr_list.as_mut_ptr() as *mut std::ffi::c_void,
                    1,
                    0,
                    &mut attr_size,
                );
                if ok == 0 {
                    return Err(format!(
                        "InitializeProcThreadAttributeList failed (Win32 error {}).",
                        GetLastError()
                    ));
                }
                let ok = UpdateProcThreadAttribute(
                    attr_list.as_mut_ptr() as *mut std::ffi::c_void,
                    0,
                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                    &caps as *const _ as *mut std::ffi::c_void,
                    std::mem::size_of::<SECURITY_CAPABILITIES>(),
                    null_mut(),
                    null_mut(),
                );
                if ok == 0 {
                    DeleteProcThreadAttributeList(
                        attr_list.as_mut_ptr() as *mut std::ffi::c_void,
                    );
                    return Err(format!(
                        "UpdateProcThreadAttribute (security capabilities) failed (Win32 error {}).",
                        GetLastError()
                    ));
                }

                let mut token: HANDLE = null_mut();
                let ok = OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
                    &mut token,
                );
                if ok == 0 {
                    DeleteProcThreadAttributeList(
                        attr_list.as_mut_ptr() as *mut std::ffi::c_void,
                    );
                    return Err(format!(
                        "OpenProcessToken failed (Win32 error {}).",
                        GetLastError()
                    ));
                }

                let env_block = build_env_block(staging);
                let mut startup: STARTUPINFOEXW = std::mem::zeroed();
                startup.StartupInfo.cb =
                    std::mem::size_of::<STARTUPINFOEXW>() as u32;
                startup.StartupInfo.dwFlags =
                    STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
                startup.StartupInfo.wShowWindow = SW_HIDE as u16;
                startup.StartupInfo.hStdInput = stdin_read;
                startup.StartupInfo.hStdOutput = stdout_write;
                startup.StartupInfo.hStdError = stderr_write;
                startup.lpAttributeList =
                    attr_list.as_mut_ptr() as *mut std::ffi::c_void;

                let staging_w = wide(&staging.to_string_lossy());
                let mut proc_info: PROCESS_INFORMATION = std::mem::zeroed();
                let ok = CreateProcessAsUserW(
                    token,
                    null(),
                    cmdline.as_mut_ptr(),
                    null_mut(),
                    null_mut(),
                    1, // inherit handles (the pipes + job handle semantics)
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    env_block.as_ptr() as *mut std::ffi::c_void,
                    staging_w.as_ptr(),
                    &mut startup as *mut STARTUPINFOEXW
                        as *mut windows_sys::Win32::System::Threading::STARTUPINFOW,
                    &mut proc_info,
                );
                DeleteProcThreadAttributeList(
                    attr_list.as_mut_ptr() as *mut std::ffi::c_void,
                );
                let _ = CloseHandle(token);
                if ok == 0 {
                    return Err(format!(
                        "CreateProcessAsUserW failed (Win32 error {}). \
                         The test command could not be started inside the AppContainer.",
                        GetLastError()
                    ));
                }
                // The child must live in the Job Object, or the memory/CPU
                // caps and kill-on-close do not apply to it. If the assign
                // fails, kill the child and fail closed.
                let ok = AssignProcessToJobObject(job, proc_info.hProcess);
                if ok == 0 {
                    let e = GetLastError();
                    windows_sys::Win32::System::Threading::TerminateProcess(
                        proc_info.hProcess,
                        1,
                    );
                    let _ = CloseHandle(proc_info.hProcess);
                    let _ = CloseHandle(proc_info.hThread);
                    return Err(format!(
                        "AssignProcessToJobObject failed (Win32 error {e}); \
                         the test process was terminated instead of running outside the limits."
                    ));
                }
                let _ = CloseHandle(proc_info.hThread);
                // Close our write ends: the readers hit EOF when the child
                // exits, instead of waiting forever on an open handle.
                let _ = CloseHandle(stdout_write);
                let _ = CloseHandle(stderr_write);

                let per_stream_cap = args.output_max_bytes / 2;
                let stdout_reader = spawn_reader(stdout_read, per_stream_cap);
                let stderr_reader = spawn_reader(stderr_read, per_stream_cap);

                let wait = WaitForSingleObject(proc_info.hProcess, args.timeout_ms);
                let mut timed_out = false;
                if wait == WAIT_TIMEOUT {
                    // Wall-clock timeout: kill the whole job (the test and
                    // anything it spawned) and report a timeout, not a
                    // pass or a crash.
                    let _ = TerminateJobObject(job, 1);
                    let _ = WaitForSingleObject(proc_info.hProcess, 5000);
                    timed_out = true;
                }
                let mut exit_code: u32 = 0;
                if !timed_out {
                    if GetExitCodeProcess(proc_info.hProcess, &mut exit_code) == 0 {
                        // The process vanished without an exit code; treat
                        // it as a worker failure, not a test result.
                        let _ = CloseHandle(proc_info.hProcess);
                        let _ = CloseHandle(job);
                        return Err(format!(
                            "GetExitCodeProcess failed (Win32 error {}).",
                            GetLastError()
                        ));
                    }
                }
                let _ = CloseHandle(proc_info.hProcess);
                let _ = CloseHandle(job);

                let stdout_bytes = stdout_reader.join().unwrap_or_default();
                let stderr_bytes = stderr_reader.join().unwrap_or_default();
                let stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
                let stderr = if timed_out {
                    "Test timed out inside the sandbox.".to_string()
                } else {
                    String::from_utf8_lossy(&stderr_bytes).into_owned()
                };
                let (output_hash, output_excerpt) = hash_and_excerpt(&stdout, &stderr);
                Ok(WorkerResult {
                    run_id: args.run_id.clone(),
                    branch: args.branch.clone(),
                    command: args.command.clone(),
                    exit_code: if timed_out {
                        None
                    } else {
                        Some(exit_code as i32)
                    },
                    passed: !timed_out && exit_code == 0,
                    stdout,
                    stderr,
                    output_hash,
                    output_excerpt,
                    timed_out,
                    backend: "appcontainer",
                    worker_error: None,
                })
            })();
            FreeSid(sid);
            result
        }
    }

    pub fn run() -> ExitCode {
        let parsed = parse_args();
        let (run_id, branch, command) = match &parsed {
            Ok(args) => (
                args.run_id.clone(),
                args.branch.clone(),
                args.command.clone(),
            ),
            Err(_) => (String::new(), "unknown".to_string(), String::new()),
        };
        let result = match parsed {
            Err(message) => WorkerResult::error(&run_id, &branch, &command, message),
            Ok(args) => {
                if !ALLOWED_COMMANDS.contains(&args.command.as_str()) {
                    WorkerResult::error(
                        &run_id,
                        &branch,
                        &command,
                        format!(
                            "Test command is not allowlisted: \"{}\".",
                            args.command
                        ),
                    )
                } else if !args.workspace.is_dir() {
                    WorkerResult::error(
                        &run_id,
                        &branch,
                        &command,
                        format!(
                            "Workspace does not exist or is not a directory: \"{}\".",
                            args.workspace.display()
                        ),
                    )
                } else {
                    match fs::canonicalize(&args.workspace) {
                        Ok(staging) => match run_inner(&args, &staging) {
                            Ok(result) => result,
                            Err(message) => WorkerResult::error(
                                &run_id, &branch, &command, message,
                            ),
                        },
                        Err(e) => WorkerResult::error(
                            &run_id,
                            &branch,
                            &command,
                            format!(
                                "Workspace does not exist: \"{}\" ({e}).",
                                args.workspace.display()
                            ),
                        ),
                    }
                }
            }
        };
        let is_error = result.worker_error.is_some();
        match serde_json::to_string(&result) {
            Ok(json) => println!("{json}"),
            Err(e) => {
                eprintln!("agentx-worker: could not serialize result JSON: {e}");
                return ExitCode::from(2);
            }
        }
        // Flush stdout before exiting so the server's pipe read sees the
        // full JSON even if the process exits immediately after.
        use std::io::Write;
        let _ = std::io::stdout().flush();
        ExitCode::from(if is_error { 2 } else { 0 })
    }
}
