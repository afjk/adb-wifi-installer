import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import App, { FileExplorer } from "../App";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
const root = "/storage/emulated/0";
const entry = { name: "photo.txt", path: `${root}/photo.txt`, is_dir: false };
const folder = { name: "Pictures", path: `${root}/Pictures`, is_dir: true };
let drop;
let unlisten;
const calls = cmd => invoke.mock.calls.filter(([name]) => name === cmd);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  invoke.mockImplementation(async cmd => {
    if (cmd === "list_files") return [entry, folder];
    if (cmd === "get_devices") return [{ address: "test-device", model: "Test device", state: "device" }];
    if (cmd === "get_usb_devices") return [];
    if (cmd === "get_apk_info") return { package: "test.app" };
    return "success";
  });
  unlisten = vi.fn();
  getCurrentWebview.mockReturnValue({ onDragDropEvent: vi.fn(async handler => { drop = handler; return unlisten; }) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const explorer = async () => {
  const dropHandlerRef = { current: null };
  const rendered = render(<FileExplorer device="test-device" dropHandlerRef={dropHandlerRef} />);
  await screen.findByText("photo.txt");
  return { ...rendered, dropHandlerRef };
};
const emitDrop = async paths => { await act(async () => { drop({ payload: { type: "drop", paths } }); }); };

describe("FileExplorer production component", () => {
  it("deletes exactly once without asking and refreshes on success", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await explorer();
    fireEvent.click(screen.getAllByTitle("削除")[0]);
    await screen.findByText("✅ success");
    expect(confirm).not.toHaveBeenCalled();
    expect(calls("delete_path")).toEqual([["delete_path", { device: "test-device", path: entry.path }]]);
    expect(calls("list_files")).toHaveLength(2);
  });
  it("shows deletion failure without removing the file", async () => {
    await explorer();
    invoke.mockRejectedValueOnce("permission denied");
    fireEvent.click(screen.getAllByTitle("削除")[0]);
    await screen.findByText("❌ permission denied");
    expect(screen.getByText("photo.txt")).toBeInTheDocument();
    expect(calls("list_files")).toHaveLength(1);
  });
  it("keeps native file and folder paths intact and uses the current directory", async () => {
    const { dropHandlerRef } = await explorer();
    fireEvent.click(screen.getByText("Pictures"));
    await waitFor(() => expect(screen.getAllByText("Pictures")).toHaveLength(2));
    const paths = ["/tmp/日本語 photo.txt", "/tmp/folder", "C:\\Users\\Test User\\Folder"];
    await act(async () => { await dropHandlerRef.current(paths); });
    expect(calls("push_files")).toEqual([["push_files", { device: "test-device", localPaths: paths, remoteDir: folder.path }]]);
  });
  it("ignores empty and duplicate in-flight drops, then permits a new upload", async () => {
    const { dropHandlerRef } = await explorer();
    const pending = deferred();
    invoke.mockImplementation(cmd => cmd === "push_files" ? pending.promise : Promise.resolve([entry, folder]));
    await act(async () => { dropHandlerRef.current([]); dropHandlerRef.current(["/tmp/folder"]); dropHandlerRef.current(["/tmp/folder"]); });
    expect(calls("push_files")).toHaveLength(1);
    await act(async () => { pending.resolve("uploaded"); });
    await act(async () => { await dropHandlerRef.current(["/tmp/next"]); });
    expect(calls("push_files")).toHaveLength(2);
  });
  it("shows upload failures and allows retry", async () => {
    const { dropHandlerRef } = await explorer();
    invoke.mockRejectedValueOnce("offline");
    await act(async () => { await dropHandlerRef.current(["/tmp/folder"]); });
    expect(screen.getByText("❌ offline")).toBeInTheDocument();
    expect(calls("list_files")).toHaveLength(2);
    await act(async () => { await dropHandlerRef.current(["/tmp/folder"]); });
    expect(calls("push_files")).toHaveLength(2);
  });
  it("does not navigate back when an upload finishes after navigation", async () => {
    const { dropHandlerRef } = await explorer();
    const pending = deferred();
    invoke.mockImplementation(cmd => cmd === "push_files" ? pending.promise : Promise.resolve([entry, folder]));
    await act(async () => { dropHandlerRef.current(["/tmp/folder"]); });
    fireEvent.click(screen.getByText("Pictures"));
    await waitFor(() => expect(calls("list_files")).toHaveLength(2));
    await act(async () => { pending.resolve("uploaded"); });
    expect(calls("list_files")).toHaveLength(2);
    expect(calls("list_files")[1][1].path).toBe(folder.path);
  });
  it("does not interrupt navigation that is still loading when upload finishes", async () => {
    const { dropHandlerRef } = await explorer();
    const upload = deferred();
    const listing = deferred();
    invoke.mockImplementation(cmd => cmd === "push_files" ? upload.promise : listing.promise);
    await act(async () => { dropHandlerRef.current(["/tmp/folder"]); });
    fireEvent.click(screen.getByText("Pictures"));
    await act(async () => { upload.resolve("uploaded"); });
    expect(calls("list_files")).toHaveLength(2);
    await act(async () => { listing.resolve([]); });
    expect(calls("list_files")[1][1].path).toBe(folder.path);
  });
  it("clears the upload callback on unmount and ignores late upload results", async () => {
    const { dropHandlerRef, unmount } = await explorer();
    const pending = deferred();
    invoke.mockImplementation(cmd => cmd === "push_files" ? pending.promise : Promise.resolve([entry, folder]));
    await act(async () => { dropHandlerRef.current(["/tmp/folder"]); });
    unmount();
    expect(dropHandlerRef.current).toBeNull();
    await act(async () => { pending.resolve("uploaded"); });
    expect(calls("list_files")).toHaveLength(1);
  });
  it("keeps the upload picker working", async () => {
    await explorer();
    open.mockResolvedValueOnce(["/tmp/file.txt"]);
    fireEvent.click(screen.getByText("⬆ アップロード"));
    await waitFor(() => expect(calls("push_files")).toHaveLength(1));
    expect(calls("push_files")[0][1].localPaths).toEqual(["/tmp/file.txt"]);
  });
});

describe("App native drop routing", () => {
  it("uploads APK plus folders in Explorer without selecting APK, then preserves APK behavior outside Explorer", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("Test device"));
    fireEvent.click(screen.getByText("ファイル"));
    await screen.findByText("photo.txt");
    await emitDrop(["/tmp/app.apk", "/tmp/folder"]);
    expect(calls("push_files")).toHaveLength(1);
    expect(calls("get_apk_info")).toHaveLength(0);
    fireEvent.click(screen.getByText("インストール", { selector: ".device-tab" }));
    await emitDrop(["/tmp/app.apk", "/tmp/folder"]);
    expect(calls("push_files")).toHaveLength(1);
    expect(calls("get_apk_info")).toHaveLength(1);
    expect(getCurrentWebview).toHaveBeenCalledTimes(1);
  });
  it("unsubscribes when registration resolves after unmount and ignores old events", async () => {
    const pending = deferred();
    getCurrentWebview.mockReturnValue({ onDragDropEvent: vi.fn(handler => { drop = handler; return pending.promise; }) });
    const { unmount } = render(<App />);
    unmount();
    await act(async () => { pending.resolve(unlisten); });
    expect(unlisten).toHaveBeenCalledTimes(1);
    await emitDrop(["/tmp/app.apk"]);
    expect(calls("get_apk_info")).toHaveLength(0);
  });
});
