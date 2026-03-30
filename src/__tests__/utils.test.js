import { describe, it, expect } from "vitest";

// Pure utility functions extracted from App.jsx for testing

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

function fmt(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

describe("getFileIcon", () => {
  it("returns image icon for image files", () => {
    expect(getFileIcon("photo.png")).toBe("🖼");
    expect(getFileIcon("shot.JPG")).toBe("🖼");
    expect(getFileIcon("anim.gif")).toBe("🖼");
  });

  it("returns video icon for video files", () => {
    expect(getFileIcon("video.mp4")).toBe("🎬");
    expect(getFileIcon("clip.mov")).toBe("🎬");
    expect(getFileIcon("film.mkv")).toBe("🎬");
  });

  it("returns audio icon for audio files", () => {
    expect(getFileIcon("song.mp3")).toBe("🎵");
    expect(getFileIcon("track.flac")).toBe("🎵");
  });

  it("returns APK icon for apk files", () => {
    expect(getFileIcon("app.apk")).toBe("📦");
  });

  it("returns archive icon for archives", () => {
    expect(getFileIcon("data.zip")).toBe("🗜");
    expect(getFileIcon("backup.tar")).toBe("🗜");
  });

  it("returns config icon for config files", () => {
    expect(getFileIcon("config.json")).toBe("⚙");
    expect(getFileIcon("settings.yaml")).toBe("⚙");
  });

  it("returns default doc icon for unknown extensions", () => {
    expect(getFileIcon("readme.txt")).toBe("📄");
    expect(getFileIcon("noext")).toBe("📄");
  });
});

describe("logcatLevel", () => {
  it("parses verbose level", () => {
    expect(logcatLevel("03-30 12:00:00.000  1234  1234 V MyTag: message")).toBe("v");
  });

  it("parses debug level", () => {
    expect(logcatLevel("03-30 12:00:00.000  1234  1234 D MyTag: message")).toBe("d");
  });

  it("parses info level", () => {
    expect(logcatLevel("03-30 12:00:00.000  1234  1234 I MyTag: message")).toBe("i");
  });

  it("parses warning level", () => {
    expect(logcatLevel("03-30 12:00:00.000  1234  1234 W MyTag: message")).toBe("w");
  });

  it("parses error level", () => {
    expect(logcatLevel("03-30 12:00:00.000  1234  1234 E MyTag: message")).toBe("e");
  });

  it("parses fatal level", () => {
    expect(logcatLevel("03-30 12:00:00.000  1234  1234 F MyTag: message")).toBe("f");
  });

  it("defaults to v for unrecognized format", () => {
    expect(logcatLevel("--- some other log format")).toBe("v");
    expect(logcatLevel("")).toBe("v");
  });
});

describe("fmt (file size formatter)", () => {
  // Reconstruct fmt as used in App.jsx
  function fmt(bytes) {
    if (bytes == null) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  it("formats bytes", () => {
    expect(fmt(0)).toBe("0 B");
    expect(fmt(512)).toBe("512 B");
    expect(fmt(1023)).toBe("1023 B");
  });

  it("formats kilobytes", () => {
    expect(fmt(1024)).toBe("1.0 KB");
    expect(fmt(2048)).toBe("2.0 KB");
    expect(fmt(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(fmt(1024 * 1024)).toBe("1.0 MB");
    expect(fmt(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("returns empty string for null", () => {
    expect(fmt(null)).toBe("");
    expect(fmt(undefined)).toBe("");
  });
});
