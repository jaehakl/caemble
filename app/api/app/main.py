from ai.router import router as ai_router
from gpstation.routers import v1 as gpstation_v1
from gpstation.routers import web as gpstation_web
from initserver import server
from routers import (
    calculation,
    calculation_data,
    catalog,
    experiment,
    material,
    measurement,
    recorded_data,
    users,
)


app = server()

app.include_router(ai_router)
app.include_router(catalog.router)
app.include_router(material.router)
app.include_router(experiment.router)
app.include_router(measurement.router)
app.include_router(recorded_data.router)
app.include_router(calculation.router)
app.include_router(calculation_data.router)
app.include_router(users.router)
app.include_router(gpstation_web.router)
app.include_router(gpstation_v1.router)
