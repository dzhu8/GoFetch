/**
 * Cross-platform launcher — delegates to the platform-specific start script.
 * Usage: node scripts/dev.mjs
 */
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { platform } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

if (platform() === "win32") {
     execFileSync("cmd", ["/c", join(__dirname, "dev.cmd")], {
          stdio: "inherit",
          cwd: root,
     });
} else {
     execFileSync("bash", [join(__dirname, "dev.sh")], {
          stdio: "inherit",
          cwd: root,
     });
}
