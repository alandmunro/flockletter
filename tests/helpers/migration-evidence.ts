import { releaseSourceFingerprint, type MigrationEvidence } from '../../scripts/release-plan.mjs';

export async function fixtureMigrationEvidence(environment:string):Promise<MigrationEvidence> {
  const current='a'.repeat(40);
  return {ok:true,version:1,environment,webRevision:current,workerRevision:current,candidateRevision:'b'.repeat(40),
    sourceFingerprint:await releaseSourceFingerprint(),checked:[current],checkedAt:new Date().toISOString()};
}
