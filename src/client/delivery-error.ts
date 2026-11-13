import {ApiError} from './api.js';

/** Known, actionable explanations; never infer success or recommend a new send on an uncertain outcome. */
export function explainDeliveryError(error:unknown){
  if(error instanceof ApiError){
    switch(error.code){
      case 'campaign_unavailable':return 'This saved campaign is unavailable in the current brand/workspace. Check the environment and signed-in workspace, then refresh saved campaigns. Do not substitute another draft.';
      case 'version_conflict':return 'The saved campaign version changed. Refresh saved campaigns, then review the exact current version before approving a test.';
      case 'broadcasts_disabled':return 'Group delivery is disabled in test-only mode, including groups named Test. Select one intended confirmed contact in the test panel and review that exact recipient. Do not enable broadcasts to retry a test.';
      case 'group_unavailable':return 'The selected group is unavailable in this brand. Refresh groups and select the intended audience; do not fall back to all contacts.';
      case 'test_daily_limit':return 'The workspace has reached its daily test limit. Refresh the original test to reconcile any pending outcome, or wait until the next UTC day. Cancellation and failure do not restore daily approvals.';
      case 'operation_conflict':return 'This operation key belongs to different inputs. Reopen and reconcile the original test; do not create a replacement while its outcome is unknown.';
      case 'test_already_pending':return 'A test for this campaign and contact is already pending or uncertain. Open that original test in test history and process or reconcile it; do not approve a replacement.';
    }
  }
  return error instanceof Error?error.message:'This action could not finish. Refresh the original test before retrying with the same inputs.';
}
