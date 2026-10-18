import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The split of NP-072a, checked on the sources (the repository has no ESLint for a
 * `no-restricted-imports` rule): the two shells never import each other, shared code imports no
 * shell, and only src/platform and the shell's choice in main.tsx know which system the app runs on.
 */

/** Every source file under `dir`, tests left out. */
function sources(dir: string): string[] {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path.replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return files;
}

/** The files `file` imports from the app's own sources, as paths under src. */
function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found = [...text.matchAll(/(?:import|export)\s[^;]*?from\s+["'](\.[^"']*)["']|import\s+["'](\.[^"']*)["']/g)];
  return found.map((m) => normalize(join(dirname(file), m[1] ?? m[2])).replace(/\\/g, "/"));
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

describe("the shells (NP-072a)", () => {
  test("the desktop shell and the phone shell never import each other", () => {
    const crossings = [
      ...sources("src/shell/desktop").flatMap((f) => imports(f).filter((i) => under(i, "src/shell/phone")).map((i) => `${f} → ${i}`)),
      ...sources("src/shell/phone").flatMap((f) => imports(f).filter((i) => under(i, "src/shell/desktop")).map((i) => `${f} → ${i}`)),
    ];
    expect(crossings).toEqual([]);
  });

  test("shared code imports no shell; only main.tsx chooses one", () => {
    const shared = sources("src").filter((f) => !under(f, "src/shell") && f !== "src/main.tsx");
    const crossings = shared.flatMap((f) => imports(f).filter((i) => under(i, "src/shell")).map((i) => `${f} → ${i}`));
    expect(crossings).toEqual([]);
  });

  test("only src/platform and main.tsx ask which system the app runs on", () => {
    const asking = sources("src")
      .filter((f) => !under(f, "src/platform") && f !== "src/main.tsx")
      .filter((f) => /\bisMobile\b|\bplatform\s*(?:===|!==)|from\s+["'][^"']*platform\/platform["']/.test(readFileSync(f, "utf8")));
    expect(asking).toEqual([]);
  });

  test("the check sees imports at all", () => {
    expect(imports("src/main.tsx")).toEqual(expect.arrayContaining(["src/shell/desktop/DesktopShell", "src/shell/phone/PhoneShell"]));
  });
});
