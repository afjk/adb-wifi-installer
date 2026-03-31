use std::io::{BufRead, BufReader};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Windowsではコンソールウィンドウを開かずにプロセスを起動するヘルパー
fn new_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone)]
pub struct Device {
    pub address: String,
    pub state: String,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub manufacturer: Option<String>,
    pub device_type: Option<String>, // "vr", "phone", "tablet", "tv"
    pub battery: Option<u8>,         // 0-100
    pub charging: Option<bool>,
}

fn get_battery(adb: &str, device: &str) -> (Option<u8>, Option<bool>) {
    let out = run_adb_shell(adb, device, &["dumpsys", "battery"]);
    let mut level: Option<u8> = None;
    let mut charging: Option<bool> = None;
    for line in out.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("level:") {
            level = v.trim().parse().ok();
        } else if let Some(v) = line.strip_prefix("status:") {
            // 2=Charging, 5=Full, others=not charging
            charging = v.trim().parse::<u8>().ok().map(|s| s == 2 || s == 5);
        }
    }
    (level, charging)
}

fn detect_device_type(manufacturer: &str, model: &str) -> &'static str {
    let mfr = manufacturer.to_lowercase();
    let mdl = model.to_lowercase();
    if mfr.contains("pico") || mfr.contains("meta") || mfr.contains("oculus")
        || mdl.contains("quest") || mdl.contains("pico")
    {
        "vr"
    } else if mfr.contains("google") && mdl.contains("adt") {
        "tv"
    } else if mdl.contains("tab") || mdl.contains("pad") || mdl.contains("sm-t")
        || mdl.contains("slate")
    {
        "tablet"
    } else {
        "phone"
    }
}

#[derive(Serialize)]
pub struct InstallResult {
    pub message: String,
    pub package: Option<String>,
}

fn get_adb_path() -> String {
    // Check PATH
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = new_command(which_cmd).arg("adb").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

    // Try common install locations
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let candidates = [
            format!("{}/Library/Android/sdk/platform-tools/adb", home),
            format!("{}/AppData/Local/Android/Sdk/platform-tools/adb.exe", home),
        ];
        for p in &candidates {
            if std::path::Path::new(p).exists() {
                return p.clone();
            }
        }
    }

    // Fallback
    "adb".to_string()
}

fn get_local_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        _ => None,
    }
}

#[tauri::command]
async fn scan_network() -> Vec<String> {
    let local_ip = match get_local_ipv4() {
        Some(ip) => ip,
        None => return vec![],
    };

    let [a, b, c, _] = local_ip.octets();
    let found: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let mut handles = vec![];

    for i in 1u8..=254 {
        let found = Arc::clone(&found);
        let handle = thread::spawn(move || {
            let ip = Ipv4Addr::new(a, b, c, i);
            let addr = SocketAddr::new(IpAddr::V4(ip), 5555);
            if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
                found.lock().unwrap().push(ip.to_string());
            }
        });
        handles.push(handle);
    }

    for h in handles {
        let _ = h.join();
    }

    let mut result = found.lock().unwrap().clone();
    result.sort();
    result
}

#[tauri::command]
async fn get_devices() -> Vec<Device> {
    let adb = get_adb_path();
    let output = match new_command(&adb).args(["devices", "-l"]).output() {
        Ok(o) => o,
        Err(_) => return vec![],
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = vec![];

    for line in stdout.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            let address = parts[0].to_string();
            let state = parts[1].to_string();
            let model = parts[2..]
                .iter()
                .find(|p| p.starts_with("model:"))
                .map(|p| p.replace("model:", "").replace('_', " "));
            // WiFi接続デバイスのシリアル番号・メーカー・バッテリーをgetpropで取得
            let (serial, manufacturer, device_type, battery, charging) = if state == "device" {
                let s = run_adb_shell(&adb, &address, &["getprop", "ro.serialno"]);
                let m = run_adb_shell(&adb, &address, &["getprop", "ro.product.manufacturer"]);
                let serial = { let v = s.trim().to_string(); if v.is_empty() { None } else { Some(v) } };
                let mfr   = { let v = m.trim().to_string(); if v.is_empty() { None } else { Some(v) } };
                let dtype = detect_device_type(
                    mfr.as_deref().unwrap_or(""),
                    model.as_deref().unwrap_or(""),
                ).to_string();
                let (bat, chg) = get_battery(&adb, &address);
                (serial, mfr, Some(dtype), bat, chg)
            } else {
                (None, None, None, None, None)
            };
            devices.push(Device { address, state, model, serial, manufacturer, device_type, battery, charging });
        }
    }

    devices
}

fn adb_connect_once(adb: &str, address: &str) -> Result<String, String> {
    let output = new_command(adb)
        .args(["connect", address])
        .output()
        .map_err(|e| format!("adb not found: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stdout.contains("connected") {
        Ok(stdout)
    } else {
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

fn reset_adb_server(adb: &str) {
    new_command(adb).arg("kill-server").output().ok();
    std::thread::sleep(Duration::from_secs(1));
    new_command(adb).arg("start-server").output().ok();
    std::thread::sleep(Duration::from_secs(1));
}

#[tauri::command]
async fn connect_device(ip: String, port: u16) -> Result<String, String> {
    let adb = get_adb_path();
    let address = format!("{}:{}", ip, port);

    match adb_connect_once(&adb, &address) {
        Ok(msg) => Ok(msg),
        Err(e) if e.contains("No route to host") || e.contains("cannot connect") => {
            // adbサーバーリセット後に1回だけリトライ（無限ループ防止）
            reset_adb_server(&adb);
            adb_connect_once(&adb, &address)
                .map(|msg| format!("[自動リセット後] {}", msg))
                .map_err(|e2| format!("自動リセット後も失敗: {}", e2))
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn disconnect_device(address: String) -> Result<String, String> {
    let adb = get_adb_path();
    let output = new_command(&adb)
        .args(["disconnect", &address])
        .output()
        .map_err(|e| e.to_string())?;

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn find_aapt() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let build_tools = std::path::Path::new(&home).join("Library/Android/sdk/build-tools");
    let mut latest = std::fs::read_dir(&build_tools)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().ok().map(|t| t.is_dir()).unwrap_or(false))
        .collect::<Vec<_>>();
    latest.sort_by_key(|e| e.file_name());
    // Try aapt2 then aapt from newest to oldest version
    for entry in latest.iter().rev() {
        let aapt2 = entry.path().join("aapt2");
        if aapt2.exists() { return Some(aapt2); }
        let aapt = entry.path().join("aapt");
        if aapt.exists() { return Some(aapt); }
    }
    None
}

#[derive(Serialize)]
pub struct ApkInfo {
    pub package: String,
    pub version_name: String,
    pub version_code: String,
    pub label: Option<String>,
    pub min_sdk: Option<String>,
    pub target_sdk: Option<String>,
    pub signature_subject: Option<String>,
    pub signature_sha256: Option<String>,
    pub debug_signed: bool,
}

fn find_apksigner() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let build_tools = std::path::Path::new(&home).join("Library/Android/sdk/build-tools");
    let mut entries: Vec<_> = std::fs::read_dir(&build_tools)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().ok().map(|t| t.is_dir()).unwrap_or(false))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries.iter().rev() {
        let p = entry.path().join("apksigner");
        if p.exists() { return Some(p); }
    }
    None
}

fn parse_aapt_attr<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("{}='", key);
    let start = line.find(&needle)? + needle.len();
    let end = line[start..].find('\'')?;
    Some(&line[start..start + end])
}

#[tauri::command]
async fn get_apk_package(apk_path: String) -> Result<String, String> {
    let info = get_apk_info(apk_path).await?;
    Ok(info.package)
}

#[tauri::command]
async fn get_apk_info(apk_path: String) -> Result<ApkInfo, String> {
    let tool = find_aapt().ok_or("aapt/aapt2 が見つかりません (Android SDK build-tools が必要です)")?;

    let output = new_command(&tool)
        .args(["dump", "badging", &apk_path])
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut package = String::new();
    let mut version_name = String::new();
    let mut version_code = String::new();
    let mut label: Option<String> = None;
    let mut min_sdk: Option<String> = None;
    let mut target_sdk: Option<String> = None;

    for line in stdout.lines() {
        if line.starts_with("package:") {
            if let Some(v) = parse_aapt_attr(line, "name")        { package      = v.to_string(); }
            if let Some(v) = parse_aapt_attr(line, "versionName") { version_name = v.to_string(); }
            if let Some(v) = parse_aapt_attr(line, "versionCode") { version_code = v.to_string(); }
        } else if line.starts_with("application-label:") {
            label = line.split('\'').nth(1).map(|s| s.to_string());
        } else if line.starts_with("sdkVersion:") {
            min_sdk = line.split('\'').nth(1).map(|s| s.to_string());
        } else if line.starts_with("targetSdkVersion:") {
            target_sdk = line.split('\'').nth(1).map(|s| s.to_string());
        }
    }

    if package.is_empty() {
        return Err("パッケージ名が見つかりませんでした".to_string());
    }

    // 署名情報
    let (signature_subject, signature_sha256, debug_signed) =
        if let Some(signer) = find_apksigner() {
            let sig_out = new_command(&signer)
                .args(["verify", "--print-certs", &apk_path])
                .output().ok();
            if let Some(out) = sig_out {
                let text = String::from_utf8_lossy(&out.stdout).to_string();
                let subject = text.lines()
                    .find(|l| l.contains("certificate DN:"))
                    .and_then(|l| l.split("certificate DN:").nth(1))
                    .map(|s| s.trim().to_string());
                let sha256 = text.lines()
                    .find(|l| l.contains("certificate SHA-256 digest:"))
                    .and_then(|l| l.split("certificate SHA-256 digest:").nth(1))
                    .map(|s| s.trim().to_string());
                let is_debug = subject.as_deref().map(|s| s.contains("Android Debug")).unwrap_or(false);
                (subject, sha256, is_debug)
            } else {
                (None, None, false)
            }
        } else {
            (None, None, false)
        };

    Ok(ApkInfo { package, version_name, version_code, label, min_sdk, target_sdk,
                 signature_subject, signature_sha256, debug_signed })
}

fn get_package_list(adb: &str, device: &str) -> std::collections::HashSet<String> {
    run_adb_shell(adb, device, &["pm", "list", "packages"])
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            l.starts_with("package:").then(|| l[8..].trim().to_string())
        })
        .collect()
}

fn parse_adb_push_progress(line: &str) -> Option<u8> {
    // adb push outputs: "[  2%] /data/local/tmp/..."
    let line = line.trim();
    if line.starts_with('[') {
        if let Some(pct_pos) = line.find('%') {
            let num_str = line[1..pct_pos].trim();
            return num_str.parse::<u8>().ok().map(|n| n.min(99));
        }
    }
    None
}

#[tauri::command]
async fn install_apk(app: tauri::AppHandle, device: String, apk_path: String) -> Result<InstallResult, String> {
    let adb = get_adb_path();
    let before = get_package_list(&adb, &device);
    let remote_path = "/data/local/tmp/_adbui_install.apk";

    // Phase 1: push APK to device with progress events
    let _ = app.emit("install_progress", serde_json::json!({
        "device": &device, "progress": 0, "phase": "uploading"
    }));

    {
        let adb2 = adb.clone();
        let device2 = device.clone();
        let apk2 = apk_path.clone();
        let app2 = app.clone();
        let dev2 = device.clone();

        tauri::async_runtime::spawn_blocking(move || {
            let mut child = new_command(&adb2)
                .args(["-s", &device2, "push", &apk2, remote_path])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;

            if let Some(stderr) = child.stderr.take() {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    if let Some(pct) = parse_adb_push_progress(&line) {
                        let _ = app2.emit("install_progress", serde_json::json!({
                            "device": &dev2, "progress": pct, "phase": "uploading"
                        }));
                    }
                }
            }

            let status = child.wait().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("アップロード失敗".to_string());
            }
            Ok::<(), String>(())
        }).await.map_err(|e| e.to_string())??;
    }

    // Phase 2: install from device storage
    let _ = app.emit("install_progress", serde_json::json!({
        "device": &device, "progress": 100, "phase": "installing"
    }));

    let output = new_command(&adb)
        .args(["-s", &device, "shell", "pm", "install", "-r", remote_path])
        .output()
        .map_err(|e| e.to_string())?;

    // Cleanup temp file
    let _ = new_command(&adb)
        .args(["-s", &device, "shell", "rm", "-f", remote_path])
        .output();

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    let success_msg = if stdout.contains("Success") {
        stdout
    } else if stderr.contains("Success") {
        stderr
    } else {
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    };

    let after = get_package_list(&adb, &device);
    let package = after.difference(&before).next().cloned();

    let _ = app.emit("install_progress", serde_json::json!({
        "device": &device, "progress": 100, "phase": "done"
    }));

    Ok(InstallResult { message: success_msg, package })
}

#[tauri::command]
async fn uninstall_apk(device: String, package: String) -> Result<String, String> {
    let adb = get_adb_path();
    let output = new_command(&adb)
        .args(["-s", &device, "uninstall", &package])
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stdout.contains("Success") {
        Ok(format!("アンインストール完了: {}", package))
    } else {
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}


#[tauri::command]
async fn identify_device(device: String) -> Result<String, String> {
    let adb = get_adb_path();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut methods = vec![];

        // 1. 画面を起こす
        new_command(&adb)
            .args(["-s", &device, "shell", "input", "keyevent", "KEYCODE_WAKEUP"])
            .output().ok();

        // 2. 画面輝度フラッシュ（VRヘッドセット含む全機種に有効）
        let orig = run_adb_shell(&adb, &device, &["settings", "get", "system", "screen_brightness"]);
        let orig = orig.trim();
        let brightness_ok = !orig.is_empty() && orig != "null";
        if brightness_ok {
            for _ in 0..3 {
                new_command(&adb)
                    .args(["-s", &device, "shell", "settings", "put", "system", "screen_brightness", "255"])
                    .output().ok();
                std::thread::sleep(Duration::from_millis(400));
                new_command(&adb)
                    .args(["-s", &device, "shell", "settings", "put", "system", "screen_brightness", "10"])
                    .output().ok();
                std::thread::sleep(Duration::from_millis(400));
            }
            new_command(&adb)
                .args(["-s", &device, "shell", "settings", "put", "system", "screen_brightness", orig])
                .output().ok();
            methods.push("輝度フラッシュ");
        }

        // 3. フラッシュライト（スマートフォン向け）
        let flash_ok = (0..3).fold(false, |_, _| {
            let on = new_command(&adb)
                .args(["-s", &device, "shell", "cmd", "flashlight", "enable"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            std::thread::sleep(Duration::from_millis(400));
            new_command(&adb)
                .args(["-s", &device, "shell", "cmd", "flashlight", "disable"])
                .output().ok();
            std::thread::sleep(Duration::from_millis(300));
            on
        });
        if flash_ok { methods.push("フラッシュライト"); }

        // 4. バイブレーション（振動パターン3回）
        let vib_ok = [
            // Android 12+: vibrator_manager（PICO対応）
            vec!["-s", &device, "shell", "cmd", "vibrator_manager", "synced", "oneshot", "300", "255"],
            // Android 8-11: vibrator_compat
            vec!["-s", &device, "shell", "cmd", "vibrator_compat", "vibrate", "800"],
        ].iter().any(|args| {
            if new_command(&adb).args(args).output().map(|o| o.status.success()).unwrap_or(false) {
                std::thread::sleep(Duration::from_millis(400));
                new_command(&adb).args(args).output().ok();
                std::thread::sleep(Duration::from_millis(400));
                new_command(&adb).args(args).output().ok();
                true
            } else { false }
        });
        if vib_ok { methods.push("バイブレーション"); }


        // 6. 通知バナー（VRオーバーレイに表示される場合がある）
        new_command(&adb)
            .args([
                "-s", &device,
                "shell", "cmd", "notification", "post",
                "-S", "bigtext", "-t", "ADB Installer",
                "識別中", "\u{1f4cd} このデバイスです",
            ])
            .output().ok();
        methods.push("通知");

        if methods.is_empty() {
            "識別方法が見つかりませんでした".to_string()
        } else {
            format!("識別: {}", methods.join(" + "))
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
async fn launch_app(device: String, package: String) -> Result<String, String> {
    let adb = get_adb_path();
    let output = new_command(&adb)
        .args([
            "-s", &device,
            "shell", "monkey",
            "-p", &package,
            "-c", "android.intent.category.LAUNCHER",
            "1",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() && !stdout.contains("error") && !stderr.contains("error") {
        Ok(format!("起動: {}", package))
    } else {
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

// ─── ファイルエクスプローラー ────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub symlink_target: Option<String>,
    pub size: Option<u64>,
    pub modified: Option<String>,
    pub permissions: Option<String>,
}

#[tauri::command]
async fn list_files(device: String, path: String) -> Result<Vec<FileEntry>, String> {
    let adb = get_adb_path();
    let raw = run_adb_shell(&adb, &device, &["ls", "-la", "--color=never", &path]);
    let mut entries = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("total") { continue; }

        // split_whitespace で列間の複数スペースを正しく処理
        let parts: Vec<&str> = line.split_whitespace().collect();
        // 最低8フィールド: perms links user group size date time name
        if parts.len() < 8 { continue; }

        let perms = parts[0];
        let is_dir     = perms.starts_with('d');
        let is_symlink = perms.starts_with('l');
        let size: Option<u64> = parts[4].parse().ok();
        let modified = Some(format!("{} {}", parts[5], parts[6]));

        // Android によっては日時後にタイムゾーン (+0000/-0800) が入る
        // 形式: perms links user group size date time [tz] name...
        let name_start = if parts.len() >= 9 {
            let tz = parts[7];
            let is_tz = tz.len() == 5
                && (tz.starts_with('+') || tz.starts_with('-'))
                && tz[1..].chars().all(|c| c.is_ascii_digit());
            if is_tz { 8 } else { 7 }
        } else {
            7
        };

        if name_start >= parts.len() { continue; }
        let raw_name = parts[name_start..].join(" ");
        if raw_name == "." || raw_name == ".." { continue; }

        // symlink: "name -> target" → name と target を分離
        let (name, symlink_target) = if is_symlink {
            if let Some((n, t)) = raw_name.split_once(" -> ") {
                (n.trim().to_string(), Some(t.trim().to_string()))
            } else {
                (raw_name.clone(), None)
            }
        } else {
            (raw_name.clone(), None)
        };

        let full_path = if path.ends_with('/') {
            format!("{}{}", path, name)
        } else {
            format!("{}/{}", path, name)
        };
        entries.push(FileEntry {
            name,
            path: full_path,
            is_dir,
            is_symlink,
            symlink_target,
            size,
            modified,
            permissions: Some(perms.to_string()),
        });
    }
    // ディレクトリ先、名前順
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
async fn delete_path(device: String, path: String) -> Result<String, String> {
    let adb = get_adb_path();
    let output = new_command(&adb)
        .args(["-s", &device, "shell", "rm", "-rf", &path])
        .output()
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() || stderr.is_empty() {
        Ok(format!("削除完了: {}", path))
    } else {
        Err(stderr)
    }
}

/// 複数ファイルをまとめてアップロード
#[tauri::command]
async fn push_files(device: String, local_paths: Vec<String>, remote_dir: String) -> Result<String, String> {
    let adb = get_adb_path();
    let mut args = vec!["-s".to_string(), device, "push".to_string()];
    let count = local_paths.len();
    args.extend(local_paths);
    args.push(remote_dir);
    let output = new_command(&adb)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(format!("アップロード完了: {} ファイル", count))
    } else {
        Err(stderr)
    }
}

/// 動画等をtempに引き出してローカルパスを返す（外部アプリで開くため）
#[tauri::command]
async fn pull_to_tmp(device: String, remote_path: String) -> Result<String, String> {
    let adb = get_adb_path();
    let file_name = remote_path.rsplit('/').next().unwrap_or("file").to_string();
    let tmp = std::env::temp_dir().join(&file_name);
    let output = new_command(&adb)
        .args(["-s", &device, "pull", &remote_path, tmp.to_str().unwrap()])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(tmp.to_string_lossy().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
async fn pull_file(device: String, remote_path: String) -> Result<String, String> {
    let adb = get_adb_path();
    let file_name = remote_path.split('/').last().unwrap_or("file").to_string();
    let local_dir = dirs::download_dir()
        .or_else(|| dirs::home_dir())
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    let local_path = local_dir.join(&file_name);
    let output = new_command(&adb)
        .args(["-s", &device, "pull", &remote_path, local_path.to_str().unwrap()])
        .output()
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(format!("ダウンロード完了: {}", local_path.display()))
    } else {
        Err(stderr)
    }
}

#[tauri::command]
async fn push_file(device: String, local_path: String, remote_dir: String) -> Result<String, String> {
    let adb = get_adb_path();
    let output = new_command(&adb)
        .args(["-s", &device, "push", &local_path, &remote_dir])
        .output()
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        Ok(format!("アップロード完了: {}", stdout))
    } else {
        Err(stderr)
    }
}

/// テキスト・画像をbase64で返す（プレビュー用）
#[tauri::command]
async fn preview_file(device: String, remote_path: String) -> Result<serde_json::Value, String> {
    let adb = get_adb_path();
    let ext = remote_path.rsplit('.').next().unwrap_or("").to_lowercase();
    let is_image = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp");
    let is_text  = matches!(ext.as_str(), "txt" | "log" | "json" | "xml" | "csv" | "md" | "yaml" | "yml" | "html" | "js" | "ts" | "py" | "sh" | "toml" | "cfg" | "ini");

    if is_text {
        let content = run_adb_shell(&adb, &device, &["cat", &remote_path]);
        return Ok(serde_json::json!({ "type": "text", "content": content }));
    }

    if is_image {
        // tempファイルに引き出してbase64化
        let tmp = std::env::temp_dir().join(
            remote_path.rsplit('/').next().unwrap_or("preview.png")
        );
        let ok = new_command(&adb)
            .args(["-s", &device, "pull", &remote_path, tmp.to_str().unwrap()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            if let Ok(bytes) = std::fs::read(&tmp) {
                let b64 = base64_encode(&bytes);
                let mime = match ext.as_str() {
                    "jpg" | "jpeg" => "image/jpeg",
                    "gif"          => "image/gif",
                    "webp"         => "image/webp",
                    "bmp"          => "image/bmp",
                    _              => "image/png",
                };
                let _ = std::fs::remove_file(&tmp);
                return Ok(serde_json::json!({ "type": "image", "mime": mime, "data": b64 }));
            }
        }
        return Err("画像の取得に失敗しました".to_string());
    }

    Ok(serde_json::json!({ "type": "unsupported" }))
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[(b0 >> 2)] as char);
        out.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 0x3f] as char } else { '=' });
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn restart_adb_server() -> Result<String, String> {
    let adb = get_adb_path();

    reset_adb_server(&adb);

    // adb devices で起動確認
    let check = new_command(&adb)
        .arg("devices")
        .output()
        .map_err(|e| e.to_string())?;

    let out = String::from_utf8_lossy(&check.stdout).trim().to_string();
    if check.status.success() && out.contains("List of devices") {
        Ok("adbサーバーを再起動しました".to_string())
    } else {
        Err("adbサーバーの起動確認に失敗しました".to_string())
    }
}

#[tauri::command]
async fn pair_device(ip: String, port: u16, code: String) -> Result<String, String> {
    let adb = get_adb_path();
    let address = format!("{}:{}", ip, port);
    let output = new_command(&adb)
        .args(["pair", &address, &code])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if stdout.contains("Successfully") || stdout.contains("success") {
        Ok(stdout)
    } else {
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

#[tauri::command]
async fn get_usb_devices() -> Vec<Device> {
    let adb = get_adb_path();
    let output = match new_command(&adb).args(["devices", "-l"]).output() {
        Ok(o) => o,
        Err(_) => return vec![],
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = vec![];

    for line in stdout.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            let address = parts[0].to_string();
            // USB devices don't have ":" in the serial (WiFi ones do, e.g. 192.168.x.x:5555)
            if address.contains(':') {
                continue;
            }
            let state = parts[1].to_string();
            let model = parts[2..]
                .iter()
                .find(|p| p.starts_with("model:"))
                .map(|p| p.replace("model:", "").replace('_', " "));
            // USBデバイス: シリアル=アドレス、メーカー・バッテリーはgetpropで取得
            let serial = Some(address.clone());
            let mfr_raw = run_adb_shell(&adb, &address, &["getprop", "ro.product.manufacturer"]);
            let manufacturer = { let v = mfr_raw.trim().to_string(); if v.is_empty() { None } else { Some(v) } };
            let device_type = Some(detect_device_type(
                manufacturer.as_deref().unwrap_or(""),
                model.as_deref().unwrap_or(""),
            ).to_string());
            let (battery, charging) = get_battery(&adb, &address);
            devices.push(Device { address, state, model, serial, manufacturer, device_type, battery, charging });
        }
    }

    devices
}

#[tauri::command]
async fn enable_tcpip(device: String, port: u16) -> Result<String, String> {
    let adb = get_adb_path();
    let port_str = port.to_string();
    let output = new_command(&adb)
        .args(["-s", &device, "tcpip", &port_str])
        .output()
        .map_err(|e| format!("adb not found: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    // adb tcpip often writes to stderr; combine both for diagnostics
    let combined = [stdout.as_str(), stderr.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" / ");

    if output.status.success() {
        Ok(if combined.is_empty() {
            format!("restarting in TCP mode port: {}", port)
        } else {
            combined
        })
    } else {
        Err(if combined.is_empty() {
            "unknown error".to_string()
        } else {
            combined
        })
    }
}

fn parse_ip_from_inet_line(line: &str) -> Option<String> {
    // "inet 192.168.x.x/24 ..." or "inet addr:192.168.x.x ..."
    let line = line.trim();
    if line.starts_with("inet ") {
        // ip addr style: "inet 192.168.x.x/24"
        let ip = line
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("");
        if !ip.is_empty() && ip != "127.0.0.1" && !ip.starts_with("169.254") {
            return Some(ip.to_string());
        }
    } else if line.contains("inet addr:") {
        // ifconfig style: "inet addr:192.168.x.x  Bcast:..."
        let ip = line
            .split("inet addr:")
            .nth(1)
            .unwrap_or("")
            .split_whitespace()
            .next()
            .unwrap_or("");
        if !ip.is_empty() && ip != "127.0.0.1" && !ip.starts_with("169.254") {
            return Some(ip.to_string());
        }
    }
    None
}

fn run_adb_shell(adb: &str, device: &str, cmd: &[&str]) -> String {
    let mut args = vec!["-s", device, "shell"];
    args.extend_from_slice(cmd);
    new_command(adb)
        .args(&args)
        .output()
        // Strip \r so \r\n line endings don't break parsing
        .map(|o| String::from_utf8_lossy(&o.stdout).replace('\r', ""))
        .unwrap_or_default()
}

#[tauri::command]
async fn diagnose_device_network(device: String) -> String {
    let adb = get_adb_path();
    let cmds: &[(&str, &[&str])] = &[
        ("ip route",         &["ip", "route"]),
        ("ip addr",          &["ip", "addr"]),
        ("ifconfig",         &["ifconfig"]),
        ("getprop dhcp.wlan0.ipaddress", &["getprop", "dhcp.wlan0.ipaddress"]),
        ("getprop dhcp.wlan0.result",    &["getprop", "dhcp.wlan0.result"]),
    ];
    let mut out = String::new();
    for (label, cmd) in cmds {
        let result = run_adb_shell(&adb, &device, cmd);
        out.push_str(&format!("=== {} ===\n{}\n", label, result.trim()));
    }
    out
}

#[tauri::command]
async fn get_device_wifi_ip(device: String) -> Result<String, String> {
    let adb = get_adb_path();

    // Method 1: ip route (most reliable - parse "src <ip>" for wlan routes)
    {
        let out = run_adb_shell(&adb, &device, &["ip", "route"]);
        for line in out.lines() {
            let lo = line.to_lowercase();
            if (lo.contains("wlan") || lo.contains("wifi") || lo.contains("wl"))
                && lo.contains("src")
            {
                if let Some(pos) = line.find("src ") {
                    let ip = line[pos + 4..].split_whitespace().next().unwrap_or("");
                    if !ip.is_empty() && ip != "127.0.0.1" && !ip.starts_with("169.254") {
                        return Ok(ip.to_string());
                    }
                }
            }
        }
    }

    // Method 2: ip addr (no -f flag, more compatible)
    {
        let out = run_adb_shell(&adb, &device, &["ip", "addr"]);
        let mut current_iface = String::new();
        for line in out.lines() {
            if line.starts_with(|c: char| c.is_ascii_digit()) {
                current_iface = line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .trim_end_matches(':')
                    .to_lowercase();
            } else if current_iface.contains("wlan")
                || current_iface.contains("wifi")
                || current_iface.contains("wl")
            {
                if let Some(ip) = parse_ip_from_inet_line(line) {
                    return Ok(ip);
                }
            }
        }
    }

    // Method 3: ifconfig wlan0 (older Android)
    {
        let out = run_adb_shell(&adb, &device, &["ifconfig", "wlan0"]);
        for line in out.lines() {
            if let Some(ip) = parse_ip_from_inet_line(line) {
                return Ok(ip);
            }
        }
    }

    // Method 4: getprop (DHCP assigned IP)
    for prop in &["dhcp.wlan0.ipaddress", "dhcp.wlan0.result"] {
        let out = run_adb_shell(&adb, &device, &["getprop", prop]);
        let ip = out.trim();
        if !ip.is_empty() && ip != "127.0.0.1" && !ip.starts_with("169.254") && ip.contains('.') {
            return Ok(ip.to_string());
        }
    }

    Err("WiFi IPが見つかりません。AndroidのWiFi接続を確認してください。".to_string())
}

fn get_scrcpy_path() -> Option<String> {
    // macOS Homebrew / Linux common paths
    let candidates = [
        "/opt/homebrew/bin/scrcpy",
        "/usr/local/bin/scrcpy",
        "/usr/bin/scrcpy",
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    // Fallback: try PATH
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = new_command(which_cmd).arg("scrcpy").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() { return Some(p); }
        }
    }
    None
}

#[tauri::command]
async fn launch_scrcpy(device: String, extra_args: Option<String>) -> Result<String, String> {
    let scrcpy = get_scrcpy_path()
        .ok_or_else(|| "scrcpy が見つかりません。brew install scrcpy でインストールしてください".to_string())?;

    // adb のパスを探して PATH に追加（GUI アプリはシェルの PATH を引き継がないため）
    let adb_path = get_adb_path();
    let adb_dir = std::path::Path::new(&adb_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string());

    let mut cmd = new_command(&scrcpy);

    // PATH を拡張して adb・scrcpy が見つかるようにする
    let current_path = std::env::var("PATH").unwrap_or_default();
    let extra_paths = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/Users/afjk/Library/Android/sdk/platform-tools",
    ];
    let mut path_dirs: Vec<String> = extra_paths.iter().map(|s| s.to_string()).collect();
    if let Some(dir) = adb_dir {
        path_dirs.push(dir);
    }
    path_dirs.push(current_path);
    let new_path = path_dirs.join(":");
    cmd.env("PATH", &new_path);

    // ANDROID_HOME も設定
    if std::env::var("ANDROID_HOME").is_err() {
        let home = std::env::var("HOME").unwrap_or_default();
        cmd.env("ANDROID_HOME", format!("{}/Library/Android/sdk", home));
    }

    if !device.is_empty() {
        cmd.args(["-s", &device]);
    }
    if let Some(args) = extra_args {
        for arg in args.split_whitespace() {
            cmd.arg(arg);
        }
    }

    cmd.spawn().map_err(|e| e.to_string())?;
    Ok("scrcpy を起動しました".to_string())
}

#[tauri::command]
async fn get_scrcpy_version() -> Result<String, String> {
    let scrcpy = get_scrcpy_path().ok_or_else(|| "not found".to_string())?;
    let out = new_command(&scrcpy).arg("--version").output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("unknown").to_string())
}

#[tauri::command]
async fn get_adb_version() -> Result<String, String> {
    let adb = get_adb_path();
    let output = new_command(&adb)
        .arg("version")
        .output()
        .map_err(|e| format!("adb not found: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("unknown")
        .to_string())
}

#[tauri::command]
async fn install_scrcpy(app: tauri::AppHandle) -> Result<String, String> {
    // brew のパスを探す
    let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|s| s.to_string())
        .ok_or_else(|| "Homebrew が見つかりません。https://brew.sh からインストールしてください".to_string())?;

    let mut child = new_command(&brew)
        .arg("install")
        .arg("scrcpy")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("brew 起動失敗: {}", e))?;

    // stdout と stderr をマージしてイベントで流す
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_out = app.clone();
    let app_err = app.clone();

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_out.emit("brew_install_line", line);
        }
    });
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_err.emit("brew_install_line", line);
        }
    });

    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        let _ = app.emit("brew_install_done", "success");
        Ok("scrcpy のインストールが完了しました".to_string())
    } else {
        let _ = app.emit("brew_install_done", "error");
        Err("brew install scrcpy が失敗しました".to_string())
    }
}

#[tauri::command]
async fn run_terminal_command(device: String, command: String) -> Result<String, String> {
    let adb = get_adb_path();
    let args: Vec<String> = shell_words(&command);
    // If device is specified, prepend -s <device>
    let mut full_args: Vec<String> = Vec::new();
    if !device.is_empty() {
        full_args.push("-s".to_string());
        full_args.push(device);
    }
    full_args.extend(args);
    let output = new_command(&adb)
        .args(&full_args)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).replace('\r', "");
    let stderr = String::from_utf8_lossy(&output.stderr).replace('\r', "");
    let combined = if stdout.is_empty() { stderr } else if stderr.is_empty() { stdout } else { format!("{}{}", stdout, stderr).into() };
    Ok(combined.trim_end().to_string())
}

fn shell_words(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut quote_char = ' ';
    for c in s.chars() {
        match c {
            '"' | '\'' if !in_quote => { in_quote = true; quote_char = c; }
            c2 if in_quote && c2 == quote_char => { in_quote = false; }
            ' ' if !in_quote => {
                if !current.is_empty() { args.push(current.clone()); current.clear(); }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() { args.push(current); }
    args
}

// ── Logcat streaming ────────────────────────────────────────────────────────

static LOGCAT_CHILD: std::sync::OnceLock<Arc<Mutex<Option<std::process::Child>>>> =
    std::sync::OnceLock::new();

fn logcat_child_handle() -> &'static Arc<Mutex<Option<std::process::Child>>> {
    LOGCAT_CHILD.get_or_init(|| Arc::new(Mutex::new(None)))
}

fn stop_logcat_inner() {
    if let Ok(mut guard) = logcat_child_handle().lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
async fn start_logcat(
    app: tauri::AppHandle,
    device: String,
    filter: String,
) -> Result<(), String> {
    stop_logcat_inner();

    let adb = get_adb_path();
    let mut args: Vec<String> = vec!["-s".to_string(), device, "logcat".to_string(), "-v".to_string(), "time".to_string()];
    // Add user filter if provided (e.g. "*:W" or "MyTag:D")
    if !filter.is_empty() {
        for part in filter.split_whitespace() {
            args.push(part.to_string());
        }
    }

    let mut child = new_command(&adb)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().ok_or("stdout unavailable")?;
    *logcat_child_handle().lock().unwrap() = Some(child);

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => { let _ = app.emit("logcat_line", l); }
                Err(_) => break,
            }
        }
        let _ = app.emit("logcat_stopped", ());
    });

    Ok(())
}

#[tauri::command]
async fn stop_logcat() -> Result<(), String> {
    stop_logcat_inner();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_network,
            get_devices,
            get_usb_devices,
            enable_tcpip,
            get_device_wifi_ip,
            diagnose_device_network,
            connect_device,
            disconnect_device,
            get_apk_package,
            get_apk_info,
            install_apk,
            uninstall_apk,
            launch_app,
            identify_device,
            restart_adb_server,
            list_files,
            delete_path,
            pull_file,
            pull_to_tmp,
            push_file,
            push_files,
            preview_file,
            pair_device,
            get_adb_version,
            launch_scrcpy,
            get_scrcpy_version,
            install_scrcpy,
            run_terminal_command,
            start_logcat,
            stop_logcat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_device_type_vr() {
        assert_eq!(detect_device_type("Pico", "A3"), "vr");
        assert_eq!(detect_device_type("Meta", "Quest 3"), "vr");
        assert_eq!(detect_device_type("Oculus", "Go"), "vr");
        assert_eq!(detect_device_type("Unknown", "pico neo"), "vr");
        assert_eq!(detect_device_type("Unknown", "quest 2"), "vr");
    }

    #[test]
    fn test_detect_device_type_tv() {
        assert_eq!(detect_device_type("Google", "ADT-3"), "tv");
    }

    #[test]
    fn test_detect_device_type_tablet() {
        assert_eq!(detect_device_type("Samsung", "SM-T870"), "tablet");
        assert_eq!(detect_device_type("Xiaomi", "Pad 6"), "tablet");
        assert_eq!(detect_device_type("Lenovo", "Tab P12"), "tablet");
    }

    #[test]
    fn test_detect_device_type_phone() {
        assert_eq!(detect_device_type("Samsung", "Galaxy S24"), "phone");
        assert_eq!(detect_device_type("Google", "Pixel 8"), "phone");
        assert_eq!(detect_device_type("OnePlus", "12R"), "phone");
    }

    #[test]
    fn test_parse_battery_from_dumpsys() {
        // Simulate parsing battery info line by line
        let output = "  level: 85\n  status: 2\n";
        let mut level: Option<u8> = None;
        let mut charging: Option<bool> = None;
        for line in output.lines() {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("level:") {
                level = v.trim().parse().ok();
            } else if let Some(v) = line.strip_prefix("status:") {
                charging = v.trim().parse::<u8>().ok().map(|s| s == 2 || s == 5);
            }
        }
        assert_eq!(level, Some(85));
        assert_eq!(charging, Some(true));
    }

    #[test]
    fn test_parse_battery_not_charging() {
        let output = "  level: 42\n  status: 3\n";
        let mut level: Option<u8> = None;
        let mut charging: Option<bool> = None;
        for line in output.lines() {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("level:") {
                level = v.trim().parse().ok();
            } else if let Some(v) = line.strip_prefix("status:") {
                charging = v.trim().parse::<u8>().ok().map(|s| s == 2 || s == 5);
            }
        }
        assert_eq!(level, Some(42));
        assert_eq!(charging, Some(false));
    }
}
