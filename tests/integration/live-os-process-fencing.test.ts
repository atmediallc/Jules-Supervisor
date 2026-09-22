import { describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { OutboxRepository } from "../../packages/db/src";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

describe("Real Multi-Process OS Worker Fencing", () => {
  it("executes two distinct OS Node.js child processes competing for the same outbox item", async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    const db = drizzle(client);
    const repo = new OutboxRepository(db);

    const outboxId = `out_os_proc_${Date.now()}`;
    const sessionId = `ses_os_proc_${Date.now()}`;
    const decisionId = `dec_os_proc_${Date.now()}`;
    const activityId = `act_os_proc_${Date.now()}`;

    // Seed DB hierarchy
    await client.query(
      `INSERT INTO sessions (id, name, repository, branch, prompt, state, supervisor_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, `Session ${sessionId}`, "org/repo", "main", "prompt", "IN_PROGRESS", "AUTO_EXECUTED"],
    );

    await client.query(
      `INSERT INTO activities (id, session_id, type, content)
       VALUES ($1, $2, $3, $4)`,
      [activityId, sessionId, "AGENT_MESSAGE", "content"],
    );

    await client.query(
      `INSERT INTO decisions (id, session_id, activity_id, action, reason, risk, confidence, idempotency_key, provider, model, context_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [decisionId, sessionId, activityId, "RESPOND", "testing", "low", 1.0, `idem_${Date.now()}`, "p", "m", "d"],
    );

    await repo.create({
      id: outboxId,
      decisionId,
      sessionId,
      action: "RESPOND",
      payload: { prompt: "os process test" },
    });

    // Spawn 2 child processes executing independent DB connection claims
    const runWorkerChild = (workerName: string): Promise<boolean> => {
      return new Promise((resolve, reject) => {
        const child = fork(
          "-e",
          [
            `
            const pg = require("pg");
            const { drizzle } = require("drizzle-orm/node-postgres");
            const { OutboxRepository } = require("./packages/db/dist/index.js");

            async function run() {
              const client = new pg.Client({ connectionString: "${DATABASE_URL}" });
              await client.connect();
              const db = drizzle(client);
              const repo = new OutboxRepository(db);
              const claimed = await repo.claim("${outboxId}", "${workerName}", 10000);
              await client.end();
              process.send({ won: claimed !== null });
            }
            run().catch(e => { console.error(e); process.exit(1); });
            `,
          ],
          { stdio: ["inherit", "inherit", "inherit", "ipc"] },
        );

        child.on("message", (msg: { won: boolean }) => {
          resolve(msg.won);
        });
        child.on("error", reject);
      });
    };

    const [won1, won2] = await Promise.all([
      runWorkerChild("os-worker-alpha"),
      runWorkerChild("os-worker-beta"),
    ]);

    // Exactly one OS process won the exclusive claim
    expect(Number(won1) + Number(won2)).toBe(1);

    // Clean up
    await client.query(`DELETE FROM outbox WHERE id = $1`, [outboxId]);
    await client.query(`DELETE FROM decisions WHERE id = $1`, [decisionId]);
    await client.query(`DELETE FROM activities WHERE id = $1`, [activityId]);
    await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    await client.end();
  });
});
