/**
 * @zinid/sdk-web — vendor-facing SDK for ZinID hosted verification flows.
 *
 * Load a session URL issued by your backend in one of three modes:
 *
 *   const flow = ZinID.createFlow({ url, mode: 'modal', onComplete });
 *   flow.mount();
 */
export { createFlow } from './flow';
export type { ZinIDFlow } from './flow';
export type {
  CancelPayload,
  CompletePayload,
  ErrorPayload,
  ReadyPayload,
  SessionStatus,
  StepChangePayload,
  ZinIDEventHandler,
  ZinIDEventMap,
  ZinIDEventName,
  ZinIDFlowMode,
  ZinIDFlowOptions,
} from './types';
