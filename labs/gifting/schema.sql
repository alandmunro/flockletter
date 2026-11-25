-- Disposable SQLite lab, schema v1. All money columns are integer USD cents.
CREATE TABLE workspace (
  name TEXT PRIMARY KEY, closing INTEGER DEFAULT 0, deficit_day INTEGER,
  operator_hold INTEGER DEFAULT 0, eligible INTEGER DEFAULT 1,
  realtor INTEGER DEFAULT 0, broker_ok INTEGER DEFAULT 0, probation INTEGER DEFAULT 0
) STRICT;
CREATE TABLE platform (
  id INTEGER PRIMARY KEY CHECK(id=1), day INTEGER NOT NULL, funds INTEGER NOT NULL,
  buffer INTEGER NOT NULL, fault TEXT NOT NULL, signing_key TEXT NOT NULL
) STRICT;
CREATE TABLE purchase (
  id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspace(name),
  currency TEXT NOT NULL CHECK(currency='USD'), face INTEGER NOT NULL CHECK(face>0),
  fee INTEGER NOT NULL CHECK(fee>=0), dispute TEXT NOT NULL DEFAULT 'none',
  refund_face INTEGER, refund_fee INTEGER, refunded INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE campaign (
  id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspace(name),
  label TEXT NOT NULL, products TEXT NOT NULL, expires INTEGER NOT NULL, face INTEGER NOT NULL,
  fingerprint TEXT NOT NULL, UNIQUE(workspace,label)
) STRICT;
CREATE TABLE offer (
  id TEXT PRIMARY KEY, campaign TEXT NOT NULL REFERENCES campaign(id), person INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('offered','pending','claimed','expired')),
  claimed_day INTEGER, issue TEXT, UNIQUE(campaign,person)
) STRICT;
CREATE TABLE allocation (
  offer TEXT NOT NULL REFERENCES offer(id), lot TEXT NOT NULL REFERENCES purchase(id),
  amount INTEGER NOT NULL CHECK(amount>0), PRIMARY KEY(offer,lot)
) STRICT;
CREATE TABLE ledger (
  seq INTEGER PRIMARY KEY, day INTEGER NOT NULL, lot TEXT NOT NULL REFERENCES purchase(id),
  kind TEXT NOT NULL, ref TEXT NOT NULL, available INTEGER NOT NULL, reserved INTEGER NOT NULL,
  UNIQUE(lot,kind,ref)
) STRICT;
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'append-only ledger'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'append-only ledger'); END;
-- Model the provider's own authoritative records. Written in a separate transaction from claim settlement.
CREATE TABLE vendor_order (
  external_id TEXT PRIMARY KEY, reward TEXT NOT NULL UNIQUE, face INTEGER NOT NULL,
  products TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('review','approved'))
) STRICT;
CREATE TABLE receipt (
  source TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(source,event_id)
) STRICT;
PRAGMA user_version=1;
