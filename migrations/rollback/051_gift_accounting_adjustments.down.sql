-- Refuse a rollback that would discard accounting adjustments.
BEGIN;
ALTER TABLE flockletter_retention_control.gift_accounting DROP CONSTRAINT gift_accounting_kind_check;
ALTER TABLE flockletter_retention_control.gift_accounting ADD CONSTRAINT gift_accounting_kind_check
  CHECK (kind IN ('purchased','reserved','claimed','expired','refunded',
    'dispute_warning_needs_response','dispute_warning_under_review','dispute_warning_closed',
    'dispute_needs_response','dispute_under_review','dispute_won','dispute_lost','dispute_prevented'));
COMMIT;
