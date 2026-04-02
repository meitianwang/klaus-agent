// Approval system types

export type ApprovalResponse = "approve" | "approve_for_session" | "reject";

export interface ApprovalRequest {
  id: string;
  toolUseId: string;
  sender: string;
  action: string;
  description: string;
}

export interface ApprovalConfig {
  yolo?: boolean;
  autoApproveActions?: string[];
}

export interface Approval {
  request(sender: string, action: string, description: string, toolUseId: string): Promise<boolean>;
  fetchRequest(): Promise<ApprovalRequest>;
  resolve(requestId: string, response: ApprovalResponse): void;
  setYolo(yolo: boolean): void;
  isYolo(): boolean;
  readonly autoApproveActions: Set<string>;
  share(): Approval;
  dispose(): void;
}
