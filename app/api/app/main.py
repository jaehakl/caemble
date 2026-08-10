from initserver import server
from gpstation.routers import v1 as gpstation_v1
from gpstation.routers import web as gpstation_web
from routers import (
    designer_model,
    experiment,
    geometry,
    material,
    material_name,
    material_parameter,
    material_parameter_qualifier,
    measurement,
    predictor_model,
    recorded_data,
    sample,
    setup,
    structure,
    users,
)


app = server()

app.include_router(material.router)
app.include_router(material_name.router)
app.include_router(material_parameter.router)
app.include_router(material_parameter_qualifier.router)
app.include_router(geometry.router)
app.include_router(structure.router)
app.include_router(experiment.router)
app.include_router(sample.router)
app.include_router(setup.router)
app.include_router(measurement.router)
app.include_router(recorded_data.router)
app.include_router(designer_model.router)
app.include_router(predictor_model.router)
app.include_router(users.router)
app.include_router(gpstation_web.router)
app.include_router(gpstation_v1.router)
