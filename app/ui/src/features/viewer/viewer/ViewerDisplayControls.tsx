import {
  createContext,
  useCallback,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
import { Layers, Route, Grid2X2 } from 'lucide-react'
import {
  DropdownMenu as Popover,
  DropdownMenuContent as PopoverContent,
  DropdownMenuTrigger as PopoverTrigger,
} from '@/components/ui/dropdown-menu'
import type { RecordedResultContracts } from '@/contracts/results'
import { GeometryDisplayButton, ViewerOutputMenuHost, ViewerToolButton, ViewerToolMenu } from './ViewerTools'
import { visualizationGroups, type GeometryMode, type VisualizationSelection } from './viewerDisplay'
import { useViewerComparison, useViewerSetting, ViewerControls } from './comparisonSettings'

export const ViewerResultMenuHost = createContext<Readonly<Record<string, HTMLElement>>>({})

export function SharedViewerDisplayControls(
  props: Pick<Parameters<typeof ViewerDisplayControls>[0], 'contracts' | 'output' | 'onOutput' | 'resultHost'>,
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
  resultHost,
}: {
  contracts: RecordedResultContracts
  output: string
  onOutput: (name: string) => void
  geometry: GeometryMode
  onGeometry: (mode: GeometryMode) => void
  visualizations: VisualizationSelection
  onVisualizations: Dispatch<SetStateAction<VisualizationSelection>>
  resultHost: (name: string, host: HTMLDivElement | null) => void
}) {
  const groups = visualizationGroups(contracts)
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
        return (
          <VisualizationMenu
            key={kind}
            kind={kind}
            label={label}
            names={names}
            value={value}
            select={select}
            setHost={resultHost}
          />
        )
      })}
    </>
  )
}

function VisualizationMenu({
  kind,
  label,
  names,
  value,
  select,
  setHost,
}: {
  kind: string
  label: string
  names: string[]
  value: string
  select: (name: string) => void
  setHost: (name: string, host: HTMLDivElement | null) => void
}) {
  const host = useCallback(
    (element: HTMLDivElement | null) => {
      if (value) setHost(value, element)
    },
    [setHost, value],
  )
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <ViewerToolButton label={label}>
          {kind === 'mesh-field' ? <Grid2X2 /> : kind === 'polyline' ? <Route /> : <Layers />}
        </ViewerToolButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[80vh] w-max max-w-[calc(100vw-1rem)] overflow-auto p-2 text-xs"
        data-capture-exclude
      >
        <div className="flex min-w-0 items-stretch">
          <div
            role="radiogroup"
            aria-label={`${kind} 선택`}
            className="grid w-56 shrink-0 content-start gap-1 overflow-y-auto"
          >
            {['', ...names].map((name) => (
              <label key={name} className="flex items-center gap-2 rounded p-1 hover:bg-accent">
                <input
                  type="radio"
                  role="menuitemradio"
                  name={`viewer-${kind}`}
                  checked={value === name}
                  onChange={() => select(name)}
                />
                {name.replace(/^@visualizations\./u, '') || '선택 안 함'}
              </label>
            ))}
            {value && !names.includes(value) ? <p>{value} · 결과 없음</p> : null}
          </div>
          <div
            ref={host}
            className="ml-2 min-w-0 flex-1 overflow-auto border-l pl-2 empty:ml-0 empty:hidden empty:border-0 empty:pl-0"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A result controller keeps its settings state while the toolbar menu owns the visible panel. */
export function ViewerResultSettings({
  name,
  children,
  standalone = false,
  output = !name.startsWith('@visualizations.'),
  label = `${name.replace(/^@visualizations\./u, '')} 설정`,
}: {
  name: string
  children: ReactNode
  standalone?: boolean
  output?: boolean
  label?: string
}) {
  const comparison = useViewerComparison()
  const resultHosts = useContext(ViewerResultMenuHost)
  const outputHost = useContext(ViewerOutputMenuHost)?.host
  const [localHost, setLocalHost] = useState<HTMLDivElement | null>(null)
  if (comparison && !comparison.controlsOwner) return null
  const host = resultHosts[name] ?? (output ? outputHost : null) ?? localHost
  return (
    <>
      {standalone && !resultHosts[name] ? (
        <ViewerControls placement="data">
          <ViewerToolMenu label={label} icon={<Layers />} modal={false}>
            <div ref={setLocalHost} className="max-h-[80vh] max-w-[calc(100vw-1rem)] overflow-auto p-2 text-xs" />
          </ViewerToolMenu>
        </ViewerControls>
      ) : null}
      {host ? createPortal(children, host) : null}
    </>
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
