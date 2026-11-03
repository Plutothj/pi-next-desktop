// 生成 Windows .ico（PNG-in-ICO，Vista+ 格式）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const sizes = [16, 32, 48, 64, 128, 256];
const src = path.resolve("build/icon.png");

const pngs = [];
for (const size of sizes) {
  const out = path.join(os.tmpdir(), `ico-${size}.png`);
  const cmd = [
    "powershell", "-NoProfile", "-Command",
    `"Add-Type -AssemblyName System.Drawing;`,
    `$s=[System.Drawing.Image]::FromFile('${src.replace(/'/g, "''")}');`,
    `$b=New-Object System.Drawing.Bitmap($s,${size},${size});`,
    `$b.Save('${out.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    `$b.Dispose();$s.Dispose()"`,
  ].join(" ");
  execSync(cmd, { stdio: "pipe" });
  pngs.push(fs.readFileSync(out));
}

const header = 6;
const entrySize = 16;
const dataOffset = header + entrySize * sizes.length;
const buf = Buffer.alloc(dataOffset + pngs.reduce((s, p) => s + p.length, 0));

buf.writeUInt16LE(0, 0);
buf.writeUInt16LE(1, 2);
buf.writeUInt16LE(sizes.length, 4);

let offset = dataOffset;
for (let i = 0; i < sizes.length; i++) {
  const s = sizes[i];
  const e = header + i * entrySize;
  const b = s >= 256 ? 0 : s;
  buf.writeUInt8(b, e);
  buf.writeUInt8(b, e + 1);
  buf.writeUInt8(0, e + 2);
  buf.writeUInt8(0, e + 3);
  buf.writeUInt16LE(1, e + 4);
  buf.writeUInt16LE(32, e + 6);
  buf.writeUInt32LE(pngs[i].length, e + 8);
  buf.writeUInt32LE(offset, e + 12);
  pngs[i].copy(buf, offset);
  offset += pngs[i].length;
}

fs.writeFileSync("build/icon.ico", buf);
console.log(`icon.ico: ${buf.length} bytes, ${sizes.length} sizes (${sizes.join(",")})`);
