"""Use the same complete ORM registration as the application and Alembic."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from model_registry import register_models

register_models()
