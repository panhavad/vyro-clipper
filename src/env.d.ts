/// <reference types="vite/client" />

interface VyroClipperBuildInfo {
  name: string;
  version: string;
  commit: string;
  shortCommit: string;
  branch: string;
  message: string;
  builtAt: string;
  target: 'web' | 'extension';
}

declare const __BUILD_INFO__: VyroClipperBuildInfo;

interface FileSystemDirectoryHandle {
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }): Promise<FileSystemDirectoryHandle>;
}
