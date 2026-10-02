import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

function sourceFiles(directory) {
    return readdirSync(directory).flatMap((entry) => {
        if (["node_modules", ".next"].includes(entry)) return [];
        const path = join(directory, entry);
        return statSync(path).isDirectory()
            ? sourceFiles(path)
            : /\.[cm]?[jt]sx?$/.test(entry)
                ? [path]
                : [];
    });
}

function fail(message) {
    failures.push(message);
}

for (const legacyPath of ["app/_components", "app/_lib", "app/manager/_components", "app/manager/_lib"]) {
    if (existsSync(join(root, legacyPath))) fail(`Legacy architecture remains: ${legacyPath}`);
}

for (const path of sourceFiles(join(root, "app")).filter((file) => file.endsWith("/page.tsx"))) {
    const contents = readFileSync(path, "utf8").trim();
    if (!/^export \{ default \} from "@\/features\/.+";$/.test(contents)) {
        fail(`${relative(root, path)} must be a one-line feature-screen export.`);
    }
}

for (const path of sourceFiles(root)) {
    const display = relative(root, path).replaceAll("\\", "/");
    const contents = readFileSync(path, "utf8");

    if (/\bfetch\s*\(/.test(contents) && display !== "core/http/client.ts") {
        fail(`${display} calls fetch directly; use core/http/client.ts.`);
    }
    if (/\btoast\.error\s*\(/.test(contents) && display !== "core/feedback/reportMutationError.ts") {
        fail(`${display} reports a mutation failure directly; use core/feedback/reportMutationError.ts.`);
    }
    if (display.startsWith("core/") && /@\/(features|domains)\//.test(contents)) {
        fail(`${display} breaks the core dependency boundary.`);
    }
    if (display.startsWith("domains/") && /@\/(app|features)\//.test(contents)) {
        fail(`${display} breaks the domain dependency boundary.`);
    }
    if (/^features\/[^/]+\/ui\//.test(display)) {
        const prohibited = ["@tanstack/react-query", "@/core/auth", "next/navigation", "/data/api"];
        if (prohibited.some((entry) => contents.includes(entry))) {
            fail(`${display} is UI but imports query, auth, router, or API data.`);
        }
    }
}

const schedulingTypes = readFileSync(join(root, "domains/scheduling/types.ts"), "utf8");
if (/interface OperationDef\s*\{[^}]*\b(machineId|durationMins)\b/s.test(schedulingTypes)) {
    fail("domains/scheduling/types.ts keeps legacy primary-route fields; OperationDef must use routes only.");
}

if (failures.length > 0) {
    console.error("Frontend architecture check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
    process.exitCode = 1;
} else {
    console.log("Frontend architecture check passed.");
}
