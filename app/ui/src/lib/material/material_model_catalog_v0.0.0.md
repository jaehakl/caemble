# Material Model Catalog v0.0.0

- Catalog ID: `material-model-catalog`
- QuantityKind data version: `0.0.1`
- Total canonical model keys: **2**

| Key                                   | Korean label | Input QuantityKind                       | Output QuantityKind                    | Minimum samples | Shared basis |
| ------------------------------------- | ------------ | ---------------------------------------- | -------------------------------------- | --------------: | ------------ |
| `model.magnetic_hysteresis.b_h_curve` | B-H 곡선     | `electromagnetism.MagneticFieldStrength` | `electromagnetism.MagneticFluxDensity` |               2 | true         |
| `model.sorption.isotherm`             | 흡착 등온선  | `thermodynamics.RelativeHumidity`        | `MassFraction`                         |               2 | false        |
