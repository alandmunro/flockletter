import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";

const scriptPath = join("scripts", "render-deploy.sh");
const serviceId = `srv-${"a".repeat(20)}`;
const commitSha = "b".repeat(40);

function runScenario(scenario: string): {
  stdout: string;
  stderr: string;
  status: number | null;
  error: Error | undefined;
} {
  const dir = mkdtempSync(join(tmpdir(), "render-deploy-test-"));

  try {
    const mockCurl = join(dir, "curl");

    writeFileSync(
      mockCurl,
      String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
let output = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-o") output = args[i + 1];
}
const isPost = args.includes("POST");
if (isPost) {
  if(process.env.SCENARIO==="refused") {
    require("fs").writeFileSync(output,JSON.stringify({message:"synthetic-private-token dep_synthetic"}));
    console.log("403");process.exit(0);
  }
  const body=JSON.parse(args[args.indexOf("--data")+1]);
  if(body.commitId!==process.env.TEST_SHA||body.clearCache!=="do_not_clear")process.exit(7);
  if (output) require("fs").writeFileSync(output, JSON.stringify({ id: "dep_synthetic", commit: { id: process.env.TEST_SHA }, status: "build_in_progress" }));
  console.log("201");
} else {
  let status = process.env.SCENARIO==="untrusted_status"?"synthetic-private-token":"live";
  let commitId = process.env.TEST_SHA;
  if (process.env.SCENARIO === "missing") {
    commitId = "";
  } else if (process.env.SCENARIO === "wrong") {
    commitId = "c".repeat(40);
  }
  const payload = { status };
  if (commitId) payload.commit = { id: commitId };
  const json = JSON.stringify(payload);
  if (output) require("fs").writeFileSync(output, json);
}
`,
      "utf8",
    );

    chmodSync(mockCurl, 0o755);

    const env = {
      PATH: `${dir}:${process.env.PATH}`,
      RENDER_API_KEY: "synthetic-private-token",
      TEST_SHA: commitSha,
      SCENARIO: scenario,
    };

    const result = spawnSync("bash", [scriptPath, serviceId, commitSha, "60"], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
      error: result.error,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("succeeds when commit matches exactly", () => {
  const result = runScenario("exact");

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Render deployment started");
  expect(result.stdout).toContain(`commit=${commitSha}`);
  expect(result.stdout).not.toContain("synthetic-private-token");
  expect(result.stderr).not.toContain("synthetic-private-token");
  expect(result.stdout+result.stderr).not.toContain(serviceId);
  expect(result.stdout+result.stderr).not.toContain("dep_synthetic");
});

it("fails when commit is missing from response", () => {
  const result = runScenario("missing");

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("deploy commit does not match the reviewed release");
  expect(result.stdout).not.toContain("synthetic-private-token");
  expect(result.stderr).not.toContain("synthetic-private-token");
  expect(result.stdout+result.stderr).not.toContain(serviceId);
  expect(result.stdout+result.stderr).not.toContain("dep_synthetic");
});

it("fails when commit does not match", () => {
  const result = runScenario("wrong");

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("deploy commit does not match the reviewed release");
  expect(result.stdout).not.toContain("synthetic-private-token");
  expect(result.stderr).not.toContain("synthetic-private-token");
  expect(result.stdout+result.stderr).not.toContain(serviceId);
  expect(result.stdout+result.stderr).not.toContain("dep_synthetic");
});


it.each(['refused','untrusted_status'])('redacts untrusted provider diagnostics: %s',scenario=>{
  const result=runScenario(scenario);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout+result.stderr).not.toContain('synthetic-private-token');
  expect(result.stdout+result.stderr).not.toContain('dep_synthetic');
});
