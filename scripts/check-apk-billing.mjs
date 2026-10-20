// Whether an Android APK carries Google Play Billing (NP-154): the site's build must not, the Play
// build (feature store-play) must. Checks the merged manifest's com.android.vending.BILLING with
// aapt2 (the SDK's newest build-tools, ANDROID_HOME) and Play Billing's classes in the dex files.
//   bun scripts/check-apk-billing.mjs <apk> absent|present
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PERMISSION = "com.android.vending.BILLING";
const CLASSES = "Lcom/android/billingclient/";

/** aapt2 of the newest build-tools of the SDK. */
function aapt2() {
  const sdk = process.env.ANDROID_HOME;
  if (!sdk) throw new Error("Set ANDROID_HOME (the Android SDK)");
  const folder = path.join(sdk, "build-tools");
  const newest = readdirSync(folder).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
  if (!newest) throw new Error(`No build-tools in ${folder}`);
  return path.join(folder, newest, process.platform === "win32" ? "aapt2.exe" : "aapt2");
}

/** What of Play Billing the APK has: the permission, and dex files naming its classes. */
export function billingIn(apk) {
  const permissions = execFileSync(aapt2(), ["dump", "permissions", apk], { encoding: "utf8" });
  const work = path.join(tmpdir(), `koonapin-apk-billing-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    execFileSync("unzip", ["-q", "-o", apk, "classes*.dex", "-d", work]);
    const dex = readdirSync(work).filter((name) => name.endsWith(".dex"));
    if (dex.length === 0) throw new Error(`${apk} has no dex files`);
    return {
      permission: permissions.includes(`'${PERMISSION}'`),
      classes: dex.filter((name) => readFileSync(path.join(work, name)).includes(CLASSES)),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Throws unless Play Billing is wholly there (`present`) or wholly absent (`absent`). */
export function checkBilling(apk, expected) {
  const { permission, classes } = billingIn(apk);
  const name = path.basename(apk);
  if (expected === "absent" && (permission || classes.length)) {
    throw new Error(`${name} carries Play Billing: ${permission ? PERMISSION : ""} ${classes.join(" ")}`.trim());
  }
  if (expected === "present" && !(permission && classes.length)) {
    throw new Error(`${name} lacks Play Billing: permission ${permission}, classes in ${classes.length} dex files`);
  }
  console.log(`${name}: Play Billing ${expected} (permission ${permission ? "declared" : "absent"}, classes in ${classes.length} dex files)`);
}

if (import.meta.main) {
  const [apk, expected] = process.argv.slice(2);
  if (!apk || !["absent", "present"].includes(expected)) throw new Error("Usage: check-apk-billing.mjs <apk> absent|present");
  checkBilling(path.resolve(apk), expected);
}
