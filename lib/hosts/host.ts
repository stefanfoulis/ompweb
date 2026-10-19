import type { RpcTransport } from "../omp/rpc-transport";
import type { SessionOps } from "./session-ops";
import type { WorkspaceOps } from "../workspace-types";

export type HostStatus = "online" | "offline" | "needs-upgrade" | "omp-missing";

/** The link carries traffic: sends, ops and children work. An omp-missing host
 * is linked too; only spawning there fails, with its own error. */
export function isLinkUp(status: HostStatus): boolean {
  return status === "online" || status === "omp-missing";
}

export interface SpawnRequest {
  cwd: string;
  recordedCwd: string | null;
  sessionFile: string;
  toolNames?: string[];
  advisor: boolean;
  /** `provider/modelId` bound at spawn (--model); resume only. */
  spawnModel?: string;
  /**
   * Spawn on a *copy* of another session on this host (`--fork <sourceFile>
   * --fork-at <cutEntryId>`) instead of resuming `sessionFile`, which must be
   * "" then: omp names the fork's file itself. The source file keeps its own
   * (possibly mid-turn) process, which is why a fork works during a run.
   */
  fork?: { sourceFile: string; cutEntryId: string };
}

export interface SpawnResult {
  transport: RpcTransport;
  cwd: string;
  fellBack: boolean;
  /** The host's project launch config forces --advisor. */
  launchAdvisor: boolean;
  /** Actual --advisor flag on a shared channel, independent of this link's requested mode. */
  advisorSpawned?: boolean;
  /** Existing shared channel: startup/ready already completed on the daemon. */
  joined?: boolean;
  pending?: string[];
  streaming?: string | null;
}

/** A machine omp sessions run on. Every machine-local action of a session goes through it. */
export interface Host {
  readonly id: string;
  readonly label: string;
  status(): HostStatus;
  onStatus(listener: (status: HostStatus) => void): () => void;
  spawnRpc(request: SpawnRequest, sessionId?: string | null, options?: { replaceAdvisor?: boolean; preparing?: boolean; expectedChannel?: string }): Promise<SpawnResult>;
  sessionFileExists(path: string): Promise<boolean>;
  invalidateSessionLists(sessionFile?: string): void;
  autoApproveExtension(): boolean;
  /** Session and project file operations, run on this host. */
  readonly sessionOps: SessionOps;
  readonly workspaceOps: WorkspaceOps;
  supportsWorkspaceOp(name: keyof WorkspaceOps): boolean;
}
