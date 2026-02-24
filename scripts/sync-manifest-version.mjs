import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CHROME_VERSION_PART = 65535;
const XYZ_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const manifestJsonPath = path.join(projectRoot, "public", "manifest.json");

function assertXyzVersion(version) {
  const match = version.match(XYZ_VERSION_PATTERN);
  if (!match) {
    throw new Error(
      `Invalid package.json version "${version}". Use X.Y.Z only (example: 1.2.3).`,
    );
  }

  const parts = match.slice(1).map((part) => Number(part));
  const outOfRange = parts.some((part) => part < 0 || part > MAX_CHROME_VERSION_PART);
  if (outOfRange) {
    throw new Error(
      `Invalid package.json version "${version}". Each part must be 0-${MAX_CHROME_VERSION_PART}.`,
    );
  }
}

async function syncManifestVersion() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const manifestJson = JSON.parse(await readFile(manifestJsonPath, "utf8"));

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string.");
  }
  assertXyzVersion(packageJson.version);

  manifestJson.version = packageJson.version;
  await writeFile(`${manifestJsonPath}`, `${JSON.stringify(manifestJson, null, 2)}\n`, "utf8");
  console.log(`Synced manifest version to ${packageJson.version}`);
}

syncManifestVersion().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
