import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getToken } from "next-auth/jwt";
import { getConfig } from "@jules/config";
import {
  ApprovalRepository,
  AuditRepository,
  BudgetRepository,
  DecisionRepository,
  OutboxRepository,
  getDatabase,
  runInTransaction,
} from "@jules/db";
import { sanitizeForLogs } from "@jules/shared";

const ApprovalActionBodySchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "EDITED", "CANCELLED"]),
  // Backward compatible: caller may still send a reviewer, but the authoritative
  // actor is ALWAYS resolved from the session token (defence-in-depth against
  // audit-trail spoofing). A client-supplied reviewer is never trusted.
  reviewer: z.string().optional(),
  modifiedResponse: z.string().optional(),
  comment: z.string().optional(),
});

function deriveHumanAction(
  status: string,
  modifiedResponse: string | undefined,
  proposedResponse: string | null,
): string {
  switch (status) {
    case "APPROVED":
      // Distinguish a rubber-stamp from an approval that required edits.
      return modifiedResponse !== undefined && modifiedResponse !== proposedResponse
        ? "APPROVED_AFTER_EDIT"
        : "APPROVED_UNCHANGED";
    case "EDITED":
      return "APPROVED_AFTER_EDIT";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  try {
    // Resolve the authoritative actor from the session token. A client-supplied
    // reviewer is never trusted for audit attribution or state transitions.
    const token = await getToken({ req });
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const reviewer = (token?.name as string | undefined) ?? "authenticated-operator";

    const body = await req.json();
    const parsed = ApprovalActionBodySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: parsed.error.issues },
        { status: 400 },
      );
    }

    try {
      const config = getConfig();
      const db = getDatabase(config.DATABASE_URL);
      const approvalRepo = new ApprovalRepository(db);

      const existing = await approvalRepo.findById(id);
      if (!existing) {
        return NextResponse.json({ error: "Approval request not found" }, { status: 404 });
      }

      if (existing.status !== "PENDING") {
        return NextResponse.json(
          { error: `Approval request already resolved with status ${existing.status}` },
          { status: 409 },
        );
      }

      // --- Human Feedback Correlation (outcome tracking) ---
      // C3 transactional atomicity: the approval status change, the decision
      // verdict + final-value stamp, the audit trail, and any budget correction
      // commit together (or not at all). The operator's verdict cannot persist
      // half-applied — e.g. a decision stamped APPROVED with no audit record, or
      // a REJECTED rejection not counted against the session budget.
      const updated = await runInTransaction(db, async (tx) => {
        const txApprovalRepo = new ApprovalRepository(tx);
        const txDecisionRepo = new DecisionRepository(tx);
        const txBudgetRepo = new BudgetRepository(tx);
        const txAuditRepo = new AuditRepository(tx);
        const txOutboxRepo = new OutboxRepository(tx);

        const u = await txApprovalRepo.updateStatus(
          id,
          parsed.data.status,
          reviewer,
          parsed.data.modifiedResponse,
          parsed.data.comment,
        );
        if (!u) return null;

        const humanAction = deriveHumanAction(
          parsed.data.status,
          parsed.data.modifiedResponse,
          u.proposedResponse,
        );

        if (u.decisionId) {
          await txDecisionRepo.recordHumanFeedback(
            u.decisionId,
            humanAction,
            parsed.data.comment,
          );

          // P1 Phase 8: persist the exact final approved value on the
          // decision so the audit trail captures what was sanctioned.
          if (
            (parsed.data.status === "APPROVED" || parsed.data.status === "EDITED") &&
            parsed.data.modifiedResponse !== undefined
          ) {
            await txDecisionRepo.recordFinalApprovedResponse(
              u.decisionId,
              parsed.data.modifiedResponse,
            );
          } else if (parsed.data.status === "APPROVED") {
            await txDecisionRepo.recordFinalApprovedResponse(
              u.decisionId,
              u.proposedResponse ?? "",
            );
          }

          // R02: Durable Outbox Dispatch Model
          // When an operator sanctions an action, stage the outbox record
          // atomically in the SAME transaction. If the worker crashes before
          // dispatch, the durable outbox item is recovered and executed.
          if (parsed.data.status === "APPROVED" || parsed.data.status === "EDITED") {
            const approvedPayload =
              parsed.data.modifiedResponse ?? u.proposedResponse ?? "";
            await txDecisionRepo.markExecuted(
              u.decisionId,
              "DISPATCH_REQUESTED",
              parsed.data.comment ?? `Operator sanctioned action ${u.action}`,
            );
            await txOutboxRepo.create({
              id: `outbox_${randomUUID()}`,
              sessionId: u.sessionId,
              decisionId: u.decisionId,
              action: u.action,
              payload: approvedPayload,
            });
          }

          await txAuditRepo.record({
            id: `aud_fb_${randomUUID()}`,
            actor: reviewer,
            actorType: "HUMAN",
            action: `HUMAN_FEEDBACK_${humanAction}`,
            targetType: "decision",
            targetId: u.decisionId,
            sessionId: u.sessionId,
            decisionId: u.decisionId,
            metadata: {
              approvalId: id,
              status: parsed.data.status,
              commentRedacted: parsed.data.comment
                ? sanitizeForLogs(parsed.data.comment).slice(0, 500)
                : null,
            },
          });

          // Corrections (rejections) count against the session autonomy budget.
          if (parsed.data.status === "REJECTED" || parsed.data.status === "CANCELLED") {
            await txDecisionRepo.markExecuted(
              u.decisionId,
              "BLOCKED",
              parsed.data.comment ?? `Human operator marked ${parsed.data.status}`,
            );
            if (parsed.data.status === "REJECTED") {
              await txBudgetRepo.incrementCorrections(u.sessionId);
            }
          }
        }
        return u;
      });

      if (!updated) {
        return NextResponse.json({ error: "Approval request not found" }, { status: 404 });
      }

      return NextResponse.json({
        success: true,
        approvalId: id,
        status: updated.status,
        reviewer,
        timestamp: new Date().toISOString(),
      });
    } catch {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
