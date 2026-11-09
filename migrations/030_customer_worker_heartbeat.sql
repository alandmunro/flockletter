BEGIN;
-- Operational process metadata only: no customer, workspace, host or credential identifiers.
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.worker_instances (
  instance_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('embedded','dedicated')),
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  stopped_at timestamptz
);
REVOKE ALL ON flockletter_customer_jobs.worker_instances FROM PUBLIC;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.worker_heartbeat(worker_kind text, instance uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF worker_kind IS NULL OR worker_kind NOT IN ('embedded','dedicated') OR instance IS NULL THEN
    RAISE EXCEPTION 'Invalid worker heartbeat';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('flockletter:worker-heartbeats'));
  DELETE FROM flockletter_customer_jobs.worker_instances
    WHERE coalesce(stopped_at,heartbeat_at)<clock_timestamp()-interval '1 day';
  DELETE FROM flockletter_customer_jobs.worker_instances w WHERE w.stopped_at IS NOT NULL
    AND w.instance_id NOT IN(SELECT recent.instance_id FROM flockletter_customer_jobs.worker_instances recent
      WHERE recent.stopped_at IS NOT NULL ORDER BY recent.stopped_at DESC LIMIT 16);
  IF NOT EXISTS(SELECT FROM flockletter_customer_jobs.worker_instances WHERE instance_id=instance)
     AND (SELECT count(*) FROM flockletter_customer_jobs.worker_instances)>=64 THEN
    RAISE EXCEPTION 'Worker heartbeat capacity requires review';
  END IF;
  INSERT INTO flockletter_customer_jobs.worker_instances(instance_id,kind,started_at,heartbeat_at)
    VALUES(instance,worker_kind,clock_timestamp(),clock_timestamp())
    ON CONFLICT(instance_id) DO UPDATE SET heartbeat_at=clock_timestamp()
    WHERE flockletter_customer_jobs.worker_instances.kind=excluded.kind
      AND flockletter_customer_jobs.worker_instances.stopped_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Worker heartbeat instance cannot be reused'; END IF;
END $$;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.worker_stop(worker_kind text, instance uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF worker_kind IS NULL OR worker_kind NOT IN ('embedded','dedicated') OR instance IS NULL THEN
    RAISE EXCEPTION 'Invalid worker heartbeat';
  END IF;
  UPDATE flockletter_customer_jobs.worker_instances SET stopped_at=clock_timestamp()
    WHERE instance_id=instance AND kind=worker_kind AND stopped_at IS NULL;
END $$;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.worker_liveness(worker_kind text)
RETURNS TABLE(state text,observed_at timestamptz,started_at timestamptz,heartbeat_at timestamptz,stopped_at timestamptz,freshness_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF worker_kind IS NULL OR worker_kind NOT IN ('embedded','dedicated') THEN
    RAISE EXCEPTION 'Invalid worker heartbeat';
  END IF;
  RETURN QUERY
  WITH observation AS (SELECT clock_timestamp() checked_at), latest AS (
    SELECT w.started_at,w.heartbeat_at,w.stopped_at FROM flockletter_customer_jobs.worker_instances w
    WHERE w.kind=worker_kind
    ORDER BY (w.stopped_at IS NULL) DESC,w.heartbeat_at DESC LIMIT 1
  )
  SELECT CASE WHEN latest.heartbeat_at IS NULL THEN 'unknown'
      WHEN latest.heartbeat_at>observation.checked_at THEN 'unknown'
      WHEN latest.stopped_at IS NOT NULL THEN 'stopped'
      WHEN latest.heartbeat_at>=observation.checked_at-interval '60 seconds' THEN 'fresh'
      ELSE 'stale' END,
    observation.checked_at,latest.started_at,latest.heartbeat_at,latest.stopped_at,60
  FROM observation LEFT JOIN latest ON true;
END $$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.worker_heartbeat(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.worker_stop(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.worker_liveness(text) FROM PUBLIC;
COMMIT;
