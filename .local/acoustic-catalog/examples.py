"""Author complete transient examples in the current Draft through catalogctl."""
from copy import deepcopy

from caemble_catalog import open_catalog
from update import DRAFT, publish_example


def acoustic_source(coupled):
    total = 1024 if coupled else 2000
    window = 32 if coupled else 500
    dt = "1 / 65536" if coupled else "0.00001"
    boundary = """      { methodId: 'acoustics.transient-surface-motion', target: ['experiment.surface.inlet'], parameters: {} },""" if coupled else """      // The inlet outward normal is -X. Negative normal velocity launches +X pressure.
      { methodId: 'acoustics.tone-burst-velocity', target: ['experiment.surface.inlet'], parameters: {
        amplitude: { dtype: 'float64', value: -0.001, quantityKind: 'kinematics.Speed', unit: 'm.s-1' },
        frequency: { dtype: 'float64', value: 250, quantityKind: 'Frequency', unit: 'Hz' },
        startTime: { dtype: 'float64', value: 0, quantityKind: 'Time', unit: 's' },
        duration: { dtype: 'float64', value: 0.008, quantityKind: 'Time', unit: 's' },
      } },"""
    return f"""import {{ Box, defineTask }} from '@caemble/core'

export default defineTask({{
  kernel: {{ name: 'pressure-acoustics', version: '1.1.0' }},
  lengthUnit: 'm',
  config: () => ({{
    parameters: {{
      analysis: 'transient',
      spatialResolution: {{ dtype: 'float64', value: 0.02, quantityKind: 'Length', unit: 'm' }},
    }},
    initializations: [
      {{ methodId: 'acoustics.fluid', target: ['experiment.geometry.fluid'], parameters: {{}} }},
      {{ methodId: 'acoustics.time', target: [], parameters: {{
        dt: {{ dtype: 'float64', value: {dt}, quantityKind: 'Time', unit: 's' }},
        totalSteps: {total}, windowSteps: {window},
      }} }},
    ],
    boundaryConditions: [
{boundary}
      {{ methodId: 'acoustics.impedance', target: ['experiment.surface.outlet'], parameters: {{
        resistance: {{ dtype: 'float64', value: 1.2 * 343, quantityKind: 'acoustics.SpecificAcousticImpedance', unit: 'Pa.s.m-1' }},
      }} }},
    ],
    // Probe samples are raw simulation samples. The coarse field is for inspection,
    // without anti-alias filtering or an audio sample-rate conversion.
    outputs: [
      {{ methodId: 'acoustics.pressure-history', key: 'pressure', target: ['task.geometry.outputGrid'], parameters: {{ gridShape: [20, 3, 3], sampleEvery: 20 }} }},
      {{ methodId: 'acoustics.pressure-history', key: 'pressureProbe', target: ['task.geometry.probe'], parameters: {{ gridShape: [1, 1, 1], sampleEvery: 1 }} }},
    ],
    exports: [],
  }}),
  geometry: ({{ vars }}) => <>
    <Box id="output-grid" size={{[Number(vars.length), Number(vars.width), Number(vars.height)]}} position={{[Number(vars.length) / 2, 0, 0]}} />
    <Box id="probe" size={{[0.001, 0.001, 0.001]}} position={{[0.8 * Number(vars.length), 0, 0]}} />
  </>,
  geometryGroup: {{ outputGrid: ['output-grid'], probe: ['probe'] }},
}})
"""


structure_source = """import { Box, defineTask } from '@caemble/core'

// Small initial +X velocity of 1e-6 m/s in a clamped elastic plate. The support projection
// enforces zero rim motion. Air starts at rest; no hidden source ramp is applied.
export default defineTask({
  kernel: { name: 'structural-mechanics', version: '6.1.0' },
  lengthUnit: 'm',
  config: ({ vars }) => ({
    parameters: {
      analysis: 'transient', geometricNonlinear: false, maxIterations: 40,
      relativeTolerance: { dtype: 'float64', value: 1e-8, quantityKind: 'Dimensionless', unit: '1' },
      // Coarse solid demonstration; refine the structural mesh for response accuracy.
      spatialResolution: { dtype: 'float64', value: 0.02, quantityKind: 'Length', unit: 'm' },
    },
    initializations: [
      { methodId: 'fea.body', target: ['experiment.geometry.plate'], parameters: {} },
      { methodId: 'fea.initial-motion', target: ['experiment.geometry.plate'], parameters: {
        initialVelocity: { dtype: 'float64', value: [0.000001, 0, 0], quantityKind: 'kinematics.Speed', unit: 'm.s-1', axes: [{ length: 3 }] },
        initialAngularVelocity: { dtype: 'float64', value: [0, 0, 0], quantityKind: 'AngularFrequency', unit: 'rad.s-1', axes: [{ length: 3 }] },
        referencePoint: { dtype: 'float64', value: [0, 0, 0], quantityKind: 'Length', unit: 'm', axes: [{ length: 3 }] },
      } },
      { methodId: 'fea.time', target: [], parameters: {
        dt: { dtype: 'float64', value: 1 / 65536, quantityKind: 'Time', unit: 's' },
        windowSize: { dtype: 'float64', value: 1 / 2048, quantityKind: 'Time', unit: 's' },
        duration: { dtype: 'float64', value: 1 / 64, quantityKind: 'Time', unit: 's' },
        outputInterval: { dtype: 'float64', value: 1 / 65536, quantityKind: 'Time', unit: 's' },
        dampingMass: { dtype: 'float64', value: 10, quantityKind: 'Frequency', unit: 'Hz' },
        dampingStiffness: { dtype: 'float64', value: 0.000001, quantityKind: 'Time', unit: 's' },
        maxCouplingIterations: 10,
        couplingTolerance: { dtype: 'float64', value: 0.00001, quantityKind: 'Dimensionless', unit: '1' },
        relaxation: { dtype: 'float64', value: 0.7, quantityKind: 'Dimensionless', unit: '1' },
      } },
    ],
    boundaryConditions: [
      { methodId: 'fea.fixed', target: ['experiment.surface.plateRim'], parameters: {
        components: { dtype: 'string', value: ['x', 'y', 'z'], axes: [{ length: 3 }] },
      } },
    ],
    outputs: [
      { methodId: 'fea.displacement-history', key: 'displacement', target: ['task.geometry.outputGrid'], parameters: { gridShape: [1, 6, 6], scope: 'cumulative' } },
      { methodId: 'fea.velocity-history', key: 'velocity', target: ['task.geometry.outputGrid'], parameters: { gridShape: [1, 6, 6], scope: 'cumulative' } },
    ],
    exports: [{ methodId: 'fea.transient-surface-motion', key: 'surfaceMotion', target: ['experiment.surface.plateFront'], parameters: {} }],
  }),
  geometry: ({ vars }) => <Box id="output-grid" size={[Number(vars.thickness), Number(vars.width), Number(vars.height)]} position={[-Number(vars.thickness) / 2, 0, 0]} />,
  geometryGroup: { outputGrid: ['output-grid'] },
})
"""


with open_catalog(DRAFT) as catalog:
    standalone = catalog.experiment("matched-impedance-duct")
    coupled = catalog.experiment("plate-driven-duct")

for example, linked in [(standalone, False), (coupled, True)]:
    example["key"] = "transient-" + example["key"]
    example["version"] = "1.0.0"
    example["calculations"] = []
    example["title"] = "Transient Plate-Driven Duct" if linked else "Transient Matched-Impedance Duct"
    example["description"] = (
        "An explicit small initial plate velocity of 1e-6 m/s drives one-way pressure-acoustic FDTD through actual converged reference-surface waveforms, never next-window predictions. The primitive plate and fluid are independently discretized as vars change. The explicit 0.02 m structural resolution is a coarse solid demonstration; structural refinement is required for response accuracy. Explicit Rayleigh damping is alpha=10/s and beta=1e-6 s. Air is initially at rest, so nonzero initial boundary motion creates a physical startup transient; no hidden ramp is applied. Thirty-two windows of 32 steps at dt=1/65536 s produce raw signed Pa probe samples and a coarse pressure field. This is initial-motion free response, not hammer impact or a complete instrument; no P/F transfer function or fluid reaction is claimed."
        if linked else
        "A 0.5 m duct with 0.1 m square cross section, rho=1.2 kg/m3 and c=343 m/s receives a finite 250 Hz Hann tone burst with 0.001 m/s +X carrier amplitude for 8 ms. Rigid sidewalls and a positive rho*c outlet define the matched normal-incidence benchmark p(x,t)=rho*c*V(t-x/c), with V=0 outside its support. Four windows preserve dt=10 microseconds; raw signed Pa probe samples at x=0.8L and coarse unfiltered field samples use the global time origin. This finite termination is not PML or arbitrary free-space radiation."
    )
    example["concepts"] = ["transient pressure acoustics", "staggered FDTD", "run-scoped checkpoint", "Box Grid pressure history"] + (["one-way structural surface motion"] if linked else ["finite tone burst", "matched resistive termination"])
    files = example["sourceBundle"]["files"]
    files["tasks/acoustics.tsx"] = acoustic_source(linked)
    if linked:
        files["tasks/structure.tsx"] = structure_source
        files["experiment.tsx"] = files["experiment.tsx"].replace("displacement: { task: 'structure', output: 'displacement' },", "displacement: { task: 'structure', output: 'displacement' },\n    velocity: { task: 'structure', output: 'velocity' },")
        files["simulate.py"] = '''async def simulate(*, sim, tasks, vars):
    initial = await sim.run(tasks["structure"])
    state = initial["state"]
    # The initial export has only t=0. It cannot drive a positive acoustic interval.
    sim.release(initial["artifacts"])
    for window in range(32):
        base = state
        structure = await sim.run(tasks["structure"], state=base)
        sound = await sim.run(tasks["acoustics"], state=structure["state"], inputs={
            "transientSurfaceMotion": structure["artifacts"]["surfaceMotion"],
        })
        state = sound["state"]
        if window == 31:
            await sim.record("displacement", structure["artifacts"]["displacement"])
            await sim.record("velocity", structure["artifacts"]["velocity"])
            await sim.record("pressure", sound["artifacts"]["pressure"])
            await sim.record("pressureProbe", sound["artifacts"]["pressureProbe"])
        # Keep base and the real surface waveform live until the acoustic call succeeds.
        sim.release(structure["artifacts"])
        sim.release(sound["artifacts"])
        sim.release(base, keep=state)
        sim.release(structure["state"], keep=state)
    sim.release(state)
'''
    else:
        files["simulate.py"] = '''async def simulate(*, sim, tasks, vars):
    state = None
    for window in range(4):
        sound = await sim.run(tasks["acoustics"], state=state)
        if window > 0:
            sim.release(state, keep=sound["state"])
        state = sound["state"]
        if window == 3:
            await sim.record("pressure", sound["artifacts"]["pressure"])
            await sim.record("pressureProbe", sound["artifacts"]["pressureProbe"])
        sim.release(sound["artifacts"])
    sim.release(state)
'''
    publish_example(example)
    print(example["key"])
