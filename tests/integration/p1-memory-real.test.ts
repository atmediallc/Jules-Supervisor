import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDatabase,
  closeDatabase,
  SessionRepository,
  ActivityRepository,
  DecisionRepository,
  RepositoryKnowledgeRepository,
  sql,
} from "@jules/db";

const TEST_DB_URL =
  process.env["DATABASE_URL"] ||
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

/**
 * P1 real-services validation (Fase 80).
 *
 * Proves against the real PostgreSQL 16 instance (no mocks, no in-memory):
 * - decisions.findPrecedents with repository scoping via sessions JOIN
 * - decision outcome / human feedback / final approved response persistence
 * - repository_knowledge upsert (exact dedup + supersession), listActive
 *   scope isolation, delete, countActive
 * Relational only: no vectors, no embeddings anywhere in this suite.
 */
describe("P1 Memory & Knowledge — Real PostgreSQL", () => {
  let db: ReturnType<typeof getDatabase>;
  let sessionRepo: SessionRepository;
  let activityRepo: ActivityRepository;
  let decisionRepo: DecisionRepository;
  let knowledgeRepo: RepositoryKnowledgeRepository;

  const REPO = `p1-integration/${randomUUID()}`;
  const OTHER_REPO = `p1-other/${randomUUID()}`;

  beforeAll(async () => {
    db = getDatabase(TEST_DB_URL);
    sessionRepo = new SessionRepository(db);
    activityRepo = new ActivityRepository(db);
    decisionRepo = new DecisionRepository(db);
    knowledgeRepo = new RepositoryKnowledgeRepository(db);
  });

  afterAll(async () => {
    // Clean up P1 integration rows to leave the shared database tidy.
    await db.execute(
      sql`DELETE FROM decisions WHERE session_id IN (SELECT id FROM sessions WHERE repository IN (${REPO}, ${OTHER_REPO}))`,
    );
    await db.execute(
      sql`DELETE FROM activities WHERE session_id IN (SELECT id FROM sessions WHERE repository IN (${REPO}, ${OTHER_REPO}))`,
    );
    await db.execute(sql`DELETE FROM sessions WHERE repository IN (${REPO}, ${OTHER_REPO})`);
    await db.execute(sql`DELETE FROM repository_knowledge WHERE repository_id IN (${REPO}, ${OTHER_REPO})`);
    await closeDatabase();
  });

  async function seedDecision(
    repository: string,
    suffix: string,
    reason: string,
  ): Promise<string> {
    const sessionId = `ses_p1_${suffix}`;
    const activityId = `act_p1_${suffix}`;
    const decisionId = `dec_p1_${suffix}`;

    await sessionRepo.upsert({
      id: sessionId,
      name: `P1 ${suffix}`,
      repository,
      prompt: "p1 integration seed",
    });

    await activityRepo.create({
      id: activityId,
      sessionId,
      type: "AGENT_MESSAGE",
      content: reason,
      rawPayload: {},
    });

    await decisionRepo.create({
      id: decisionId,
      sessionId,
      activityId,
      idempotencyKey: `idem_p1_${suffix}`,
      action: "EXECUTE_COMMAND",
      risk: "low",
      confidence: 0.9,
      reason,
      provider: "openai",
      model: "gpt-4o",
      contextDigest: "p".repeat(64),
      executionState: "DRY_RUN_COMPLETED",
    });

    return decisionId;
  }

  it("proves findPrecedents scopes by repository through the sessions JOIN", async () => {
    const mineId = await seedDecision(REPO, "scope_a", "p1 precedent seed A");
    await decisionRepo.recordOutcome(mineId, "EXECUTED_ACCEPTED", "matched expectations");

    const otherId = await seedDecision(OTHER_REPO, "scope_b", "p1 precedent seed B");
    await decisionRepo.recordOutcome(otherId, "EXECUTED_ACCEPTED", "ok");

    const mine = await decisionRepo.findPrecedents({ repositoryId: REPO, limit: 10 });
    expect(mine.some((d) => d.id === mineId)).toBe(true);
    expect(mine.every((d) => d.id !== otherId)).toBe(true);
    const found = mine.find((d) => d.id === mineId)!;
    expect(found.outcome).toBe("EXECUTED_ACCEPTED");
    expect(found.outcomeObservedAt).not.toBeNull();

    const others = await decisionRepo.findPrecedents({ repositoryId: OTHER_REPO, limit: 10 });
    expect(others.some((d) => d.id === otherId)).toBe(true);
    expect(others.every((d) => d.id !== mineId)).toBe(true);
  });

  it("proves excludeSessionId hides the current session's own decisions", async () => {
    const decisionId = await seedDecision(REPO, "excl", "current session decision");
    await decisionRepo.recordOutcome(decisionId, "EXECUTED_ACCEPTED", "ok");

    const withOwn = await decisionRepo.findPrecedents({ repositoryId: REPO, limit: 50 });
    expect(withOwn.some((d) => d.id === decisionId)).toBe(true);

    const excluded = await decisionRepo.findPrecedents({
      repositoryId: REPO,
      excludeSessionId: "ses_p1_excl",
      limit: 50,
    });
    expect(excluded.some((d) => d.id === decisionId)).toBe(false);
  });

  it("proves recordHumanFeedback and recordFinalApprovedResponse persist on real PG", async () => {
    const decisionId = await seedDecision(REPO, "hf", "human feedback target");
    await decisionRepo.recordOutcome(decisionId, "EXECUTED_ACCEPTED", "executed fine");
    await decisionRepo.recordHumanFeedback(decisionId, "APPROVE", "operator approved");
    await decisionRepo.recordFinalApprovedResponse(decisionId, "final approved response text");

    const stored = await decisionRepo.findById(decisionId);
    expect(stored!.humanAction).toBe("APPROVE");
    expect(stored!.humanReason).toBe("operator approved");
    expect(stored!.humanReviewedAt).not.toBeNull();
    expect(stored!.finalApprovedResponse).toBe("final approved response text");
  });

  it("proves a human REJECTION is stamped as a verified REJECTED outcome", async () => {
    const decisionId = await seedDecision(REPO, "rej", "to be rejected");
    await decisionRepo.recordHumanFeedback(decisionId, "REJECTED", "dangerous command");

    const stored = await decisionRepo.findById(decisionId);
    expect(stored!.humanAction).toBe("REJECTED");
    expect(stored!.outcome).toBe("REJECTED");
    expect(stored!.outcomeObservedAt).not.toBeNull();
  });

  it("proves knowledge upsert deduplicates exact content and supersedes changed content", async () => {
    // v1 from a known file path.
    const first = await knowledgeRepo.upsert({
      id: `kn_${randomUUID()}`,
      repositoryId: REPO,
      knowledgeType: "BUILD_COMMAND",
      sourceType: "HUMAN_OPERATOR",
      sourcePath: "docs/BUILD.md",
      sourceHash: "hash_v1",
      content: "pnpm turbo build",
    });

    // Same path, same hash: exact dedup — no second row is created.
    const again = await knowledgeRepo.upsert({
      id: `kn_${randomUUID()}`,
      repositoryId: REPO,
      knowledgeType: "BUILD_COMMAND",
      sourceType: "HUMAN_OPERATOR",
      sourcePath: "docs/BUILD.md",
      sourceHash: "hash_v1",
      content: "pnpm turbo build",
    });
    expect(again.id).toBe(first.id);

    // Same path, changed content: the old row is superseded, only v2 is active.
    const changed = await knowledgeRepo.upsert({
      id: `kn_${randomUUID()}`,
      repositoryId: REPO,
      knowledgeType: "BUILD_COMMAND",
      sourceType: "HUMAN_OPERATOR",
      sourcePath: "docs/BUILD.md",
      sourceHash: "hash_v2",
      content: "pnpm turbo build --force",
    });
    expect(changed.id).not.toBe(first.id);

    const active = await knowledgeRepo.listActive({ repositoryId: REPO });
    expect(active.some((k) => k.id === changed.id)).toBe(true);
    // The superseded row must not be served.
    expect(active.some((k) => k.id === first.id)).toBe(false);

    const old = await knowledgeRepo.findById(first.id);
    expect(old!.supersededBy).toBe(changed.id);
  });

  it("proves listActive never leaks knowledge across repositories", async () => {
    await knowledgeRepo.upsert({
      id: `kn_${randomUUID()}`,
      repositoryId: OTHER_REPO,
      knowledgeType: "CONVENTION",
      sourceType: "HUMAN_OPERATOR",
      sourceHash: "hash_other_repo",
      content: "other repo secret convention",
    });

    const mine = await knowledgeRepo.listActive({ repositoryId: REPO, limit: 50 });
    expect(mine.every((k) => k.repositoryId === REPO)).toBe(true);
    expect(mine.some((k) => k.content === "other repo secret convention")).toBe(false);
  });

  it("proves knowledge delete and countActive on real PG", async () => {
    const before = await knowledgeRepo.countActive(REPO);
    const row = await knowledgeRepo.upsert({
      id: `kn_${randomUUID()}`,
      repositoryId: REPO,
      knowledgeType: "TEST_COMMAND",
      sourceType: "HUMAN_OPERATOR",
      sourceHash: "hash_delete_me",
      content: "pnpm turbo test",
    });
    expect(await knowledgeRepo.countActive(REPO)).toBe(before + 1);

    const deleted = await knowledgeRepo.delete(row.id);
    expect(deleted).toBe(true);
    expect(await knowledgeRepo.findById(row.id)).toBeNull();
    expect(await knowledgeRepo.countActive(REPO)).toBe(before);
  });
});
