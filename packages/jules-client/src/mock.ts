import { IJulesClient } from "./client.js";
import {
  ApprovePlanRequest,
  JulesActivity,
  JulesMutationAck,
  JulesSession,
  ListActivitiesResponse,
  ListSessionsResponse,
  SendMessageRequest,
} from "./schemas.js";

export interface MockJulesHooks {
  onSendMessage?: (sessionId: string, req: SendMessageRequest) => void;
  onApprovePlan?: (sessionId: string, req?: ApprovePlanRequest) => void;
  shouldFail?: (endpoint: string) => Error | null;
}

export class MockJulesClient implements IJulesClient {
  public sessions: Map<string, JulesSession> = new Map();
  public activities: Map<string, JulesActivity[]> = new Map();
  public sentMessages: Array<{ sessionId: string; request: SendMessageRequest }> = [];
  public approvedPlans: Array<{ sessionId: string; request?: ApprovePlanRequest }> = [];
  public hooks: MockJulesHooks = {};

  constructor() {
    this.seedDefaultData();
  }

  public seedDefaultData(): void {
    const session1: JulesSession = {
      id: "ses_test_001",
      name: "sessions/ses_test_001",
      title: "Add rate limiting to auth routes",
      repository: "owner/repo",
      branch: "main",
      prompt: "Please add Redis token bucket rate limiting to our auth endpoints",
      state: "AWAITING_USER_INPUT",
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      metadata: {},
    };

    const session2: JulesSession = {
      id: "ses_test_002",
      name: "sessions/ses_test_002",
      title: "Review database migration plan",
      repository: "owner/repo",
      branch: "feat/db",
      prompt: "Migrate user table to add multi-factor authentication column",
      state: "AWAITING_PLAN_APPROVAL",
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      metadata: {},
    };

    this.sessions.set(session1.id, session1);
    this.sessions.set(session2.id, session2);

    this.activities.set(session1.id, [
      {
        id: "act_101",
        sessionId: session1.id,
        type: "AGENT_MESSAGE",
        content: "Should rate limiting apply per IP address or per authenticated user ID?",
        createTime: new Date(Date.now() - 60000).toISOString(),
      },
    ]);

    this.activities.set(session2.id, [
      {
        id: "act_201",
        sessionId: session2.id,
        type: "PLAN_GENERATED",
        content: "Drafted database migration plan",
        plan: {
          steps: [
            { id: 1, description: "Create migration 0004_add_mfa.sql", status: "PENDING" },
            { id: 2, description: "Update schema definitions", status: "PENDING" },
          ],
        },
        createTime: new Date(Date.now() - 30000).toISOString(),
      },
    ]);
  }

  public async listSessions(): Promise<ListSessionsResponse> {
    const err = this.hooks.shouldFail?.("listSessions");
    if (err) throw err;
    return {
      sessions: Array.from(this.sessions.values()),
    };
  }

  public async getSession(sessionId: string): Promise<JulesSession> {
    const err = this.hooks.shouldFail?.("getSession");
    if (err) throw err;
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found in mock`);
    return session;
  }

  public async listActivities(sessionId: string): Promise<ListActivitiesResponse> {
    const err = this.hooks.shouldFail?.("listActivities");
    if (err) throw err;
    const acts = this.activities.get(sessionId) || [];
    return { activities: [...acts] };
  }

  public async getActivity(sessionId: string, activityId: string): Promise<JulesActivity> {
    const err = this.hooks.shouldFail?.("getActivity");
    if (err) throw err;
    const acts = this.activities.get(sessionId) || [];
    const act = acts.find((a) => a.id === activityId);
    if (!act) throw new Error(`Activity ${activityId} not found in session ${sessionId}`);
    return act;
  }

  public async sendMessage(sessionId: string, request: SendMessageRequest): Promise<JulesMutationAck> {
    const err = this.hooks.shouldFail?.("sendMessage");
    if (err) throw err;
    this.hooks.onSendMessage?.(sessionId, request);
    this.sentMessages.push({ sessionId, request });

    const messageContent = request.prompt ?? request.message ?? "";
    const newActivity: JulesActivity = {
      id: `act_mock_${Date.now()}`,
      sessionId,
      type: "USER_MESSAGE",
      content: messageContent,
      createTime: new Date().toISOString(),
    };

    const acts = this.activities.get(sessionId) || [];
    acts.push(newActivity);
    this.activities.set(sessionId, acts);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "IN_PROGRESS";
      session.updateTime = new Date().toISOString();
    }

    return { acknowledged: true };
  }

  public async approvePlan(sessionId: string, request?: ApprovePlanRequest): Promise<JulesMutationAck> {
    const err = this.hooks.shouldFail?.("approvePlan");
    if (err) throw err;
    this.hooks.onApprovePlan?.(sessionId, request);
    this.approvedPlans.push({ sessionId, request: request ?? {} });

    const approved = request?.approved ?? true;
    const newActivity: JulesActivity = {
      id: `act_mock_plan_${Date.now()}`,
      sessionId,
      type: approved ? "PLAN_APPROVED" : "PLAN_REJECTED",
      content: request?.feedback || (approved ? "Plan approved" : "Plan rejected"),
      createTime: new Date().toISOString(),
    };

    const acts = this.activities.get(sessionId) || [];
    acts.push(newActivity);
    this.activities.set(sessionId, acts);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = approved ? "IN_PROGRESS" : "PLANNING";
      session.updateTime = new Date().toISOString();
    }

    return { acknowledged: true };
  }
}
