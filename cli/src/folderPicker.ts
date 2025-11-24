import { execFile } from "node:child_process";
import os from "node:os";

const trimOutput = (value: string | null | undefined) => value?.toString().trim() ?? "";

const deriveFolderName = (folderPath: string) => {
     const normalized = folderPath.replace(/\\+/g, "/").replace(/\/+$/, "");
     const segments = normalized.split("/").filter(Boolean);
     return segments[segments.length - 1] ?? normalized;
};

const runCommand = (command: string, args: string[]) => {
     return new Promise<string>((resolve, reject) => {
          execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
               if (error) {
                    const message = stderr ? `${error.message}: ${stderr}` : error.message;
                    reject(new Error(message));
                    return;
               }
               resolve(stdout.toString());
          });
     });
};

const pickFolderWindows = async () => {
     const psScript = `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Select a folder for GoFetch'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }`;
     const stdout = await runCommand("powershell.exe", ["-NoProfile", "-Sta", "-Command", psScript]);
     return trimOutput(stdout);
};

const pickFolderMac = async () => {
     const scriptLines = [
          'set dialogTitle to "Select a folder for GoFetch"',
          "try",
          "set selectedFolder to choose folder with prompt dialogTitle",
          "on error number -128",
          'return ""',
          "end try",
          "POSIX path of selectedFolder",
     ];

     const args = scriptLines.flatMap((line) => ["-e", line]);
     const stdout = await runCommand("osascript", args);
     return trimOutput(stdout);
};

const pickFolderLinux = async () => {
     const stdout = await runCommand("zenity", [
          "--file-selection",
          "--directory",
          "--title=Select a folder for GoFetch",
     ]);
     return trimOutput(stdout);
};

export type FolderPickerResult = {
     path: string;
     name: string;
};

export const selectFolderInteractive = async (): Promise<FolderPickerResult | null> => {
     let rawPath = "";
     const platform = os.platform();

     try {
          if (platform === "win32") {
               rawPath = await pickFolderWindows();
          } else if (platform === "darwin") {
               rawPath = await pickFolderMac();
          } else {
               rawPath = await pickFolderLinux();
          }
     } catch (error) {
          const enoent = typeof error === "object" && error && (error as NodeJS.ErrnoException).code === "ENOENT";
          const message = enoent
               ? platform === "darwin"
                    ? "osascript is unavailable. Ensure AppleScript is accessible on this machine."
                    : platform === "win32"
                      ? "PowerShell is unavailable."
                      : "Zenity is required to open folder dialogs on Linux. Please install zenity (e.g., sudo apt install zenity)."
               : error instanceof Error
                 ? error.message
                 : "Folder picker is unavailable on this system.";
          throw new Error(message);
     }

     const normalized = trimOutput(rawPath);
     if (!normalized) {
          return null;
     }

     return {
          path: normalized,
          name: deriveFolderName(normalized),
     };
};
