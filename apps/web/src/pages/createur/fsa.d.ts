// The parts of the File System Access API (Chrome, Edge on a computer) that TypeScript's DOM types do not have yet:
// the pickers, the permission calls and the listing of a folder. Firefox, Safari and phones have none of them
// (folder.ts checks before use).

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
}

interface PilotixFilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}

interface Window {
  showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string | FileSystemHandle }): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?(options?: { id?: string; multiple?: boolean; excludeAcceptAllOption?: boolean; types?: PilotixFilePickerType[]; startIn?: string | FileSystemHandle }): Promise<FileSystemFileHandle[]>;
}
