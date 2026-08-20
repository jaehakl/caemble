from itertools import pairwise
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text


def test_alembic_history_is_one_connected_chain():
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    script = ScriptDirectory.from_config(config)

    assert len(script.get_bases()) == 1
    assert len(script.get_heads()) == 1
    revisions = list(script.walk_revisions())
    assert revisions[-1].down_revision is None
    assert all(revision.down_revision == parent.revision for revision, parent in pairwise(revisions))


@pytest.mark.slow
@pytest.mark.asyncio
async def test_configured_database_is_at_the_alembic_head(db_session):
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    script = ScriptDirectory.from_config(config)
    applied = set(
        (await db_session.execute(text("SELECT version_num FROM alembic_version"))).scalars()
    )

    assert applied == set(script.get_heads())
