// Copies the editor files (node HTML, locales, icons) next to the compiled runtime files,
// where Node-RED expects them.
import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = "src";
const dist = "dist";

for (const file of readdirSync(src)) {
  if (file.endsWith(".html")) {
    cpSync(join(src, file), join(dist, file));
  }
}
for (const dir of ["icons", "locales"]) {
  cpSync(join(src, dir), join(dist, dir), { recursive: true });
}
