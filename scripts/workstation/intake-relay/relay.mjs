// Intake relay service entry + operator console (plan p2-wake-on-work, Slice B, file B7).
//
//   relay.mjs                          — run the singleton deliverer/writer service
//   relay.mjs --status                 — read-only per-envelope state incl. hold reasons
//   relay.mjs fence --reason <text>    — durable operator fence (fsynced marker, §9.3)
//   relay.mjs unfence                  — remove the fence marker
//   relay.mjs resume --id <id>|--all   — operator hold-resume via the authenticated
//                                        writer IPC (mutation happens INSIDE the
//                                        single writer process, M5)
//
// The fence marker is written directly by design: fencing must work even when
// the deliverer is stopped or hung. Envelope mutations, by contrast, always go
// through the writer IPC — there is no second spool writer.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  clearFence,
  OPERATOR_AUTO_HOLD_STATES,
  OPERATOR_HOLD_STATES,
  readFence,
  writeFence,
} from "./deliverer.mjs";
import { requestWriter } from "./submit.mjs";
import { createSpool } from "./spool.mjs";
import { loadPrincipalMap } from "./config.mjs";

function printStatus(config) {
  const fence = readFence(config.fencePath);
  let spool = null;
  let envelopes = [];
  let spoolError = null;
  try {
    spool = createSpool({
      dir: config.spoolDir,
      maxEnvelopes: config.maxEnvelopes,
      maxBytes: config.maxBytes,
    });
    envelopes = spool.list();
  } catch (error) {
    spoolError = String(error?.message ?? error);
  }
  const summary = {
    mode: config.mode,
    endpoint: config.mode === "deliver" ? config.endpoint : null,
    socketPath: config.socketPath,
    spoolDir: config.spoolDir,
    fence: fence ? { at: fence.at, reason: fence.reason } : null,
    spool: spool
      ? { count: envelopes.length, maxEnvelopes: config.maxEnvelopes, maxBytes: config.maxBytes }
      : null,
    spoolError,
    envelopes: envelopes.map((record) => ({
      id: record.id,
      state: record.state,
      requestId: record.requestId,
      projectId: record.projectId,
      taskId: record.taskId ?? null,
      attempts: record.attempts ?? 0,
      watchAttempts: record.watchAttempts ?? 0,
      holdReason: record.holdReason ?? null,
      scheduledAt: record.scheduledAt ?? null,
      lastReceipt: record.receipts?.[record.receipts.length - 1] ?? null,
    })),
    socketLive: (function () {
      try {
        statSync(config.socketPath);
        return true;
      } catch {
        return false;
      }
    })(),
    checkedAt: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function resumeEnvelopes(config, selector) {
  // Mutation through the authenticated writer IPC — M5 single-writer.
  const credential = readFileSync(config.writerCredentialPath, "utf8").trim();
  const reply = await requestWriter({
    socketPath: config.socketPath,
    credential,
    envelope: null,
    control: { op: "resume", ...selector },
  });
  process.stdout.write(`${JSON.stringify(reply, null, 2)}\n`);
  if (!reply?.ok) process.exitCode = 2;
}

function usage() {
  process.stdout.write(
    [
      "usage: relay.mjs                       run the singleton deliverer/writer service",
      "       relay.mjs --status              read-only spool/fence status",
      "       relay.mjs fence --reason <text> write the durable operator fence marker",
      "       relay.mjs unfence               remove the fence marker",
      "       relay.mjs resume --id <id>|--all operator hold-resume via the writer IPC",
      "",
    ].join("\n"),
  );
}

async function main(argv) {
  const { loadConfig } = await import("./config.mjs");
  const config = loadConfig();

  if (argv.includes("--status")) {
    printStatus(config);
    return;
  }
  if (argv.includes("fence")) {
    const flagIndex = argv.indexOf("--reason");
    const reason = flagIndex >= 0 ? argv[flagIndex + 1] : "unspecified";
    const marker = writeFence(config.fencePath, reason);
    process.stdout.write(`${JSON.stringify({ fenced: true, ...marker })}\n`);
    return;
  }
  if (argv.includes("unfence")) {
    const removed = clearFence(config.fencePath);
    process.stdout.write(`${JSON.stringify({ fenced: false, removed })}\n`);
    return;
  }
  if (argv.includes("resume")) {
    const idIndex = argv.indexOf("--id");
    const id = idIndex >= 0 ? argv[idIndex + 1] : null;
    if (!id && !argv.includes("--all")) {
      process.stderr.write("resume requires --id <id> or --all\n");
      process.exitCode = 1;
      return;
    }
    await resumeEnvelopes(config, id ? { id } : { all: true });
    return;
  }
  if (argv.some((arg) => arg.startsWith("-") && arg !== "-")) {
    usage();
    process.exitCode = 1;
    return;
  }

  // Service entry: singleton deliverer + authenticated retention writer.
  const principalMap = loadPrincipalMap(config.principalsPath);
  const spool = createSpool({
    dir: config.spoolDir,
    maxEnvelopes: config.maxEnvelopes,
    maxBytes: config.maxBytes,
  });
  const { runService } = await import("./deliverer.mjs");
  await runService({ config, spool, principalMap });
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

export { OPERATOR_HOLD_STATES };
