BEGIN;
ALTER TABLE flockletter_retention_control.gift_accounting DROP CONSTRAINT gift_accounting_kind_check;
ALTER TABLE flockletter_retention_control.gift_accounting ADD CONSTRAINT gift_accounting_kind_check
  CHECK (kind IN ('purchased','reserved','claimed','expired','refunded','canceled','external_refund','refund_reversed',
    'dispute_warning_needs_response','dispute_warning_under_review','dispute_warning_closed',
    'dispute_needs_response','dispute_under_review','dispute_won','dispute_lost','dispute_prevented'));
COMMIT;
