export const supportTopics=['plans','trial','audience','campaigns','billing','security','privacy','recovery','other'] as const;
export type SupportTopic=(typeof supportTopics)[number];
