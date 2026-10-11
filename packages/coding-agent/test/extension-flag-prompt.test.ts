import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];

const probeExtension = `export default function (pi) {
	pi.registerFlag("probe", { type: "boolean", default: false });
	pi.registerFlag("target", { type: "string" });
	pi.on("input", async (event) => {
		process.stderr.write("INPUT " + JSON.stringify({ text: event.text, probe: pi.getFlag("probe"), target: pi.getFlag("target") }) + "\\n");
		return { action: "handled" };
	});
}
`;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function runCli(args: string[]): Promise<{ code: number | null; inputs: unknown[] }> {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-extension-flag-prompt-"));
	tempDirs.push(tempRoot);
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	const extensionPath = join(tempRoot, "probe.js");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(extensionPath, probeExtension);

	let stderr = "";
	const child = spawn(
		process.execPath,
		["--import", sourceResolverUrl, cliPath, "-ne", "-e", extensionPath, "--no-session", ...args],
		{
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				ANTHROPIC_API_KEY: "test-key",
				PI_OFFLINE: "1",
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			resolvePromise(exitCode);
		});
	});

	const inputs = stderr
		.split("\n")
		.filter((line) => line.startsWith("INPUT "))
		.map((line) => JSON.parse(line.slice("INPUT ".length)));
	return { code, inputs };
}

describe("extension CLI flags", () => {
	// #7139
	it("keeps the prompt after a boolean extension flag", async () => {
		const result = await runCli(["-p", "--probe", "list the files here"]);

		expect(result.code).toBe(0);
		expect(result.inputs).toEqual([{ text: "list the files here", probe: true }]);
	});

	it("keeps the separate value of a string extension flag", async () => {
		const result = await runCli(["-p", "--target", "user@host", "--probe", "first", "second"]);

		expect(result.code).toBe(0);
		expect(result.inputs).toEqual([
			{ text: "first", probe: true, target: "user@host" },
			{ text: "second", probe: true, target: "user@host" },
		]);
	});
});
