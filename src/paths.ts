import { getPreferences } from "./prefs";

export function storageRoot(): string {
  return (
    getPreferences().storageDirectory ||
    PathUtils.join(Zotero.getProfileDirectory().path, "paper-companion")
  );
}

export function sessionDirectory(): string {
  return PathUtils.join(storageRoot(), "sessions");
}

export function indexDirectory(): string {
  return PathUtils.join(storageRoot(), "indexes");
}

export async function ensureStorageDirectory(): Promise<string> {
  const root = storageRoot();
  await Zotero.File.createDirectoryIfMissingAsync(root);
  return root;
}

export function filePickerPath(file: unknown): string {
  // Zotero 9's filePicker.mjs returns a path string. Keep the object fallback
  // for older wrappers and test environments that expose nsIFile-like values.
  const value =
    typeof file === "string"
      ? file
      : file && typeof file === "object" && "path" in file
        ? (file as { path?: unknown }).path
        : undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("文件选择器没有返回有效路径，请重启 Zotero 后重试");
  }
  return value;
}

export async function verifyStorageDirectory(path: string): Promise<void> {
  if (!path.trim()) throw new Error("没有选择存储目录");
  await Zotero.File.createDirectoryIfMissingAsync(path);
  const marker = PathUtils.join(path, `.paper-companion-write-test-${Date.now()}`);
  try {
    await Zotero.File.putContentsAsync(marker, "ok");
    if (!(await IOUtils.exists(marker))) throw new Error("写入测试文件后无法读取");
  } finally {
    if (await IOUtils.exists(marker)) await IOUtils.remove(marker);
  }
}

export async function chooseStorageDirectory(win: Window): Promise<string | null> {
  const filePickerModule = ChromeUtils.importESModule(
    "chrome://zotero/content/modules/filePicker.mjs",
  ) as {
    FilePicker: new () => {
      modeGetFolder: number;
      returnOK: number;
      file: string | { path: string };
      init(win: Window, title: string, mode: number): void;
      show(): Promise<number>;
    };
  };
  const picker = new filePickerModule.FilePicker();
  picker.init(win, "选择 your_zotero 本地存储目录", picker.modeGetFolder);
  const result = await picker.show();
  if (result !== picker.returnOK) return null;
  const path = filePickerPath(picker.file);
  await verifyStorageDirectory(path);
  return path;
}
