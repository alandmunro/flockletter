export type SendingPhase = 'new' | 'established' | 'full' | 'limited';
export type SendingTrustStatus = {
 phase:SendingPhase;dailyLimit:number|null;usedToday:number;held:boolean;warning:boolean;
 codes:string[];reasons:string[];observedAt:string;revision:number;ageDays:number;delivered:number;
};
export const sendingReasons:Record<string,string> = {
 sending_reputation_hold:'Sending is paused after bounce or complaint feedback. A platform operator must review it; changing plans or retrying cannot clear the hold.',
 sending_daily_limit:'The workspace has reached its UTC daily sending limit across all brands. Remaining recipients wait for the next day.',
 sending_provider_usage_unavailable:'Current Resend usage could not be verified. Live Resend submissions wait for a fresh account check.',
 sending_provider_capacity:'The shared delivery service has reached its safety reserve. Sending waits for operator capacity review; no paid overage is enabled.',
 sending_rate_wait:'Messages are paced at one per second per workspace and two per second across the platform.',
};
