export const defaultExperimentSimulationCode = `async def simulate(*, sim, tasks, vars):
    electric = await sim.run(tasks["electric"])
    await sim.record(
        "measuredCurrent",
        electric["artifacts"]["totalCurrent"],
    )
    sim.release(electric["artifacts"]["currentDensity"])
    return electric["state"]
`
