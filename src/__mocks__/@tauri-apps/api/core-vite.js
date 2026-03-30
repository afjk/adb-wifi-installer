const MOCK_DEVICES = [
  {
    address: "192.168.1.42:5555",
    state: "device",
    model: "Pico 4 Ultra",
    manufacturer: "Pico",
    device_type: "vr",
    battery: 78,
    charging: false,
  },
  {
    address: "192.168.1.55:5555",
    state: "offline",
    model: "Pixel 8",
    manufacturer: "Google",
    device_type: "phone",
    battery: 45,
    charging: true,
  },
];

export async function invoke(cmd, _args) {
  if (cmd === "get_devices") return MOCK_DEVICES;
  if (cmd === "get_usb_devices") return [];
  if (cmd === "get_adb_version") return "Android Debug Bridge version 1.0.41 (1.0.41)";
  if (cmd === "get_scrcpy_version") return null;
  if (cmd === "scan_network") return MOCK_DEVICES;
  if (cmd === "list_files") return [
    { name: "DCIM", path: "/storage/emulated/0/DCIM", is_dir: true, is_symlink: false, size: null, modified: "2024-01-01" },
    { name: "Download", path: "/storage/emulated/0/Download", is_dir: true, is_symlink: false, size: null, modified: "2024-01-02" },
    { name: "notes.txt", path: "/storage/emulated/0/notes.txt", is_dir: false, is_symlink: false, size: 1024, modified: "2024-01-03" },
  ];
  if (cmd === "get_apk_info") return null;
  return null;
}
