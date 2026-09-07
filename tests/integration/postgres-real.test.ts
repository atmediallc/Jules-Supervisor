import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getDatabase,
  closeDatabase,
  SessionRepository,
  ActivityRepository,
  DecisionRepository,
  ApprovalRepository,
  AuditRepository,
  runInTransaction,
  sql,
} from "@jules/db";

const TEST_DB_URL =
  process.env["DATABASE_URL"] ||
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

describe("Real PostgreSQL 16 & Drizzle Schema Integration", () => {
  let db: ReturnType<typeof getDatabase>;
  let sessionRepo: SessionRepository;
  let activityRepo: ActivityRepository;
  let decisionRepo: DecisionRepository;
  let approvalRepo: ApprovalRepository;
  let auditRepo: AuditRepository;

  beforeAll(async () => {
    db = getDatabase(TEST_DB_URL);
    sessionRepo = new SessionRepository(db);
    activityRepo = new ActivityRepository(db);
    decisionRepo = new DecisionRepository(db);
    approvalRepo = new ApprovalRepository(db);
    auditRepo = new AuditRepository(db);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("proves PostgreSQL 16 database connection and schema tables existence", async () => {
    const res = await db.execute(sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const tableNames = (res.rows as Array<{ table_name: string }>).map((r) => r.table_name);

    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("activities");
    expect(tableNames).toContain("decisions");
    expect(tableNames).toContain("approval_requests");
    expect(tableNames).toContain("audit_events");
    expect(tableNames).toContain("policies");
    expect(tableNames).toContain("sync_checkpoints");

    // Check unique index on decisions.idempotency_key
    const indexRes = await db.execute(sql`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'decisions'
    `);
    const indexNames = (indexRes.rows as Array<{ indexname: string }>).map((r) => r.indexname);
    expect(indexNames).toContain("uniq_decisions_idempotency");
  });

  it("persists sessions and activities with foreign key integrity", async () => {
    const sessionId = `ses_pg_${Date.now()}`;
    const activityId = `act_pg_${Date.now()}`;

    // 1. Create Session
    const session = await sessionRepo.upsert({
      id: sessionId,
      name: "PostgreSQL Real Test",
      repository: "octocat/real-pg-repo",
      branch: "main",
      prompt: "Test database real persistence",
      state: "AWAITING_USER_INPUT",
      supervisorStatus: "IDLE",
    });
    expect(session.id).toBe(sessionId);

    // 2. Create Activity referencing Session
    const activity = await activityRepo.create({
      id: activityId,
      sessionId,
      type: "AGENT_MESSAGE",
      content: "Do you prefer option A or option B?",
      rawPayload: { type: "AGENT_MESSAGE", text: "Do you prefer option A or option B?" },
    });
    expect(activity.id).toBe(activityId);
    expect(activity.sessionId).toBe(sessionId);

    // 3. Verify querying by session
    const fetchedActivities = await activityRepo.listBySession(sessionId);
    expect(fetchedActivities.length).toBeGreaterThanOrEqual(1);
    expect(fetchedActivities.some((a) => a.id === activityId)).toBe(true);
  });

  it("strictly rejects duplicate decisions.idempotency_key via PostgreSQL unique constraint", async () => {
    const sessionId = `ses_idem_${Date.now()}`;
    const activityId = `act_idem_${Date.now()}`;
    const idempotencyKey = `idem_key_${Date.now()}`;

    await sessionRepo.upsert({
      id: sessionId,
      name: "Idempotency Test",
      repository: "octocat/idem-repo",
      prompt: "Idempotency test",
      state: "AWAITING_USER_INPUT",
    });

    await activityRepo.create({
      id: activityId,
      sessionId,
      type: "AGENT_MESSAGE",
      content: "Plan generated",
      rawPayload: {},
    });

    // First decision insert succeeds
    const firstDecision = await decisionRepo.create({
      id: `dec_first_${Date.now()}`,
      sessionId,
      activityId,
      idempotencyKey,
      action: "RESPOND",
      risk: "low",
      confidence: 0.95,
      reason: "Safe response",
      provider: "openai",
      model: "gpt-4o",
      contextDigest: "a".repeat(64),
      executionState: "DRY_RUN_COMPLETED",
    });
    expect(firstDecision).not.toBeNull();

    // Second decision with the exact same idempotency_key is a no-op: the
    // PostgreSQL unique index is the backstop, and the repository converts the
    // concurrent-duplicate/redelivery race into a graceful idempotent skip that
    // returns the ORIGINAL decision (never a duplicate row, never a thrown error).
    const duplicateDecision = await decisionRepo.create({
      id: `dec_second_${Date.now()}`,
      sessionId,
      activityId,
      idempotencyKey,
      action: "RESPOND",
      risk: "low",
      confidence: 0.95,
      reason: "Duplicate attempt",
      provider: "openai",
      model: "gpt-4o",
      contextDigest: "b".repeat(64),
      executionState: "DRY_RUN_COMPLETED",
    });
    // Dedup returns the pre-existing decision, not a newly inserted duplicate.
    expect(duplicateDecision?.id).toBe(firstDecision.id);
    // Only one row exists for this idempotency key (the unique index enforced it).
    const byKey = await decisionRepo.findByIdempotencyKey(idempotencyKey);
    expect(byKey).not.toBeNull();
    expect(byKey?.id).toBe(firstDecision.id);
  });

  it("handles database transactions and rollbacks correctly on constraint violation", async () => {
    const invalidActivityId = `act_orphan_${Date.now()}`;

    await expect(
      db.transaction(async (tx) => {
        // Inserting an activity pointing to non-existent session_id violates foreign key constraint
        await tx.execute(
          sql`INSERT INTO activities (id, session_id, type, created_at) VALUES (${invalidActivityId}, 'non_existent_session_id', 'AGENT_MESSAGE', NOW())`,
        );
      }),
    ).rejects.toThrow();
  });

  it("proves multi-statement transaction rollback atomically removes all inserted records on failure", async () => {
    const rollbackSessionId = `ses_rollback_${Date.now()}`;
    const rollbackActivityId = `act_rollback_${Date.now()}`;

    let caughtError: Error | null = null;
    try {
      await db.transaction(async (tx) => {
        // Statement 1: Insert valid session
        await tx.execute(
          sql`INSERT INTO sessions (id, name, repository, prompt, state, created_at, updated_at)
              VALUES (${rollbackSessionId}, 'Rollback Session', 'org/repo', 'prompt', 'PLANNING', NOW(), NOW())`,
        );

        // Statement 2: Insert valid activity referencing that session
        await tx.execute(
          sql`INSERT INTO activities (id, session_id, type, created_at)
              VALUES (${rollbackActivityId}, ${rollbackSessionId}, 'PLAN_GENERATED', NOW())`,
        );

        // Trigger controlled failure before transaction commits
        throw new Error("Controlled rollback trigger");
      });
    } catch (err: unknown) {
      caughtError = err as Error;
    }

    expect(caughtError?.message).toBe("Controlled rollback trigger");

    // Prove NEITHER record persisted in the database after the transaction aborted
    const sessionCheck = await db.execute(
      sql`SELECT id FROM sessions WHERE id = ${rollbackSessionId}`,
    );
    expect(sessionCheck.rows.length).toBe(0);

    const activityCheck = await db.execute(
      sql`SELECT id FROM activities WHERE id = ${rollbackActivityId}`,
    );
    expect(activityCheck.rows.length).toBe(0);
  });

  it("records audit events and approval requests accurately", async () => {
    const sessionId = `ses_audit_${Date.now()}`;
    const activityId = `act_audit_${Date.now()}`;
    const decisionId = `dec_audit_${Date.now()}`;
    const approvalId = `appr_audit_${Date.now()}`;

    await sessionRepo.upsert({
      id: sessionId,
      name: "Audit Test",
      repository: "octocat/audit-repo",
      prompt: "Audit trail test",
      state: "AWAITING_USER_INPUT",
    });

    await activityRepo.create({
      id: activityId,
      sessionId,
      type: "AGENT_MESSAGE",
      rawPayload: {},
    });

    await decisionRepo.create({
      id: decisionId,
      sessionId,
      activityId,
      idempotencyKey: `idem_audit_${Date.now()}`,
      action: "APPROVE_PLAN",
      risk: "high",
      confidence: 0.9,
      reason: "Audit approval test",
      provider: "openai",
      model: "gpt-4o",
      contextDigest: "c".repeat(64),
      executionState: "AWAITING_APPROVAL",
    });

    const approval = await approvalRepo.create({
      id: approvalId,
      decisionId,
      sessionId,
      status: "PENDING",
      action: "APPROVE_PLAN",
      proposedResponse: "Approve plan step",
    });
    expect(approval.status).toBe("PENDING");

    const updatedApproval = await approvalRepo.updateStatus(
      approvalId,
      "APPROVED",
      "human_reviewer_01",
      undefined,
      "Approved after manual code review",
    );
    expect(updatedApproval?.status).toBe("APPROVED");
    expect(updatedApproval?.reviewer).toBe("human_reviewer_01");

    const auditEvent = await auditRepo.record({
      id: `aud_${Date.now()}`,
      actor: "human_reviewer_01",
      actorType: "HUMAN",
      action: "APPROVAL_GRANTED",
      targetType: "DECISION",
      targetId: decisionId,
      sessionId,
      decisionId,
      afterState: { status: "APPROVED" },
    });
    expect(auditEvent.actor).toBe("human_reviewer_01");
  });

  it("proves concurrent double-submit on approval request guarantees exactly one winner and one rejection", async () => {
    const sessionId = `ses_race_${Date.now()}`;
    const activityId = `act_race_${Date.now()}`;
    const decisionId = `dec_race_${Date.now()}`;
    const approvalId = `appr_race_${Date.now()}`;

    await sessionRepo.upsert({
      id: sessionId,
      name: "Race Test",
      repository: "octocat/race-repo",
      prompt: "Race test",
      state: "AWAITING_PLAN_APPROVAL",
    });

    await activityRepo.create({
      id: activityId,
      sessionId,
      type: "PLAN_GENERATED",
      rawPayload: {},
    });

    await decisionRepo.create({
      id: decisionId,
      sessionId,
      activityId,
      idempotencyKey: `idem_race_${Date.now()}`,
      action: "APPROVE_PLAN",
      risk: "high",
      confidence: 0.95,
      reason: "Race test",
      provider: "openai",
      model: "gpt-4o",
      contextDigest: "d".repeat(64),
      executionState: "AWAITING_APPROVAL",
    });

    // Insert pending approval request
    await approvalRepo.create({
      id: approvalId,
      decisionId,
      sessionId,
      status: "PENDING",
      action: "APPROVE_PLAN",
      proposedResponse: "Approve plan step",
    });

    // Fire TWO concurrent updateStatus requests simultaneously
    const [result1, result2] = await Promise.all([
      approvalRepo.updateStatus(approvalId, "APPROVED", "operator_alpha"),
      approvalRepo.updateStatus(approvalId, "REJECTED", "operator_beta"),
    ]);

    // Exactly ONE request succeeds; the other returns null (atomic CAS failure)
    const successCount = (result1 !== null ? 1 : 0) + (result2 !== null ? 1 : 0);
    const rejectedCount = (result1 === null ? 1 : 0) + (result2 === null ? 1 : 0);

    expect(successCount).toBe(1);
    expect(rejectedCount).toBe(1);

    // Verify DB persisted exactly the winner's status
    const finalRecord = await approvalRepo.findById(approvalId);
    expect(finalRecord).not.toBeNull();
    expect(["APPROVED", "REJECTED"]).toContain(finalRecord!.status);
    expect(finalRecord!.status).toBe(result1 ? "APPROVED" : "REJECTED");
  });

  it("runInTransaction commits ALL repo writes atomically on success", async () => {
    const sessionId = `ses_txc_${Date.now()}`;
    const activityId = `act_txc_${Date.now()}`;
    const decisionId = `dec_txc_${Date.now()}`;
    const auditId = `aud_txc_${Date.now()}`;

    await sessionRepo.upsert({
      id: sessionId,
      name: "Tx Commit Test",
      repository: "octocat/txc-repo",
      prompt: "Tx commit test",
      state: "AWAITING_USER_INPUT",
    });
    await activityRepo.create({
      id: activityId,
      sessionId,
      type: "AGENT_MESSAGE",
      rawPayload: {},
    });

    // Mirror the web route pattern: construct tx-bound repos inside the helper.
    const decision = await runInTransaction(db, async (tx) => {
      const txDecision = new DecisionRepository(tx);
      const txAudit = new AuditRepository(tx);
      const created = await txDecision.create({
        id: decisionId,
        sessionId,
        activityId,
        idempotencyKey: `idem_txc_${Date.now()}`,
        action: "RESPOND",
        risk: "low",
        confidence: 0.9,
        reason: "Tx commit decision",
        provider: "openai",
        model: "gpt-4o",
        contextDigest: "e".repeat(64),
        executionState: "EXECUTED",
      });
      await txAudit.record({
        id: auditId,
        actor: "integration-test",
        actorType: "SYSTEM",
        action: "DECISION_RECORDED",
        targetType: "decision",
        targetId: decisionId,
        sessionId,
        decisionId,
      });
      return created;
    });

    expect(decision.id).toBe(decisionId);
    // Both the decision AND the audit event committed together.
    const decCheck = await db.execute(sql`SELECT id FROM decisions WHERE id = ${decisionId}`);
    expect(decCheck.rows.length).toBe(1);
    const auditCheck = await db.execute(sql`SELECT id FROM audit_events WHERE id = ${auditId}`);
    expect(auditCheck.rows.length).toBe(1);
  });

  it("runInTransaction rolls back ALL repo writes when a later step throws", async () => {
    const sessionId = `ses_txr_${Date.now()}`;
    const activityId = `act_txr_${Date.now()}`;
    const decisionId = `dec_txr_${Date.now()}`;
    const auditId = `aud_txr_${Date.now()}`;

    await sessionRepo.upsert({
      id: sessionId,
      name: "Tx Rollback Test",
      repository: "octocat/txr-repo",
      prompt: "Tx rollback test",
      state: "AWAITING_USER_INPUT",
    });
    await activityRepo.create({
      id: activityId,
      sessionId,
      type: "AGENT_MESSAGE",
      rawPayload: {},
    });

    // Mirror the approval route pattern: update + decision stamp + audit + budget.
    await expect(
      runInTransaction(db, async (tx) => {
        const txDecision = new DecisionRepository(tx);
        const txAudit = new AuditRepository(tx);
        await txDecision.create({
          id: decisionId,
          sessionId,
          activityId,
          idempotencyKey: `idem_txr_${Date.now()}`,
          action: "RESPOND",
          risk: "low",
          confidence: 0.9,
          reason: "Tx rollback decision",
          provider: "openai",
          model: "gpt-4o",
          contextDigest: "f".repeat(64),
          executionState: "EXECUTED",
        });
        await txAudit.record({
          id: auditId,
          actor: "integration-test",
          actorType: "SYSTEM",
          action: "DECISION_RECORDED",
          targetType: "decision",
          targetId: decisionId,
          sessionId,
          decisionId,
        });
        // A later step fails (e.g. an audit or budget write) — the whole batch
        // must roll back, leaving no decision and no audit behind.
        throw new Error("simulated downstream failure after writes");
      }),
    ).rejects.toThrow("simulated downstream failure after writes");

    // NEITHER the decision NOR the audit persisted — atomic rollback.
    const decCheck = await db.execute(sql`SELECT id FROM decisions WHERE id = ${decisionId}`);
    expect(decCheck.rows.length).toBe(0);
    const auditCheck = await db.execute(sql`SELECT id FROM audit_events WHERE id = ${auditId}`);
    expect(auditCheck.rows.length).toBe(0);
    // The session/activity committed OUTSIDE the transaction are untouched.
    const sesCheck = await db.execute(sql`SELECT id FROM sessions WHERE id = ${sessionId}`);
    expect(sesCheck.rows.length).toBe(1);
  });
});
