from db import DesignerModel, PredictorModel
from routers.designer_model import CRUD_SPEC as DESIGNER_CRUD_SPEC
from routers.predictor_model import CRUD_SPEC as PREDICTOR_CRUD_SPEC


def test_model_artifact_experiment_lineage_is_immutable():
    assert DESIGNER_CRUD_SPEC.immutable_update_fields == ("experiment_id",)
    assert PREDICTOR_CRUD_SPEC.immutable_update_fields == ("experiment_id",)


def test_model_artifact_experiment_foreign_keys_are_indexed():
    for model in (DesignerModel, PredictorModel):
        indexes = {
            tuple(column.name for column in index.columns)
            for index in model.__table__.indexes
        }
        assert ("experiment_id",) in indexes
