// Distinct-process contender for the keyed-intake cross-connection race test
// (plan p2-wake-on-work §7.2 / §11.3). Spawned by taskIntake.test.ts under
// `node --import tsx` with argv: <sqlitePath> <dedupKey> <payloadDigest> <projectId>.
// Opens its OWN connection to the same database file and runs the same admission
// function as the test process, then prints one JSON result line to stdout.
import { getDb, closeDb } from "@aif/shared/server";
import { createTaskWithIntakeBinding } from "../../taskIntake.ts";

const [, , sqlitePath, dedupKey, payloadDigest, projectId] = process.argv;

getDb(sqlitePath);
const result = createTaskWithIntakeBinding(
  {
    projectId,
    title: "Contended intake task",
    description: "Created by the distinct-process contender",
  },
  {
    dedupKey,
    projectId,
    principalKind: "participant",
    principalId: "relay-svc",
    requestId: dedupKey.split("|")[3],
    payloadDigest,
    source: "relay",
  },
);
closeDb();
process.stdout.write(`${JSON.stringify(result)}\n`);
