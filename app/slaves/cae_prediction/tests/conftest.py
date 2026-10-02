"""Load the Predictor package without colliding with other slave packages named app."""
import importlib.util
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("predictor", ROOT / "app" / "__init__.py", submodule_search_locations=[str(ROOT / "app")])
PACKAGE = importlib.util.module_from_spec(SPEC)
sys.modules["predictor"] = PACKAGE
SPEC.loader.exec_module(PACKAGE)
sys.path.insert(0, str(ROOT.parents[1]))
sys.path.insert(0, str(ROOT.parents[2] / "shared"))
