import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const distZipDir = path.join(projectRoot, "dist-zip");
const packageJsonPath = path.join(projectRoot, "package.json");

function toSafeFileSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function runZipCommand(outputPath) {
  const result = spawnSync("zip", ["-r", outputPath, "."], {
    cwd: distDir,
    stdio: "inherit",
  });

  if (result.error?.code === "ENOENT") {
    return false;
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`zip command failed with exit code ${result.status}.`);
  }

  return true;
}

function runPythonFallback(outputPath) {
  const pythonScript = [
    "import os, sys, zipfile",
    "output_path = sys.argv[1]",
    "root_dir = sys.argv[2]",
    "with zipfile.ZipFile(output_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:",
    "    for current_root, _dirs, files in os.walk(root_dir):",
    "        for name in files:",
    "            file_path = os.path.join(current_root, name)",
    "            arcname = os.path.relpath(file_path, root_dir)",
    "            zf.write(file_path, arcname)",
  ].join("\n");

  const result = spawnSync("python3", ["-c", pythonScript, outputPath, distDir], {
    stdio: "inherit",
  });

  if (result.error?.code === "ENOENT") {
    throw new Error('Neither "zip" nor "python3" command is available.');
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`python3 zip fallback failed with exit code ${result.status}.`);
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const rawName = packageJson.name;
  const rawVersion = packageJson.version;

  if (typeof rawName !== "string" || rawName.length === 0) {
    throw new Error("package.json name must be a non-empty string.");
  }
  if (typeof rawVersion !== "string" || rawVersion.length === 0) {
    throw new Error("package.json version must be a non-empty string.");
  }

  const name = toSafeFileSegment(rawName);
  const version = toSafeFileSegment(rawVersion);
  const zipFileName = `${name}-${version}.zip`;
  const outputPath = path.join(distZipDir, zipFileName);

  try {
    await access(distDir);
  } catch {
    throw new Error("dist directory not found. Run \"npm run build\" first.");
  }

  await mkdir(distZipDir, { recursive: true });
  await rm(outputPath, { force: true });

  const createdByZip = runZipCommand(outputPath);
  if (!createdByZip) {
    runPythonFallback(outputPath);
  }

  console.log(`Created ${path.relative(projectRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
