use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use jupyter_protocol::connection_info::Transport;
use jupyter_protocol::media::MediaType;
use jupyter_protocol::{
    CommMsg, ConnectionInfo, ExecuteRequest, ExecutionState, JupyterMessage, JupyterMessageContent,
    KernelInfoRequest, ReplyStatus, ShutdownRequest, Stdio as JupyterStdio,
};
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Instant};
use uuid::Uuid;

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Substituted into every `--kernel-argv` element at spawn time. Kernels that
/// take the connection file positionally and kernels that take it behind a flag
/// are both expressible without the bridge knowing anything language-specific.
const CONNECTION_FILE_PLACEHOLDER: &str = "{connection_file}";
const DEFAULT_KERNEL_NAME: &str = "python3";
const KERNEL_STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_CAPACITY: usize = 128;
const MAX_IN_FLIGHT: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Protocol {
    Kernel,
    Runtime,
}

impl Protocol {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "kernel" => Ok(Self::Kernel),
            "runtime" => Ok(Self::Runtime),
            _ => bail!("unsupported protocol {value:?}; expected kernel or runtime"),
        }
    }
}

/// How the bridge starts its kernel process.
///
/// The Jupyter wire protocol below this point is kernel-agnostic — only the
/// launch differs per language, so only the launch is modelled per language.
#[derive(Clone, Debug, PartialEq, Eq)]
enum KernelLaunch {
    /// Bundled CPython + `ipykernel_launcher`. Byte-for-byte the original path.
    Python(PathBuf),
    /// Generic argv template; `{connection_file}` is substituted at spawn time.
    Argv(Vec<String>),
}

impl KernelLaunch {
    fn program_display(&self) -> String {
        match self {
            Self::Python(python) => python.display().to_string(),
            Self::Argv(argv) => argv.first().cloned().unwrap_or_default(),
        }
    }
}

#[derive(Debug)]
struct Options {
    protocol: Protocol,
    launch: KernelLaunch,
    kernel_name: String,
    runtime_root: Option<PathBuf>,
    drain_timeout: Duration,
}

impl Options {
    fn parse() -> Result<Option<Self>> {
        Self::parse_args(std::env::args().skip(1))
    }

    fn parse_args<I>(args: I) -> Result<Option<Self>>
    where
        I: IntoIterator<Item = String>,
    {
        let mut args = args.into_iter();
        let mut protocol = None;
        let mut python: Option<PathBuf> = None;
        let mut kernel_argv: Vec<String> = Vec::new();
        let mut kernel_name: Option<String> = None;
        let mut runtime_root = None;
        let mut drain_timeout = DRAIN_TIMEOUT;

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--version" => {
                    println!("choreograph-jupyter-bridge {VERSION}");
                    return Ok(None);
                }
                "--protocol" => {
                    let value = args.next().context("--protocol requires a value")?;
                    protocol = Some(Protocol::parse(&value)?);
                }
                "--python" => {
                    python = Some(PathBuf::from(
                        args.next().context("--python requires a value")?,
                    ));
                }
                "--kernel-argv" => {
                    kernel_argv.push(args.next().context("--kernel-argv requires a value")?);
                }
                "--kernel-name" => {
                    let value = args.next().context("--kernel-name requires a value")?;
                    if value.trim().is_empty() {
                        bail!("--kernel-name must not be empty");
                    }
                    kernel_name = Some(value);
                }
                "--runtime-root" => {
                    runtime_root = Some(PathBuf::from(
                        args.next().context("--runtime-root requires a value")?,
                    ));
                }
                "--drain-timeout-ms" => {
                    let value = args.next().context("--drain-timeout-ms requires a value")?;
                    let milliseconds = value
                        .parse::<u64>()
                        .context("--drain-timeout-ms must be a positive integer")?;
                    if milliseconds == 0 {
                        bail!("--drain-timeout-ms must be positive");
                    }
                    drain_timeout = Duration::from_millis(milliseconds);
                }
                "--help" | "-h" => {
                    println!(
						"Usage: choreograph-jupyter-bridge --protocol <kernel|runtime> ((--python <absolute-path> --runtime-root <absolute-path>) | --kernel-argv <arg> ...) [--kernel-name <name>]"
					);
                    return Ok(None);
                }
                _ => bail!("unknown argument: {arg}"),
            }
        }

        let launch = match (python, kernel_argv.is_empty()) {
            (Some(_), false) => bail!("--python and --kernel-argv are mutually exclusive"),
            (Some(python), true) => {
                if !python.is_absolute() {
                    bail!("--python must be an absolute path");
                }
                KernelLaunch::Python(python)
            }
            (None, false) => {
                if !Path::new(&kernel_argv[0]).is_absolute() {
                    bail!("--kernel-argv program must be an absolute path");
                }
                if !kernel_argv
                    .iter()
                    .any(|argument| argument.contains(CONNECTION_FILE_PLACEHOLDER))
                {
                    bail!(
                        "--kernel-argv must contain the {CONNECTION_FILE_PLACEHOLDER} placeholder"
                    );
                }
                KernelLaunch::Argv(kernel_argv)
            }
            (None, true) => bail!("--python or --kernel-argv is required"),
        };

        let runtime_root = match runtime_root {
            Some(runtime_root)
                if runtime_root.is_absolute()
                    && !runtime_root.components().any(|component| {
                        matches!(component, Component::CurDir | Component::ParentDir)
                    }) =>
            {
                Some(runtime_root)
            }
            Some(_) => bail!("--runtime-root must be a normalized absolute path"),
            None => None,
        };
        if matches!(launch, KernelLaunch::Python(_)) && runtime_root.is_none() {
            bail!("--runtime-root is required with --python");
        }

        Ok(Some(Self {
            protocol: protocol.context("--protocol is required")?,
            launch,
            kernel_name: kernel_name.unwrap_or_else(|| DEFAULT_KERNEL_NAME.to_string()),
            runtime_root,
            drain_timeout,
        }))
    }

    #[cfg(test)]
    fn parse_from(args: impl IntoIterator<Item = String>) -> Result<Option<Self>> {
        Self::parse_args(args)
    }
}

fn render_kernel_argv(argv: &[String], connection_file: &Path) -> Vec<String> {
    let connection_file = connection_file.to_string_lossy();
    argv.iter()
        .map(|argument| argument.replace(CONNECTION_FILE_PLACEHOLDER, connection_file.as_ref()))
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum BridgeCommand {
    Exec {
        input_id: String,
        code: String,
    },
    Interrupt,
    HostResponse {
        request_id: String,
        ok: bool,
        result: Option<Value>,
        error: Option<Value>,
    },
    Close,
}

#[derive(Default)]
struct Execution {
    sequence: u64,
    input_id: String,
    stdout: String,
    stderr: String,
    result: Option<String>,
    error: Option<String>,
    reply_status: Option<ReplyStatus>,
    reply_received: bool,
    idle_received: bool,
}

impl Execution {
    fn new(sequence: u64, input_id: String) -> Self {
        Self {
            sequence,
            input_id,
            ..Self::default()
        }
    }

    fn complete(&self) -> bool {
        self.reply_received && self.idle_received
    }
}

struct RuntimePaths {
    connection_file: PathBuf,
    ipc_prefix: String,
}

struct AbortTasks(Vec<JoinHandle<()>>);

impl Drop for AbortTasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

impl RuntimePaths {
    fn new() -> Self {
        let id = Uuid::new_v4().simple().to_string();
        let short_id = &id[..12];
        Self {
            connection_file: PathBuf::from(format!("/tmp/cj-{short_id}.json")),
            ipc_prefix: format!("/tmp/cj-{short_id}"),
        }
    }

    fn connection_info(&self, kernel_name: &str) -> ConnectionInfo {
        ConnectionInfo {
            transport: Transport::IPC,
            ip: self.ipc_prefix.clone(),
            stdin_port: 1,
            control_port: 2,
            hb_port: 3,
            shell_port: 4,
            iopub_port: 5,
            signature_scheme: "hmac-sha256".to_string(),
            key: Uuid::new_v4().to_string(),
            kernel_name: Some(kernel_name.to_string()),
        }
    }

    fn write_connection_file(&self, info: &ConnectionInfo) -> Result<()> {
        let content = serde_json::to_vec(info).context("serialize Jupyter connection info")?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&self.connection_file)
            .with_context(|| format!("create {}", self.connection_file.display()))?;
        file.write_all(&content)
            .with_context(|| format!("write {}", self.connection_file.display()))?;
        file.sync_all()
            .with_context(|| format!("sync {}", self.connection_file.display()))?;
        Ok(())
    }

    fn socket_path(&self, suffix: u8) -> PathBuf {
        PathBuf::from(format!("{}-{suffix}", self.ipc_prefix))
    }

    fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.connection_file);
        for suffix in 1..=5 {
            let _ = std::fs::remove_file(format!("{}-{suffix}", self.ipc_prefix));
        }
    }
}

async fn wait_for_kernel_sockets(child: &mut Child, paths: &RuntimePaths) -> Result<()> {
    let deadline = Instant::now() + KERNEL_STARTUP_TIMEOUT;
    let required_sockets = [2, 4, 5];

    loop {
        if required_sockets
            .iter()
            .all(|suffix| paths.socket_path(*suffix).exists())
        {
            return Ok(());
        }

        if let Some(status) = child.try_wait().context("poll kernel startup")? {
            bail!("kernel exited before opening its Jupyter sockets: {status}");
        }

        if Instant::now() >= deadline {
            bail!("kernel did not open its Jupyter sockets within 90 seconds");
        }

        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

impl Drop for RuntimePaths {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn emit(value: Value) -> Result<()> {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    serde_json::to_writer(&mut lock, &value).context("serialize bridge event")?;
    lock.write_all(b"\n").context("write bridge event")?;
    lock.flush().context("flush bridge event")?;
    Ok(())
}

fn parent_id(message: &JupyterMessage) -> Option<&str> {
    message
        .parent_header
        .as_ref()
        .map(|header| header.msg_id.as_str())
}

fn media_value(media: &jupyter_protocol::media::Media) -> Result<Value> {
    serde_json::to_value(media).context("serialize Jupyter media bundle")
}

fn plain_result(media: &jupyter_protocol::media::Media) -> Option<String> {
    media.content.iter().find_map(|entry| match entry {
        MediaType::Plain(value) => Some(value.clone()),
        _ => None,
    })
}

fn reply_status(status: &ReplyStatus) -> &'static str {
    match status {
        ReplyStatus::Ok => "ok",
        ReplyStatus::Error | ReplyStatus::Aborted => "error",
    }
}

fn strip_ansi(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\u{1b}' || chars.peek() != Some(&'[') {
            output.push(character);
            continue;
        }
        let _ = chars.next();
        for next in chars.by_ref() {
            if ('@'..='~').contains(&next) {
                break;
            }
        }
    }
    output
}

fn spawn_shell_reader(
    mut connection: jupyter_zmq_client::DealerRecvConnection,
) -> (
    mpsc::Receiver<Result<JupyterMessage, String>>,
    JoinHandle<()>,
) {
    let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
    let task = tokio::spawn(async move {
        loop {
            let message = connection.read().await.map_err(|error| error.to_string());
            let stop = message.is_err();
            if sender.send(message).await.is_err() || stop {
                break;
            }
        }
    });
    (receiver, task)
}

fn spawn_iopub_reader(
    mut connection: jupyter_zmq_client::ClientIoPubConnection,
) -> (
    mpsc::Receiver<Result<JupyterMessage, String>>,
    JoinHandle<()>,
) {
    let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
    let task = tokio::spawn(async move {
        loop {
            let message = connection.read().await.map_err(|error| error.to_string());
            let stop = message.is_err();
            if sender.send(message).await.is_err() || stop {
                break;
            }
        }
    });
    (receiver, task)
}

fn spawn_command_reader() -> (
    mpsc::Receiver<Result<BridgeCommand, String>>,
    JoinHandle<()>,
) {
    let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        loop {
            let next = match lines.next_line().await {
                Ok(Some(line)) => serde_json::from_str::<BridgeCommand>(&line)
                    .map_err(|error| format!("invalid bridge command: {error}")),
                Ok(None) => break,
                Err(error) => Err(format!("read bridge command: {error}")),
            };
            let stop = next.is_err();
            if sender.send(next).await.is_err() || stop {
                break;
            }
        }
    });
    (receiver, task)
}

fn spawn_diagnostic_drain<R>(mut reader: R) -> JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut stderr = tokio::io::stderr();
        let _ = tokio::io::copy(&mut reader, &mut stderr).await;
    })
}

fn spawn_kernel(options: &Options, connection_file: &Path) -> Result<(Child, Vec<JoinHandle<()>>)> {
    let mut command = match &options.launch {
        KernelLaunch::Python(python) => {
            let runtime_root = options
                .runtime_root
                .as_ref()
                .context("--runtime-root is required with --python")?;
            if !runtime_root.is_dir() {
                bail!(
                    "trusted kernel runtime root is not a directory: {}",
                    runtime_root.display()
                );
            }
            let mut command = Command::new(python);
            command
                .arg("-m")
                .arg("ipykernel_launcher")
                .arg("-f")
                .arg(connection_file)
                .arg("--colors=NoColor")
                .env("PYTHONPATH", runtime_root)
                .env("PYTHONNOUSERSITE", "1")
                .env("PYTHONDONTWRITEBYTECODE", "1");
            command
        }
        KernelLaunch::Argv(argv) => {
            let rendered = render_kernel_argv(argv, connection_file);
            let (program, arguments) = rendered
                .split_first()
                .context("kernel argv must not be empty")?;
            let mut command = Command::new(program);
            command.args(arguments);
            command
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(target_os = "linux")]
    {
        let expected_parent = i32::try_from(std::process::id()).context("bridge pid overflow")?;
        // SAFETY: the closure calls only async-signal-safe libc functions between
        // fork and exec. PR_SET_PDEATHSIG prevents an orphaned kernel process if
        // the Rust controller is killed before it can run normal Drop/cleanup.
        unsafe {
            command.pre_exec(move || {
                if nix::libc::prctl(nix::libc::PR_SET_PDEATHSIG, nix::libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if nix::libc::getppid() != expected_parent {
                    nix::libc::_exit(127);
                }
                Ok(())
            });
        }
    }

    let mut child = command.spawn().with_context(|| {
        format!(
            "spawn kernel program at {}",
            options.launch.program_display()
        )
    })?;
    let mut drains = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        drains.push(spawn_diagnostic_drain(stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        drains.push(spawn_diagnostic_drain(stderr));
    }
    Ok((child, drains))
}

async fn wait_until_ready(shell: &mut jupyter_zmq_client::ClientShellConnection) -> Result<()> {
    let request: JupyterMessage = KernelInfoRequest::default().into();
    shell
        .send(request)
        .await
        .context("send kernel_info_request")?;

    timeout(READY_TIMEOUT, async {
        loop {
            let message = shell.read().await.context("read kernel_info_reply")?;
            if matches!(message.content, JupyterMessageContent::KernelInfoReply(_)) {
                return Ok::<(), anyhow::Error>(());
            }
        }
    })
    .await
    .context("kernel did not become ready within 30 seconds")??;
    Ok(())
}

fn emit_runtime_result(execution: Execution) -> Result<()> {
    let ok = execution.reply_status == Some(ReplyStatus::Ok) && execution.error.is_none();
    let mut payload = json!({
        "kind": "exec_result",
        "input_id": execution.input_id,
        "ok": ok,
        "stdout": execution.stdout,
        "stderr": execution.stderr,
        "has_result": execution.result.is_some(),
    });
    if let Some(result) = execution.result {
        payload["result"] = Value::String(result);
    }
    if let Some(error) = execution.error {
        payload["error"] = Value::String(error);
    }
    emit(payload)
}

fn emit_drain_failures(executions: &mut HashMap<String, Execution>) -> Result<()> {
    let mut pending = executions
        .drain()
        .map(|(_, execution)| execution)
        .collect::<Vec<_>>();
    pending.sort_by_key(|execution| execution.sequence);
    for execution in pending {
        emit(json!({
            "kind": "exec_result",
            "input_id": execution.input_id,
            "ok": false,
            "stdout": execution.stdout,
            "stderr": execution.stderr,
            "has_result": false,
            "error": "runtime close drain timed out",
        }))?;
    }
    Ok(())
}

fn finish_if_complete(
    protocol: Protocol,
    executions: &mut HashMap<String, Execution>,
    request_id: &str,
) -> Result<()> {
    if !executions.get(request_id).is_some_and(Execution::complete) {
        return Ok(());
    }
    if let Some(execution) = executions.remove(request_id) {
        if protocol == Protocol::Runtime {
            emit_runtime_result(execution)?;
        }
    }
    Ok(())
}

fn handle_shell_message(
    protocol: Protocol,
    executions: &mut HashMap<String, Execution>,
    message: JupyterMessage,
) -> Result<()> {
    let Some(request_id) = parent_id(&message).map(str::to_owned) else {
        return Ok(());
    };
    let Some(execution) = executions.get_mut(&request_id) else {
        return Ok(());
    };

    if let JupyterMessageContent::ExecuteReply(reply) = message.content {
        execution.reply_received = true;
        execution.reply_status = Some(reply.status.clone());
        if execution.error.is_none() {
            if let Some(error) = reply.error {
                execution.error = Some(strip_ansi(&error.traceback.join("\n")));
            }
        }
        if protocol == Protocol::Kernel {
            emit(json!({
                "kind": "reply",
                "input_id": execution.input_id,
                "status": reply_status(&reply.status),
                "execution_count": reply.execution_count.value(),
            }))?;
        }
    }

    finish_if_complete(protocol, executions, &request_id)
}

fn handle_iopub_message(
    protocol: Protocol,
    executions: &mut HashMap<String, Execution>,
    message: JupyterMessage,
) -> Result<()> {
    let parent_request_id = parent_id(&message).map(str::to_owned);
    if let JupyterMessageContent::CommOpen(open) = &message.content {
        if open.target_name == "host.request" {
            let input_id = parent_request_id
                .as_ref()
                .and_then(|request_id| executions.get(request_id))
                .map(|execution| execution.input_id.clone())
                .context("host.request has no executing parent cell")?;
            emit(json!({
                "kind": "host_request",
                "request_id": String::from(open.comm_id.clone()),
                "input_id": input_id,
                "payload": open.data,
            }))?;
        }
    }
    let Some(request_id) = parent_request_id else {
        return Ok(());
    };
    let Some(execution) = executions.get_mut(&request_id) else {
        return Ok(());
    };

    match message.content {
        JupyterMessageContent::Status(status) => match status.execution_state {
            ExecutionState::Busy if protocol == Protocol::Kernel => {
                emit(json!({ "kind": "busy", "input_id": execution.input_id }))?;
            }
            ExecutionState::Idle => {
                execution.idle_received = true;
                if protocol == Protocol::Kernel {
                    emit(json!({ "kind": "idle", "input_id": execution.input_id }))?;
                }
            }
            _ => {}
        },
        JupyterMessageContent::StreamContent(stream) => {
            let name = match stream.name {
                JupyterStdio::Stdout => {
                    execution.stdout.push_str(&stream.text);
                    "stdout"
                }
                JupyterStdio::Stderr => {
                    execution.stderr.push_str(&stream.text);
                    "stderr"
                }
            };
            if protocol == Protocol::Kernel {
                emit(json!({
                    "kind": "stream",
                    "input_id": execution.input_id,
                    "name": name,
                    "text": stream.text,
                }))?;
            }
        }
        JupyterMessageContent::DisplayData(display) if protocol == Protocol::Kernel => {
            emit(json!({
                "kind": "display",
                "input_id": execution.input_id,
                "data": media_value(&display.data)?,
                "metadata": display.metadata,
            }))?;
        }
        JupyterMessageContent::UpdateDisplayData(display) if protocol == Protocol::Kernel => {
            emit(json!({
                "kind": "display",
                "input_id": execution.input_id,
                "data": media_value(&display.data)?,
                "metadata": display.metadata,
            }))?;
        }
        JupyterMessageContent::ExecuteResult(result) => {
            execution.result = plain_result(&result.data);
            if protocol == Protocol::Kernel {
                emit(json!({
                    "kind": "result",
                    "input_id": execution.input_id,
                    "data": media_value(&result.data)?,
                    "metadata": result.metadata,
                    "execution_count": result.execution_count.value(),
                }))?;
            }
        }
        JupyterMessageContent::ErrorOutput(error) => {
            let traceback = error
                .traceback
                .iter()
                .map(|line| strip_ansi(line))
                .collect::<Vec<_>>();
            execution.error = Some(traceback.join("\n"));
            if protocol == Protocol::Kernel {
                emit(json!({
                    "kind": "error",
                    "input_id": execution.input_id,
                    "ename": error.ename,
                    "evalue": error.evalue,
                    "traceback": traceback,
                }))?;
            }
        }
        _ => {}
    }

    finish_if_complete(protocol, executions, &request_id)
}

async fn run(options: Options) -> Result<i32> {
    let paths = RuntimePaths::new();
    let connection_info = paths.connection_info(&options.kernel_name);
    paths.write_connection_file(&connection_info)?;

    let (mut child, diagnostic_tasks) = spawn_kernel(&options, &paths.connection_file)?;
    let kernel_pid = child.id().context("kernel did not have a pid")?;
    let kernel_pid = Pid::from_raw(i32::try_from(kernel_pid).context("kernel pid overflow")?);

    if let Err(error) = wait_for_kernel_sockets(&mut child, &paths).await {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(error);
    }

    // Subscribe to IOPub before the first request so the PUB/SUB slow-joiner cannot
    // discard the ready or first-execution status messages.
    let session_id = Uuid::new_v4().to_string();
    let iopub =
        jupyter_zmq_client::create_client_iopub_connection(&connection_info, "", &session_id)
            .await
            .context("connect Jupyter IOPub channel")?;
    let identity = jupyter_zmq_client::peer_identity_for_session(&session_id)
        .context("create Jupyter peer identity")?;
    let mut shell = jupyter_zmq_client::create_client_shell_connection_with_identity(
        &connection_info,
        &session_id,
        identity,
    )
    .await
    .context("connect Jupyter shell channel")?;
    let mut control =
        jupyter_zmq_client::create_client_control_connection(&connection_info, &session_id)
            .await
            .context("connect Jupyter control channel")?;

    if let Err(error) = wait_until_ready(&mut shell).await {
        let _ = kill(kernel_pid, Signal::SIGKILL);
        let _ = child.wait().await;
        return Err(error);
    }

    let (mut shell_send, shell_recv) = shell.split();
    let (mut shell_events, shell_task) = spawn_shell_reader(shell_recv);
    let (mut iopub_events, iopub_task) = spawn_iopub_reader(iopub);
    let (mut commands, command_task) = spawn_command_reader();
    let mut tasks = diagnostic_tasks;
    tasks.extend([shell_task, iopub_task, command_task]);
    let _task_guard = AbortTasks(tasks);
    let mut term_signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("install SIGTERM handler")?;

    emit(match options.protocol {
        Protocol::Kernel => json!({ "kind": "ready", "kernel": options.kernel_name }),
        Protocol::Runtime => json!({ "kind": "ready" }),
    })?;

    let mut executions = HashMap::<String, Execution>::new();
    let mut shutdown_requested = false;
    let mut input_closed = false;
    let mut drain_failed = false;
    let drain_timer = tokio::time::sleep(Duration::from_secs(365 * 24 * 60 * 60));
    tokio::pin!(drain_timer);
    let mut child_wait = Box::pin(child.wait());
    let mut child_exit = None;
    let mut next_sequence = 0_u64;

    while !shutdown_requested {
        tokio::select! {
            status = &mut child_wait => {
                child_exit = Some(status.context("wait for kernel")?.code().unwrap_or(1));
                break;
            }
            command = commands.recv(), if !input_closed && executions.len() < MAX_IN_FLIGHT => {
                match command {
                    Some(Ok(BridgeCommand::Exec { input_id, code })) if !input_closed => {
                        let mut request = ExecuteRequest::new(code);
                        request.stop_on_error = false;
                        let request: JupyterMessage = request.into();
                        let request_id = request.header.msg_id.clone();
                        executions.insert(request_id, Execution::new(next_sequence, input_id));
                        next_sequence = next_sequence.saturating_add(1);
                        shell_send.send(request).await.context("send execute_request")?;
                    }
                    Some(Ok(BridgeCommand::Interrupt)) => {
                        kill(kernel_pid, Signal::SIGINT).context("interrupt kernel")?;
                    }
                    Some(Ok(BridgeCommand::HostResponse { request_id, ok, result, error })) => {
                        let mut data = serde_json::Map::new();
                        data.insert("status".to_string(), Value::String(if ok { "ok" } else { "error" }.to_string()));
                        if ok {
                            if let Some(Value::Object(fields)) = result {
                                data.extend(fields);
                            }
                        } else {
                            data.insert("error".to_string(), validate_host_error(error)?);
                        }
                        let response: JupyterMessage = CommMsg {
                            comm_id: request_id.into(),
                            data,
                        }.into();
                        control.send(response).await.context("send host request comm reply")?;
                    }
                    Some(Ok(BridgeCommand::Close)) | None => {
                        input_closed = true;
                        if options.protocol == Protocol::Kernel || executions.is_empty() {
                            shutdown_requested = true;
                        } else {
                            drain_timer.as_mut().reset(Instant::now() + options.drain_timeout);
                        }
                    }
                    Some(Ok(BridgeCommand::Exec { .. })) => {}
                    Some(Err(error)) => return Err(anyhow!(error)),
                }
            }
            message = shell_events.recv() => {
                match message {
                    Some(Ok(message)) => handle_shell_message(options.protocol, &mut executions, message)?,
                    Some(Err(error)) => return Err(anyhow!("Jupyter shell channel failed: {error}")),
                    None => return Err(anyhow!("Jupyter shell reader stopped unexpectedly")),
                }
            }
            message = iopub_events.recv() => {
                match message {
                    Some(Ok(message)) => handle_iopub_message(options.protocol, &mut executions, message)?,
                    Some(Err(error)) => return Err(anyhow!("Jupyter IOPub channel failed: {error}")),
                    None => return Err(anyhow!("Jupyter IOPub reader stopped unexpectedly")),
                }
            }
            _ = term_signal.recv() => {
                shutdown_requested = true;
            }
            _ = &mut drain_timer, if input_closed && options.protocol == Protocol::Runtime && !executions.is_empty() => {
                emit_drain_failures(&mut executions)?;
                drain_failed = true;
                shutdown_requested = true;
            }
        }

        if input_closed && executions.is_empty() {
            shutdown_requested = true;
        }
    }

    if shutdown_requested && child_exit.is_none() {
        let request: JupyterMessage = ShutdownRequest { restart: false }.into();
        let _ = control.send(request).await;
        child_exit = Some(match timeout(SHUTDOWN_TIMEOUT, &mut child_wait).await {
            Ok(status) => status
                .context("wait for kernel shutdown")?
                .code()
                .unwrap_or(1),
            Err(_) => {
                let _ = kill(kernel_pid, Signal::SIGKILL);
                child_wait
                    .await
                    .context("wait for killed kernel")?
                    .code()
                    .unwrap_or(1)
            }
        });
    }

    paths.cleanup();

    Ok(if drain_failed {
        1
    } else if shutdown_requested {
        0
    } else {
        child_exit.unwrap_or(1)
    })
}

fn validate_host_error(error: Option<Value>) -> Result<Value> {
    const CLASSES: [&str; 6] = [
        "invalid",
        "denied",
        "conflict",
        "not_found",
        "unavailable",
        "internal",
    ];
    let Value::Object(fields) =
        error.context("failed host response requires a structured error object")?
    else {
        bail!("failed host response requires a structured error object");
    };
    let expected = ["code", "class", "message", "retryable"];
    if fields.len() != expected.len() || !expected.iter().all(|field| fields.contains_key(*field)) {
        bail!("failed host response error fields are non-canonical");
    }
    let code = fields
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let class = fields
        .get("class")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = fields
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if code.is_empty()
        || code.len() > 128
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        bail!("failed host response error code is invalid");
    }
    if !CLASSES.contains(&class) {
        bail!("failed host response error class is invalid");
    }
    if message.is_empty()
        || message.len() > 4096
        || !message.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
    {
        bail!("failed host response error message is invalid");
    }
    if !matches!(fields.get("retryable"), Some(Value::Bool(_))) {
        bail!("failed host response error retryable flag is invalid");
    }
    Ok(Value::Object(fields))
}

#[cfg(test)]
mod host_contract_tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn runtime_root_is_required_and_absolute_without_traversal() {
        let base = ["--protocol", "kernel", "--python", "/opt/python"];
        assert!(Options::parse_from(args(&base)).is_err());
        for root in ["relative", "/opt/runtime/../poison"] {
            let mut values = base.to_vec();
            values.extend(["--runtime-root", root]);
            assert!(Options::parse_from(args(&values)).is_err());
        }
        let mut values = base.to_vec();
        values.extend([
            "--runtime-root",
            "/opt/choreograph-runtime/sophia-kernel-runtime/src",
        ]);
        let options = Options::parse_from(args(&values)).unwrap().unwrap();
        assert_eq!(
            options.runtime_root,
            Some(PathBuf::from(
                "/opt/choreograph-runtime/sophia-kernel-runtime/src"
            ))
        );
    }

    #[test]
    fn host_errors_must_be_exact_structured_testimony() {
        let valid = json!({
            "code": "child_budget_exhausted",
            "class": "denied",
            "message": "No remaining child budget",
            "retryable": false
        });
        assert_eq!(validate_host_error(Some(valid.clone())).unwrap(), valid);
        assert!(validate_host_error(Some(Value::String("legacy".to_string()))).is_err());
        assert!(validate_host_error(Some(json!({
            "code": "child_budget_exhausted",
            "class": "fatal",
            "message": "No remaining child budget",
            "retryable": false
        })))
        .is_err());
        assert!(validate_host_error(None).is_err());
    }
}

#[tokio::main]
async fn main() {
    let result = async {
        let Some(options) = Options::parse()? else {
            return Ok(0);
        };
        run(options).await
    }
    .await;

    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("choreograph-jupyter-bridge: {error:#}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<Options>> {
        Options::parse_args(args.iter().map(|value| (*value).to_string()))
    }

    #[test]
    fn python_launch_keeps_its_original_contract() {
        let options = parse(&[
            "--protocol",
            "kernel",
            "--python",
            "/opt/runtime/python/bin/python3",
            "--runtime-root",
            "/opt/choreograph-runtime/sophia-kernel-runtime/src",
        ])
        .expect("parse")
        .expect("options");
        assert_eq!(options.protocol, Protocol::Kernel);
        assert_eq!(
            options.launch,
            KernelLaunch::Python(PathBuf::from("/opt/runtime/python/bin/python3"))
        );
        // The registry's python3 entry passes no --kernel-name, so the ready
        // event and the connection file must still say python3.
        assert_eq!(options.kernel_name, DEFAULT_KERNEL_NAME);
        assert_eq!(options.drain_timeout, DRAIN_TIMEOUT);
    }

    #[test]
    fn relative_python_is_rejected() {
        assert!(parse(&["--protocol", "kernel", "--python", "python3"]).is_err());
    }

    #[test]
    fn kernel_argv_launch_is_parsed_in_order() {
        let options = parse(&[
            "--protocol",
            "kernel",
            "--kernel-name",
            "julia",
            "--kernel-argv",
            "/opt/runtime/julia/bin/julia",
            "--kernel-argv",
            "-i",
            "--kernel-argv",
            "/opt/runtime/julia/launch_kernel.jl",
            "--kernel-argv",
            "{connection_file}",
        ])
        .expect("parse")
        .expect("options");
        assert_eq!(options.kernel_name, "julia");
        assert_eq!(
            options.launch,
            KernelLaunch::Argv(vec![
                "/opt/runtime/julia/bin/julia".to_string(),
                "-i".to_string(),
                "/opt/runtime/julia/launch_kernel.jl".to_string(),
                CONNECTION_FILE_PLACEHOLDER.to_string(),
            ])
        );
    }

    #[test]
    fn kernel_argv_requires_the_connection_file_placeholder() {
        let error = parse(&[
            "--protocol",
            "kernel",
            "--kernel-argv",
            "/usr/bin/kernel",
            "--kernel-argv",
            "--serve",
        ])
        .expect_err("missing placeholder must fail closed");
        assert!(error.to_string().contains(CONNECTION_FILE_PLACEHOLDER));
    }

    #[test]
    fn kernel_argv_program_must_be_absolute() {
        assert!(parse(&[
            "--protocol",
            "kernel",
            "--kernel-argv",
            "julia",
            "--kernel-argv",
            "{connection_file}"
        ])
        .is_err());
    }

    #[test]
    fn python_and_kernel_argv_are_mutually_exclusive() {
        assert!(parse(&[
            "--protocol",
            "kernel",
            "--python",
            "/opt/runtime/python/bin/python3",
            "--kernel-argv",
            "/opt/runtime/julia/bin/julia",
            "--kernel-argv",
            "{connection_file}",
        ])
        .is_err());
    }

    #[test]
    fn a_launch_mode_is_required() {
        assert!(parse(&["--protocol", "kernel"]).is_err());
    }

    #[test]
    fn empty_kernel_name_is_rejected() {
        assert!(parse(&[
            "--protocol",
            "kernel",
            "--kernel-name",
            "  ",
            "--python",
            "/opt/runtime/python/bin/python3",
        ])
        .is_err());
    }

    #[test]
    fn connection_file_is_substituted_everywhere_it_appears() {
        let argv = vec![
            "/opt/runtime/julia/bin/julia".to_string(),
            "--project=/opt/runtime/julia/depot/environments/v1.11".to_string(),
            "/opt/runtime/julia/launch_kernel.jl".to_string(),
            CONNECTION_FILE_PLACEHOLDER.to_string(),
            format!("--also={CONNECTION_FILE_PLACEHOLDER}"),
        ];
        let rendered = render_kernel_argv(&argv, Path::new("/tmp/cj-abc123.json"));
        assert_eq!(
            rendered,
            vec![
                "/opt/runtime/julia/bin/julia".to_string(),
                "--project=/opt/runtime/julia/depot/environments/v1.11".to_string(),
                "/opt/runtime/julia/launch_kernel.jl".to_string(),
                "/tmp/cj-abc123.json".to_string(),
                "--also=/tmp/cj-abc123.json".to_string(),
            ]
        );
    }

    #[test]
    fn connection_info_carries_ipc_transport_and_the_kernel_name() {
        let paths = RuntimePaths::new();
        let info = paths.connection_info("julia");
        assert_eq!(info.transport, Transport::IPC);
        assert_eq!(info.kernel_name.as_deref(), Some("julia"));
        // IJulia binds "$(transport)://$(ip)-$(port)" for ipc; the bridge's own
        // socket paths must agree with that convention or nothing connects.
        assert_eq!(
            paths.socket_path(4),
            PathBuf::from(format!("{}-4", info.ip))
        );
    }

    #[test]
    fn strip_ansi_removes_escape_sequences() {
        assert_eq!(strip_ansi("\u{1b}[31mboom\u{1b}[0m"), "boom");
        assert_eq!(strip_ansi("plain"), "plain");
    }
}
