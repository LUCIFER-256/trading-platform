import type { OrderIntent } from "../../trading/src";

export type ExecutionMode = "paper" | "live";
export type ExecutionSubmissionResult =
  | { readonly status: "accepted"; readonly externalReference: string }
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string };

/** Contract only. No adapter implementation, provider behavior, or live pathway exists in Phase 1. */
export interface ExecutionAdapter {
  readonly mode: ExecutionMode;
  submit(intent: OrderIntent): Promise<ExecutionSubmissionResult>;
  cancel(orderId: string): Promise<ExecutionSubmissionResult>;
}
