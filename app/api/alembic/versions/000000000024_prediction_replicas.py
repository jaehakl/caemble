"""Separate immutable Prediction revisions from their storage copies and operations."""
from alembic import op

revision = "000000000024"
down_revision = "000000000023"
branch_labels = None
depends_on = None

# Frozen DDL: never import evolving application ORM metadata here.
DDL = (
    """
CREATE TABLE prediction_storage_accesses (
	storage_id UUID NOT NULL,
	launcher_id UUID NOT NULL,
	checked_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT pk_prediction_storage_accesses PRIMARY KEY (storage_id, launcher_id),
	CONSTRAINT fk_prediction_storage_accesses_storage_id_prediction_storages FOREIGN KEY(storage_id) REFERENCES prediction_storages (storage_id) ON DELETE CASCADE
)


    """,
    """
CREATE TABLE prediction_replicas (
	id UUID NOT NULL,
	model_id UUID,
	dataset_id UUID,
	revision INTEGER NOT NULL,
	storage_id UUID NOT NULL,
	state TEXT NOT NULL,
	manifest_sha256 TEXT,
	artifact JSONB,
	object_id UUID,
	delete_id UUID,
	checked_at TIMESTAMP WITH TIME ZONE,
	verified_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT pk_prediction_replicas PRIMARY KEY (id),
	CONSTRAINT one_asset CHECK ((model_id IS NULL) <> (dataset_id IS NULL)),
	CONSTRAINT fk_prediction_replicas_model_id_prediction_model_revisions FOREIGN KEY(model_id, revision) REFERENCES prediction_model_revisions (model_id, revision) ON DELETE CASCADE,
	CONSTRAINT fk_prediction_replicas_dataset_id_prediction_dataset_revisions FOREIGN KEY(dataset_id, revision) REFERENCES prediction_dataset_revisions (dataset_id, revision) ON DELETE CASCADE,
	CONSTRAINT uq_prediction_replicas_model_id UNIQUE (model_id, revision, storage_id),
	CONSTRAINT uq_prediction_replicas_dataset_id UNIQUE (dataset_id, revision, storage_id),
	CONSTRAINT fk_prediction_replicas_storage_id_prediction_storages FOREIGN KEY(storage_id) REFERENCES prediction_storages (storage_id) ON DELETE RESTRICT,
	CONSTRAINT fk_prediction_replicas_object_id_storage_objects FOREIGN KEY(object_id) REFERENCES storage_objects (id) ON DELETE RESTRICT
)


    """,
    """
CREATE TABLE prediction_operations (
	id UUID NOT NULL,
	user_id UUID NOT NULL,
	request_id UUID NOT NULL,
	request_hash TEXT NOT NULL,
	kind TEXT NOT NULL,
	asset_kind TEXT NOT NULL,
	asset_id UUID NOT NULL,
	revision INTEGER,
	experiment_id INTEGER NOT NULL,
	state TEXT NOT NULL,
	stage TEXT NOT NULL,
	details JSONB NOT NULL,
	error JSONB,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	expires_at TIMESTAMP WITH TIME ZONE,
	completed_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT pk_prediction_operations PRIMARY KEY (id),
	CONSTRAINT uq_prediction_operations_user_id UNIQUE (user_id, request_id),
	CONSTRAINT fk_prediction_operations_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
)


    """,
    """
CREATE TABLE prediction_operation_objects (
	operation_id UUID NOT NULL,
	slot TEXT NOT NULL,
	object_id UUID NOT NULL,
	CONSTRAINT pk_prediction_operation_objects PRIMARY KEY (operation_id, slot),
	CONSTRAINT fk_prediction_operation_objects_operation_id_prediction_8255 FOREIGN KEY(operation_id) REFERENCES prediction_operations (id) ON DELETE CASCADE,
	CONSTRAINT fk_prediction_operation_objects_object_id_storage_objects FOREIGN KEY(object_id) REFERENCES storage_objects (id) ON DELETE RESTRICT
)


    """,
    """CREATE INDEX ix_prediction_replicas_dataset_id ON prediction_replicas (dataset_id)
    """,
    """CREATE INDEX ix_prediction_replicas_model_id ON prediction_replicas (model_id)
    """,
    """CREATE INDEX ix_prediction_replicas_object_id ON prediction_replicas (object_id)
    """,
    """CREATE INDEX ix_prediction_operations_asset_id ON prediction_operations (asset_id)
    """,
    """CREATE INDEX ix_prediction_operations_experiment_id ON prediction_operations (experiment_id)
    """,
    """CREATE INDEX ix_prediction_operations_user_id ON prediction_operations (user_id)
    """,
    """CREATE INDEX ix_prediction_operation_objects_object_id ON prediction_operation_objects (object_id)
    """,
)


def upgrade():
    op.execute("ALTER TABLE prediction_storages ADD COLUMN kind TEXT NOT NULL DEFAULT 'predictor_local'")
    op.execute("ALTER TABLE prediction_model_revisions ADD COLUMN preparation JSONB NOT NULL DEFAULT '{}'")
    op.execute("ALTER TABLE prediction_model_leases ADD COLUMN storage_id UUID")
    op.execute("ALTER TABLE prediction_model_leases ADD COLUMN replica_id UUID")
    for statement in DDL:
        op.execute(statement)
    op.execute("""
        INSERT INTO prediction_storage_accesses (storage_id, launcher_id, checked_at)
        SELECT storage_id, launcher_id, checked_at FROM prediction_storages
    """)
    op.execute("""
        UPDATE prediction_model_revisions r SET preparation = jsonb_build_object(
            'storage_id', m.storage_id::text, 'launcher_id', m.launcher_id::text)
        FROM prediction_models m WHERE m.id = r.model_id
    """)
    op.execute("""
        INSERT INTO prediction_replicas
            (id, model_id, revision, storage_id, state, manifest_sha256, artifact, delete_id)
        SELECT md5('model/' || m.id::text || '/' || r.revision::text || '/' || m.storage_id::text)::uuid,
            m.id, r.revision, m.storage_id,
            CASE WHEN m.state = 'deleted' THEN 'deleted' WHEN m.state = 'deleting' THEN 'deleting' ELSE 'unverified' END,
            r.artifact->>'manifest_sha256', r.artifact, m.delete_id
        FROM prediction_models m JOIN prediction_model_revisions r ON r.model_id = m.id
        WHERE r.state = 'ready' OR (m.state = 'deleting' AND r.state IN ('reserved', 'abandoned'))
    """)
    op.execute("""
        INSERT INTO prediction_replicas
            (id, dataset_id, revision, storage_id, state, manifest_sha256, artifact, delete_id)
        SELECT md5('dataset/' || d.id::text || '/' || r.revision::text || '/' || d.storage_id::text)::uuid,
            d.id, r.revision, d.storage_id,
            CASE WHEN d.state = 'deleted' THEN 'deleted' WHEN d.state = 'deleting' THEN 'deleting' ELSE 'unverified' END,
            r.summary->>'manifest_sha256', jsonb_build_object('manifest_sha256', r.summary->>'manifest_sha256',
                'fingerprint', r.fingerprint), d.delete_id
        FROM prediction_datasets d JOIN prediction_dataset_revisions r
            ON r.dataset_id = d.id AND r.revision = d.current_revision
        WHERE d.source_kind = 'local' AND d.storage_id IS NOT NULL
    """)
    op.execute("""
        INSERT INTO prediction_storages (storage_id, user_id, name, kind, checked_at, launcher_id)
        SELECT DISTINCT md5('api-dataset/' || user_id::text)::uuid, user_id, '서버 학습 데이터', 'api_dataset', now(),
            '00000000-0000-0000-0000-000000000000'::uuid FROM prediction_datasets WHERE source_kind = 'server'
    """)
    op.execute("""
        INSERT INTO prediction_replicas (id, dataset_id, revision, storage_id, state, artifact)
        SELECT md5('server-dataset/' || d.id::text || '/' || r.revision::text)::uuid,
            d.id, r.revision, md5('api-dataset/' || d.user_id::text)::uuid, 'present',
            jsonb_build_object('fingerprint', r.fingerprint)
        FROM prediction_datasets d JOIN prediction_dataset_revisions r ON r.dataset_id = d.id
        WHERE d.source_kind = 'server' AND d.state = 'active' AND r.payload IS NOT NULL
    """)
    op.execute("""
        UPDATE prediction_model_leases l SET storage_id = m.storage_id,
            replica_id = (SELECT r.id FROM prediction_replicas r
                WHERE r.model_id = l.model_id AND r.revision = l.revision AND r.storage_id = m.storage_id)
        FROM prediction_models m WHERE l.model_id = m.id
    """)
    # Keep interrupted legacy deletions resumable with their original request IDs.
    op.execute("""
        INSERT INTO prediction_operations (id, user_id, request_id, request_hash, kind, asset_kind, asset_id,
            revision, experiment_id, state, stage, details, created_at, updated_at)
        SELECT r.request_id, m.user_id, r.request_id, r.request_hash, 'prepare', 'model', m.id,
            r.revision, m.experiment_id, 'interrupted', 'preparing', jsonb_build_object(
                'target_storage_id',m.storage_id::text,'target_launcher_id',m.launcher_id::text,
                'dataset_id',r.dataset_id::text,'dataset_revision',r.dataset_revision,
                'definition',r.definition,'direction',m.direction,'name',m.name), r.created_at, now()
        FROM prediction_model_revisions r JOIN prediction_models m ON m.id = r.model_id
        WHERE r.state = 'reserved' AND m.state = 'active'
        ON CONFLICT (id) DO NOTHING
    """)
    op.execute("""
        INSERT INTO prediction_operations (id, user_id, request_id, request_hash, kind, asset_kind, asset_id,
            experiment_id, state, stage, details, created_at, updated_at)
        SELECT a.delete_id, a.user_id, a.delete_id, 'migrated-deletion', 'delete_asset', a.kind, a.id,
            a.experiment_id, 'interrupted', 'deleting', jsonb_build_object('replica_ids',
                COALESCE((SELECT jsonb_agg(r.id::text) FROM prediction_replicas r
                    WHERE r.model_id = a.id OR r.dataset_id = a.id), '[]'::jsonb)), now(), now()
        FROM (SELECT id,user_id,experiment_id,delete_id,'model' AS kind,state FROM prediction_models
              UNION ALL SELECT id,user_id,experiment_id,delete_id,'dataset',state FROM prediction_datasets) a
        WHERE a.state = 'deleting' AND a.delete_id IS NOT NULL
        ON CONFLICT (id) DO NOTHING
    """)
    op.drop_column("prediction_models", "storage_id")
    op.drop_column("prediction_models", "launcher_id")
    op.drop_column("prediction_datasets", "storage_id")
    op.drop_column("prediction_datasets", "launcher_id")
    op.drop_column("prediction_storages", "launcher_id")
    op.execute("ALTER TABLE prediction_storages ALTER COLUMN kind DROP DEFAULT")
    op.execute("ALTER TABLE prediction_model_revisions ALTER COLUMN preparation DROP DEFAULT")


def downgrade():
    raise RuntimeError("Prediction replicas cannot be collapsed into one location without losing saved copies; restore the pre-upgrade database backup instead.")
