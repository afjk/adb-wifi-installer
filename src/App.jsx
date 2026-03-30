import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./App.css";

const STATUS = {
  IDLE: "idle",
  SCANNING: "scanning",
  INSTALLING: "installing",
  PAIRING: "pairing",
  TCPIP: "tcpip",
};

// ─── ファイルエクスプローラー (インライン) ────────────────────────────────
function FileExplorer({ device }) {
  const [path, setPath] = useState("/storage/emulated/0");
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState("");
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState("/storage/emulated/0");
  const pathInputRef = useRef(null);

  const load = async (p) => {
    setLoading(true);
    setPreview(null);
    setEditingPath(false);
    try {
      const entries = await invoke("list_files", { device, path: p });
      setFiles(entries);
      setPath(p);
      setPathInput(p);
    } catch (e) {
      setStatus("エラー: " + e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load("/storage/emulated/0"); }, [device]);

  const breadcrumbs = path.split("/").filter(Boolean);
  const navigateTo = (i) => load("/" + breadcrumbs.slice(0, i + 1).join("/"));

  const handleClick = (f) => {
    if (f.is_dir) { load(f.path); return; }
    if (f.is_symlink && f.symlink_target) { load(f.symlink_target); return; }
    handlePreview(f);
  };

  const handlePreview = async (f) => {
    const ext = f.name.split(".").pop().toLowerCase();
    if (["mp4","mov","avi","mkv","webm"].includes(ext)) {
      setStatus("動画を取得中...");
      try {
        const local = await invoke("pull_to_tmp", { device, remotePath: f.path });
        await openPath(local);
        setStatus("✅ 外部アプリで開きました");
      } catch (e) { setStatus("❌ " + e); }
      return;
    }
    setPreview({ loading: true, name: f.name });
    try {
      const result = await invoke("preview_file", { device, remotePath: f.path });
      setPreview({ ...result, name: f.name, path: f.path });
    } catch (e) {
      setPreview({ type: "error", name: f.name, content: String(e) });
    }
  };

  const handleDownload = async (f) => {
    setStatus((f.is_dir ? "📁 ダウンロード中: " : "ダウンロード中: ") + f.name);
    try {
      setStatus("✅ " + await invoke("pull_file", { device, remotePath: f.path }));
    } catch (e) { setStatus("❌ " + e); }
  };

  const handleUpload = async () => {
    const { open: dlg } = await import("@tauri-apps/plugin-dialog");
    const selected = await dlg({ multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setStatus(`アップロード中... (${paths.length} ファイル)`);
    try {
      setStatus("✅ " + await invoke("push_files", { device, localPaths: paths, remoteDir: path }));
      load(path);
    } catch (e) { setStatus("❌ " + e); }
  };

  const handleDelete = async (f) => {
    if (!window.confirm(`削除しますか?\n${f.path}`)) return;
    setStatus("削除中: " + f.name);
    try {
      setStatus("✅ " + await invoke("delete_path", { device, path: f.path }));
      load(path);
    } catch (e) { setStatus("❌ " + e); }
  };

  const goUp = () => {
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) return;
    load("/" + parts.slice(0, -1).join("/") || "/");
  };

  const fmt = (size) => {
    if (!size) return "";
    if (size < 1024) return size + "B";
    if (size < 1024 ** 2) return (size / 1024).toFixed(1) + "K";
    if (size < 1024 ** 3) return (size / 1024 ** 2).toFixed(1) + "M";
    return (size / 1024 ** 3).toFixed(1) + "G";
  };

  return (
    <div className="fe-inline">
      {/* パンくず */}
      <div className="fe-topbar">
        <div
          className="fe-breadcrumb"
          onClick={!editingPath ? () => { setPathInput(path); setEditingPath(true); setTimeout(() => pathInputRef.current?.select(), 50); } : undefined}
        >
          {editingPath ? (
            <input
              ref={pathInputRef}
              className="fe-path-input"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") load(pathInput.trim() || "/");
                if (e.key === "Escape") setEditingPath(false);
              }}
              onBlur={() => setTimeout(() => setEditingPath(false), 150)}
              autoFocus
            />
          ) : (
            <>
              <span className="fe-bc-item" onClick={e => { e.stopPropagation(); load("/"); }}>/</span>
              {breadcrumbs.map((crumb, i) => (
                <span key={i}>
                  <span className="fe-bc-sep">/</span>
                  <span className="fe-bc-item" onClick={e => { e.stopPropagation(); navigateTo(i); }}>{crumb}</span>
                </span>
              ))}
              <span className="fe-bc-hint"> ✎</span>
            </>
          )}
        </div>
        <div className="fe-topbar-actions">
          <button className="btn btn-ghost btn-xs" onClick={handleUpload}>⬆ アップロード</button>
          <button className="btn btn-ghost btn-xs" onClick={() => load(path)}>↻</button>
        </div>
      </div>

      <div className="fe-body">
        <div className="fe-list">
          {path !== "/" && (
            <div className="fe-row fe-dir" onClick={goUp}>
              <span className="fe-icon">📁</span>
              <span className="fe-name">..</span>
            </div>
          )}
          {loading && <div className="fe-loading">読み込み中...</div>}
          {!loading && files.map((f, i) => (
            <div key={i} className={`fe-row ${f.is_dir ? "fe-dir" : f.is_symlink ? "fe-symlink" : "fe-file"}`}>
              <span className="fe-icon" onClick={() => handleClick(f)}>
                {f.is_symlink ? "🔗" : f.is_dir ? "📁" : getFileIcon(f.name)}
              </span>
              <span className="fe-name" onClick={() => handleClick(f)} title={f.path}>{f.name}</span>
              <span className="fe-size">{!f.is_dir ? fmt(f.size) : ""}</span>
              <span className="fe-date">{f.modified || ""}</span>
              <div className="fe-actions">
                {!f.is_dir && !f.is_symlink && (
                  <button className="btn btn-ghost btn-xs" onClick={() => handlePreview(f)} title="プレビュー">👁</button>
                )}
                {!f.is_symlink && (
                  <button className="btn btn-ghost btn-xs" onClick={() => handleDownload(f)} title="ダウンロード">⬇</button>
                )}
                <button className="btn btn-ghost btn-xs fe-del" onClick={() => handleDelete(f)} title="削除">🗑</button>
              </div>
            </div>
          ))}
        </div>

        {preview && (
          <div className="fe-preview">
            <div className="fe-preview-header">
              <span>{preview.name}</span>
              {preview.path && (
                <button className="btn btn-ghost btn-xs" onClick={() => handleDownload({ name: preview.name, path: preview.path })}>⬇ DL</button>
              )}
              <button className="btn btn-ghost btn-xs" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className="fe-preview-body">
              {preview.loading && <div className="fe-loading">読み込み中...</div>}
              {preview.type === "text" && <pre className="fe-text-preview">{preview.content}</pre>}
              {preview.type === "image" && <img src={`data:${preview.mime};base64,${preview.data}`} className="fe-image-preview" alt={preview.name} />}
              {preview.type === "unsupported" && <div className="fe-unsupported">プレビュー非対応</div>}
              {preview.type === "error" && <div className="fe-unsupported">❌ {preview.content}</div>}
            </div>
          </div>
        )}
      </div>

      {status && <div className="fe-status">{status}</div>}
    </div>
  );
}

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (["png","jpg","jpeg","gif","webp","bmp"].includes(ext)) return "🖼";
  if (["mp4","mov","avi","mkv","webm"].includes(ext)) return "🎬";
  if (["mp3","wav","ogg","aac","flac"].includes(ext)) return "🎵";
  if (["apk"].includes(ext)) return "📦";
  if (["zip","tar","gz","7z","rar"].includes(ext)) return "🗜";
  if (["json","xml","yaml","yml","toml"].includes(ext)) return "⚙";
  return "📄";
}

function logcatLevel(line) {
  const m = line.match(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ +\d+ +\d+ ([VDIWEF]) /);
  return m ? m[1].toLowerCase() : "v";
}

function typeIcon(type) {
  if (type === "vr") return "🥽";
  if (type === "tv") return "📺";
  return "📱";
}

// ─── デバイスカード（サイドバー用） ─────────────────────────────────────
function DeviceCard({ device, selected, onClick }) {
  const connected = device.state === "device";
  return (
    <div
      className={`device-card ${selected ? "selected" : ""} ${connected ? "connected" : "offline"}`}
      onClick={onClick}
    >
      <span className="dc-icon">{typeIcon(device.device_type)}</span>
      <div className="dc-info">
        <span className="dc-name">{device.model || device.address}</span>
        <span className="dc-addr">{device.address}</span>
      </div>
      <div className="dc-right">
        {device.battery != null && (
          <span className={`dc-battery${device.battery <= 20 ? " low" : ""}`}>
            {device.charging ? "⚡" : "🔋"}{device.battery}%
          </span>
        )}
        <span className={`dc-dot ${connected ? "on" : "off"}`} />
      </div>
    </div>
  );
}

// ─── APKパネル ───────────────────────────────────────────────────────────
function ApkPanel({ device, apkPath, apkPackage, apkInfo, installedPackage, dragOver,
  onPickApk, onClearApk, onInstall, onUninstall, onLaunch, onSetPackage, installProgress, busy }) {

  const [editingPkg, setEditingPkg] = useState(false);
  const [pkgInput, setPkgInput] = useState(installedPackage || "");

  useEffect(() => { setPkgInput(installedPackage || ""); }, [installedPackage]);

  const submitPkg = () => {
    if (pkgInput.trim()) onSetPackage(device, pkgInput.trim());
    setEditingPkg(false);
  };

  return (
    <div className="apk-panel">
      {/* Drop zone */}
      <div className={`apk-drop${dragOver ? " drag-over" : ""}`} onClick={onPickApk}>
        {apkPath ? (
          <div className="apk-selected">
            <div className="apk-sel-row">
              <span className="apk-icon">📦</span>
              <div className="apk-sel-info">
                <span className="apk-filename">{apkPath.split(/[/\\]/).pop()}</span>
                {apkPackage && <span className="apk-package">{apkPackage}</span>}
              </div>
              <button className="btn btn-ghost btn-xs" onClick={e => { e.stopPropagation(); onClearApk(); }}>✕</button>
            </div>
            {apkInfo && (
              <div className="apk-details">
                <div className="apk-detail-row">
                  <span className="apk-dl">バージョン</span>
                  <span>{apkInfo.version_name} <span className="muted">(build {apkInfo.version_code})</span></span>
                </div>
                {apkInfo.label && <div className="apk-detail-row"><span className="apk-dl">アプリ名</span><span>{apkInfo.label}</span></div>}
                {apkInfo.min_sdk && <div className="apk-detail-row"><span className="apk-dl">SDK</span><span>min {apkInfo.min_sdk} / target {apkInfo.target_sdk}</span></div>}
                {apkInfo.signature_subject && (
                  <div className="apk-detail-row">
                    <span className="apk-dl">署名</span>
                    <span className={apkInfo.debug_signed ? "warn-text" : "ok-text"}>
                      {apkInfo.debug_signed ? "⚠️ Debug" : "✅ Release"} — {apkInfo.signature_subject}
                    </span>
                  </div>
                )}
                {apkInfo.signature_sha256 && (
                  <div className="apk-detail-row">
                    <span className="apk-dl">SHA-256</span>
                    <span className="mono muted small">{apkInfo.signature_sha256}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="apk-dropzone">
            <span className="apk-drop-icon">📦</span>
            <span className="apk-drop-text">{dragOver ? "ここにドロップ！" : "ドロップ または クリックして選択"}</span>
          </div>
        )}
      </div>

      {/* Install progress */}
      {installProgress && installProgress.device === device && (
        <div className="install-progress">
          <div className="install-phase">
            {installProgress.phase === "uploading"
              ? `アップロード中... ${installProgress.progress}%`
              : "インストール中..."}
          </div>
          <div className="progress-bar-bg">
            <div className="progress-bar-fill" style={{ width: `${installProgress.progress}%` }} />
          </div>
        </div>
      )}

      {/* Install button */}
      <button
        className="btn btn-success btn-full"
        onClick={() => onInstall(device)}
        disabled={!apkPath || busy}
      >
        {busy ? "インストール中..." : "インストール"}
      </button>

      {/* Installed package */}
      {installedPackage && !editingPkg ? (
        <div className="installed-pkg">
          <div className="installed-pkg-row">
            <span className="installed-pkg-name">{installedPackage}</span>
            <button className="btn btn-ghost btn-xs" onClick={() => { setPkgInput(installedPackage); setEditingPkg(true); }}>✎</button>
          </div>
          <div className="installed-pkg-actions">
            <button className="btn btn-launch" onClick={() => onLaunch(device, installedPackage)}>▶ 起動</button>
            <button className="btn btn-danger" onClick={() => onUninstall(device, installedPackage)}>アンインストール</button>
          </div>
        </div>
      ) : installedPackage && editingPkg ? (
        <div className="pkg-edit-row">
          <input
            className="input"
            value={pkgInput}
            onChange={e => setPkgInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submitPkg()}
            autoFocus
          />
          <button className="btn btn-primary btn-sm" onClick={submitPkg}>OK</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setEditingPkg(false)}>✕</button>
        </div>
      ) : (
        <button className="btn btn-ghost btn-sm" onClick={() => { setPkgInput(""); setEditingPkg(true); }}>
          + パッケージ名を入力して起動
        </button>
      )}
      {!installedPackage && editingPkg && (
        <div className="pkg-edit-row">
          <input
            className="input"
            value={pkgInput}
            placeholder="com.example.app"
            onChange={e => setPkgInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submitPkg()}
            autoFocus
          />
          <button className="btn btn-primary btn-sm" onClick={submitPkg}>OK</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setEditingPkg(false)}>✕</button>
        </div>
      )}
    </div>
  );
}

// ─── メインアプリ ────────────────────────────────────────────────────────
export default function App() {
  const [status, setStatus] = useState(STATUS.IDLE);
  const [devices, setDevices] = useState([]);
  const [usbDevices, setUsbDevices] = useState([]);
  const [scanResults, setScanResults] = useState([]);
  const [apkPath, setApkPath] = useState("");
  const [apkPackage, setApkPackage] = useState("");
  const [apkInfo, setApkInfo] = useState(null);
  const [log, setLog] = useState([]);
  const [adbVersion, setAdbVersion] = useState("");
  const [scrcpyVersion, setScrcpyVersion] = useState("");
  const [pairModal, setPairModal] = useState(false);
  const [pairForm, setPairForm] = useState({ ip: "", port: "37000", code: "" });
  const [manualIp, setManualIp] = useState("");
  const [installProgress, setInstallProgress] = useState(null);
  const [termInput, setTermInput] = useState("");
  const [termHistory, setTermHistory] = useState([]);
  const termOutputRef = useRef(null);
  const termInputRef = useRef(null);
  const [logcatLines, setLogcatLines] = useState([]);
  const [logcatRunning, setLogcatRunning] = useState(false);
  const [logcatFilter, setLogcatFilter] = useState("");
  const logcatRef = useRef(null);
  const MAX_LOGCAT_LINES = 500;
  const [dragOver, setDragOver] = useState(false);

  // 新レイアウト用state
  const [selectedAddr, setSelectedAddr] = useState(null);
  const [deviceTab, setDeviceTab] = useState("install");
  const [logOpen, setLogOpen] = useState(false);

  const [installedPackages, setInstalledPackages] = useState(() => {
    try { return JSON.parse(localStorage.getItem("installedPackages") || "{}"); }
    catch { return {}; }
  });

  useEffect(() => {
    localStorage.setItem("installedPackages", JSON.stringify(installedPackages));
  }, [installedPackages]);

  useEffect(() => {
    let unlisten;
    listen("install_progress", (e) => {
      const { device, progress, phase } = e.payload;
      setInstallProgress(phase === "done" ? null : { device, progress, phase });
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  useEffect(() => {
    let unlistenLine, unlistenStop;
    listen("logcat_line", (e) => {
      setLogcatLines(prev => {
        const next = [...prev, e.payload];
        return next.length > MAX_LOGCAT_LINES ? next.slice(-MAX_LOGCAT_LINES) : next;
      });
      setTimeout(() => { if (logcatRef.current) logcatRef.current.scrollTop = logcatRef.current.scrollHeight; }, 20);
    }).then(fn => { unlistenLine = fn; });
    listen("logcat_stopped", () => setLogcatRunning(false)).then(fn => { unlistenStop = fn; });
    return () => { unlistenLine?.(); unlistenStop?.(); };
  }, []);

  const addLog = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString();
    setLog(prev => [...prev.slice(-199), { time, msg, type }]);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const [devs, usb] = await Promise.all([invoke("get_devices"), invoke("get_usb_devices")]);
      setDevices(devs);
      setUsbDevices(usb);
    } catch (e) { addLog("デバイス一覧取得失敗: " + e, "error"); }
  }, [addLog]);

  useEffect(() => {
    invoke("get_adb_version").then(setAdbVersion).catch(() => setAdbVersion("adb not found"));
    invoke("get_scrcpy_version").then(setScrcpyVersion).catch(() => setScrcpyVersion(""));
    refreshDevices();
    const iv = setInterval(refreshDevices, 5000);
    return () => clearInterval(iv);
  }, [refreshDevices]);

  // Drag & Drop
  useEffect(() => {
    let unlisten;
    getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "over") { setDragOver(true); }
      else if (e.payload.type === "drop") {
        setDragOver(false);
        const apks = (e.payload.paths || []).filter(p => p.endsWith(".apk"));
        if (apks.length > 0) applyApkPath(apks[0]);
      } else { setDragOver(false); }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  const applyApkPath = useCallback(async (path) => {
    if (!path.endsWith(".apk")) { addLog("APKファイルを選択してください", "error"); return; }
    setApkPath(path);
    setApkPackage("");
    setApkInfo(null);
    addLog("APK選択: " + path);
    try {
      const info = await invoke("get_apk_info", { apkPath: path });
      setApkInfo(info);
      setApkPackage(info.package);
      addLog(`パッケージ: ${info.package} v${info.version_name} (${info.version_code})`, "info");
      if (info.debug_signed) addLog("⚠️ デバッグ署名のAPKです", "warn");
    } catch (e) { addLog("APK情報取得失敗: " + e, "warn"); }
  }, [addLog]);

  const handlePickApk = async () => {
    const selected = await open({ filters: [{ name: "APK", extensions: ["apk"] }], multiple: false });
    if (selected) await applyApkPath(selected);
  };

  const handleScan = async () => {
    setStatus(STATUS.SCANNING);
    setScanResults([]);
    addLog("$ (TCP port 5555 scan on local subnet)", "cmd");
    addLog("ネットワークスキャン開始...");
    try {
      const found = await invoke("scan_network");
      setScanResults(found);
      addLog(found.length === 0
        ? "ADB対応デバイスが見つかりませんでした"
        : `${found.length}台発見: ${found.join(", ")}`,
        found.length === 0 ? "warn" : "success");
    } catch (e) { addLog("スキャン失敗: " + e, "error"); }
    finally { setStatus(STATUS.IDLE); }
  };

  const handleConnect = async (ip, port = 5555) => {
    addLog(`$ adb connect ${ip}:${port}`, "cmd");
    try {
      const result = await invoke("connect_device", { ip, port });
      addLog(result, "success");
      await refreshDevices();
    } catch (e) { addLog("接続失敗: " + e, "error"); }
  };

  const handleConnectAddress = async (address) => {
    const [ip, portStr] = address.includes(":") ? address.split(":") : [address, "5555"];
    await handleConnect(ip, parseInt(portStr) || 5555);
  };

  const handleDisconnect = async (address) => {
    addLog(`$ adb disconnect ${address}`, "cmd");
    try {
      addLog(await invoke("disconnect_device", { address }), "warn");
      if (selectedAddr === address) setSelectedAddr(null);
      await refreshDevices();
    } catch (e) { addLog("切断失敗: " + e, "error"); }
  };

  const handleEnableTcpip = async (device) => {
    setStatus(STATUS.TCPIP);
    addLog(`$ adb -s ${device.address} tcpip 5555`, "cmd");
    try {
      addLog(await invoke("enable_tcpip", { device: device.address, port: 5555 }), "success");
      try {
        const ip = await invoke("get_device_wifi_ip", { device: device.address });
        addLog(`WiFi IP: ${ip} → USBを抜いてから接続してください`, "warn");
        setManualIp(ip + ":5555");
      } catch (e) { addLog("WiFi IP取得失敗: " + e, "error"); }
    } catch (e) { addLog("TCP/IP有効化失敗: " + e, "error"); }
    finally { setStatus(STATUS.IDLE); }
  };

  const handleInstall = async (device) => {
    if (!apkPath) return;
    setStatus(STATUS.INSTALLING);
    addLog(`$ adb -s ${device} install "${apkPath}"`, "cmd");
    try {
      const result = await invoke("install_apk", { device, apkPath });
      addLog("インストール成功: " + result.message, "success");
      if (result.package) {
        addLog(`パッケージ: ${result.package}`, "info");
        setInstalledPackages(prev => ({ ...prev, [device]: result.package }));
      }
    } catch (e) { addLog("インストール失敗: " + e, "error"); }
    finally { setStatus(STATUS.IDLE); }
  };

  const handleUninstall = async (device, pkg) => {
    if (!window.confirm(`アンインストールしますか?\n${pkg}`)) return;
    addLog(`$ adb -s ${device} uninstall ${pkg}`, "cmd");
    try {
      addLog(await invoke("uninstall_apk", { device, package: pkg }), "success");
      setInstalledPackages(prev => { const n = { ...prev }; delete n[device]; return n; });
    } catch (e) { addLog("アンインストール失敗: " + e, "error"); }
  };

  const handleScrcpy = async (device) => {
    addLog(`$ scrcpy -s ${device}`, "cmd");
    try {
      addLog(await invoke("launch_scrcpy", { device, extraArgs: null }), "success");
    } catch (e) { addLog("scrcpy起動失敗: " + e, "error"); }
  };

  const handleLaunch = async (device, pkg) => {
    addLog(`$ adb -s ${device} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, "cmd");
    try { addLog(await invoke("launch_app", { device, package: pkg }), "success"); }
    catch (e) { addLog("起動失敗: " + e, "error"); }
  };

  const handleIdentify = async (device) => {
    addLog(`$ adb -s ${device} shell (brightness/flashlight/vibrator)`, "cmd");
    try { addLog(await invoke("identify_device", { device }), "success"); }
    catch (e) { addLog("識別失敗: " + e, "error"); }
  };

  const handleSetPackage = (address, pkg) => {
    setInstalledPackages(prev => ({ ...prev, [address]: pkg }));
    addLog(`パッケージ設定: ${pkg}`);
  };

  const handleRestartAdb = async () => {
    addLog("$ adb kill-server && adb start-server", "cmd");
    try {
      addLog(await invoke("restart_adb_server"), "success");
      await refreshDevices();
    } catch (e) { addLog("リセット失敗: " + e, "error"); }
  };

  const handleTermRun = async () => {
    const cmd = termInput.trim();
    if (!cmd) return;
    const prefix = selectedAddr ? `adb -s ${selectedAddr}` : "adb";
    addLog(`$ ${prefix} ${cmd}`, "cmd");
    setTermInput("");
    try {
      const output = await invoke("run_terminal_command", { device: selectedAddr || "", command: cmd });
      setTermHistory(prev => [...prev, { cmd: `${prefix} ${cmd}`, output: output || "(出力なし)" }]);
    } catch (e) {
      setTermHistory(prev => [...prev, { cmd: `${prefix} ${cmd}`, output: `エラー: ${e}` }]);
    }
    setTimeout(() => termOutputRef.current?.scrollTo(0, termOutputRef.current.scrollHeight), 50);
  };

  const handleLogcatStart = async () => {
    if (!selectedAddr) return;
    setLogcatLines([]);
    setLogcatRunning(true);
    addLog(`$ adb -s ${selectedAddr} logcat -v time ${logcatFilter}`, "cmd");
    try { await invoke("start_logcat", { device: selectedAddr, filter: logcatFilter }); }
    catch (e) { addLog("logcat起動失敗: " + e, "error"); setLogcatRunning(false); }
  };

  const handleLogcatStop = async () => {
    await invoke("stop_logcat");
    setLogcatRunning(false);
  };

  const handlePair = async () => {
    setStatus(STATUS.PAIRING);
    addLog(`$ adb pair ${pairForm.ip}:${pairForm.port}`, "cmd");
    try {
      addLog(await invoke("pair_device", { ip: pairForm.ip, port: parseInt(pairForm.port), code: pairForm.code }), "success");
      setPairModal(false);
    } catch (e) { addLog("ペアリング失敗: " + e, "error"); }
    finally { setStatus(STATUS.IDLE); }
  };

  const busy = status !== STATUS.IDLE;
  const allDevices = [...devices, ...usbDevices];
  const selectedDevice = allDevices.find(d => d.address === selectedAddr) || null;
  const installedPackage = selectedAddr ? (installedPackages[selectedAddr] || apkPackage) : "";

  return (
    <div className="app">
      {/* ─── Header ─── */}
      <header className="header">
        <h1 className="header-title">ADB WiFi Installer</h1>
        <div className="header-right">
          <button className="btn btn-ghost btn-sm" onClick={handleRestartAdb}>adbリセット</button>
          <span className="adb-version">{adbVersion}</span>
        </div>
      </header>

      <div className="main-layout">
        {/* ─── Sidebar ─── */}
        <aside className="sidebar">
          {/* WiFi devices */}
          <div className="sidebar-block">
            <div className="sidebar-block-header">
              <span className="sidebar-label">デバイス</span>
              <button className="btn btn-ghost btn-xs" onClick={refreshDevices}>↻</button>
            </div>
            {devices.length === 0 && usbDevices.length === 0 ? (
              <div className="sidebar-empty">デバイスなし</div>
            ) : (
              <>
                {devices.map(d => (
                  <DeviceCard key={d.address} device={d} selected={d.address === selectedAddr} onClick={() => setSelectedAddr(d.address)} />
                ))}
                {usbDevices.length > 0 && (
                  <>
                    <div className="sidebar-divider">USB</div>
                    {usbDevices.map(d => (
                      <DeviceCard key={d.address} device={d} selected={d.address === selectedAddr} onClick={() => setSelectedAddr(d.address)} />
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {/* Connection controls */}
          <div className="sidebar-block">
            <div className="sidebar-block-header">
              <span className="sidebar-label">接続</span>
            </div>
            <button className="btn btn-primary btn-full btn-sm" onClick={handleScan} disabled={busy}>
              {status === STATUS.SCANNING ? "スキャン中..." : "ネットワークスキャン"}
            </button>
            {scanResults.length > 0 && (
              <div className="scan-results">
                {scanResults.map(ip => (
                  <div key={ip} className="scan-row">
                    <span className="scan-ip">{ip}:5555</span>
                    <button className="btn btn-primary btn-xs" onClick={() => handleConnect(ip, 5555)}>接続</button>
                  </div>
                ))}
              </div>
            )}
            <div className="manual-connect">
              <input
                className="input"
                placeholder="192.168.x.x:5555"
                value={manualIp}
                onChange={e => setManualIp(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleConnectAddress(manualIp)}
              />
              <button className="btn btn-secondary btn-sm" onClick={() => handleConnectAddress(manualIp)} disabled={!manualIp.trim()}>接続</button>
            </div>
            <button className="btn btn-ghost btn-full btn-sm" onClick={() => setPairModal(true)}>ペアリング (Android 11+)</button>
          </div>

          {/* USB → WiFi */}
          {usbDevices.filter(d => d.state === "device").length > 0 && (
            <div className="sidebar-block">
              <div className="sidebar-block-header">
                <span className="sidebar-label">USB → WiFi切り替え</span>
              </div>
              {usbDevices.filter(d => d.state === "device").map(d => (
                <div key={d.address} className="usb-tcpip-row">
                  <span className="mono small">{d.model || d.address}</span>
                  <button className="btn btn-primary btn-xs" onClick={() => handleEnableTcpip(d)} disabled={busy}>
                    tcpip 5555
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ─── Main content ─── */}
        <div className="main-content">
          {!selectedAddr ? (
            <div className="empty-state">
              <div className="empty-icon">📱</div>
              <div className="empty-title">デバイスを選択してください</div>
              <div className="empty-desc">左のサイドバーでデバイスを選択するか、スキャンで検索してください</div>
            </div>
          ) : (
            <div className="device-detail">
              {/* Device header */}
              <div className="device-detail-header">
                <span className="ddh-icon">{typeIcon(selectedDevice?.device_type)}</span>
                <div className="ddh-info">
                  <span className="ddh-name">{selectedDevice?.model || selectedAddr}</span>
                  <span className="ddh-addr">{selectedAddr}
                    {selectedDevice?.manufacturer && ` · ${selectedDevice.manufacturer}`}
                    {selectedDevice?.serial && ` · ${selectedDevice.serial}`}
                  </span>
                </div>
                {selectedDevice?.battery != null && (
                  <span className={`ddh-battery${selectedDevice.battery <= 20 ? " low" : ""}`}>
                    {selectedDevice.charging ? "⚡" : "🔋"}{selectedDevice.battery}%
                  </span>
                )}
                <div className="ddh-actions">
                  {scrcpyVersion ? (
                    <button className="btn btn-scrcpy btn-sm" onClick={() => handleScrcpy(selectedAddr)} title={`scrcpy ${scrcpyVersion}`}>
                      📺 画面
                    </button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" disabled title="scrcpy が見つかりません (brew install scrcpy)">
                      📺
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => handleIdentify(selectedAddr)} title="フラッシュ＋バイブで識別">📍 識別</button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDisconnect(selectedAddr)}>切断</button>
                </div>
              </div>

              {/* Tabs */}
              <div className="device-tabs">
                {["install","files","terminal","logcat"].map(tab => (
                  <button
                    key={tab}
                    className={`device-tab ${deviceTab === tab ? "active" : ""}`}
                    onClick={() => setDeviceTab(tab)}
                  >
                    {tab === "install" && "インストール"}
                    {tab === "files" && "ファイル"}
                    {tab === "terminal" && "ターミナル"}
                    {tab === "logcat" && <>Logcat {logcatRunning && <span className="logcat-dot" />}</>}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="device-tab-content">
                {deviceTab === "install" && (
                  <ApkPanel
                    device={selectedAddr}
                    apkPath={apkPath}
                    apkPackage={apkPackage}
                    apkInfo={apkInfo}
                    installedPackage={installedPackage}
                    dragOver={dragOver}
                    onPickApk={handlePickApk}
                    onClearApk={() => { setApkPath(""); setApkPackage(""); setApkInfo(null); }}
                    onInstall={handleInstall}
                    onUninstall={handleUninstall}
                    onLaunch={handleLaunch}
                    onSetPackage={handleSetPackage}
                    installProgress={installProgress}
                    busy={busy}
                  />
                )}
                {deviceTab === "files" && <FileExplorer device={selectedAddr} />}
                {deviceTab === "terminal" && (
                  <div className="terminal-panel">
                    <div className="terminal-output" ref={termOutputRef}>
                      {termHistory.length === 0 ? (
                        <div className="terminal-empty">コマンドを入力してください<br /><span className="muted small">例: devices / shell ls /sdcard / install /path/to/app.apk</span></div>
                      ) : termHistory.map((h, i) => (
                        <div key={i} className="terminal-entry">
                          <div className="terminal-cmd">$ {h.cmd}</div>
                          <pre className="terminal-result">{h.output}</pre>
                        </div>
                      ))}
                    </div>
                    <div className="terminal-input-row">
                      <span className="terminal-prompt">adb&gt;</span>
                      <input
                        ref={termInputRef}
                        className="input terminal-input"
                        placeholder="devices / shell ls /sdcard ..."
                        value={termInput}
                        onChange={e => setTermInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") handleTermRun(); }}
                      />
                      <button className="btn btn-primary btn-sm" onClick={handleTermRun} disabled={!termInput.trim()}>実行</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setTermHistory([])}>クリア</button>
                    </div>
                  </div>
                )}
                {deviceTab === "logcat" && (
                  <div className="logcat-panel">
                    <div className="logcat-toolbar">
                      <input
                        className="input input-sm"
                        placeholder="フィルタ例: *:W MyTag:D"
                        value={logcatFilter}
                        onChange={e => setLogcatFilter(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && !logcatRunning) handleLogcatStart(); }}
                      />
                      {!logcatRunning ? (
                        <button className="btn btn-primary btn-sm" onClick={handleLogcatStart}>▶ 開始</button>
                      ) : (
                        <button className="btn btn-danger btn-sm" onClick={handleLogcatStop}>■ 停止</button>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => setLogcatLines([])}>クリア</button>
                    </div>
                    <div className="logcat-output" ref={logcatRef}>
                      {logcatLines.length === 0
                        ? <div className="logcat-empty">▶ 開始ボタンで Logcat を開始します</div>
                        : logcatLines.map((line, i) => (
                          <div key={i} className={`logcat-line logcat-${logcatLevel(line)}`}>{line}</div>
                        ))
                      }
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Log panel (collapsible bottom) ─── */}
      <div className={`log-panel ${logOpen ? "open" : ""}`}>
        <div className="log-panel-header" onClick={() => setLogOpen(o => !o)}>
          <span className="log-panel-title">ログ {log.length > 0 && `(${log.length})`}</span>
          <div className="log-panel-actions" onClick={e => e.stopPropagation()}>
            <button className="btn btn-ghost btn-xs" onClick={() => setLog([])}>クリア</button>
          </div>
          <span className="log-panel-toggle">{logOpen ? "▼" : "▲"}</span>
        </div>
        {logOpen && (
          <div className="log-area">
            {log.length === 0 ? (
              <div className="log-empty">ログなし</div>
            ) : (
              [...log].reverse().map((entry, i) => (
                <div key={i} className={`log-entry log-${entry.type}`}>
                  <span className="log-time">{entry.time}</span>
                  <span className="log-msg">{entry.msg}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ─── Pair modal ─── */}
      {pairModal && (
        <div className="modal-overlay" onClick={() => setPairModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">ワイヤレスペアリング</h3>
            <p className="modal-desc">設定 → 開発者オプション → ワイヤレスデバッグ → デバイスのペアリング</p>
            <div className="form-row">
              <input className="input" placeholder="IPアドレス" value={pairForm.ip} onChange={e => setPairForm({ ...pairForm, ip: e.target.value })} />
              <input className="input input-sm" placeholder="ポート" value={pairForm.port} onChange={e => setPairForm({ ...pairForm, port: e.target.value })} />
            </div>
            <input className="input" placeholder="ペアリングコード (6桁)" value={pairForm.code} onChange={e => setPairForm({ ...pairForm, code: e.target.value })} />
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setPairModal(false)}>キャンセル</button>
              <button className="btn btn-primary" onClick={handlePair} disabled={!pairForm.ip || !pairForm.code || busy}>ペアリング</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
