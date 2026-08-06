from initserver import server
from routers import (
    designer_model,
    experiment,
    geometry,
    gps_access_token,
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
app.include_router(gps_access_token.router)
app.include_router(users.router)
