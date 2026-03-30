import { vi } from "vitest";

export const invoke = vi.fn(async (cmd, args) => {
  const defaults = {
    list_devices: [],
    get_adb_version: "Android Debug Bridge version 1.0.41",
    get_scrcpy_version: null,
    scan_network: [],
    connect_device: "connected",
    disconnect_device: "disconnected",
    get_device_info: { manufacturer: "Unknown", model: "Unknown", serial: "unknown" },
    get_battery_info: { level: 100, is_charging: false },
    list_files: [],
    pull_file: "/tmp/file",
    push_file: "success",
    delete_file: "success",
    install_apk: "success",
    uninstall_apk: "success",
    launch_app: "success",
    get_apk_info: null,
    adb_command: "",
    start_logcat: null,
    stop_logcat: null,
    launch_scrcpy: null,
    set_tcpip: "5555",
    pair_device: "success",
    identify_device: null,
    get_preview_image: null,
  };
  if (cmd in defaults) return defaults[cmd];
  throw new Error(`Unknown command: ${cmd}`);
});
