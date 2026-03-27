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

function DeviceRow({ device, onConnect, onDisconnect, onInstall, onUninstall, onLaunch, onIdentify, onOpenFiles, onSetPackage, apkPath, installedPackage }) {
  const connected = device.state === "device";
  const [editingPkg, setEditingPkg] = useState(false);
  const [pkgInput, setPkgInput] = useState(installedPackage || "");

  const submitPkg = () => {
    if (pkgInput.trim()) onSetPackage(device.address, pkgInput.trim());
    setEditingPkg(false);
  };

  return (
    <div className={`device-row ${connected ? "connected" : "offline"}`}>
      <div className="device-info">
        <span className="device-type-icon" title={device.manufacturer || device.device_type || ""}>
          {device.device_type === "vr" ? "🥽"
            : device.device_type === "tablet" ? "📱"
            : device.device_type === "tv" ? "📺"
            : device.device_type === "phone" ? "📱"
            : "📱"}
        </span>
        <span className="device-address">{device.address}</span>
        {device.model && <span className="device-model">{device.model}</span>}
        {device.manufacturer && <span className="device-serial" title="メーカー">{device.manufacturer}</span>}
        {device.serial && <span className="device-serial" title="シリアル番号">{device.serial}</span>}
        {device.battery != null && (
          <span className={`device-battery${device.battery <= 20 ? " battery-low" : ""}`}
                title={device.charging ? "充電中" : "バッテリー"}>
            {device.charging ? "⚡" : "🔋"}{device.battery}%
          </span>
        )}
        <span className={`device-state ${connected ? "state-ok" : "state-err"}`}>
          {connected ? "接続中" : device.state}
        </span>
      </div>
      <div className="device-actions">
        {!connected ? (
          <button className="btn btn-primary" onClick={() => onConnect(device.address)}>
            接続
          </button>
        ) : (
          <>
            {editingPkg ? (
              <div className="pkg-input-row">
                <input
                  className="pkg-input"
                  value={pkgInput}
                  onChange={(e) => setPkgInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitPkg()}
                  placeholder="com.example.app"
                  autoFocus
                />
                <button className="btn btn-launch" onClick={submitPkg}>OK</button>
                <button className="btn" onClick={() => setEditingPkg(false)}>✕</button>
              </div>
            ) : (
              <>
                {installedPackage ? (
                  <button
                    className="btn btn-launch"
                    onClick={() => onLaunch(device.address, installedPackage)}
                    title={installedPackage}
                  >
                    起動
                  </button>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => { setPkgInput(""); setEditingPkg(true); }}
                    title="パッケージ名を入力して起動"
                  >
                    pkg
                  </button>
                )}
                {installedPackage && (
                  <>
                    <button
                      className="btn btn-uninstall"
                      onClick={() => onUninstall(device.address, installedPackage)}
                      title={`アンインストール: ${installedPackage}`}
                    >
                      削除
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setPkgInput(installedPackage); setEditingPkg(true); }}
                      title={installedPackage}
                    >
                      ✎
                    </button>
                  </>
                )}
                <button
                  className="btn btn-success"
                  onClick={() => onInstall(device.address)}
                  disabled={!apkPath}
                  title={!apkPath ? "APKを選択してください" : ""}
                >
                  インストール
                </button>
                <button
                  className="btn btn-files"
                  onClick={() => onOpenFiles(device.address)}
                  title="ファイルエクスプローラー"
                >
                  📂
                </button>
                <button
                  className="btn btn-identify"
                  onClick={() => onIdentify(device.address)}
                  title="フラッシュライト点滅＋バイブで識別"
                >
                  📍
                </button>
                <button className="btn btn-danger" onClick={() => onDisconnect(device.address)}>
                  切断
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FileExplorer({ device, onClose }) {
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

  const startEditPath = () => {
    setPathInput(path);
    setEditingPath(true);
    setTimeout(() => pathInputRef.current?.select(), 50);
  };

  const submitPath = () => {
    const p = pathInput.trim() || "/";
    load(p);
  };

  useEffect(() => { load(path); }, []);

  const breadcrumbs = path.split("/").filter(Boolean);

  const navigateTo = (index) => {
    const p = "/" + breadcrumbs.slice(0, index + 1).join("/");
    load(p);
  };

  const handleClick = (file) => {
    if (file.is_dir) { load(file.path); return; }
    if (file.is_symlink && file.symlink_target) { load(file.symlink_target); return; }
    handlePreview(file);
  };

  const handlePreview = async (file) => {
    const ext = file.name.split(".").pop().toLowerCase();
    const isVideo = ["mp4","mov","avi","mkv","webm"].includes(ext);
    if (isVideo) {
      setStatus("動画を取得中...");
      try {
        const localPath = await invoke("pull_to_tmp", { device, remotePath: file.path });
        await openPath(localPath);
        setStatus("✅ 外部アプリで開きました");
      } catch (e) {
        setStatus("❌ " + e);
      }
      return;
    }
    setPreview({ loading: true, name: file.name });
    try {
      const result = await invoke("preview_file", { device, remotePath: file.path });
      setPreview({ ...result, name: file.name, path: file.path });
    } catch (e) {
      setPreview({ type: "error", name: file.name, content: String(e) });
    }
  };

  const handleDownload = async (file) => {
    setStatus((file.is_dir ? "📁 フォルダをダウンロード中: " : "ダウンロード中: ") + file.name);
    try {
      const msg = await invoke("pull_file", { device, remotePath: file.path });
      setStatus("✅ " + msg);
    } catch (e) {
      setStatus("❌ " + e);
    }
  };

  const handleUpload = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setStatus(`アップロード中... (${paths.length} ファイル)`);
    try {
      const msg = await invoke("push_files", { device, localPaths: paths, remoteDir: path });
      setStatus("✅ " + msg);
      load(path);
    } catch (e) {
      setStatus("❌ " + e);
    }
  };

  const handleDelete = async (file) => {
    if (!window.confirm(`削除しますか?\n${file.path}`)) return;
    setStatus("削除中: " + file.name);
    try {
      const msg = await invoke("delete_path", { device, path: file.path });
      setStatus("✅ " + msg);
      load(path);
    } catch (e) {
      setStatus("❌ " + e);
    }
  };

  const goUp = () => {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return;
    const parent = "/" + parts.slice(0, -1).join("/") || "/";
    load(parent);
  };

  const formatSize = (size) => {
    if (!size) return "";
    if (size < 1024) return size + "B";
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + "K";
    if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + "M";
    return (size / 1024 / 1024 / 1024).toFixed(1) + "G";
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="file-explorer" onClick={e => e.stopPropagation()}>
        {/* ヘッダー */}
        <div className="fe-header">
          <span className="fe-title">📂 {device}</span>
          <div className="fe-header-actions">
            <button className="btn btn-ghost btn-sm" onClick={handleUpload}>⬆ アップロード</button>
            <button className="btn btn-ghost btn-sm" onClick={() => load(path)}>↻</button>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* パンくず / パス入力 */}
        <div className="fe-breadcrumb" onClick={!editingPath ? startEditPath : undefined} title="クリックでパスを編集">
          {editingPath ? (
            <input
              ref={pathInputRef}
              className="fe-path-input"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") submitPath();
                if (e.key === "Escape") setEditingPath(false);
              }}
              onBlur={() => setTimeout(() => setEditingPath(false), 150)}
              autoFocus
            />
          ) : (
            <>
              <span className="fe-bc-item" onClick={e => { e.stopPropagation(); load("/"); }}>/ </span>
              {breadcrumbs.map((crumb, i) => (
                <span key={i}>
                  <span className="fe-bc-item" onClick={e => { e.stopPropagation(); navigateTo(i); }}>{crumb}</span>
                  {i < breadcrumbs.length - 1 && <span className="fe-bc-sep">/</span>}
                </span>
              ))}
              <span className="fe-bc-hint">✎</span>
            </>
          )}
        </div>

        <div className="fe-body">
          {/* ファイル一覧 */}
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
                <span className="fe-size">{!f.is_dir ? formatSize(f.size) : ""}</span>
                <span className="fe-date">{f.modified || ""}</span>
                <div className="fe-actions">
                  {!f.is_dir && !f.is_symlink && (
                    <button className="btn btn-ghost btn-xs" onClick={() => handlePreview(f)} title="プレビュー">👁</button>
                  )}
                  {!f.is_symlink && (
                    <button className="btn btn-ghost btn-xs" onClick={() => handleDownload(f)} title="ダウンロード">⬇</button>
                  )}
                  <button className="btn btn-ghost btn-xs" style={{color:"#f87171"}} onClick={() => handleDelete(f)} title="削除">🗑</button>
                </div>
              </div>
            ))}
          </div>

          {/* プレビュー */}
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
                {preview.type === "unsupported" && <div className="fe-unsupported">このファイル形式はプレビューできません</div>}
                {preview.type === "error" && <div className="fe-unsupported">❌ {preview.content}</div>}
              </div>
            </div>
          )}
        </div>

        {status && <div className="fe-status">{status}</div>}
      </div>
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
  if (["txt","log","md"].includes(ext)) return "📄";
  if (["json","xml","yaml","yml","toml"].includes(ext)) return "⚙";
  return "📄";
}

// logcat行のレベル検出 (format: "MM-DD HH:MM:SS.mmm PID TID LEVEL TAG: msg")
function logcatLevel(line) {
  const m = line.match(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ +\d+ +\d+ ([VDIWEF]) /);
  if (!m) return "v";
  return m[1].toLowerCase();
}

function ScanResult({ ip, onConnect }) {
  return (
    <div className="scan-result-row">
      <span className="scan-ip">{ip}:5555</span>
      <button className="btn btn-primary btn-sm" onClick={() => onConnect(ip, 5555)}>
        接続
      </button>
    </div>
  );
}

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
  const [pairModal, setPairModal] = useState(false);
  const [pairForm, setPairForm] = useState({ ip: "", port: "37000", code: "" });
  const [manualIp, setManualIp] = useState("");
  const [fileExplorerDevice, setFileExplorerDevice] = useState(null);
  const [installProgress, setInstallProgress] = useState(null); // { device, progress, phase }
  const [termInput, setTermInput] = useState("");
  const [termHistory, setTermHistory] = useState([]);
  const [termDevice, setTermDevice] = useState("");
  const termOutputRef = useRef(null);
  const termInputRef = useRef(null);
  const [bottomTab, setBottomTab] = useState("log"); // "log" | "terminal" | "logcat"
  const [logcatLines, setLogcatLines] = useState([]);
  const [logcatRunning, setLogcatRunning] = useState(false);
  const [logcatDevice, setLogcatDevice] = useState("");
  const [logcatFilter, setLogcatFilter] = useState("");
  const logcatRef = useRef(null);
  const MAX_LOGCAT_LINES = 500;
  const [installedPackages, setInstalledPackages] = useState(() => {
    try { return JSON.parse(localStorage.getItem("installedPackages") || "{}"); }
    catch { return {}; }
  });

  // localStorage に永続化
  useEffect(() => {
    localStorage.setItem("installedPackages", JSON.stringify(installedPackages));
  }, [installedPackages]);

  // インストール進捗イベントのリスナー
  useEffect(() => {
    let unlisten;
    listen("install_progress", (e) => {
      const { device, progress, phase } = e.payload;
      if (phase === "done") {
        setInstallProgress(null);
      } else {
        setInstallProgress({ device, progress, phase });
      }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  // logcatイベントリスナー
  useEffect(() => {
    let unlistenLine, unlistenStop;
    listen("logcat_line", (e) => {
      setLogcatLines((prev) => {
        const next = [...prev, e.payload];
        return next.length > MAX_LOGCAT_LINES ? next.slice(next.length - MAX_LOGCAT_LINES) : next;
      });
      setTimeout(() => {
        if (logcatRef.current) logcatRef.current.scrollTop = logcatRef.current.scrollHeight;
      }, 20);
    }).then(fn => { unlistenLine = fn; });
    listen("logcat_stopped", () => setLogcatRunning(false)).then(fn => { unlistenStop = fn; });
    return () => { unlistenLine?.(); unlistenStop?.(); };
  }, []);

  const addLog = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString();
    setLog((prev) => [...prev.slice(-99), { time, msg, type }]);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const [devs, usb] = await Promise.all([
        invoke("get_devices"),
        invoke("get_usb_devices"),
      ]);
      setDevices(devs);
      setUsbDevices(usb);
    } catch (e) {
      addLog("デバイス一覧取得失敗: " + e, "error");
    }
  }, [addLog]);

  useEffect(() => {
    invoke("get_adb_version")
      .then((v) => setAdbVersion(v))
      .catch(() => setAdbVersion("adb not found"));
    refreshDevices();
    const interval = setInterval(refreshDevices, 5000);
    return () => clearInterval(interval);
  }, [refreshDevices]);

  const handleDiagnose = async (device) => {
    addLog(`診断中: ${device}`);
    try {
      const result = await invoke("diagnose_device_network", { device });
      // Print each line as a separate log entry
      for (const line of result.split("\n")) {
        if (line.trim()) addLog(line, "info");
      }
    } catch (e) {
      addLog("診断失敗: " + e, "error");
    }
  };

  const handleEnableTcpip = async (device) => {
    setStatus(STATUS.TCPIP);
    addLog(`$ adb -s ${device.address} tcpip 5555`, "cmd");
    addLog(`TCP/IP有効化中: ${device.address} (${device.model ?? "Unknown"})`);
    try {
      const result = await invoke("enable_tcpip", { device: device.address, port: 5555 });
      addLog("TCP/IP有効化: " + result, "success");

      // WiFi IPを取得して接続フォームに自動入力
      try {
        const ip = await invoke("get_device_wifi_ip", { device: device.address });
        addLog(`WiFi IP: ${ip} → USBを抜いてから接続してください`, "warn");
        setManualIp(ip + ":5555");
      } catch (e) {
        addLog("WiFi IP取得失敗: " + e, "error");
        addLog("デバイスがWiFiに接続されているか確認し、IPを手動入力してください", "warn");
      }
    } catch (e) {
      addLog("TCP/IP有効化失敗: " + e, "error");
    } finally {
      setStatus(STATUS.IDLE);
    }
  };

  const handleScan = async () => {
    setStatus(STATUS.SCANNING);
    setScanResults([]);
    addLog("$ (TCP port 5555 scan on local subnet)", "cmd");
    addLog("ネットワークスキャン開始...");
    try {
      const found = await invoke("scan_network");
      setScanResults(found);
      if (found.length === 0) {
        addLog("ADB対応デバイスが見つかりませんでした", "warn");
      } else {
        addLog(`${found.length}台のデバイスを発見: ${found.join(", ")}`, "success");
      }
    } catch (e) {
      addLog("スキャン失敗: " + e, "error");
    } finally {
      setStatus(STATUS.IDLE);
    }
  };

  const handleConnect = async (ip, port = 5555) => {
    addLog(`$ adb connect ${ip}:${port}`, "cmd");
    addLog(`接続中: ${ip}:${port}`);
    try {
      const result = await invoke("connect_device", { ip, port });
      addLog(result, "success");
      await refreshDevices();
    } catch (e) {
      addLog("接続失敗: " + e, "error");
    }
  };

  const handleConnectAddress = async (address) => {
    const [ip, portStr] = address.includes(":") ? address.split(":") : [address, "5555"];
    await handleConnect(ip, parseInt(portStr) || 5555);
  };

  const handleDisconnect = async (address) => {
    addLog(`$ adb disconnect ${address}`, "cmd");
    addLog(`切断: ${address}`);
    try {
      const result = await invoke("disconnect_device", { address });
      addLog(result, "warn");
      await refreshDevices();
    } catch (e) {
      addLog("切断失敗: " + e, "error");
    }
  };

  const applyApkPath = useCallback(async (path) => {
    if (!path.endsWith(".apk")) {
      addLog("APKファイル (.apk) を選択してください", "error");
      return;
    }
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
    } catch (e) {
      addLog("APK情報取得失敗: " + e, "warn");
    }
  }, [addLog]);

  const handlePickApk = async () => {
    const selected = await open({
      filters: [{ name: "APK", extensions: ["apk"] }],
      multiple: false,
    });
    if (selected) await applyApkPath(selected);
  };

  // Drag & Drop（Tauri WebView経由）
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    let unlisten;
    getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "over") {
        setDragOver(true);
      } else if (e.payload.type === "drop") {
        setDragOver(false);
        const apks = (e.payload.paths || []).filter(p => p.endsWith(".apk"));
        if (apks.length > 0) applyApkPath(apks[0]);
      } else {
        setDragOver(false);
      }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [applyApkPath]);

  const handleInstall = async (device) => {
    if (!apkPath) return;
    setStatus(STATUS.INSTALLING);
    addLog(`$ adb -s ${device} install "${apkPath}"`, "cmd");
    addLog(`インストール中: ${apkPath} → ${device}`);
    try {
      const result = await invoke("install_apk", { device, apkPath });
      addLog("インストール成功: " + result.message, "success");
      if (result.package) {
        addLog(`パッケージ: ${result.package}`, "info");
        setInstalledPackages((prev) => ({ ...prev, [device]: result.package }));
      }
    } catch (e) {
      addLog("インストール失敗: " + e, "error");
    } finally {
      setStatus(STATUS.IDLE);
    }
  };

  const handleSetPackage = (address, pkg) => {
    setInstalledPackages((prev) => ({ ...prev, [address]: pkg }));
    addLog(`パッケージ設定: ${pkg}`);
  };

  const handleLaunch = async (device, pkg) => {
    addLog(`$ adb -s ${device} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, "cmd");
    addLog(`起動中: ${pkg}`);
    try {
      const result = await invoke("launch_app", { device, package: pkg });
      addLog(result, "success");
    } catch (e) {
      addLog("起動失敗: " + e, "error");
    }
  };

  const handleIdentify = async (device) => {
    addLog(`$ adb -s ${device} shell (brightness/flashlight/vibrator sequence)`, "cmd");
    addLog(`識別中: ${device}`);
    try {
      const result = await invoke("identify_device", { device });
      addLog(result, "success");
    } catch (e) {
      addLog("識別失敗: " + e, "error");
    }
  };

  const handleUninstall = async (device, pkg) => {
    if (!window.confirm(`アンインストールしますか?\n${pkg}`)) return;
    addLog(`$ adb -s ${device} uninstall ${pkg}`, "cmd");
    addLog(`アンインストール中: ${pkg}`);
    try {
      const result = await invoke("uninstall_apk", { device, package: pkg });
      addLog(result, "success");
      setInstalledPackages((prev) => {
        const next = { ...prev };
        delete next[device];
        return next;
      });
    } catch (e) {
      addLog("アンインストール失敗: " + e, "error");
    }
  };

  const handleRestartAdb = async () => {
    addLog("$ adb kill-server && adb start-server", "cmd");
    addLog("adbサーバーリセット中...");
    try {
      const result = await invoke("restart_adb_server");
      addLog(result, "success");
      await refreshDevices();
      // リセット後に自動スキャン
      addLog("ネットワークスキャン開始...");
      const found = await invoke("scan_network");
      setScanResults(found);
      if (found.length === 0) {
        addLog("ADB対応デバイスが見つかりませんでした", "warn");
      } else {
        addLog(`${found.length}台のデバイスを発見: ${found.join(", ")}`, "success");
      }
    } catch (e) {
      addLog("リセット失敗: " + e, "error");
    }
  };

  const handleTermRun = async () => {
    const cmd = termInput.trim();
    if (!cmd) return;
    const prefix = termDevice ? `adb -s ${termDevice}` : "adb";
    addLog(`$ ${prefix} ${cmd}`, "cmd");
    setTermInput("");
    try {
      const output = await invoke("run_terminal_command", { device: termDevice, command: cmd });
      setTermHistory((prev) => [...prev, { cmd: `${prefix} ${cmd}`, output: output || "(出力なし)" }]);
    } catch (e) {
      setTermHistory((prev) => [...prev, { cmd: `${prefix} ${cmd}`, output: `エラー: ${e}` }]);
    }
    setTimeout(() => termOutputRef.current?.scrollTo(0, termOutputRef.current.scrollHeight), 50);
  };

  const handleLogcatStart = async () => {
    if (!logcatDevice) return;
    setLogcatLines([]);
    setLogcatRunning(true);
    addLog(`$ adb -s ${logcatDevice} logcat -v time ${logcatFilter}`, "cmd");
    try {
      await invoke("start_logcat", { device: logcatDevice, filter: logcatFilter });
    } catch (e) {
      addLog("logcat起動失敗: " + e, "error");
      setLogcatRunning(false);
    }
  };

  const handleLogcatStop = async () => {
    await invoke("stop_logcat");
    setLogcatRunning(false);
  };

  const handlePair = async () => {
    setStatus(STATUS.PAIRING);
    addLog(`$ adb pair ${pairForm.ip}:${pairForm.port}`, "cmd");
    addLog(`ペアリング: ${pairForm.ip}:${pairForm.port}`);
    try {
      const result = await invoke("pair_device", {
        ip: pairForm.ip,
        port: parseInt(pairForm.port),
        code: pairForm.code,
      });
      addLog("ペアリング成功: " + result, "success");
      setPairModal(false);
    } catch (e) {
      addLog("ペアリング失敗: " + e, "error");
    } finally {
      setStatus(STATUS.IDLE);
    }
  };

  const handleManualConnect = async () => {
    if (!manualIp.trim()) return;
    const [ip, portStr] = manualIp.includes(":")
      ? manualIp.split(":")
      : [manualIp, "5555"];
    await handleConnect(ip.trim(), parseInt(portStr) || 5555);
    setManualIp("");
  };

  const busy = status !== STATUS.IDLE;

  return (
    <div className="app">
      {fileExplorerDevice && (
        <FileExplorer device={fileExplorerDevice} onClose={() => setFileExplorerDevice(null)} />
      )}
      {/* Header */}
      <header className="header">
        <h1 className="header-title">ADB WiFi Installer</h1>
        <div className="header-right">
          <button className="btn btn-ghost btn-sm" onClick={handleRestartAdb} title="adb kill-server && start-server">
            adbリセット
          </button>
          <span className="adb-version">{adbVersion}</span>
        </div>
      </header>

      <div className="main-layout">
        {/* Left panel */}
        <div className="panel left-panel">
          {/* APK Selection */}
          <section className="section">
            <h2 className="section-title">APKファイル</h2>
            <div className={`apk-area${dragOver ? " drag-over" : ""}`}>
              {apkPath ? (
                <div className="apk-selected">
                  <div className="apk-selected-header">
                    <span className="apk-icon">📦</span>
                    <div className="apk-info">
                      <span className="apk-name" title={apkPath}>
                        {apkPath.split(/[/\\]/).pop()}
                      </span>
                      {apkPackage && <span className="apk-package">{apkPackage}</span>}
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setApkPath(""); setApkPackage(""); setApkInfo(null); }}>
                      ✕
                    </button>
                  </div>
                  {apkInfo && (
                    <div className="apk-details">
                      <div className="apk-detail-row">
                        <span className="apk-detail-label">バージョン</span>
                        <span className="apk-detail-value">{apkInfo.version_name} <span className="apk-detail-muted">(build {apkInfo.version_code})</span></span>
                      </div>
                      {apkInfo.label && (
                        <div className="apk-detail-row">
                          <span className="apk-detail-label">アプリ名</span>
                          <span className="apk-detail-value">{apkInfo.label}</span>
                        </div>
                      )}
                      {apkInfo.min_sdk && (
                        <div className="apk-detail-row">
                          <span className="apk-detail-label">SDK</span>
                          <span className="apk-detail-value">min {apkInfo.min_sdk} / target {apkInfo.target_sdk}</span>
                        </div>
                      )}
                      {apkInfo.signature_subject && (
                        <div className="apk-detail-row">
                          <span className="apk-detail-label">署名</span>
                          <span className={`apk-detail-value ${apkInfo.debug_signed ? "apk-debug-sign" : "apk-release-sign"}`}>
                            {apkInfo.debug_signed ? "⚠️ Debug" : "✅ Release"} — {apkInfo.signature_subject}
                          </span>
                        </div>
                      )}
                      {apkInfo.signature_sha256 && (
                        <div className="apk-detail-row">
                          <span className="apk-detail-label">SHA-256</span>
                          <span className="apk-detail-value apk-hash">{apkInfo.signature_sha256}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="apk-dropzone" onClick={handlePickApk}>
                  <span className="apk-dropzone-icon">📦</span>
                  <span className="apk-dropzone-text">
                    {dragOver ? "ここにドロップ！" : "ドロップ または クリックして選択"}
                  </span>
                </div>
              )}
              <button className="btn btn-secondary btn-full" onClick={handlePickApk}>
                ファイルを選択
              </button>
            </div>
          </section>

          {/* USB → WiFi */}
          <section className="section">
            <div className="section-header">
              <h2 className="section-title">USB → WiFi切り替え</h2>
              <button className="btn btn-ghost btn-sm" onClick={refreshDevices}>更新</button>
            </div>
            {usbDevices.length === 0 ? (
              <div className="usb-empty">USBデバイスなし</div>
            ) : (
              <div className="usb-list">
                {usbDevices.map((d) => (
                  <div key={d.address} className="usb-row">
                    <div className="usb-info">
                      <span className="usb-serial">{d.address}</span>
                      {d.model && <span className="device-model">{d.model}</span>}
                    </div>
                    <div className="device-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleDiagnose(d.address)}
                        disabled={busy || d.state !== "device"}
                        title="ネットワーク診断"
                      >
                        診断
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleEnableTcpip(d)}
                        disabled={busy || d.state !== "device"}
                        title={d.state !== "device" ? "unauthorized / offline" : "adb tcpip 5555を実行"}
                      >
                        {status === STATUS.TCPIP ? "実行中..." : "tcpip 5555"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Scan */}
          <section className="section">
            <h2 className="section-title">デバイス検索</h2>
            <button
              className="btn btn-primary btn-full"
              onClick={handleScan}
              disabled={busy}
            >
              {status === STATUS.SCANNING ? "スキャン中..." : "ネットワークをスキャン"}
            </button>

            {scanResults.length > 0 && (
              <div className="scan-results">
                {scanResults.map((ip) => (
                  <ScanResult key={ip} ip={ip} onConnect={handleConnect} />
                ))}
              </div>
            )}

            {/* Manual IP */}
            <div className="manual-connect">
              <input
                className="input"
                placeholder="IPアドレス (例: 192.168.1.10:5555)"
                value={manualIp}
                onChange={(e) => setManualIp(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleManualConnect()}
              />
              <button
                className="btn btn-secondary"
                onClick={handleManualConnect}
                disabled={!manualIp.trim() || busy}
              >
                接続
              </button>
            </div>

            {/* Pair (Android 11+) */}
            <button
              className="btn btn-ghost btn-full"
              onClick={() => setPairModal(true)}
              disabled={busy}
            >
              ペアリング (Android 11+)
            </button>
          </section>
        </div>

        {/* Right panel */}
        <div className="panel right-panel">
          {/* Connected devices */}
          <section className="section">
            <div className="section-header">
              <h2 className="section-title">接続済みデバイス</h2>
              <button className="btn btn-ghost btn-sm" onClick={refreshDevices}>
                更新
              </button>
            </div>

            {status === STATUS.INSTALLING && (
              <div className="installing-banner">
                {installProgress ? (
                  <>
                    <div className="install-phase-label">
                      {installProgress.phase === "uploading"
                        ? `アップロード中... ${installProgress.progress}%`
                        : "インストール中..."}
                    </div>
                    <div className="install-progress-bar-bg">
                      <div
                        className="install-progress-bar-fill"
                        style={{ width: `${installProgress.progress}%` }}
                      />
                    </div>
                  </>
                ) : (
                  "インストール中..."
                )}
              </div>
            )}

            {devices.length === 0 ? (
              <div className="empty-state">デバイスが接続されていません</div>
            ) : (
              <div className="device-list">
                {devices.map((d) => (
                  <DeviceRow
                    key={d.address}
                    device={d}
                    onConnect={handleConnectAddress}
                    onDisconnect={handleDisconnect}
                    onInstall={handleInstall}
                    onLaunch={handleLaunch}
                    onUninstall={handleUninstall}
                    onIdentify={handleIdentify}
                    onOpenFiles={(dev) => setFileExplorerDevice(dev)}
                    onSetPackage={handleSetPackage}
                    apkPath={apkPath}
                    installedPackage={installedPackages[d.address] || apkPackage}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Bottom tabs: Log / Terminal / Logcat */}
          <section className="section bottom-tabs-section">
            {/* Tab bar */}
            <div className="bottom-tab-bar">
              <button
                className={`bottom-tab ${bottomTab === "log" ? "active" : ""}`}
                onClick={() => setBottomTab("log")}
              >
                ログ
              </button>
              <button
                className={`bottom-tab ${bottomTab === "terminal" ? "active" : ""}`}
                onClick={() => setBottomTab("terminal")}
              >
                ターミナル
              </button>
              <button
                className={`bottom-tab ${bottomTab === "logcat" ? "active" : ""}`}
                onClick={() => setBottomTab("logcat")}
              >
                Logcat {logcatRunning && <span className="logcat-dot" />}
              </button>

              {/* Tab-specific controls (right side) */}
              <div className="bottom-tab-actions">
                {bottomTab === "log" && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setLog([])}>クリア</button>
                )}
                {bottomTab === "terminal" && (
                  <>
                    <select className="input input-sm" value={termDevice} onChange={(e) => setTermDevice(e.target.value)} style={{ maxWidth: 180 }}>
                      <option value="">デバイスを選択</option>
                      {[...devices, ...usbDevices].map((d) => (
                        <option key={d.address} value={d.address}>{d.address} {d.model ? `(${d.model})` : ""}</option>
                      ))}
                    </select>
                    <button className="btn btn-ghost btn-sm" onClick={() => setTermHistory([])}>クリア</button>
                  </>
                )}
                {bottomTab === "logcat" && (
                  <>
                    <select className="input input-sm" value={logcatDevice} onChange={(e) => setLogcatDevice(e.target.value)} style={{ maxWidth: 160 }}>
                      <option value="">デバイスを選択</option>
                      {[...devices, ...usbDevices].map((d) => (
                        <option key={d.address} value={d.address}>{d.address} {d.model ? `(${d.model})` : ""}</option>
                      ))}
                    </select>
                    <input
                      className="input input-sm"
                      style={{ maxWidth: 130 }}
                      placeholder="*:W MyTag:D"
                      value={logcatFilter}
                      onChange={(e) => setLogcatFilter(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !logcatRunning) handleLogcatStart(); }}
                    />
                    {!logcatRunning ? (
                      <button className="btn btn-primary btn-sm" onClick={handleLogcatStart} disabled={!logcatDevice}>▶ 開始</button>
                    ) : (
                      <button className="btn btn-danger btn-sm" onClick={handleLogcatStop}>■ 停止</button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => setLogcatLines([])}>クリア</button>
                  </>
                )}
              </div>
            </div>

            {/* Tab content */}
            {bottomTab === "log" && (
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

            {bottomTab === "terminal" && (
              <>
                <div className="terminal-output" ref={termOutputRef}>
                  {termHistory.length === 0 ? (
                    <div className="terminal-empty">コマンドを入力してください</div>
                  ) : (
                    termHistory.map((h, i) => (
                      <div key={i} className="terminal-entry">
                        <div className="terminal-cmd">$ {h.cmd}</div>
                        <pre className="terminal-result">{h.output}</pre>
                      </div>
                    ))
                  )}
                </div>
                <div className="terminal-input-row">
                  <span className="terminal-prompt">$</span>
                  <input
                    ref={termInputRef}
                    className="input terminal-input"
                    placeholder="devices / connect 192.168.x.x:5555 / shell ls /sdcard ..."
                    value={termInput}
                    onChange={(e) => setTermInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleTermRun(); }}
                  />
                  <button className="btn btn-primary btn-sm" onClick={handleTermRun} disabled={!termInput.trim()}>
                    実行
                  </button>
                </div>
              </>
            )}

            {bottomTab === "logcat" && (
              <div className="logcat-output" ref={logcatRef}>
                {logcatLines.length === 0 ? (
                  <div className="terminal-empty">
                    {logcatRunning ? "ログ待機中..." : "デバイスを選択して ▶ 開始"}
                  </div>
                ) : (
                  logcatLines.map((line, i) => (
                    <div key={i} className={`logcat-line logcat-${logcatLevel(line)}`}>{line}</div>
                  ))
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Pair modal */}
      {pairModal && (
        <div className="modal-overlay" onClick={() => setPairModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">ワイヤレスペアリング</h3>
            <p className="modal-desc">
              Android 11以降: 設定 → 開発者オプション → ワイヤレスデバッグ → デバイスのペアリング
            </p>
            <div className="form-row">
              <input
                className="input"
                placeholder="IPアドレス"
                value={pairForm.ip}
                onChange={(e) => setPairForm({ ...pairForm, ip: e.target.value })}
              />
              <input
                className="input input-sm"
                placeholder="ポート"
                value={pairForm.port}
                onChange={(e) => setPairForm({ ...pairForm, port: e.target.value })}
              />
            </div>
            <input
              className="input"
              placeholder="ペアリングコード (6桁)"
              value={pairForm.code}
              onChange={(e) => setPairForm({ ...pairForm, code: e.target.value })}
            />
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setPairModal(false)}>
                キャンセル
              </button>
              <button
                className="btn btn-primary"
                onClick={handlePair}
                disabled={!pairForm.ip || !pairForm.code || busy}
              >
                ペアリング
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
