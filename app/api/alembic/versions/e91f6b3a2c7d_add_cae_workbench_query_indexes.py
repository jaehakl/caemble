"""add CAE workbench query indexes

Revision ID: e91f6b3a2c7d
Revises: d2f7a1c9e4b6
Create Date: 2026-08-11
"""

from collections.abc import Sequence

from alembic import op


revision: str = "e91f6b3a2c7d"
down_revision: str | Sequence[str] | None = "d2f7a1c9e4b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_structures_parent_id",
        "structures",
        ["parent_id"],
        unique=False,
    )
    op.create_index(
        "ix_experiments_parent_id",
        "experiments",
        ["parent_id"],
        unique=False,
    )
    op.create_index(
        "ix_samples_structure_id",
        "samples",
        ["structure_id"],
        unique=False,
    )
    op.create_index(
        "ix_setups_experiment_id",
        "setups",
        ["experiment_id"],
        unique=False,
    )
    op.create_index(
        "ix_measurements_setup_id",
        "measurements",
        ["setup_id"],
        unique=False,
    )
    op.create_index(
        "ix_measurements_user_id_updated_at",
        "measurements",
        ["user_id", "updated_at"],
        unique=False,
    )
    op.create_index(
        "ix_recorded_data_measurement_id",
        "recorded_data",
        ["measurement_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_recorded_data_measurement_id",
        table_name="recorded_data",
    )
    op.drop_index(
        "ix_measurements_user_id_updated_at",
        table_name="measurements",
    )
    op.drop_index(
        "ix_measurements_setup_id",
        table_name="measurements",
    )
    op.drop_index(
        "ix_setups_experiment_id",
        table_name="setups",
    )
    op.drop_index(
        "ix_samples_structure_id",
        table_name="samples",
    )
    op.drop_index(
        "ix_experiments_parent_id",
        table_name="experiments",
    )
    op.drop_index(
        "ix_structures_parent_id",
        table_name="structures",
    )
