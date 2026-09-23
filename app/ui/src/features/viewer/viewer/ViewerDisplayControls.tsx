import { createContext, useCallback, useContext, type Dispatch, type SetStateAction } from 'react'
import { Layers, Route, Grid2X2 } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  DropdownMenu as Popover,
  DropdownMenuContent as PopoverContent,
  DropdownMenuTrigger as PopoverTrigger,
} from '@/components/ui/dropdown-menu'
import type { RecordedResultContracts } from '@/contracts/results'
import { GeometryDisplayButton, ViewerOutputMenuHost, ViewerToolButton, ViewerToolMenu } from './ViewerTools'
import { visualizationGroups, type GeometryMode, type VisualizationSelection } from './viewerDisplay'
import { useViewerSetting } from './comparisonSettings'

export const MeshSettingsHost = createContext<Readonly<Record<string, HTMLElement>>>({})

export function SharedViewerDisplayControls(
  props: Pick<Parameters<typeof ViewerDisplayControls>[0], 'contracts' | 'output' | 'onOutput' | 'meshHost'>,
) {
  const [geometry, setGeometry] = useViewerSetting<GeometryMode>('geometryMode', 0.9, 'workspace')
  const [visualizations, setVisualizations] = useViewerSetting<VisualizationSelection>(
    'visualizations',
    {},
    'workspace',
  )
  return (
    <ViewerDisplayControls
      {...props}
      geometry={geometry}
      onGeometry={setGeometry}
      visualizations={visualizations}
      onVisualizations={setVisualizations}
    />
  )
}

export function ViewerDisplayControls({
  contracts,
  output,
  onOutput,
  geometry,
  onGeometry,
  visualizations,
  onVisualizations,
  meshHost,
}: {
  contracts: RecordedResultContracts
  output: string
  onOutput: (name: string) => void
  geometry: GeometryMode
  onGeometry: (mode: GeometryMode) => void
  visualizations: VisualizationSelection
  onVisualizations: Dispatch<SetStateAction<VisualizationSelection>>
  meshHost: (name: string, host: HTMLDivElement | null) => void
}) {
  const groups = visualizationGroups(contracts)
  const choices = (names: string[], value: string, select: (name: string) => void) => (
    <>
      <DropdownMenuItem role="menuitemradio" aria-checked={!value} onSelect={() => select('')}>
        선택 안 함
      </DropdownMenuItem>
      {value && !names.includes(value) ? <DropdownMenuItem disabled>{value} · 결과 없음</DropdownMenuItem> : null}
      {names.map((name) => (
        <DropdownMenuItem key={name} role="menuitemradio" aria-checked={name === value} onSelect={() => select(name)}>
          {name.replace(/^@visualizations\./u, '')}
        </DropdownMenuItem>
      ))}
    </>
  )
  return (
    <>
      <GeometryDisplayButton mode={geometry} onChange={onGeometry} />
      <OutputMenu
        names={Object.keys(contracts).filter((name) => !name.startsWith('@visualizations.'))}
        value={output}
        select={onOutput}
      />
      {Object.entries(groups).map(([kind, names]) => {
        const value = visualizations[kind] ?? ''
        const label = `${kind === 'polyline' ? 'ray' : kind} · ${value.replace(/^@visualizations\./u, '') || '선택 안 함'}`
        const select = (name: string) => onVisualizations((current) => ({ ...current, [kind]: name }))
        if (kind === 'mesh-field')
          return (
            <MeshFieldMenu key={kind} label={label} names={names} value={value} select={select} meshHost={meshHost} />
          )
        return (
          <ViewerToolMenu key={kind} label={label} icon={kind === 'polyline' ? <Route /> : <Layers />}>
            {choices(names, value, select)}
          </ViewerToolMenu>
        )
      })}
    </>
  )
}

function MeshFieldMenu({
  label,
  names,
  value,
  select,
  meshHost,
}: {
  label: string
  names: string[]
  value: string
  select: (name: string) => void
  meshHost: (name: string, host: HTMLDivElement | null) => void
}) {
  const host = useCallback((element: HTMLDivElement | null) => meshHost(value, element), [meshHost, value])
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <ViewerToolButton label={label}>
          <Grid2X2 />
        </ViewerToolButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[70vh] w-72 overflow-auto p-2 text-xs" data-capture-exclude>
        <div role="radiogroup" aria-label="mesh-field 선택" className="grid gap-1">
          {['', ...names].map((name) => (
            <label key={name} className="flex items-center gap-2 rounded p-1 hover:bg-accent">
              <input
                type="radio"
                name={`viewer-${label.split(' · ')[0]}`}
                checked={value === name}
                onChange={() => select(name)}
              />
              {name.replace(/^@visualizations\./u, '') || '선택 안 함'}
            </label>
          ))}
        </div>
        {value && !names.includes(value) ? <p>{value} · 결과 없음</p> : null}
        <div ref={host} className="mt-2 grid gap-2 border-t pt-2 empty:hidden" />
      </PopoverContent>
    </Popover>
  )
}

function OutputMenu({ names, value, select }: { names: string[]; value: string; select: (name: string) => void }) {
  const settingsHost = useContext(ViewerOutputMenuHost)
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <ViewerToolButton label={`Output · ${value || '선택 안 함'}`}>
          <Layers />
        </ViewerToolButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[80vh] w-max max-w-[calc(100vw-1rem)] overflow-auto p-2 text-xs"
        data-capture-exclude
      >
        <div className="flex min-w-0 items-stretch">
          <div role="group" aria-label="Output 선택" className="grid w-56 shrink-0 content-start gap-1 overflow-y-auto">
            {['', ...names].map((name) => (
              <label key={name} className="flex items-center gap-2 rounded p-1 hover:bg-accent">
                <input
                  type="radio"
                  role="menuitemradio"
                  name="viewer-output"
                  checked={value === name}
                  onChange={() => select(name)}
                />
                {name || '선택 안 함'}
              </label>
            ))}
            {value && !names.includes(value) ? <p>{value} · 결과 없음</p> : null}
          </div>
          <div
            ref={settingsHost?.setHost}
            className="ml-2 min-w-0 flex-1 overflow-auto border-l pl-2 empty:ml-0 empty:hidden empty:border-0 empty:pl-0"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
