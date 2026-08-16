import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import type { CatalogQuantityKind } from '@/api/catalog'
import type { RecordedDataRule } from '@/lib/cad'
import { identityCartesianBasis } from '@/lib/quantitykind'
import RecordedDataResultsView from './RecordedDataResults'
import { componentIndexPaths, componentLabel, projectRecordedComponents } from './recordedComponents'
import { convertRecordedNumericValue } from './recordedData'

const quantityKinds = new Map<string, CatalogQuantityKind>([
  [
    'test.Ratio',
    { name: 'test.Ratio', domain: 'test', tensorOrder: 0, opaque: false, applicableUnits: ['{fraction}'] },
  ],
  ['test.Length', { name: 'test.Length', domain: 'test', tensorOrder: 0, opaque: false, applicableUnits: ['m', 'mm'] }],
  [
    'test.Current',
    { name: 'test.Current', domain: 'test', tensorOrder: 0, opaque: false, applicableUnits: ['A', 'mA'] },
  ],
  [
    'test.CurrentDensity',
    { name: 'test.CurrentDensity', domain: 'test', tensorOrder: 1, opaque: false, applicableUnits: ['A.m-2'] },
  ],
])

function RecordedDataResults(props: ComponentProps<typeof RecordedDataResultsView>) {
  return <RecordedDataResultsView quantityKinds={quantityKinds} {...props} />
}

function rule(
  label: string,
  shape: readonly number[],
  dtype: RecordedDataRule['result']['dtype'],
  unit?: string,
  axisUnit?: string,
): RecordedDataRule {
  const quantityMetadata = dtype.startsWith('float')
    ? unit === 'A'
      ? { unit, quantityKind: 'test.Current' as const }
      : unit === 'A.m-2'
        ? { unit, quantityKind: 'test.CurrentDensity' as const, basis: identityCartesianBasis }
        : { unit: '{fraction}', quantityKind: 'test.Ratio' as const }
    : {}
  return {
    target: ['experiment.geometry.domain'],
    label,
    methodId: `field.${label.toLowerCase().replace(/ /g, '-')}`,
    parameters: {},
    result: {
      dtype,
      ...quantityMetadata,
      ...(shape.length === 0
        ? {}
        : {
            axes: shape.map((size, index) => ({
              ...(size === -1 ? {} : { length: size }),
              name: `axis ${index}`,
              ...(axisUnit ? { unit: axisUnit, quantityKind: 'test.Length' as const } : {}),
              ...(size === -1 ? {} : { ticks: Array.from({ length: size }, (_, tick) => `${index}:${tick}`) }),
            })),
          }),
    } as RecordedDataRule['result'],
  }
}

describe('RecordedDataResults', () => {
  const rules = [
    rule('Average', [], 'float64', 'A'),
    rule('Profile', [3], 'float32', 'A', 'm'),
    rule('Field', [2, 3], 'float32', 'A', 'm'),
  ]

  it('shows schema-driven scalar, chart, and heatmap shells without values', () => {
    const markup = renderToStaticMarkup(<RecordedDataResults rules={rules} />)

    expect(markup).toContain('aria-label="Recorded Data Results"')
    expect(markup).toContain('data-result-visualization="scalar"')
    expect(markup).toContain('data-result-visualization="line chart"')
    expect(markup).toContain('data-result-visualization="heatmap"')
    expect(markup.match(/No recorded data/g)).toHaveLength(3)
    expect(markup).toContain('expected axis lengths [2,3]')
    expect(markup).toMatch(/<select[^>]*aria-label="Average result display unit"[^>]*>\s*<option[^>]*value="A"/)
    expect(markup).toContain('<option value="mA">mA</option>')
    expect(markup).not.toContain('aria-label="Profile axis 0 axis display unit"')
  })

  it('shows valid scalar data and isolates unknown labels and shape errors', () => {
    const markup = renderToStaticMarkup(
      <RecordedDataResults
        rules={rules}
        recordedData={{
          Average: { value: 0.5 },
          Profile: { value: [1, 2] },
          Unknown: { value: 1 },
        }}
      />,
    )

    expect(markup).toContain('Unknown recordedData labels: Unknown')
    expect(markup).toContain('aria-label="Recorded scalar value"')
    expect(markup).toContain('<span>0.5</span>')
    expect(markup).toContain('<span class="text-base text-slate-500">A</span>')
    expect(markup).toContain('actual shape [2]; expected shape [3]')
    expect(markup).toContain('aria-label="Profile empty line chart"')
  })

  it('applies independent result and numeric-axis display units to card values and ticks', () => {
    const numericAxisRule: RecordedDataRule = {
      target: ['experiment.geometry.domain'],
      label: 'Numeric profile',
      methodId: 'field.numeric-profile',
      parameters: {},
      result: {
        dtype: 'float32',
        unit: 'A',
        quantityKind: 'test.Current',
        axes: [{ length: 3, name: 'position', ticks: [0, 0.5, 1], unit: 'm', quantityKind: 'test.Length' }],
      },
    }
    const markup = renderToStaticMarkup(
      <RecordedDataResults
        displayUnits={{ 'Numeric profile': { result: 'mA', axes: { 0: 'mm' } } }}
        recordedData={{ 'Numeric profile': { value: [1, 2, 3] } }}
        rules={[numericAxisRule]}
      />,
    )

    expect(markup).toContain('float32 · axes 3 · mA')
    expect(markup).toContain('length 3')
    expect(markup).toContain('aria-label="Numeric profile result display unit"')
    expect(markup).toContain('aria-label="Numeric profile position axis display unit"')
    expect(markup).toContain('[0,500,1000]')
    expect(markup).toContain('aria-label="Recorded line chart"')
  })

  it('converts scalar display values while keeping unitless results and nonnumeric axes read-only', () => {
    const textRule = rule('Labels', [2], 'string', undefined, 'm')
    const markup = renderToStaticMarkup(
      <RecordedDataResults
        displayUnits={{ Average: { result: 'mA' }, Labels: { axes: { 0: 'mm' } } }}
        recordedData={{ Average: { value: 0.5 }, Labels: { value: ['left', 'right'] } }}
        rules={[rules[0], textRule]}
      />,
    )

    expect(markup).toContain('<span>500</span>')
    expect(markup).toContain('<span class="text-base text-slate-500">mA</span>')
    expect(markup).not.toContain('aria-label="Labels result display unit"')
    expect(markup).not.toContain('aria-label="Labels axis 0 axis display unit"')
    expect(markup).toContain('[&quot;0:0&quot;,&quot;0:1&quot;]')
  })

  it('renders N-dimensional string slices with leading-axis selectors and a matrix table', () => {
    const textRule = rule('Labels', [2, 2, 2], 'string')
    const markup = renderToStaticMarkup(
      <RecordedDataResults
        rules={[textRule]}
        recordedData={{
          Labels: {
            value: [
              [
                ['a', 'b'],
                ['c', 'd'],
              ],
              [
                ['e', 'f'],
                ['g', 'h'],
              ],
            ],
          },
        }}
      />,
    )

    expect(markup).toContain('aria-label="Select axis 0 slice"')
    expect(markup).toContain('0: 0:0')
    expect(markup).toContain('>a</td>')
    expect(markup).toContain('>d</td>')
    expect(markup).not.toContain('>e</td>')
  })

  it('renders CSP-safe native SVG line and heatmap plots', () => {
    const markup = renderToStaticMarkup(
      <RecordedDataResults
        rules={rules.slice(1)}
        recordedData={{
          Profile: { value: [1, 2, 3] },
          Field: {
            value: [
              [1, 2, 3],
              [4, 5, 6],
            ],
          },
        }}
      />,
    )

    expect(markup).toContain('aria-label="Recorded line chart"')
    expect(markup).toContain('aria-label="Recorded heatmap"')
    expect(markup).toContain('<polyline')
  })

  it('defaults vector results to norm and exposes identity-basis components', () => {
    const vectorRule = rule('Current density', [2], 'float64', 'A.m-2')
    const markup = renderToStaticMarkup(
      <RecordedDataResults
        rules={[vectorRule]}
        recordedData={{
          'Current density': {
            value: [
              [3, 4, 0],
              [0, 0, 5],
            ],
          },
        }}
      />,
    )

    expect(markup).toContain('tensor order 1 · components [3]')
    expect(markup).toContain('aria-label="Current density component"')
    expect(markup).toMatch(/<option value="norm" selected="">norm<\/option>/)
    expect(markup).toContain('x [0]')
    expect(markup).toContain('y [1]')
    expect(markup).toContain('z [2]')
    expect(markup).toContain('aria-label="Recorded line chart"')
  })

  it('renders raw base64 DataTensor values through the shared accessor', () => {
    const vectorRule = rule('Current density', [2], 'float64', 'A.m-2')
    const bytes = new Uint8Array(6 * 8)
    const view = new DataView(bytes.buffer)
    ;[3, 4, 0, 0, 0, 5].forEach((value, index) => view.setFloat64(index * 8, value, true))
    const markup = renderToStaticMarkup(
      <RecordedDataResults
        rules={[vectorRule]}
        recordedData={{
          'Current density': {
            tensorEncodingVersion: 1,
            shape: [2, 3],
            storage: {
              kind: 'base64',
              data: btoa(String.fromCharCode(...bytes)),
              byteLength: bytes.byteLength,
            },
          },
        }}
      />,
    )

    expect(markup).toContain('aria-label="Recorded line chart"')
    expect(markup).toContain('0:0: 5 A.m-2')
    expect(markup).not.toContain('role="alert"')
  })

  it('projects vector and general tensor components after recursive unit conversion', () => {
    const converted = convertRecordedNumericValue([[3, 4, 0]], 'A', 'mA', 1)
    expect(projectRecordedComponents(converted, 1, 1, 'norm')).toEqual([5_000])
    expect(projectRecordedComponents(converted, 1, 1, 'component:1')).toEqual([4_000])
    expect(
      projectRecordedComponents(
        [
          [1, 2, 2],
          [0, 0, 0],
          [0, 0, 0],
        ],
        0,
        2,
        'norm',
      ),
    ).toBe(3)
    expect(
      projectRecordedComponents(
        [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8, 9],
        ],
        0,
        2,
        'component:2,1',
      ),
    ).toBe(8)
  })

  it('enumerates high-order selectors and labels rotated-basis components', () => {
    expect(componentIndexPaths(3)).toHaveLength(27)
    expect(componentIndexPaths(4)).toHaveLength(81)
    expect(componentIndexPaths(4)[80]).toEqual([2, 2, 2, 2])
    expect(componentLabel([0, 2], true)).toBe('xz')
    expect(componentLabel([0, 2], false)).toBe('b0b2')
    expect(Object.isFrozen(componentIndexPaths(4))).toBe(true)
  })

  it('renders a resolved empty wildcard tensor without attempting an invalid slice', () => {
    const emptyRule = rule('Dynamic empty', [-1, -1, -1], 'float32')
    const markup = renderToStaticMarkup(
      <RecordedDataResults rules={[emptyRule]} recordedData={{ 'Dynamic empty': { value: [] } }} />,
    )

    expect(markup).toContain('No recorded values')
    expect(markup).toContain('Resolved empty data · actual axis lengths [0,0,0]')
  })
})
