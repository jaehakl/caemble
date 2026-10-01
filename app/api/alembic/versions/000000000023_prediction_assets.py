"""Owned Dataset snapshots, scoped reads and immutable saved Prediction models."""
from alembic import op

revision = "000000000023"
down_revision = "000000000022"
branch_labels = None
depends_on = None

# Fixed DDL: never import evolving application metadata from a migration.
DDL = (
    """
    CREATE TABLE prediction_datasets (
        id UUID NOT NULL,
        user_id UUID NOT NULL,
        experiment_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        selection JSONB NOT NULL,
        current_revision INTEGER NOT NULL,
        storage_id UUID,
        launcher_id UUID,
        delete_id UUID,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        CONSTRAINT pk_prediction_datasets PRIMARY KEY (id),
        CONSTRAINT fk_prediction_datasets_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE prediction_models (
        id UUID NOT NULL,
        user_id UUID NOT NULL,
        experiment_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        direction TEXT NOT NULL,
        state TEXT NOT NULL,
        current_revision INTEGER NOT NULL,
        storage_id UUID NOT NULL,
        launcher_id UUID NOT NULL,
        delete_id UUID,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        CONSTRAINT pk_prediction_models PRIMARY KEY (id),
        CONSTRAINT fk_prediction_models_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE prediction_storages (
        storage_id UUID NOT NULL,
        user_id UUID NOT NULL,
        launcher_id UUID NOT NULL,
        name TEXT NOT NULL,
        checked_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        CONSTRAINT pk_prediction_storages PRIMARY KEY (storage_id),
        CONSTRAINT fk_prediction_storages_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE prediction_dataset_grants (
        id UUID NOT NULL,
        dataset_id UUID NOT NULL,
        revision INTEGER NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT pk_prediction_dataset_grants PRIMARY KEY (id),
        CONSTRAINT fk_prediction_dataset_grants_dataset_id_prediction_datasets FOREIGN KEY(dataset_id) REFERENCES prediction_datasets (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE prediction_dataset_requests (
        dataset_id UUID NOT NULL,
        request_id UUID NOT NULL,
        request_hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        CONSTRAINT pk_prediction_dataset_requests PRIMARY KEY (dataset_id, request_id),
        CONSTRAINT fk_prediction_dataset_requests_dataset_id_prediction_datasets FOREIGN KEY(dataset_id) REFERENCES prediction_datasets (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE prediction_dataset_revisions (
        dataset_id UUID NOT NULL,
        revision INTEGER NOT NULL,
        request_id UUID NOT NULL,
        request_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        summary JSONB NOT NULL,
        payload JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        CONSTRAINT pk_prediction_dataset_revisions PRIMARY KEY (dataset_id, revision),
        CONSTRAINT uq_prediction_dataset_revisions_dataset_id UNIQUE (dataset_id, request_id),
        CONSTRAINT fk_prediction_dataset_revisions_dataset_id_prediction_datasets FOREIGN KEY(dataset_id) REFERENCES prediction_datasets (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE prediction_model_revisions (
        model_id UUID NOT NULL,
        revision INTEGER NOT NULL,
        request_id UUID NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        dataset_id UUID NOT NULL,
        dataset_revision INTEGER NOT NULL,
        dataset_fingerprint TEXT NOT NULL,
        definition JSONB NOT NULL,
        source_contracts JSONB NOT NULL,
        artifact JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        CONSTRAINT pk_prediction_model_revisions PRIMARY KEY (model_id, revision),
        CONSTRAINT uq_prediction_model_revisions_model_id UNIQUE (model_id, request_id),
        CONSTRAINT fk_prediction_model_revisions_model_id_prediction_models FOREIGN KEY(model_id) REFERENCES prediction_models (id) ON DELETE CASCADE,
        CONSTRAINT fk_prediction_model_revisions_dataset_id_prediction_datasets FOREIGN KEY(dataset_id) REFERENCES prediction_datasets (id) ON DELETE RESTRICT
    )
    """,
    """
    CREATE TABLE prediction_model_leases (
        model_id UUID NOT NULL,
        revision INTEGER NOT NULL,
        job_id UUID NOT NULL,
        CONSTRAINT pk_prediction_model_leases PRIMARY KEY (model_id, revision, job_id),
        CONSTRAINT fk_prediction_model_leases_model_id_prediction_models FOREIGN KEY(model_id) REFERENCES prediction_models (id) ON DELETE CASCADE,
        CONSTRAINT fk_prediction_model_leases_job_id_jobs FOREIGN KEY(job_id) REFERENCES jobs (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE prediction_dataset_objects (
        dataset_id UUID NOT NULL,
        revision INTEGER NOT NULL,
        object_id UUID NOT NULL,
        CONSTRAINT pk_prediction_dataset_objects PRIMARY KEY (dataset_id, revision, object_id),
        CONSTRAINT fk_prediction_dataset_objects_dataset_id_prediction_dat_d7b4 FOREIGN KEY(dataset_id, revision) REFERENCES prediction_dataset_revisions (dataset_id, revision) ON DELETE CASCADE,
        CONSTRAINT fk_prediction_dataset_objects_object_id_storage_objects FOREIGN KEY(object_id) REFERENCES storage_objects (id) ON DELETE RESTRICT
    )
    """,
    """
    CREATE INDEX ix_prediction_datasets_experiment_id ON prediction_datasets (experiment_id)
    """,
    """
    CREATE INDEX ix_prediction_datasets_user_id ON prediction_datasets (user_id)
    """,
    """
    CREATE INDEX ix_prediction_models_experiment_id ON prediction_models (experiment_id)
    """,
    """
    CREATE INDEX ix_prediction_models_user_id ON prediction_models (user_id)
    """,
    """
    CREATE INDEX ix_prediction_storages_user_id ON prediction_storages (user_id)
    """,
    """
    CREATE INDEX ix_prediction_dataset_grants_dataset_id ON prediction_dataset_grants (dataset_id)
    """,
    """
    CREATE INDEX ix_prediction_dataset_objects_object_id ON prediction_dataset_objects (object_id)
    """,
)


def upgrade():
    for statement in DDL:
        op.execute(statement)


def downgrade():
    op.drop_table('prediction_dataset_objects')
    op.drop_table('prediction_model_leases')
    op.drop_table('prediction_model_revisions')
    op.drop_table('prediction_dataset_revisions')
    op.drop_table('prediction_dataset_requests')
    op.drop_table('prediction_dataset_grants')
    op.drop_table('prediction_storages')
    op.drop_table('prediction_models')
    op.drop_table('prediction_datasets')
